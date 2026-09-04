/**
 * 纯函数层(设计文档 3.2、3.3)。
 * 覆盖:log4j 风格日志行解析(含多行堆栈聚合)、级别识别、时间戳提取、
 * 错误聚类、环形缓冲、文本截断,以及远端 shell 命令构造(纯字符串,便于单测)。
 * 无副作用、不触碰存储,全部可单测。
 */

// ===== 类型 =====

export type LogLevel = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL" | "UNKNOWN"

export interface LogEvent {
  /** 前导时间戳(若存在)。 */
  time?: string
  level: LogLevel
  /** 聚合后的完整消息(含续行堆栈),以换行连接。 */
  message: string
  /** 原始拼接文本。 */
  raw: string
  /** log4j 前缀中的 logger/组件名(若存在)。 */
  component?: string
}

export interface ErrorGroup {
  signature: string
  level: LogLevel
  count: number
  firstSeen?: string
  lastSeen?: string
  sample: string
  /** 代表事件的 logger/组件名(若存在)。 */
  component?: string
  /** 未折叠的原始首行,用于给出 get_log_context 的 match 建议。 */
  firstLine?: string
}

export interface RingBuffer<T> {
  push(item: T): void
  snapshot(): T[]
  clear(): void
}

// ===== 常量 =====

export const MAX_TEXT_CHARS = 20000
/** 单次搜索拉取的远端行数上限(设计文档 7)。 */
export const ERROR_SEARCH_WINDOW = 2000

const LEVEL_RE = /\b(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b/i
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/

// ===== 级别与时间戳 =====

export function detectLevel(line: string): LogLevel {
  const m = line.match(LEVEL_RE)
  if (!m) return "UNKNOWN"
  const v = m[1].toUpperCase()
  if (v === "WARNING") return "WARN"
  return v as LogLevel
}

export function extractTimestamp(line: string): string | undefined {
  const m = line.match(TIMESTAMP_RE)
  return m ? m[0] : undefined
}

/** 一行是否为新事件起点:前导时间戳,或行首(允许缩进)出现级别词。 */
function isEventStart(line: string): boolean {
  if (TIMESTAMP_RE.test(line)) return true
  return /^\s*(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b/.test(line)
}

// ===== 事件聚合(多行堆栈) =====

export function parseLogEvents(raw: string): LogEvent[] {
  const lines = raw.split(/\r?\n/)
  const events: LogEvent[] = []
  for (const line of lines) {
    if (line.trim() === "") continue
    if (isEventStart(line)) {
      const time = extractTimestamp(line)
      events.push({ time, level: detectLevel(line), message: line, raw: line, component: extractComponent(line) })
    } else if (events.length > 0) {
      const last = events[events.length - 1]
      last.message += "\n" + line
      last.raw += "\n" + line
    } else {
      // 文件起始即为续行(异常首行无时间戳):作为未知级别单事件兜底
      events.push({ level: "UNKNOWN", message: line, raw: line })
    }
  }
  return events
}

// ===== 错误聚类 =====

function describeSignature(message: string): string {
  const firstLine = message.split("\n")[0].trim()
  let s = firstLine.replace(TIMESTAMP_RE, "").trim()
  // 去掉常见 log4j 前缀:[thread] LEVEL logger - 
  s = s.replace(/^\[[^\]]*\]\s*(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)?\s*/i, "")
  s = s.replace(/^(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\s*-?\s*/i, "")
  // 折叠连续数字/十六进制,使同类异常(仅变量不同)归并
  s = s.replace(/\d+/g, "#").replace(/0x[0-9a-f]+/gi, "#").replace(/\s+/g, " ")
  return s.slice(0, 160)
}

function isErrorEvent(e: LogEvent): boolean {
  return e.level === "ERROR" || e.level === "FATAL" || /exception|caused by/i.test(e.message)
}

export function groupErrors(events: LogEvent[], topN = 20): ErrorGroup[] {
  const seen = new Map<string, ErrorGroup>()
  for (const e of events) {
    if (!isErrorEvent(e)) continue
    const signature = describeSignature(e.message)
    const existing = seen.get(signature)
    if (existing) {
      existing.count += 1
      existing.lastSeen = e.time ?? existing.lastSeen
    } else {
      seen.set(signature, {
        signature,
        level: e.level === "UNKNOWN" ? "ERROR" : e.level,
        count: 1,
        firstSeen: e.time,
        lastSeen: e.time,
        sample: truncateText(e.raw, 2000),
        component: e.component,
        firstLine: e.message.split("\n")[0],
      })
    }
  }
  return [...seen.values()].sort((a, b) => b.count - a.count).slice(0, topN)
}

export function filterEvents(events: LogEvent[], opts?: { level?: string; grep?: string }): LogEvent[] {
  let out = events
  if (opts?.level) {
    const lv = opts.level.toUpperCase()
    out = out.filter((e) => e.level === lv)
  }
  if (opts?.grep) {
    const needle = opts.grep
    out = out.filter((e) => e.message.includes(needle) || new RegExp(needle, "i").test(e.message))
  }
  return out
}

// ===== 分析增强(设计文档 3.3 / 阶段 2 B) =====

const COMPONENT_RE = /\b(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b\s+(\S+?)\s+-\s/

/** 从 log4j 风格首行提取 logger/组件名,如 "[main] ERROR com.Foo - msg" → "com.Foo"。 */
export function extractComponent(message: string): string | undefined {
  const m = message.match(COMPONENT_RE)
  return m ? m[2] : undefined
}

/** 时间戳字符串(逗号毫秒或 ISO)解析为 epoch 毫秒;无法解析返回 undefined。 */
export function parseTimestampToEpoch(s?: string): number | undefined {
  if (!s) return undefined
  const t = Date.parse(s.replace(",", "."))
  return Number.isNaN(t) ? undefined : t
}

function truncateTime(raw: string, unit: number): string {
  // 保留服务器本地时区:按原始时间字符串前缀截到分钟/小时
  const sliced = unit === 60_000 ? raw.slice(0, 16) : raw.slice(0, 13)
  return sliced.replace("T", " ")
}

export interface TimeBucket {
  bucket: string
  count: number
}

/** 按分钟/小时对带时间戳的事件分桶计数(本地时区),用于发现错误突增尖峰。 */
export function bucketByTime(events: LogEvent[]): TimeBucket[] {
  const withTime = events.filter((e) => Boolean(e.time))
  if (withTime.length === 0) return []
  const epochs = withTime.map((e) => parseTimestampToEpoch(e.time)).filter((t): t is number => t !== undefined)
  const span = epochs.length ? Math.max(...epochs) - Math.min(...epochs) : 0
  const unit = span > 2 * 3600_000 ? 3600_000 : 60_000
  const buckets = new Map<string, TimeBucket>()
  for (const e of withTime) {
    const label = truncateTime(e.time!, unit)
    const existing = buckets.get(label)
    if (existing) existing.count += 1
    else buckets.set(label, { bucket: label, count: 1 })
  }
  return [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v)
}

/** 根因排序:计数降序优先,其次末次出现越新越靠前。返回最可能根因或 null。 */
export function rankRootCause(groups: ErrorGroup[]): ErrorGroup | null {
  if (groups.length === 0) return null
  const ranked = [...groups].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count
    const ta = parseTimestampToEpoch(a.lastSeen) ?? 0
    const tb = parseTimestampToEpoch(b.lastSeen) ?? 0
    return tb - ta
  })
  return ranked[0]
}

// ===== 环形缓冲与截断 =====

export function createRingBuffer<T>(max: number): RingBuffer<T> {
  const items: T[] = []
  return {
    push(item: T) {
      items.push(item)
      if (items.length > max) items.shift()
    },
    snapshot() {
      return items.slice()
    },
    clear() {
      items.length = 0
    },
  }
}

export function truncateText(text: string, max: number = MAX_TEXT_CHARS): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n…(已截断,原文共 ${text.length} 字符)`
}

// ===== 远端 shell 命令构造(纯字符串) =====

function quote(p: string): string {
  return `"${p.replace(/"/g, '\\"')}"`
}

