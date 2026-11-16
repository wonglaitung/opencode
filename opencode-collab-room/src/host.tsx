import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { Show, createSignal } from "solid-js"
import { lanAddress } from "./net"
import { formatInvite, type ClientMessage, type ServerMessage, type WireMessage, type WirePart } from "./protocol"
import { logHost, startRelay, type Relay } from "./relay"
import {
  awaitApproval,
  cancelRequest,
  createRoom,
  markIdle,
  request,
  resolveApproval,
  takeNext,
  toWireState,
  watchdog,
  type RoomState,
} from "./room"
import type { QueueItem } from "./queue"

export const WATCHDOG_INTERVAL_MS = 3_000

export type HostRoom = {
  state: RoomState
  relay: Relay
  invite: string
  dispose: () => void
}

export function startHostRoom(api: TuiPluginApi): HostRoom {
  const state = createRoom()
  const token = crypto.randomUUID().replaceAll("-", "")
  let seq = 0
  let busy = false
  let lastPeers: string[] = []
  let relay: Relay
  const [version, setVersion] = createSignal(0)
  const bump = () => setVersion((value) => value + 1)

  const broadcast = (message: ServerMessage) => relay.broadcast(message)
  const broadcastState = () => {
    broadcast({ type: "state", state: toWireState(state, relay.peers().length) })
    bump()
  }

  const submit = async (item: QueueItem) => {
    const sessionID = currentSession(api)
    if (!sessionID) return
    try {
      await api.client.session.prompt({
        sessionID,
        parts: [{ type: "text", text: `${item.by}：${item.text}` }],
      })
    } catch {
      markIdle(state)
      broadcastState()
      api.ui.toast({ title: "协作房间", message: "队列任务提交失败" })
    }
  }

  const promote = () => {
    if (busy || !currentSession(api)) return
    const item = takeNext(state)
    if (!item) return
    broadcastState()
    void submit(item)
  }

  relay = startRelay({
    token,
    room: "collab-room",
    sessionTitle: () => currentTitle(api),
    snapshot: () => {
      const messages = snapshotMessages(api)
      logHost(`snapshot messages=${messages.length} session=${currentSession(api) ?? "-"}`)
      return { seq, messages }
    },
    state: (peers) => toWireState(state, peers.length),
    onPeers: (peers) => {
      for (const name of peers) {
        if (!lastPeers.includes(name)) api.ui.toast({ title: "协作房间", message: `${name} 加入了房间` })
      }
      lastPeers = peers
      broadcastState()
    },
    onMessage: (message, peer) => {
      if (message.type === "suggest") {
        const sessionID = currentSession(api)
        if (!sessionID) return
        const by = peer.name || "访客"
        void api.client.session
          .prompt({ sessionID, parts: [{ type: "text", text: `[${by} 的建议] ${message.text}` }], noReply: true })
          .catch(() => {})
        return
      }
      if (message.type === "queue") {
        request(state, { id: message.id, by: peer.name || "访客", text: message.text, queuedAt: Date.now() })
        broadcastState()
        promote()
        return
      }
      if (message.type === "queue.cancel") {
        if (cancelRequest(state, message.id)) broadcastState()
      }
    },
  })

  const invite = formatInvite(lanAddress() ?? "127.0.0.1", relay.port, token)

  api.event.on("session.status", (event) => {
    const sessionID = currentSession(api)
    if (!sessionID || event.properties.sessionID !== sessionID) return
    if (event.properties.status.type !== "idle") {
      busy = true
      return
    }
    busy = false
    if (state.status === "busy") {
      markIdle(state)
      broadcastState()
    }
    promote()
  })

  api.event.on("permission.asked", (event) => {
    const sessionID = currentSession(api)
    const permission = event.properties
    if (!sessionID || permission.sessionID !== sessionID) return
    awaitApproval(state, { id: permission.id, tool: permission.permission, requestedAt: Date.now() })
    broadcast({
      type: "permission",
      id: permission.id,
      tool: permission.permission,
      detail: permission.patterns.join(" "),
    })
    broadcastState()
  })

  api.event.on("permission.replied", (event) => {
    const sessionID = currentSession(api)
    if (!sessionID || event.properties.sessionID !== sessionID) return
    resolveApproval(state)
    broadcast({ type: "permission.result", id: event.properties.requestID, reply: "done" })
    broadcastState()
  })

  api.event.on("message.updated", (event) => {
    const sessionID = currentSession(api)
    const info = event.properties.info
    if (!sessionID || info.sessionID !== sessionID) return
    broadcast({ type: "message.updated", seq: ++seq, id: info.id, role: info.role })
  })

  api.event.on("message.part.delta", (event) => {
    const sessionID = currentSession(api)
    if (!sessionID || event.properties.sessionID !== sessionID) return
    broadcast({
      type: "part.delta",
      seq: ++seq,
      messageID: event.properties.messageID,
      partID: event.properties.partID,
      field: event.properties.field,
      delta: event.properties.delta,
    })
  })

  api.event.on("message.part.updated", (event) => {
    const sessionID = currentSession(api)
    if (!sessionID || event.properties.part.sessionID !== sessionID) return
    broadcast({
      type: "part.updated",
      seq: ++seq,
      messageID: event.properties.part.messageID,
      part: toWirePart(event.properties.part),
    })
  })

  const timer = setInterval(() => {
    const action = watchdog(state)
    if (action.kind === "none") return
    broadcastState()
    if (action.kind === "drop") {
      api.ui.toast({ title: "协作房间", message: `${action.item.by} 的任务超时，已丢弃` })
      return
    }
    promote()
  }, WATCHDOG_INTERVAL_MS)

  const openPanel = () => {
    api.ui.dialog.replace(
      () => <api.ui.DialogAlert title="协作房间" message={panelText(state, relay.peers(), invite)} />,
      () => {},
    )
  }

  api.slots.register({
    order: 100,
    slots: {
      sidebar_content: () => <RoomCard api={api} state={state} relay={relay} version={version} invite={invite} />,
      home_bottom: () => <RoomCard api={api} state={state} relay={relay} version={version} invite={invite} />,
    },
  })

  api.keymap.registerLayer({
    commands: [
      {
        name: "collab.status",
        title: "协作房间：状态",
        slashName: "room-status",
        category: "Collaboration",
        namespace: "palette",
        run: openPanel,
      },
      {
        name: "collab.stop",
        title: "协作房间：关闭房间",
        slashName: "room-stop",
        category: "Collaboration",
        namespace: "palette",
        run() {
          void relay.stop()
          api.ui.toast({ title: "协作房间", message: "房间已关闭" })
        },
      },
    ],
  })

  return {
    state,
    relay,
    invite,
    dispose() {
      clearInterval(timer)
      void relay.stop()
    },
  }
}

