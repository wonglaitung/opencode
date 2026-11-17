import type { SyntaxStyle } from "@opentui/core"
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { For, Match, Show, Switch, createMemo, createSignal } from "solid-js"
import type { WirePart } from "../protocol"
import { Spinner } from "./spinner"
import {
  collapseOutput,
  diffStat,
  fileBase,
  formatDuration,
  inputSummary,
  numberValue,
  recordValue,
  stringValue,
  truncate,
} from "./util"

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

const ICONS: Record<string, string> = {
  bash: "$",
  shell: "$",
  execute: "$",
  edit: "←",
  write: "←",
  apply_patch: "←",
  read: "→",
  webfetch: "→",
  websearch: "⌕",
  glob: "✱",
  grep: "✱",
  task: "#",
  todowrite: "☑",
  skill: "⚙",
  question: "?",
}

/**
 * 工具行：与正常会话页同一个信息密度。
 * 完成的工具默认折叠输出，点击整行展开/收起；失败时展开错误。
 */
export function ToolView(props: {
  part: WirePart
  theme: () => TuiThemeCurrent
  syntax: () => SyntaxStyle
  showGenericOutput: boolean
}) {
  const state = createMemo(() => recordValue(props.part.state))
  const status = createMemo(() => stringValue(state().status) ?? "pending")
  const tool = createMemo(() => stringValue(props.part.tool) ?? "tool")
  const input = createMemo(() => recordValue(state().input))
  const metadata = createMemo(() => recordValue(state().metadata))
  const output = createMemo(() => stringValue(state().output) ?? stringValue(metadata().output) ?? "")
  const error = createMemo(() => stringValue(state().error))
  const title = createMemo(() => stringValue(state().title))
  const time = createMemo(() => recordValue(state().time))
  const duration = createMemo(() => {
    const start = numberValue(time().start)
    const end = numberValue(time().end)
    if (start === undefined || end === undefined) return undefined
    return Math.max(0, end - start)
  })
  const truncated = createMemo(() => numberValue(props.part.truncated) ?? 0)
  const running = createMemo(() => status() === "running" || status() === "pending")
  const failed = createMemo(() => status() === "error")
  const skill = createMemo(() => display(tool()))
  const icon = createMemo(() => (failed() ? "✗" : (ICONS[tool()] ?? ICONS[skill()] ?? "⚙")))
  const color = createMemo(() =>
    failed() ? props.theme().error : running() ? props.theme().text : props.theme().textMuted,
  )
  const [expanded, setExpanded] = createSignal(false)

  const header = createMemo(() => {
    const label = tool()
    const detail = inputSummary(input())
    if (title()) return `${label}: ${title()}`
    return detail ? `${label} ${detail}` : label
  })

  return (
    <Switch>
      <Match when={skill() === "bash" || skill() === "execute"}>
        <Shell
          part={props.part}
          theme={props.theme}
          icon={icon()}
          command={stringValue(input().command) ?? inputSummary(input())}
          workdir={stringValue(input().workdir)}
          output={output()}
          running={running()}
          failed={failed()}
          error={error()}
          duration={duration()}
          expanded={expanded()}
          toggle={() => setExpanded((value) => !value)}
          truncated={truncated()}
        />
      </Match>
      <Match when={skill() === "edit" || skill() === "apply_patch"}>
        <DiffTool
          part={props.part}
          theme={props.theme}
          syntax={props.syntax()}
          icon={icon()}
          title={header()}
          path={stringValue(input().filePath) ?? stringValue(input().path) ?? ""}
          diff={stringValue(metadata().diff) ?? stringValue(metadata().patch) ?? ""}
          files={metadata().files}
          running={running()}
          error={error()}
          duration={duration()}
        />
      </Match>
      <Match when={skill() === "write"}>
        <WriteTool
          part={props.part}
          theme={props.theme}
          syntax={props.syntax()}
          icon={icon()}
          path={stringValue(input().filePath) ?? ""}
          content={stringValue(input().content) ?? ""}
          error={error()}
        />
      </Match>
      <Match when={skill() === "todowrite"}>
        <TodoTool
          part={props.part}
          theme={props.theme}
          icon={icon()}
          todos={todos(metadata().todos ?? input().todos)}
        />
      </Match>
      <Match when={true}>
        <Generic
          part={props.part}
          theme={props.theme}
          icon={icon()}
          color={color()}
          header={header()}
          output={skill() === "generic" && !props.showGenericOutput ? "" : output()}
          running={running()}
          failed={failed()}
          error={error()}
          duration={duration()}
          expanded={expanded()}
          toggle={() => setExpanded((value) => !value)}
          truncated={truncated()}
        />
      </Match>
    </Switch>
  )
}

