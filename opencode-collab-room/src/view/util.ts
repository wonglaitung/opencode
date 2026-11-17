/** 展示层通用工具：与 packages/tui 的同名行为保持一致，避免访客页出现两种口径。 */

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** 工具参数摘要，口径与正常页的 `input()` 接近：只显示短标量，长内容省略。 */
export function inputSummary(input: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === "") continue
    if (typeof value === "string") {
      const text = value.replace(/\s+/g, " ").trim()
      if (!text) continue
      parts.push(text.length <= 60 ? text : `${text.slice(0, 59)}…`)
      continue
    }
    if (typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}=${value}`)
    }
  }
  return parts.join(" ")
}

export function collapseOutput(output: string, maxLines: number, maxChars: number) {
  const lines = output.split("\n")
  if (lines.length <= maxLines && Array.from(output).length <= maxChars) {
    return { output, overflow: false }
  }
  const preview = lines.slice(0, maxLines).join("\n")
  if (Array.from(preview).length > maxChars) {
    return {
      output: Array.from(preview).slice(0, Math.max(0, maxChars - 1)).join("") + "…",
      overflow: true,
    }
  }
  return { output: [...lines.slice(0, maxLines), "…"].join("\n"), overflow: true }
}

export function formatDuration(input: number) {
  if (input < 1000) return `${Math.max(0, Math.round(input))}ms`
  if (input < 60_000) return `${(input / 1000).toFixed(1)}s`
  if (input < 3_600_000) {
    const minutes = Math.floor(input / 60_000)
    const seconds = Math.floor((input % 60_000) / 1000)
    return `${minutes}m ${seconds}s`
  }
  return `${Math.floor(input / 3_600_000)}h`
}

export function formatTokens(count: number) {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}K`
  return `${(count / 1_000_000).toFixed(2)}M`
}

export function formatCost(cost: number) {
  if (!Number.isFinite(cost) || cost <= 0) return undefined
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`
}

export function fileBase(path: string) {
  const text = path.replace(/[\\/]+$/, "")
  const index = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"))
  return index >= 0 ? text.slice(index + 1) : text
}

/** 从 diff 文本统计增删行数，用于工具行的标题。 */
export function diffStat(diff: string) {
  let additions = 0
  let deletions = 0
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue
    if (line.startsWith("+")) additions++
    else if (line.startsWith("-")) deletions++
  }
  return { additions, deletions }
}

export function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

export function timeOfDay(ms: number) {
  return new Date(ms).toLocaleTimeString(undefined, { timeStyle: "short" })
}
