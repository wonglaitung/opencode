import type { TextareaRenderable } from "@opentui/core"
import type { TuiPluginApi, TuiRouteDefinition, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { For, Show, createSignal, onMount } from "solid-js"
import type { GuestClient } from "./client"
import type { WireMessage, WirePart } from "./protocol"

export const ROUTE = "collab-room"

type Mode = "suggest" | "queue"

// 与 packages/tui/src/ui/border.ts 的 SplitBorder/EmptyBorder 保持一致，
// 让访客页的输入框和正常会话页的 Prompt 外观相同。
const BORDER_CHARS = {
  topLeft: "",
  bottomLeft: "",
  vertical: "┃",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
}
const PROMPT_CHARS = { ...BORDER_CHARS, bottomLeft: "╹" }
const TAIL_CHARS = { ...BORDER_CHARS, vertical: " " }

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
    <box flexDirection="row" flexGrow={1} minHeight={0}>
      <box flexGrow={1} minHeight={0} paddingBottom={1} paddingLeft={2} paddingRight={2}>
        <scrollbox
          viewportOptions={{ paddingRight: 1 }}
          verticalScrollbarOptions={{
            paddingLeft: 1,
            visible: true,
            trackOptions: {
              backgroundColor: theme().backgroundElement,
              foregroundColor: theme().border,
            },
          }}
          stickyScroll={true}
          stickyStart="bottom"
          flexGrow={1}
          minHeight={0}
        >
          <box height={1} />
          <Show when={room().messages.length === 0}>
            <box paddingLeft={3}>
              <text fg={theme().textMuted}>{emptyText(room().connection)}</text>
            </box>
          </Show>
          <For each={room().messages}>{(message) => <RoomMessage theme={theme} message={message} />}</For>
        </scrollbox>

        <box flexShrink={0}>
          <Show when={room().info.queue.length > 0}>
            <box paddingLeft={3} marginBottom={1}>
              <For each={room().info.queue}>
                {(item, index) => (
                  <text fg={theme().textMuted}>
                    {index() + 1}. {item.by}：{truncate(item.text, 48)}
                  </text>
                )}
              </For>
            </box>
          </Show>
          <Show when={room().approval}>
            <box paddingLeft={3} marginBottom={1}>
              <text fg={theme().warning}>
                ⏳ 等待主机审批{room().approval?.tool ? `（${room().approval?.tool}）` : ""}
              </text>
            </box>
          </Show>
          <Show when={room().notice}>
            <box paddingLeft={3} marginBottom={1}>
              <text fg={theme().error}>{room().notice}</text>
            </box>
          </Show>
          <Show when={room().error}>
            <box paddingLeft={3} marginBottom={1}>
              <text fg={theme().error}>{room().error}</text>
            </box>
          </Show>

          <box width="100%">
            <box width="100%" border={["left"]} borderColor={theme().border} customBorderChars={PROMPT_CHARS}>
              <box
                paddingLeft={2}
                paddingRight={2}
                paddingTop={1}
                width="100%"
                flexGrow={1}
                backgroundColor={theme().backgroundElement}
              >
                <textarea
                  width="100%"
                  minHeight={1}
                  maxHeight={4}
                  placeholder={mode() === "queue" ? "输入要让主机执行的任务…" : "输入建议…"}
                  placeholderColor={theme().textMuted}
                  textColor={theme().text}
                  focusedTextColor={theme().text}
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
                <box flexDirection="row" flexShrink={0} paddingTop={1} gap={1} justifyContent="space-between">
                  <text fg={mode() === "queue" ? theme().warning : theme().success}>
                    <b>{mode() === "queue" ? "排队" : "建议"}</b>
                  </text>
                  <Show when={room().info.queue.length > 0}>
                    <text fg={theme().textMuted}>队列 {room().info.queue.length}</text>
                  </Show>
                </box>
              </box>
            </box>
            <box height={1} border={["left"]} borderColor={theme().border} customBorderChars={TAIL_CHARS}>
              <box height={1} border={["bottom"]} borderColor={theme().border} />
            </box>
          </box>

          <box flexDirection="row" paddingLeft={3} paddingTop={1} justifyContent="space-between" gap={2}>
            <text fg={theme().textMuted}>房间：{room().title ?? (room().room || "协作房间")}</text>
            <text fg={statusColor(theme(), room().connection, room().info.status)}>
              {statusLabel(room())} · 成员 {room().info.peers} · Alt+M / F3 排队 · Esc 退出
            </text>
          </box>
        </box>
      </box>
    </box>
  )
}

function RoomMessage(props: { theme: () => TuiThemeCurrent; message: WireMessage }) {
  const text = () =>
    props.message.parts
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n\n")
      .trim()

  return (
    <>
      <Show when={props.message.role === "user"}>
        <Show when={text()}>
          <box
            border={["left"]}
            borderColor={props.theme().secondary}
            customBorderChars={BORDER_CHARS}
            marginTop={1}
          >
            <box
              paddingTop={1}
              paddingBottom={1}
              paddingLeft={2}
              backgroundColor={props.theme().backgroundPanel}
              flexShrink={0}
            >
              <text fg={props.theme().text}>{text()}</text>
            </box>
          </box>
        </Show>
      </Show>
      <Show when={props.message.role !== "user"}>
        <box paddingLeft={3} marginTop={1} flexShrink={0}>
          <For each={props.message.parts}>{(part) => <PartRow theme={props.theme} part={part} />}</For>
        </box>
      </Show>
    </>
  )
}

function PartRow(props: { theme: () => TuiThemeCurrent; part: WirePart }) {
  if (props.part.type === "text") {
    const value = typeof props.part.text === "string" ? props.part.text.trim() : ""
    if (!value) return null
    return (
      <text fg={props.theme().text} wrapMode="word">
        {value}
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

function emptyText(connection: string) {
  if (connection === "connecting") return "正在连接房间…"
  if (connection === "closed") return "房间已结束"
  return "房间里还没有内容。"
}

function statusLabel(room: { connection: string; info: { status: string } }) {
  if (room.connection === "connecting") return "连接中…"
  if (room.connection === "closed") return "房间已结束"
  if (room.info.status === "busy") return "执行中"
  if (room.info.status === "waiting_approval") return "等待审批"
  return "空闲"
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