function display(tool: string) {
  if (tool === "bash" || tool === "shell" || tool === "execute") return "bash"
  return tool
}

function Generic(props: {
  part: WirePart
  theme: () => TuiThemeCurrent
  icon: string
  color: unknown
  header: string
  output: string
  running: boolean
  failed: boolean
  error?: string
  duration?: number
  expanded: boolean
  toggle: () => void
  truncated: number
}) {
  const output = () => props.output.trim()
  const collapsed = createMemo(() => collapseOutput(output(), 3, 240))
  const shown = () => (props.expanded || !collapsed().overflow ? output() : collapsed().output)

  return (
    <Show
      when={output() || props.failed}
      fallback={
        <InlineRow part={props.part} theme={props.theme} icon={props.icon} color={props.color}>
          {props.header}
          <Duration duration={props.duration} />
        </InlineRow>
      }
    >
      <Block
        part={props.part}
        theme={props.theme}
        icon={props.icon}
        title={props.header}
        onClick={collapsed().overflow ? props.toggle : undefined}
        running={props.running}
      >
        <Show when={shown()}>
          <text fg={props.theme().text} wrapMode="word">
            {shown()}
          </text>
        </Show>
        <Show when={collapsed().overflow}>
          <text fg={props.theme().textMuted}>{props.expanded ? "点击收起" : "点击展开"}</text>
        </Show>
        <Show when={props.truncated > 0}>
          <text fg={props.theme().textMuted}>输出过长，已省略 {props.truncated} 字符</text>
        </Show>
        <Show when={props.failed && props.error}>
          <text fg={props.theme().error}>{props.error}</text>
        </Show>
      </Block>
    </Show>
  )
}

function Shell(props: {
  part: WirePart
  theme: () => TuiThemeCurrent
  icon: string
  command: string
  workdir?: string
  output: string
  running: boolean
  failed: boolean
  error?: string
  duration?: number
  expanded: boolean
  toggle: () => void
  truncated: number
}) {
  const text = () => props.output.trim()
  const collapsed = createMemo(() => collapseOutput(text(), 10, 800))
  const shown = () => (props.expanded || !collapsed().overflow ? text() : collapsed().output)

  return (
    <Show
      when={text() || props.running || props.failed}
      fallback={
        <InlineRow part={props.part} theme={props.theme} icon={props.icon} color={props.theme().textMuted}>
          {props.command}
          <Duration duration={props.duration} />
        </InlineRow>
      }
    >
      <Block
        part={props.part}
        theme={props.theme}
        icon={props.icon}
        title={props.workdir && props.workdir !== "." ? `# 在 ${props.workdir} 运行` : undefined}
        onClick={collapsed().overflow ? props.toggle : undefined}
        running={props.running}
      >
        <Show
          when={props.running}
          fallback={
            <text fg={props.theme().text}>
              $ {props.command}
              <Duration duration={props.duration} />
            </text>
          }
        >
          <Spinner theme={props.theme}>{props.command}</Spinner>
        </Show>
        <Show when={shown()}>
          <text fg={props.theme().text} wrapMode="word">
            {shown()}
          </text>
        </Show>
        <Show when={collapsed().overflow}>
          <text fg={props.theme().textMuted}>{props.expanded ? "点击收起" : "点击展开"}</text>
        </Show>
        <Show when={props.truncated > 0}>
          <text fg={props.theme().textMuted}>输出过长，已省略 {props.truncated} 字符</text>
        </Show>
        <Show when={props.failed && props.error}>
          <text fg={props.theme().error}>{props.error}</text>
        </Show>
      </Block>
    </Show>
  )
}

function DiffTool(props: {
  part: WirePart
  theme: () => TuiThemeCurrent
  syntax: SyntaxStyle
  icon: string
  title: string
  path: string
  diff: string
  files: unknown
  running: boolean
  error?: string
  duration?: number
}) {
  const stat = createMemo(() => diffStat(props.diff))
  const fileList = createMemo(() => {
    if (!Array.isArray(props.files)) return []
    return props.files
      .map((entry) => recordValue(entry))
      .map((entry) => stringValue(entry.relativePath) ?? stringValue(entry.filePath) ?? "")
      .filter((entry) => entry.length > 0)
  })
  return (
    <Show
      when={props.diff}
      fallback={
        <InlineRow part={props.part} theme={props.theme} icon={props.icon} color={props.theme().textMuted}>
          {props.title}
          <Show when={fileList().length > 0}> {fileList().map(fileBase).join(", ")}</Show>
          <Show when={stat().additions > 0}>
            <span style={{ fg: props.theme().diffAdded }}> +{stat().additions}</span>
          </Show>
          <Show when={stat().deletions > 0}>
            <span style={{ fg: props.theme().diffRemoved }}> -{stat().deletions}</span>
          </Show>
          <Show when={props.error}>
            <span style={{ fg: props.theme().error }}> {props.error}</span>
          </Show>
          <Duration duration={props.duration} />
        </InlineRow>
      }
    >
      <Block
        part={props.part}
        theme={props.theme}
        icon={props.icon}
        title={`${props.path ? `← ${props.path}` : props.title}`}
        running={props.running}
      >
        <box paddingLeft={1}>
          <diff
            diff={props.diff}
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
            syntaxStyle={props.syntax}
          />
        </box>
        <Show when={props.error}>
          <text fg={props.theme().error}>{props.error}</text>
        </Show>
      </Block>
    </Show>
  )
}