/** 取最近 N 行,可选按级别/子串/时间前缀子串过滤。 */
export function buildTailCommand(
  path: string,
  lines: number,
  opts?: { level?: string; grep?: string; since?: string },
): string {
  let cmd = `tail -n ${lines} ${quote(path)}`
  if (opts?.level) cmd += ` | grep -i -E ${quote(`\\b(${opts.level.toUpperCase()})\\b`)}`
  if (opts?.grep) cmd += ` | grep -i -F ${quote(opts.grep)}`
  if (opts?.since) cmd += ` | grep -F ${quote(opts.since)}`
  return cmd
}

/** 错误搜索:拉取最近窗口行,聚类在本地完成(设计文档 3.3)。 */
export function buildErrorSearchCommand(path: string, windowLines: number = ERROR_SEARCH_WINDOW): string {
  return `tail -n ${windowLines} ${quote(path)}`
}

/** 按行号取上下文字段。 */
export function buildContextCommand(path: string, centerLine: number, contextLines: number): string {
  const start = Math.max(1, centerLine - contextLines)
  const end = centerLine + contextLines
  return `sed -n ${start},${end}p ${quote(path)}`
}

/** 按子串定位行号(取前 5 条)。 */
export function buildFindLineCommand(path: string, pattern: string): string {
  return `grep -n -F -- ${quote(pattern)} ${quote(path)} | head -5`
}

/** 列出各日志文件路径与大小;缺失给出提示。 */
export function buildListFilesCommand(paths: string[]): string {
  return paths.map((p) => `ls -l ${quote(p)} 2>/dev/null || echo "缺失: ${p}"`).join(" ; ")
}
