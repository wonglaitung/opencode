import type { SyntaxStyle } from "@opentui/core"
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { For, Match, Show, Switch, createMemo } from "solid-js"
import type { WireMessage, WirePart } from "../protocol"
import { ReasoningView } from "./reasoning"
import { TextBlock } from "./text"
import { ToolView } from "./tool"
import { fileBase, recordValue, stringValue, timeOfDay } from "./util"

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

export function MessageView(props: {
  message: WireMessage
  first: boolean
  theme: () => TuiThemeCurrent
  syntax: () => SyntaxStyle
  timestamps: boolean
  genericOutput: boolean
  streaming: boolean
  hideThinking: boolean
}) {
  return (
    <Switch>
      <Match when={props.message.role === "user"}>
        <UserMessage
          message={props.message}
          first={props.first}
          theme={props.theme}
          timestamps={props.timestamps}
        />
      </Match>
      <Match when={true}>
        <AssistantMessage
          message={props.message}
          theme={props.theme}
          syntax={props.syntax}
          genericOutput={props.genericOutput}
          streaming={props.streaming}
          hideThinking={props.hideThinking}
        />
      </Match>
    </Switch>
  )
}

function UserMessage(props: {
  message: WireMessage
  first: boolean
  theme: () => TuiThemeCurrent
  timestamps: boolean
}) {
  const text = createMemo(() =>
    props.message.parts
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => (part.text as string).trim())
      .filter((value) => value.length > 0)
      .join("\n\n"),
  )
  const files = createMemo(() =>
    props.message.parts
      .filter((part) => part.type === "file")
      .map((part) => ({
        name: stringValue(part.filename) ?? stringValue(part.url) ?? "附件",
        mime: stringValue(part.mime),
      })),
  )
  const created = createMemo(() => {
    const info = props.message.info
    return info?.created
  })
  return (
    <Show when={text() || files().length > 0}>
      <box
        border={["left"]}
        borderColor={props.theme().secondary}
        customBorderChars={BORDER_CHARS}
        marginTop={props.first ? 0 : 1}
        flexShrink={0}
      >
        <box
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          backgroundColor={props.theme().backgroundPanel}
          flexShrink={0}
        >
          <Show when={text()}>
            <text fg={props.theme().text}>{text()}</text>
          </Show>
          <Show when={files().length > 0}>
            <box flexDirection="row" paddingTop={text() ? 1 : 0} gap={1} flexWrap="wrap">
              <For each={files()}>
                {(file) => (
                  <text fg={props.theme().text}>
                    <span style={{ bg: props.theme().secondary, fg: props.theme().background }}>
                      {file.mime === "application/x-directory" ? " Directory " : " File "}
                    </span>
                    <span style={{ bg: props.theme().backgroundElement, fg: props.theme().textMuted }}>
                      {" "}
                      {fileBase(file.name)}{" "}
                    </span>
                  </text>
                )}
              </For>
            </box>
          </Show>
          <Show when={props.timestamps && created() !== undefined}>
            <text fg={props.theme().textMuted}>{timeOfDay(created()!)}</text>
          </Show>
        </box>
      </box>
    </Show>
  )
}

function AssistantMessage(props: {
  message: WireMessage
  theme: () => TuiThemeCurrent
  syntax: () => SyntaxStyle
  genericOutput: boolean
  streaming: boolean
  hideThinking: boolean
}) {
  const error = createMemo(() => props.message.info?.error)
  return (
    <>
      <For each={props.message.parts}>
        {(part) => (
          <PartView
            part={part}
            theme={props.theme}
            syntax={props.syntax}
            genericOutput={props.genericOutput}
            streaming={props.streaming}
            hideThinking={props.hideThinking}
          />
        )}
      </For>
      <Show when={error()}>
        <box paddingLeft={3} marginTop={1}>
          <text fg={props.theme().error}>
            {error()!.name}
            {error()!.message ? `: ${error()!.message}` : ""}
          </text>
        </box>
      </Show>
    </>
  )
}

function PartView(props: {
  part: WirePart
  theme: () => TuiThemeCurrent
  syntax: () => SyntaxStyle
  genericOutput: boolean
  streaming: boolean
  hideThinking: boolean
}) {
  return (
    <Switch>
      <Match when={props.part.type === "text"}>
        <TextBlock theme={props.theme} syntax={props.syntax} text={stringValue(props.part.text) ?? ""} streaming={props.streaming} />
      </Match>
      <Match when={props.part.type === "reasoning"}>
        <ReasoningView
          part={props.part}
          theme={props.theme}
          syntax={props.syntax}
          hideMode={props.hideThinking}
        />
      </Match>
      <Match when={props.part.type === "tool"}>
        <ToolView
          part={props.part}
          theme={props.theme}
          syntax={props.syntax}
          showGenericOutput={props.genericOutput}
        />
      </Match>
      <Match when={props.part.type === "patch"}>
        <PatchView part={props.part} theme={props.theme} />
      </Match>
      <Match when={props.part.type === "compaction"}>
        <box marginTop={1} border={["top"]} title=" Compaction " titleAlignment="center" borderColor={props.theme().borderActive} />
      </Match>
    </Switch>
  )
}

function PatchView(props: { part: WirePart; theme: () => TuiThemeCurrent }) {
  const files = createMemo(() => {
    const raw = recordValue(props.part).files
    if (!Array.isArray(raw)) return []
    return raw.filter((value): value is string => typeof value === "string")
  })
  return (
    <Show when={files().length > 0}>
      <box paddingLeft={3} marginTop={1} flexDirection="column" flexShrink={0}>
        <text fg={props.theme().textMuted}>更新 {files().length} 个文件</text>
        <For each={files()}>
          {(file) => <text fg={props.theme().textMuted}>{file}</text>}
        </For>
      </box>
    </Show>
  )
}