function WriteTool(props: {
  part: WirePart
  theme: () => TuiThemeCurrent
  syntax: SyntaxStyle
  icon: string
  path: string
  content: string
  error?: string
}) {
  return (
    <Show
      when={props.content}
      fallback={
        <InlineRow part={props.part} theme={props.theme} icon={props.icon} color={props.theme().textMuted}>
          写入 {props.path}
        </InlineRow>
      }
    >
      <Block part={props.part} theme={props.theme} icon={props.icon} title={`# 写入 ${props.path}`}>
        <box paddingLeft={1}>
          <code
            conceal={false}
            fg={props.theme().text}
            filetype={filetype(props.path)}
            syntaxStyle={props.syntax}
            content={props.content}
          />
        </box>
        <Show when={props.error}>
          <text fg={props.theme().error}>{props.error}</text>
        </Show>
      </Block>
    </Show>
  )
}

function TodoTool(props: { part: WirePart; theme: () => TuiThemeCurrent; icon: string; todos: Todo[] }) {
  return (
    <Show
      when={props.todos.length > 0}
      fallback={<InlineRow part={props.part} theme={props.theme} icon={props.icon} color={props.theme().textMuted}>更新待办</InlineRow>}
    >
      <box paddingLeft={3} marginTop={1} flexDirection="column" flexShrink={0}>
        <For each={props.todos}>
          {(todo) => (
            <text fg={todo.status === "completed" ? props.theme().textMuted : props.theme().text}>
              {todo.status === "completed" ? "☑" : todo.status === "in_progress" ? "◐" : "☐"} {truncate(todo.content, 80)}
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

type Todo = { content: string; status: string }

function todos(raw: unknown): Todo[] {
  if (!Array.isArray(raw)) return []
  const out: Todo[] = []
  for (const item of raw) {
    const record = recordValue(item)
    const content = stringValue(record.content)
    if (!content) continue
    out.push({ content, status: stringValue(record.status) ?? "pending" })
  }
  return out
}

function InlineRow(props: {
  part: WirePart
  theme: () => TuiThemeCurrent
  icon: string
  color: unknown
  children: unknown
}) {
  return (
    <box paddingLeft={3} marginTop={1}>
      <text fg={props.color as never} wrapMode="word">
        {props.icon} {props.children as never}
      </text>
    </box>
  )
}

function Block(props: {
  part: WirePart
  theme: () => TuiThemeCurrent
  icon: string
  title?: string
  children: unknown
  onClick?: () => void
  running?: boolean
}) {
  const [hover, setHover] = createSignal(false)
  const interactive = () => Boolean(props.onClick)
  return (
    <box
      border={["left"]}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      marginTop={1}
      gap={1}
      backgroundColor={hover() ? props.theme().backgroundMenu : props.theme().backgroundPanel}
      customBorderChars={BORDER_CHARS}
      borderColor={props.theme().background}
      onMouseOver={() => interactive() && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => props.onClick?.()}
    >
      <Show when={props.title}>
        <Show
          when={props.running}
          fallback={
            <text paddingLeft={3} fg={props.theme().textMuted}>
              {props.title}
            </text>
          }
        >
          <box paddingLeft={3}>
            <Spinner theme={props.theme} color={props.theme().textMuted}>
              {(props.title ?? "").replace(/^# /, "")}
            </Spinner>
          </box>
        </Show>
      </Show>
      {props.children as never}
    </box>
  )
}

function Duration(props: { duration?: number }) {
  return (
    <Show when={props.duration !== undefined}>
      <span style={{ fg: "gray" }}> · {formatDuration(props.duration!)}</span>
    </Show>
  )
}

function filetype(path: string) {
  const base = fileBase(path)
  const index = base.lastIndexOf(".")
  return index > 0 ? base.slice(index + 1) : "txt"
}
