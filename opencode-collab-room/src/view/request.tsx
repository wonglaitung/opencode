import type { SyntaxStyle } from "@opentui/core"
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { For, Show, createMemo } from "solid-js"
import type { WirePermission, WireQuestion } from "../protocol"
import { recordValue, stringValue, truncate } from "./util"

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

/** 权限审批：内容与正常会话页一致，只是选项换成「等待主机」。 */
export function PermissionCard(props: {
  request: WirePermission
  theme: () => TuiThemeCurrent
  syntax: () => SyntaxStyle
}) {
  const metadata = createMemo(() => recordValue(props.request.metadata))
  const command = createMemo(() => stringValue(metadata().command) ?? stringValue(metadata().bash))
  const filepath = createMemo(() => stringValue(metadata().filepath) ?? stringValue(metadata().filePath))
  const diff = createMemo(() => stringValue(metadata().diff) ?? stringValue(metadata().patch))
  const url = createMemo(() => stringValue(metadata().url))
  const description = createMemo(() => stringValue(metadata().description) ?? stringValue(metadata().title))
  const patterns = createMemo(() => props.request.patterns.filter((value) => value.length > 0))

  return (
    <box
      border={["left"]}
      borderColor={props.theme().warning}
      customBorderChars={BORDER_CHARS}
      marginTop={1}
      flexShrink={0}
    >
      <box
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        gap={1}
        backgroundColor={props.theme().backgroundPanel}
        flexShrink={0}
      >
        <text fg={props.theme().warning}>
          ⏳ 等待主机审批 · {props.request.tool}
        </text>
        <Show when={description()}>
          <text fg={props.theme().textMuted}>{description()}</text>
        </Show>
        <Show when={command()}>
          <text fg={props.theme().text}>$ {command()}</text>
        </Show>
        <Show when={filepath()}>
          <text fg={props.theme().text}>文件：{filepath()}</text>
        </Show>
        <Show when={url()}>
          <text fg={props.theme().text}>地址：{url()}</text>
        </Show>
        <Show when={diff()}>
          <diff
            diff={diff()!}
            view="unified"
            showLineNumbers={true}
            width="100%"
            wrapMode="word"
            fg={props.theme().text}
            addedBg={props.theme().diffAddedBg}
            removedBg={props.theme().diffRemovedBg}
            contextBg={props.theme().diffContextBg}
            addedSignColor={props.theme().diffHighlightAdded}
            removedSignColor={props.theme().diffHighlightRemoved}
            lineNumberFg={props.theme().diffLineNumber}
            lineNumberBg={props.theme().diffContextBg}
            addedLineNumberBg={props.theme().diffAddedLineNumberBg}
            removedLineNumberBg={props.theme().diffRemovedLineNumberBg}
            syntaxStyle={props.syntax()}
          />
        </Show>
        <Show when={patterns().length > 0}>
          <text fg={props.theme().textMuted}>范围：{patterns().map((value) => truncate(value, 60)).join("、")}</text>
        </Show>
        <text fg={props.theme().textMuted}>审批权在主机；访客只读。</text>
      </box>
    </box>
  )
}

/** 提问：与正常页一样列问题与选项，访客只读。 */
export function QuestionCard(props: { request: WireQuestion; theme: () => TuiThemeCurrent }) {
  return (
    <box
      border={["left"]}
      borderColor={props.theme().info}
      customBorderChars={BORDER_CHARS}
      marginTop={1}
      flexShrink={0}
    >
      <box
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        gap={1}
        backgroundColor={props.theme().backgroundPanel}
        flexShrink={0}
      >
        <text fg={props.theme().info}>❓ 等待主机选择</text>
        <For each={props.request.questions}>
          {(item) => (
            <box flexDirection="column" gap={1}>
              <Show when={item.header}>
                <text fg={props.theme().textMuted}>{item.header}</text>
              </Show>
              <text fg={props.theme().text}>{item.question}</text>
              <For each={item.options}>
                {(option, index) => (
                  <text fg={props.theme().textMuted}>
                    {item.multiple ? "☐" : `${index() + 1}.`} {option.label}
                    {option.description ? ` — ${option.description}` : ""}
                  </text>
                )}
              </For>
            </box>
          )}
        </For>
        <text fg={props.theme().textMuted}>回答后主机继续；访客只读。</text>
      </box>
    </box>
  )
}
