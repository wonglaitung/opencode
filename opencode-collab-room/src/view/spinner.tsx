import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup } from "solid-js"

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/** 与正常会话页一致的运行中转圈；节奏相同（80ms）。 */
export function Spinner(props: { theme: () => TuiThemeCurrent; children: string; color?: unknown }) {
  const [frame, setFrame] = createSignal(0)
  const timer = setInterval(() => setFrame((value) => (value + 1) % FRAMES.length), 80)
  onCleanup(() => clearInterval(timer))
  return (
    <text fg={(props.color as never) ?? props.theme().text}>
      {FRAMES[frame()]} {props.children}
    </text>
  )
}
