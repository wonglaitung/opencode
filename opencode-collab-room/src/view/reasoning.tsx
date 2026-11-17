import { RGBA } from "@opentui/core"
import type { SyntaxStyle } from "@opentui/core"
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { Match, Show, Switch, createMemo, createSignal } from "solid-js"
import type { WirePart } from "../protocol"
import { Spinner } from "./spinner"
import { formatDuration, recordValue, stringValue } from "./util"

/** 与 packages/tui 的 reasoningSummary 一致：首行加粗标题抽出来当摘要。 */
function reasoningSummary(text: string) {
  const content = text.trim()
  const match = content.match(/^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)/)
  if (!match) return { title: null as string | null, body: content }
  return { title: match[1]!.trim(), body: content.slice(match[0].length).trimEnd() }
}

export function ReasoningView(props: {
  part: WirePart
  theme: () => TuiThemeCurrent
  syntax: () => SyntaxStyle
  hideMode: boolean
}) {
  const [expanded, setExpanded] = createSignal(false)
  const content = createMemo(() => (stringValue(props.part.text) ?? "").replace("[REDACTED]", "").trim())
  const opaque = createMemo(() => !content() && Boolean(props.part.metadata))
  const time = createMemo(() => recordValue(props.part.time))
  const isDone = createMemo(() => time().end !== undefined)
  const duration = createMemo(() => {
    const end = time().end
    const start = time().start
    if (typeof end !== "number" || typeof start !== "number") return undefined
    return Math.max(0, end - start)
  })
  const summary = createMemo(() => reasoningSummary(content()))
  const open = createMemo(() => !props.hideMode || expanded())
  const fg = createMemo(() =>
    open()
      ? RGBA.fromValues(
          props.theme().warning.r,
          props.theme().warning.g,
          props.theme().warning.b,
          props.theme().thinkingOpacity,
        )
      : props.theme().warning,
  )

  return (
    <Show when={content() || opaque()}>
      <box paddingLeft={3} marginTop={1} flexDirection="column" flexShrink={0}>
        <box onMouseUp={() => props.hideMode && !opaque() && setExpanded((value) => !value)}>
          <Switch>
            <Match when={!isDone()}>
              <Spinner theme={props.theme} color={fg()}>
                {summary().title ? `Thinking: ${summary().title}` : "Thinking"}
              </Spinner>
            </Match>
            <Match when={true}>
              <text fg={fg()} wrapMode="none">
                {reasoningHeader(opaque(), open(), props.hideMode, summary().title, duration())}
              </text>
            </Match>
          </Switch>
        </box>
        <Show when={!opaque() && open() && summary().body}>
          <box paddingLeft={props.hideMode ? 2 : 0} marginTop={1}>
            <code
              filetype="markdown"
              drawUnstyledText={false}
              streaming={true}
              syntaxStyle={props.syntax()}
              content={summary().body}
              fg={props.theme().textMuted}
            />
          </box>
        </Show>
      </box>
    </Show>
  )
}

function reasoningHeader(
  encrypted: boolean,
  open: boolean,
  toggleable: boolean,
  title: string | null,
  duration: number | undefined,
) {
  const time = duration === undefined ? undefined : formatDuration(duration)
  if (encrypted) return `Thought${time ? ` · ${time}` : ""}`
  const detail = [title, time].filter(Boolean).join(" · ")
  const marker = toggleable ? (open ? "- " : "+ ") : ""
  return `${marker}Thought${detail ? `: ${detail}` : ""}`
}
