import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import type { TuiPluginApi, TuiRouteDefinition, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { logGuest, type GuestClient } from "./client"
import type { ClientMessage, WirePermission, WireQuestion } from "./protocol"
import { MessageView } from "./view/message"
import { PermissionCard, QuestionCard } from "./view/request"
import { useSyntaxStyle } from "./view/syntax"
import { formatCost, formatTokens } from "./view/util"

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

export function roomRoute(input: { api: TuiPluginApi; client: GuestClient; leave: () => void }): TuiRouteDefinition {
  return {
    name: ROUTE,
    render: () => <RoomView api={input.api} client={input.client} leave={input.leave} />,
  }
}

function RoomView(props: { api: TuiPluginApi; client: GuestClient; leave: () => void }) {
  const theme = () => props.api.theme.current
  const syntax = useSyntaxStyle(theme)
  const room = () => props.client.room()
  const [mode, setMode] = createSignal<Mode>("suggest")
  let input: TextareaRenderable | undefined
  let scroll: ScrollBoxRenderable | undefined

  // 访客自己的显示偏好（与正常会话页共用同一批 KV 键），非响应式但随数据刷新重算。
  const timestamps = () => props.api.kv.get<string>("timestamps", "hide") === "show"
  const genericOutput = () => Boolean(props.api.kv.get("generic_tool_output_visibility", false))
  const scrollbar = () => Boolean(props.api.kv.get("scrollbar_visible", false))
  const thinkingMode = () => props.api.kv.get("thinking_mode", "hide")

  const toggle = () => {
    setMode(mode() === "queue" ? "suggest" : "queue")
    logGuest(`mode=${mode()}`)
  }

  // 键盘优先走宿主的 keymap（终端即便不认 Alt 组合也能生效），
  // textarea 的 onKeyDown 只作为兜底。
  onCleanup(
    props.api.keymap.registerLayer({
      commands: [
        {
          name: "collab.toggle-mode",
          title: "协作房间：切换建议/排队",
          category: "Collaboration",
          run: () => toggle(),
        },
        {
          name: "collab.page.up",
          title: "协作房间：向上翻页",
          category: "Collaboration",
          run: () => {
            if (scroll) scroll.scrollBy(-scroll.height / 2)
          },
        },
        {
          name: "collab.page.down",
          title: "协作房间：向下翻页",
          category: "Collaboration",
          run: () => {
            if (scroll) scroll.scrollBy(scroll.height / 2)
          },
        },
      ],
      bindings: [
        { key: "alt+m", cmd: "collab.toggle-mode", desc: "切换建议/排队" },
        { key: "f3", cmd: "collab.toggle-mode", desc: "切换建议/排队" },
        // 与正常会话页的默认键位一致；Home/End 留给输入框移动光标
        { key: "pageup,ctrl+alt+b", cmd: "collab.page.up", desc: "向上翻页" },
        { key: "pagedown,ctrl+alt+f", cmd: "collab.page.down", desc: "向下翻页" },
      ],
    }),
  )

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

  const lastAssistant = createMemo(() => {
    const messages = room().messages
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]!
      if (message.role === "assistant") return message
    }
  })

  const usage = createMemo(() => {
    let tokens = 0
    let cost = 0
    for (const message of room().messages) {
      const info = message.info
      if (!info) continue
      if (info.tokens) {
        tokens +=
          info.tokens.input +
          info.tokens.output +
          info.tokens.reasoning +
          info.tokens.cacheRead +
          info.tokens.cacheWrite
      }
      if (info.cost) cost += info.cost
    }
    const parts = [tokens > 0 ? `${formatTokens(tokens)} tokens` : undefined, formatCost(cost)]
    return parts.filter(Boolean).join(" · ")
  })

  const hostLine = createMemo(() => {
    const info = lastAssistant()?.info
    const model = info?.model
    const parts = [info?.agent, model ? (model.variant ? `${model.modelID} · ${model.variant}` : model.modelID) : undefined]
    return parts.filter(Boolean).join(" · ")
  })

  return (
    <box flexDirection="row" flexGrow={1} minHeight={0}>
      <box flexGrow={1} minHeight={0} paddingBottom={1} paddingLeft={2} paddingRight={2}>
        <scrollbox
          ref={(renderable: ScrollBoxRenderable) => (scroll = renderable)}
          viewportOptions={{ paddingRight: scrollbar() ? 1 : 0 }}
          verticalScrollbarOptions={{
            paddingLeft: 1,
            visible: scrollbar(),
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
          <For each={room().messages}>
            {(message, index) => (
              <MessageView
                message={message}
                first={index() === 0}
                theme={theme}
                syntax={syntax}
                timestamps={timestamps()}
                genericOutput={genericOutput()}
                streaming={message.id === lastAssistant()?.id}
                hideThinking={thinkingMode() !== "show"}
              />
            )}
          </For>
        </scrollbox>

        <box flexShrink={0}>
          <Show when={room().info.queue.length > 0}>
            <box paddingLeft={3} marginBottom={1} flexDirection="column">
              <For each={room().info.queue}>
                {(item, index) => (
                  <text fg={theme().textMuted}>
                    {index() + 1}. {item.by}：{truncate(item.text, 60)}
                  </text>
                )}
              </For>
            </box>
          </Show>
          <Show when={room().approval}>
            {(request: () => WirePermission) => <PermissionCard request={request()} theme={theme} syntax={syntax} />}
          </Show>
          <Show when={!room().approval && room().question}>
            {(request: () => WireQuestion) => <QuestionCard request={request()} theme={theme} />}
          </Show>
          <Show when={room().sessionError}>
            {(error: () => { name: string; message?: string }) => (
              <box paddingLeft={3} marginTop={1}>
                <text fg={theme().error}>
                  {error().name}
                  {error().message ? `: ${error().message}` : ""}
                </text>
              </box>
            )}
          </Show>
          <Show when={room().notice}>
            <box paddingLeft={3} marginTop={1}>
              <text fg={theme().error}>{room().notice}</text>
            </box>
          </Show>
          <Show when={room().error}>
            <box paddingLeft={3} marginTop={1}>
              <text fg={theme().error}>{room().error}</text>
            </box>
          </Show>

          <box width="100%" marginTop={1}>
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
                    if (key.meta || key.option || /^f\d+$/.test(key.name)) {
                      logGuest(`key ${key.name} meta=${key.meta} option=${key.option}`)
                    }
                    if (key.name === "escape") {
                      key.preventDefault()
                      props.leave()
                      return
                    }
                    if ((key.name === "m" && (key.option || key.meta)) || key.name === "f3") {
                      key.preventDefault()
                      toggle()
                      return
                    }
                    // 兜底：textarea 可能自己吃掉 PageUp/PageDown，按半页滚动与正常会话页一致
                    if (key.name === "pageup" || key.name === "pagedown") {
                      key.preventDefault()
                      if (scroll) scroll.scrollBy((key.name === "pageup" ? -1 : 1) * (scroll.height / 2))
                    }
                  }}
                  ref={(renderable: TextareaRenderable) => {
                    input = renderable
                  }}
                />
                <box flexDirection="row" flexShrink={0} paddingTop={1} gap={2} justifyContent="space-between">
                  <box flexDirection="row" gap={1}>
                    <box onMouseUp={() => toggle()}>
                      <text fg={mode() === "queue" ? theme().warning : theme().success}>
                        <b>{mode() === "queue" ? "排队" : "建议"}</b>
                      </text>
                    </box>
                    <Show when={hostLine()}>
                      <text fg={theme().textMuted}>· {hostLine()}</text>
                    </Show>
                  </box>
                  <box flexDirection="row" gap={2}>
                    <Show when={room().info.queue.length > 0}>
                      <text fg={theme().textMuted}>队列 {room().info.queue.length}</text>
                    </Show>
                    <Show when={usage()}>
                      <text fg={theme().textMuted}>{usage()}</text>
                    </Show>
                  </box>
                </box>
              </box>
            </box>
          </box>

          <box flexDirection="row" paddingLeft={3} paddingTop={1} justifyContent="space-between" gap={2}>
            <text fg={theme().textMuted}>房间：{room().title ?? (room().room || "协作房间")}</text>
            <text fg={statusColor(theme(), room().connection, room().info.status)}>
              {statusLabel(room())} · 成员 {room().info.peers} · PgUp/PgDn 翻页 · Alt+M / F3 排队 · Esc 退出
            </text>
          </box>
        </box>
      </box>
    </box>
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
