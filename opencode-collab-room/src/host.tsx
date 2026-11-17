import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { Show, createSignal } from "solid-js"
import { lanAddress } from "./net"
import {
  formatInvite,
  MAX_PART_TEXT,
  MAX_TOOL_OUTPUT,
  type ClientMessage,
  type ServerMessage,
  type WireMessage,
  type WireMessageInfo,
  type WirePart,
  type WirePermission,
} from "./protocol"
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
    const request = toWirePermission(permission)
    broadcast({ type: "permission", request })
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
    const wireInfo = toWireInfo(info)
    broadcast(
      wireInfo === undefined
        ? { type: "message.updated", seq: ++seq, id: info.id, role: info.role }
        : { type: "message.updated", seq: ++seq, id: info.id, role: info.role, info: wireInfo },
    )
  })

  api.event.on("question.asked", (event) => {
    const sessionID = currentSession(api)
    const question = event.properties
    if (!sessionID || question.sessionID !== sessionID) return
    broadcast({ type: "question", request: { id: question.id, questions: question.questions } })
  })

  api.event.on("question.replied", (event) => {
    const sessionID = currentSession(api)
    if (!sessionID || event.properties.sessionID !== sessionID) return
    broadcast({ type: "question.result", id: event.properties.requestID, answers: event.properties.answers })
  })

  api.event.on("question.rejected", (event) => {
    const sessionID = currentSession(api)
    if (!sessionID || event.properties.sessionID !== sessionID) return
    broadcast({ type: "question.result", id: event.properties.requestID, rejected: true })
  })

  api.event.on("session.error", (event) => {
    const sessionID = currentSession(api)
    const properties = event.properties
    if (!sessionID || (properties.sessionID && properties.sessionID !== sessionID)) return
    const error = toWireError(properties.error)
    broadcast(error === undefined ? { type: "session.error" } : { type: "session.error", error })
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
  return api.state.session.messages(sessionID).map((message) => {
    const info = toWireInfo(message)
    const parts = (api.state.part(message.id) ?? []).map(toWirePart)
    return info === undefined
      ? { id: message.id, role: message.role, parts }
      : { id: message.id, role: message.role, info, parts }
  })
}

function toWirePart(part: unknown): WirePart {
  if (!isRecord(part)) return { id: "unknown", messageID: "unknown", type: "unknown" }
  const id = typeof part.id === "string" ? part.id : "unknown"
  const messageID = typeof part.messageID === "string" ? part.messageID : "unknown"
  const type = typeof part.type === "string" ? part.type : "unknown"
  const wire: WirePart = { ...part, id, messageID, type }
  const text = typeof part.text === "string" ? part.text : undefined
  if (text !== undefined) {
    if (text.length > MAX_PART_TEXT) {
      wire.text = text.slice(0, MAX_PART_TEXT)
      wire.truncated = text.length - MAX_PART_TEXT
    }
  }
  // 工具输出可能上百 KB：截断后再发，并在渲染侧提示省略长度
  if (isRecord(part.state) && typeof part.state.output === "string" && part.state.output.length > MAX_TOOL_OUTPUT) {
    const output = part.state.output
    wire.state = { ...part.state, output: output.slice(0, MAX_TOOL_OUTPUT) }
    wire.truncated = (typeof wire.truncated === "number" ? wire.truncated : 0) + output.length - MAX_TOOL_OUTPUT
  }
  return wire
}

function toWireInfo(message: unknown): WireMessageInfo | undefined {
  if (!isRecord(message)) return undefined
  const info: WireMessageInfo = {}
  const agent = typeof message.agent === "string" && message.agent ? message.agent : undefined
  if (agent) info.agent = agent
  const model = isRecord(message.model)
    ? message.model
    : isRecord(message.modelID) || typeof message.modelID === "string"
      ? { providerID: message.providerID, modelID: message.modelID, variant: message.variant }
      : undefined
  if (model) {
    const providerID = typeof model.providerID === "string" ? model.providerID : ""
    const modelID = typeof model.modelID === "string" ? model.modelID : ""
    if (providerID && modelID) {
      const variant = typeof model.variant === "string" && model.variant ? model.variant : undefined
      info.model = variant === undefined ? { providerID, modelID } : { providerID, modelID, variant }
    }
  }
  const time = isRecord(message.time) ? message.time : undefined
  const created = time && typeof time.created === "number" ? time.created : undefined
  if (created !== undefined) info.created = created
  const completed = time && typeof time.completed === "number" ? time.completed : undefined
  if (completed !== undefined) info.completed = completed
  const cost = typeof message.cost === "number" ? message.cost : undefined
  if (cost !== undefined) info.cost = cost
  const tokens = isRecord(message.tokens) ? message.tokens : undefined
  if (tokens) {
    const cache = isRecord(tokens.cache) ? tokens.cache : {}
    info.tokens = {
      input: numberOr(tokens.input),
      output: numberOr(tokens.output),
      reasoning: numberOr(tokens.reasoning),
      cacheRead: numberOr(cache.read),
      cacheWrite: numberOr(cache.write),
    }
  }
  const finish = typeof message.finish === "string" && message.finish ? message.finish : undefined
  if (finish) info.finish = finish
  const error = toWireError(message.error)
  if (error) info.error = error
  return Object.keys(info).length === 0 ? undefined : info
}

function toWireError(raw: unknown): { name: string; message?: string } | undefined {
  if (!isRecord(raw)) return undefined
  const name = typeof raw.name === "string" && raw.name ? raw.name : "Error"
  const data = isRecord(raw.data) ? raw.data : undefined
  const text = typeof data?.message === "string" ? data.message : undefined
  return text === undefined ? { name } : { name, message: text.slice(0, 400) }
}

function toWirePermission(permission: unknown): WirePermission {
  const record = isRecord(permission) ? permission : {}
  const id = typeof record.id === "string" ? record.id : ""
  const tool = typeof record.permission === "string" ? record.permission : "unknown"
  const toolRef = isRecord(record.tool) ? record.tool : undefined
  const callID = typeof toolRef?.callID === "string" ? toolRef.callID : undefined
  const request: WirePermission = {
    id,
    tool,
    patterns: stringList(record.patterns),
    always: stringList(record.always),
    metadata: metadataRecord(record.metadata),
  }
  if (callID) request.callID = callID
  return request
}

function stringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string" && value.length > 0) : []
}

function metadataRecord(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") out[key] = value.slice(0, MAX_TOOL_OUTPUT)
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value
    else if (Array.isArray(value)) out[key] = stringList(value).slice(0, 200)
  }
  return out
}

function numberOr(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