function RoomCard(props: {
  api: TuiPluginApi
  state: RoomState
  relay: Relay
  version: () => number
  invite: string
}) {
  const theme = () => props.api.theme.current
  const info = () => {
    props.version()
    return toWireState(props.state, props.relay.peers().length)
  }
  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="column">
        <text fg={theme().text}>
          <b>协作房间</b>
        </text>
        <text fg={theme().success}>● 进行中 · {info().peers} 人</text>
        <Show when={info().queue.length > 0}>
          <text fg={theme().textMuted}>
            队列 {info().queue.length} · {truncate(info().queue[0]?.text ?? "", 18)}
          </text>
        </Show>
        <Show when={info().pendingApproval}>
          <text fg={theme().warning}>⏳ 待审批</text>
        </Show>
      </box>
      <box flexDirection="column">
        <text fg={theme().textMuted}>邀请码</text>
        <text fg={theme().text} wrapMode="char">
          {props.invite}
        </text>
      </box>
    </box>
  )
}

export function panelText(state: RoomState, peers: string[], invite: string) {
  const info = toWireState(state, peers.length)
  const queue = info.queue.length ? `\n队列：${info.queue.map((item, index) => `${index + 1}. ${item.by}：${truncate(item.text, 24)}`).join("；")}` : ""
  const approval = info.pendingApproval ? `\n待审批：${info.pendingApproval.tool ?? "权限请求"}` : ""
  return `进行中 · ${info.peers} 人${queue}${approval}\n\n邀请码：${invite}`
}

function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function currentSession(api: TuiPluginApi): string | undefined {
  const route = api.route.current
  if (route.name !== "session") return
  const params = "params" in route ? route.params : undefined
  if (!params || typeof params !== "object") return
  const sessionID = (params as Record<string, unknown>).sessionID
  return typeof sessionID === "string" && sessionID ? sessionID : undefined
}

function currentTitle(api: TuiPluginApi): string | undefined {
  const sessionID = currentSession(api)
  if (!sessionID) return
  return api.state.session.get(sessionID)?.title
}

function snapshotMessages(api: TuiPluginApi): WireMessage[] {
  const sessionID = currentSession(api)
  if (!sessionID) return []
  return api.state.session.messages(sessionID).map((message) => ({
    id: message.id,
    role: message.role,
    parts: (api.state.part(message.id) ?? []).map(toWirePart),
  }))
}

function toWirePart(part: unknown): WirePart {
  if (!isRecord(part)) return { id: "unknown", messageID: "unknown", type: "unknown" }
  const id = typeof part.id === "string" ? part.id : "unknown"
  const messageID = typeof part.messageID === "string" ? part.messageID : "unknown"
  const type = typeof part.type === "string" ? part.type : "unknown"
  const text = typeof part.text === "string" ? part.text : undefined
  return text === undefined ? { ...part, id, messageID, type } : { ...part, id, messageID, type, text }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
