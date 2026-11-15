/**
 * 交接文件格式（.ocsave）。
 *
 * 一个文件 = 一次交接 = gzip 压缩的 JSON。外层是 manifest（谁、何时、哪条会话），
 * 内层是会话本体（meta + 全部消息与 part）。
 *
 * 刻意不做加密：交接文件由同事自行传递，可读性优先。
 * 路径已归一化（见 paths.ts），文件里不含源机器的绝对路径。
 */
import { gunzipSync, gzipSync } from "node:zlib"

export const HANDOFF_FORMAT = "ocshare/1"

export type HandoffTokens = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export type HandoffSession = {
  id: string
  title: string
  slug?: string
  parentID?: string
  version?: string
  agent?: string
  model?: unknown
  /** 归一化后的会话目录（占位符）。 */
  directory: string
  /** 相对项目根的目录，导入时据此还原本机目录。 */
  path?: string
  /** 源机器上的 project id（仅信息，导入时不用）。 */
  projectID?: string
  time: { created: number; updated: number }
  cost?: number
  tokens?: HandoffTokens
  summary?: { additions: number; deletions: number; files: number }
}

export type HandoffMessage = {
  info: Record<string, unknown>
  parts: Record<string, unknown>[]
}

export type HandoffWorkflow = {
  /** WorkflowState 的 JSON（路径已归一化）。 */
  state: Record<string, unknown>
  tags?: string[]
  status?: string | null
}

export type HandoffFile = {
  format: typeof HANDOFF_FORMAT
  exportedAt: number
  exportedBy: { user: string; machine: string }
  note: string
  session: HandoffSession
  messages: HandoffMessage[]
  /** 工作流状态（可选）：老文件没有这个字段，导入时跳过即可。 */
  workflow?: HandoffWorkflow
}

/** 交接文件问题（面向用户的中文提示）。 */
export class HandoffError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HandoffError"
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

/** 校验并收窄一个交接文件；任何不合法的输入都抛出可读的错误。 */
export function parseHandoff(value: unknown): HandoffFile {
  if (!isObject(value)) throw new HandoffError("交接文件内容不是有效的对象")
  if (value["format"] !== HANDOFF_FORMAT) {
    throw new HandoffError(
      `交接文件版本不匹配（期望 ${HANDOFF_FORMAT}，实际 ${String(value["format"] ?? "无")}）`,
    )
  }
  if (typeof value["exportedAt"] !== "number") throw new HandoffError("交接文件缺少导出时间")
  const exportedBy = value["exportedBy"]
  if (!isObject(exportedBy) || !nonEmptyString(exportedBy["user"]) || !nonEmptyString(exportedBy["machine"])) {
    throw new HandoffError("交接文件缺少导出人信息")
  }
  if (typeof value["note"] !== "string") throw new HandoffError("交接文件缺少交接说明字段")
  const session = value["session"]
  if (!isObject(session)) throw new HandoffError("交接文件缺少会话信息")
  if (!nonEmptyString(session["id"])) throw new HandoffError("交接文件缺少会话 id")
  if (!nonEmptyString(session["title"])) throw new HandoffError("交接文件缺少会话标题")
  if (!nonEmptyString(session["directory"])) throw new HandoffError("交接文件缺少会话目录")
  const time = session["time"]
  if (!isObject(time) || typeof time["created"] !== "number" || typeof time["updated"] !== "number") {
    throw new HandoffError("交接文件的会话时间字段无效")
  }
  const messages = value["messages"]
  if (!Array.isArray(messages)) throw new HandoffError("交接文件缺少消息列表")
  for (const [index, message] of messages.entries()) {
    if (!isObject(message) || !isObject(message["info"]) || !Array.isArray(message["parts"])) {
      throw new HandoffError(`交接文件的第 ${index + 1} 条消息结构无效`)
    }
  }
  return value as unknown as HandoffFile
}

/** 对象 → gzip 压缩的交接文件字节。 */
export function encodeHandoff(file: HandoffFile): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(file), "utf8"), { level: 9 })
}

/** 交接文件字节 → 已校验的交接文件。 */
export function decodeHandoff(buffer: Buffer): HandoffFile {
  let raw: Buffer
  try {
    raw = gunzipSync(buffer)
  } catch {
    throw new HandoffError("交接文件不是有效的压缩文件，可能已损坏或并非 .ocsave")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString("utf8"))
  } catch {
    throw new HandoffError("交接文件内容不是有效的 JSON")
  }
  return parseHandoff(parsed)
}

/** 交接单摘要（给导入前的确认界面看）。 */
export function handoffSummary(file: HandoffFile) {
  return {
    format: file.format,
    exportedAt: file.exportedAt,
    from: file.exportedBy,
    note: file.note,
    sessionId: file.session.id,
    sessionTitle: file.session.title,
    messageCount: file.messages.length,
  }
}
