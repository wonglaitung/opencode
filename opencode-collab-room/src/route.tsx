import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import type { TuiPluginApi, TuiRouteDefinition, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { For, Show, createSignal, onMount } from "solid-js"
import type { GuestClient } from "./client"
import type { WireMessage, WirePart } from "./protocol"

export const ROUTE = "collab-room"

type Mode = "suggest" | "queue"

export function roomRoute(input: { api: TuiPluginApi; client: GuestClient; leave: () => void }): TuiRouteDefinition {
  return {
    name: ROUTE,
    render: () => <RoomView api={input.api} client={input.client} leave={input.leave} />,
  }
}

function RoomView(props: { api: TuiPluginApi; client: GuestClient; leave: () => void }) {
  const theme = () => props.api.theme.current
  const room = () => props.client.room()
  const [mode, setMode] = createSignal<Mode>("suggest")
  let input: TextareaRenderable | undefined

  const toggle = () => setMode(mode() === "queue" ? "suggest" : "queue")

  const submit = () => {
    const text = input?.plainText.trim() ?? ""
    if (!text) return
    if (mode() === "queue") {
      const ok = props.client.send({ type: "queue", id: crypto.randomUUID(), text })
      if (ok) {
        setMode("suggest")
        props.api.ui.toast({ message: "已加入队列" })
      }
    } else {
      props.client.send({ type: "suggest", text })
    }
    input?.clear()
  }

  onMount(() => {
    setTimeout(() => input?.focus(), 0)
  })

  return (
    <box flexDirection="row" width="100%" height="100%">
      <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2} gap={1}>
        <box flexDirection="row" gap={2}>
          <text fg={theme().text}>
            <b>{room().title ?? (room().room || "协作房间")}</b>
          </text>
          <text fg={statusColor(theme(), room().connection, room().info.status)}>{statusLabel(room())}</text>
        </box>

        <scrollbox flexGrow={1} minHeight={0} stickyScroll stickyStart="bottom">
          <Show when={room().messages.length === 0}>
            <text fg={theme().textMuted}>等待房间内容…</text>
          </Show>
          <For each={room().messages}>{(message) => <MessageRow theme={theme} message={message} />}</For>
        </scrollbox>

        <box flexDirection="column" flexShrink={0}>
          <box flexDirection="row" gap={1} alignItems="center">
            <text fg={mode() === "queue" ? theme().warning : theme().success}>
              <b>{mode() === "queue" ? "[排队]" : "[建议]"}</b>
            </text>
            <textarea
              width="100%"
              flexGrow={1}
              minHeight={1}
              maxHeight={4}
              placeholder={mode() === "queue" ? "输入要让主机执行的任务…" : "输入建议…"}
              placeholderColor={theme().textMuted}
              textColor={theme().text}
              focusedTextColor={theme().text}
              focusedBackgroundColor={theme().backgroundElement}
              cursorColor={theme().text}
              onSubmit={submit}
              onKeyDown={(key) => {
                if (key.name === "escape") {
                  key.preventDefault()
                  props.leave()
                  return
                }
                if ((key.name === "m" && (key.option || key.meta)) || key.name === "f3") {
                  key.preventDefault()
                  toggle()
                }
              }}
              ref={(renderable: TextareaRenderable) => {
                input = renderable
              }}
            />
          </box>
          <text fg={theme().textMuted}>
            Enter 发送 · Alt+M / F3 切换{mode() === "queue" ? "建议" : "排队"} · Esc 退出
          </text>
        </box>
      </box>

      <box
        width={42}
        flexShrink={0}
        flexDirection="column"
        gap={1}
        paddingTop={1}
        paddingLeft={2}
        paddingRight={2}
        backgroundColor={theme().backgroundPanel}
      >
        <text fg={theme().text}>
          <b>房间状态</b>
        </text>
        <text fg={statusColor(theme(), room().connection, room().info.status)}>{statusLabel(room())}</text>
        <text fg={theme().textMuted}>成员 {room().info.peers}</text>
        <Show when={room().approval}>
          <text fg={theme().warning}>⏳ 等待主机审批{room().approval?.tool ? `（${room().approval?.tool}）` : ""}</text>
        </Show>
        <Show when={room().notice}>
          <text fg={theme().error}>{room().notice}</text>
        </Show>
        <text fg={theme().textMuted}>队列 {room().info.queue.length}</text>
        <For each={room().info.queue}>
          {(item, index) => (
            <text fg={theme().textMuted}>
              {index() + 1}. {item.by}：{truncate(item.text, 30)}
            </text>
          )}
        </For>
      </box>
    </box>
  )
}

function MessageRow(props: { theme: () => TuiThemeCurrent; message: WireMessage }) {
  const label = () => (props.message.role === "user" ? "用户" : "AI")
  return (
    <box flexDirection="column" paddingBottom={1}>
      <text fg={props.theme().textMuted}>{label()}</text>
      <For each={props.message.parts}>{(part) => <PartRow theme={props.theme} part={part} />}</For>
    </box>
  )
}

function PartRow(props: { theme: () => TuiThemeCurrent; part: WirePart }) {
  if (props.part.type === "text" && typeof props.part.text === "string") {
    return (
      <text fg={props.theme().text} wrapMode="word">
        {props.part.text}
      </text>
    )
  }
  const tool = typeof props.part.tool === "string" ? ` ${props.part.tool}` : ""
  return (
    <text fg={props.theme().textMuted}>
      [{props.part.type}
      {tool}]
    </text>
  )
}

function statusLabel(room: { connection: string; info: { status: string } }) {
  if (room.connection === "connecting") return "● 连接中…"
  if (room.connection === "closed") return "● 房间已结束"
  if (room.info.status === "busy") return "● 执行中"
  if (room.info.status === "waiting_approval") return "● 等待审批"
  return "● 空闲"
}

function statusColor(theme: TuiThemeCurrent, connection: string, status: string) {
  if (connection === "closed") return theme.error
  if (connection === "connecting") return theme.textMuted
  if (status === "waiting_approval") return theme.warning
  if (status === "busy") return theme.info
  return theme.success
}

function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}
