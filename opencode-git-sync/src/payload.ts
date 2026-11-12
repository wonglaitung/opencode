import crypto from "node:crypto"
import type { MessageInfo, MessageWithParts, PartInfo, SessionInfo } from "./types"

/**
 * 同步载荷格式（加密前的明文）。
 *
 * 仓库布局：
 *   sessions/<sessionID>/meta.ocgs            会话元信息
 *   sessions/<sessionID>/<messageID>.ocgs      单条消息 + parts
 *
 * 路径归一化：跨机绝对路径不同，写入前把本机根目录替换为占位符，
 * 导入时再还原为当前机器的实际路径。占位符替换只作用于「字符串值」，不动 key。
 */

export const WORKSPACE_PLACEHOLDER = "${WORKSPACE_ROOT}"
export const PROJECT_PLACEHOLDER = "${PROJECT_DIR}"

export type PathRules = { worktree: string; directory: string }

export type SessionMeta = {
  id: string
  title: string
  slug?: string
  parentID?: string
  version?: string
  agent?: string
  model?: unknown
  time: { created: number; updated: number }
  cost?: number
  tokens?: unknown
  summary?: unknown
}

export type MessagePayload = { info: MessageInfo; parts: PartInfo[] }

export type PayloadFile = { path: string; content: Buffer }

function replaceInString(value: string, rules: PathRules, reverse: boolean): string {
  const pairs: Array<[string, string]> = reverse
    ? [
        [WORKSPACE_PLACEHOLDER, rules.worktree],
        [PROJECT_PLACEHOLDER, rules.directory],
      ]
    : [
        [rules.worktree, WORKSPACE_PLACEHOLDER],
        [rules.directory, PROJECT_PLACEHOLDER],
      ]
  // 长路径优先替换：directory 可能是 worktree 的子目录，先换 worktree 会把 directory 也吃掉。
  pairs.sort((a, b) => b[0].length - a[0].length)
  let result = value
  for (const [from, to] of pairs) {
    if (!from) continue
    result = result.split(from).join(to)
  }
  return result
}

/** 递归替换字符串值中的路径（write=true 归一化，false 还原）。 */
export function mapStrings(value: unknown, rules: PathRules, write: boolean): unknown {
  if (typeof value === "string") return replaceInString(value, rules, !write)
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, rules, write))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = mapStrings(item, rules, write)
    }
    return out
  }
  return value
}

export function normalize(value: unknown, rules: PathRules): unknown {
  return mapStrings(value, rules, true)
}

export function denormalize(value: unknown, rules: PathRules): unknown {
  return mapStrings(value, rules, false)
}

export function sha256(value: unknown): string {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")
}

/** 会话信息 → 可同步的元信息（只保留有意义的字段）。 */
export function toSessionMeta(info: SessionInfo): SessionMeta {
  const meta: SessionMeta = {
    id: info.id,
    title: typeof info.title === "string" ? info.title : "Untitled session",
    time: {
      created: numberOr(info.time?.created, Date.now()),
      updated: numberOr(info.time?.updated, Date.now()),
    },
  }
  if (typeof info["slug"] === "string") meta.slug = info["slug"]
  if (typeof info.parentID === "string") meta.parentID = info.parentID
  if (typeof info["version"] === "string") meta.version = info["version"]
  if (typeof info["agent"] === "string") meta.agent = info["agent"]
  if (info["model"] !== undefined) meta.model = info["model"]
  if (typeof info["cost"] === "number") meta.cost = info["cost"]
  if (info["tokens"] !== undefined) meta.tokens = info["tokens"]
  if (info["summary"] !== undefined) meta.summary = info["summary"]
  return meta
}

export function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

/** 单条消息 → 可同步载荷（去掉 sessionID 绑定，导入时按目标会话重写）。 */
export function toMessagePayload(message: MessageWithParts): MessagePayload {
  return { info: message.info, parts: message.parts }
}

export function sessionMetaPath(sessionID: string): string {
  return `sessions/${sessionID}/meta.ocgs`
}

export function messagePath(sessionID: string, messageID: string): string {
  return `sessions/${sessionID}/${messageID}.ocgs`
}

/** 从仓库相对路径解析出会话 ID 与消息 ID。 */
export function parseSessionPath(filePath: string): { sessionID: string; messageID?: string } | undefined {
  const match = /^sessions\/([^/]+)\/([^/]+)\.ocgs$/.exec(filePath)
  if (!match) return undefined
  const sessionID = match[1]!
  const name = match[2]!
  if (name === "meta") return { sessionID }
  return { sessionID, messageID: name }
}
