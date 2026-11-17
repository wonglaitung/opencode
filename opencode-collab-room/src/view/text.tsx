import type { SyntaxStyle } from "@opentui/core"
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { Show } from "solid-js"

/**
 * 助手正文：用宿主内置 markdown 渲染块（与正常会话页同一 renderable）。
 * 访客拿到的是已完成的稳定文本，streaming 只在最后一条消息上用。
 */
export function TextBlock(props: {
  theme: () => TuiThemeCurrent
  syntax: () => SyntaxStyle
  text: string
  streaming?: boolean
}) {
  const content = () => props.text.trim()
  return (
    <Show when={content()}>
      <box paddingLeft={3} marginTop={1} flexShrink={0}>
        <markdown
          syntaxStyle={props.syntax()}
          streaming={props.streaming ?? false}
          internalBlockMode="top-level"
          content={content()}
          tableOptions={{ style: "grid" }}
          fg={props.theme().markdownText}
          bg={props.theme().background}
        />
      </box>
    </Show>
  )
}
