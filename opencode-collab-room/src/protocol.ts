export const MAX_NAME_LENGTH = 64
export const MAX_TEXT_LENGTH = 4000
export const MAX_ID_LENGTH = 64
/** 单条文本 part 上限：超长粘贴/输出只传前段，避免一帧几 MB。 */
export const MAX_PART_TEXT = 64_000
/** 单个工具输出上限；超出部分在主机侧截断并标记长度。 */
export const MAX_TOOL_OUTPUT = 32_000

export type WireStatus = "idle" | "busy" | "waiting_approval"

export type WireQueueItem = { id: string; by: string; text: string }

export type WireState = {
  status: WireStatus
  peers: number
  queue: WireQueueItem[]
  pendingApproval?: { id: string; tool?: string }
}

export type WirePart = { id: string; messageID: string; type: string; text?: string; [key: string]: unknown }

/** 消息级信息：访客判断「谁在回答、花了多少、成没成」的依据。 */
export type WireMessageInfo = {
  agent?: string
  model?: { providerID: string; modelID: string; variant?: string }
  cost?: number
  tokens?: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  created?: number
  completed?: number
  finish?: string
  error?: { name: string; message?: string }
}

export type WireMessage = { id: string; role: string; info?: WireMessageInfo; parts: WirePart[] }

/** 权限请求：与正常会话页的 PermissionPrompt 同源，访客据此判断主机被要求做什么。 */
export type WirePermission = {
  id: string
  tool: string
  patterns: string[]
  always: string[]
  metadata: Record<string, unknown>
  callID?: string
}

export type WireQuestionOption = { label: string; description?: string }

export type WireQuestionInfo = {
  question: string
  header?: string
  options: WireQuestionOption[]
  multiple?: boolean
  custom?: boolean
}

export type WireQuestion = { id: string; questions: WireQuestionInfo[] }

export type ClientMessage =
  | { type: "hello"; name: string }
  | { type: "suggest"; text: string }
  | { type: "queue"; id: string; text: string }
  | { type: "queue.cancel"; id: string }
  | { type: "ping" }

export type ServerMessage =
  | { type: "hello"; room: string; sessionTitle?: string; state: WireState }
  | { type: "snapshot"; seq: number; messages: WireMessage[] }
  | { type: "message.updated"; seq: number; id: string; role: string; info?: WireMessageInfo }
  | { type: "part.delta"; seq: number; messageID: string; partID: string; field: string; delta: string }
  | { type: "part.updated"; seq: number; messageID: string; part: WirePart }
  | { type: "state"; state: WireState }
  | { type: "permission"; request: WirePermission }
  | { type: "permission.result"; id: string; reply: "once" | "always" | "reject" | "done" }
  | { type: "question"; request: WireQuestion }
  | { type: "question.result"; id: string; answers?: string[][]; rejected?: boolean }
  | { type: "session.error"; error?: { name: string; message?: string } }
  | { type: "bye"; reason: string }

export type Invite = { url: string; token: string }

export function formatInvite(host: string, port: number, token: string) {
  return `ws://${host}:${port}?token=${encodeURIComponent(token)}`
}

export function parseInvite(raw: string): Invite | undefined {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") return
  const token = url.searchParams.get("token")?.trim() ?? ""
  if (!token || token.length > MAX_ID_LENGTH) return
  return { url: raw.trim(), token }
}

export function parseClientJson(text: string): ClientMessage | undefined {
  return parseClientMessage(parseJson(text))
}

export function parseServerJson(text: string): ServerMessage | undefined {
  return parseServerMessage(parseJson(text))
}

export function parseClientMessage(raw: unknown): ClientMessage | undefined {
  if (!isRecord(raw)) return
  switch (raw.type) {
    case "hello": {
      const name = readName(raw.name)
      if (!name) return
      return { type: "hello", name }
    }
    case "suggest": {
      const text = readText(raw.text)
      if (!text) return
      return { type: "suggest", text }
    }
    case "queue": {
      const id = readId(raw.id)
      const text = readText(raw.text)
      if (!id || !text) return
      return { type: "queue", id, text }
    }
    case "queue.cancel": {
      const id = readId(raw.id)
      if (!id) return
      return { type: "queue.cancel", id }
    }
    case "ping":
      return { type: "ping" }
  }
}

export function parseServerMessage(raw: unknown): ServerMessage | undefined {
  if (!isRecord(raw)) return
  switch (raw.type) {
    case "hello": {
      const room = typeof raw.room === "string" ? raw.room.trim() : ""
      const state = parseState(raw.state)
      if (!room || !state) return
      const title = typeof raw.sessionTitle === "string" ? raw.sessionTitle : undefined
      return title === undefined ? { type: "hello", room, state } : { type: "hello", room, sessionTitle: title, state }
    }
    case "snapshot": {
      const seq = readSeq(raw.seq)
      const messages = readMessages(raw.messages)
      if (seq === undefined || !messages) return
      return { type: "snapshot", seq, messages }
    }
    case "part.delta": {
      const seq = readSeq(raw.seq)
      const messageID = readId(raw.messageID)
      const partID = readId(raw.partID)
      const field = typeof raw.field === "string" && raw.field ? raw.field : undefined
      const delta = typeof raw.delta === "string" ? raw.delta : undefined
      if (seq === undefined || !messageID || !partID || !field || delta === undefined) return
      return { type: "part.delta", seq, messageID, partID, field, delta }
    }
    case "message.updated": {
      const seq = readSeq(raw.seq)
      const id = readId(raw.id)
      const role = typeof raw.role === "string" && raw.role ? raw.role : undefined
      if (seq === undefined || !id || !role) return
      const info = readMessageInfo(raw.info)
      return info === undefined
        ? { type: "message.updated", seq, id, role }
        : { type: "message.updated", seq, id, role, info }
    }
    case "part.updated": {
      const seq = readSeq(raw.seq)
      const part = readPart(raw.part)
      if (seq === undefined || !part) return
      return { type: "part.updated", seq, messageID: part.messageID, part }
    }
    case "state": {
      const state = parseState(raw.state)
      if (!state) return
      return { type: "state", state }
    }
    case "permission": {
      // 兼容旧 host：旧格式是顶层 id/tool/detail，新格式是 request 对象
      const request = readPermission(raw.request) ?? readLegacyPermission(raw)
      if (!request) return
      return { type: "permission", request }
    }
    case "permission.result": {
      const id = readId(raw.id)
      const reply = raw.reply
      if (!id) return
      if (reply !== "once" && reply !== "always" && reply !== "reject" && reply !== "done") return
      return { type: "permission.result", id, reply }
    }
    case "question": {
      const request = readQuestion(raw.request)
      if (!request) return
      return { type: "question", request }
    }
    case "question.result": {
      const id = readId(raw.id)
      if (!id) return
      const answers = readAnswers(raw.answers)
      const rejected = raw.rejected === true
      return answers === undefined
        ? { type: "question.result", id, rejected }
        : { type: "question.result", id, answers, rejected }
    }
    case "session.error": {
      const error = readError(raw.error)
      return error === undefined ? { type: "session.error" } : { type: "session.error", error }
    }
    case "bye": {
      const reason = typeof raw.reason === "string" ? raw.reason : "room closed"
      return { type: "bye", reason }
    }
  }
}

export function parseState(raw: unknown): WireState | undefined {
  if (!isRecord(raw)) return
  const status = raw.status
  if (status !== "idle" && status !== "busy" && status !== "waiting_approval") return
  const peers = typeof raw.peers === "number" && Number.isFinite(raw.peers) ? Math.max(0, Math.trunc(raw.peers)) : 0
  const queue = Array.isArray(raw.queue) ? raw.queue.map(readQueueItem).filter(isDefined) : []
  const pending = readApproval(raw.pendingApproval)
  return pending === undefined ? { status, peers, queue } : { status, peers, queue, pendingApproval: pending }
}

function readQueueItem(raw: unknown): WireQueueItem | undefined {
  if (!isRecord(raw)) return
  const id = readId(raw.id)
  const by = readName(raw.by)
  const text = readText(raw.text)
  if (!id || !by || !text) return
  return { id, by, text }
}

function readApproval(raw: unknown): { id: string; tool?: string } | undefined {
  if (!isRecord(raw)) return
  const id = readId(raw.id)
  if (!id) return
  const tool = typeof raw.tool === "string" ? raw.tool : undefined
  return tool === undefined ? { id } : { id, tool }
}

function readMessageInfo(raw: unknown): WireMessageInfo | undefined {
  if (!isRecord(raw)) return undefined
  const info: WireMessageInfo = {}
  const agent = typeof raw.agent === "string" && raw.agent ? raw.agent : undefined
  if (agent) info.agent = agent
  const model = readModel(raw.model)
  if (model) info.model = model
  const cost = readNumber(raw.cost)
  if (cost !== undefined) info.cost = cost
  const tokens = readTokens(raw.tokens)
  if (tokens) info.tokens = tokens
  const created = readNumber(raw.created)
  if (created !== undefined) info.created = created
  const completed = readNumber(raw.completed)
  if (completed !== undefined) info.completed = completed
  const finish = typeof raw.finish === "string" && raw.finish ? raw.finish : undefined
  if (finish) info.finish = finish
  const error = readError(raw.error)
  if (error) info.error = error
  return Object.keys(info).length === 0 ? undefined : info
}

function readModel(raw: unknown): WireMessageInfo["model"] | undefined {
  if (!isRecord(raw)) return undefined
  const providerID = typeof raw.providerID === "string" ? raw.providerID : ""
  const modelID = typeof raw.modelID === "string" ? raw.modelID : ""
  if (!providerID || !modelID) return undefined
  const variant = typeof raw.variant === "string" && raw.variant ? raw.variant : undefined
  return variant === undefined ? { providerID, modelID } : { providerID, modelID, variant }
}

function readTokens(raw: unknown): WireMessageInfo["tokens"] | undefined {
  if (!isRecord(raw)) return undefined
  const cache = isRecord(raw.cache) ? raw.cache : {}
  return {
    input: readNumber(raw.input) ?? 0,
    output: readNumber(raw.output) ?? 0,
    reasoning: readNumber(raw.reasoning) ?? 0,
    cacheRead: readNumber(cache.read) ?? 0,
    cacheWrite: readNumber(cache.write) ?? 0,
  }
}

function readError(raw: unknown): { name: string; message?: string } | undefined {
  if (!isRecord(raw)) return undefined
  const name = typeof raw.name === "string" && raw.name ? raw.name : "Error"
  const message = typeof raw.message === "string" && raw.message ? raw.message.slice(0, 400) : undefined
  return message === undefined ? { name } : { name, message }
}

function readPermission(raw: unknown): WirePermission | undefined {
  if (!isRecord(raw)) return undefined
  const id = readId(raw.id)
  const tool = typeof raw.tool === "string" && raw.tool ? raw.tool : undefined
  if (!id || !tool) return undefined
  const callID = typeof raw.callID === "string" && raw.callID ? raw.callID : undefined
  const permission: WirePermission = {
    id,
    tool,
    patterns: readStringArray(raw.patterns),
    always: readStringArray(raw.always),
    metadata: readMetadata(raw.metadata),
  }
  if (callID) permission.callID = callID
  return permission
}

function readLegacyPermission(raw: Record<string, unknown>): WirePermission | undefined {
  const id = readId(raw.id)
  const tool = typeof raw.tool === "string" && raw.tool ? raw.tool : undefined
  if (!id || !tool) return undefined
  const detail = typeof raw.detail === "string" ? raw.detail : ""
  return { id, tool, patterns: detail ? [detail] : [], always: [], metadata: {} }
}

function readQuestion(raw: unknown): WireQuestion | undefined {
  if (!isRecord(raw)) return undefined
  const id = readId(raw.id)
  if (!id || !Array.isArray(raw.questions)) return undefined
  const questions: WireQuestionInfo[] = []
  for (const item of raw.questions) {
    if (!isRecord(item)) continue
    const question = typeof item.question === "string" ? item.question.trim() : ""
    if (!question) continue
    const header = typeof item.header === "string" && item.header ? item.header : undefined
    const options: WireQuestionOption[] = []
    if (Array.isArray(item.options)) {
      for (const option of item.options) {
        if (!isRecord(option)) continue
        const label = typeof option.label === "string" ? option.label.trim() : ""
        if (!label) continue
        const description = typeof option.description === "string" && option.description ? option.description : undefined
        options.push(description === undefined ? { label } : { label, description })
      }
    }
    questions.push({
      question: question.slice(0, 2000),
      header,
      options,
      multiple: item.multiple === true,
      custom: item.custom === true,
    })
  }
  return questions.length === 0 ? undefined : { id, questions }
}

function readAnswers(raw: unknown): string[][] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: string[][] = []
  for (const item of raw) {
    out.push(readStringArray(item).map((value) => value.slice(0, 500)))
  }
  return out
}

function readStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((value): value is string => typeof value === "string" && value.length > 0)
}

function readMetadata(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") out[key] = value.slice(0, MAX_TOOL_OUTPUT)
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value
    else if (Array.isArray(value)) out[key] = readStringArray(value).slice(0, 200)
  }
  return out
}

function readNumber(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined
}

function readMessages(raw: unknown): WireMessage[] | undefined {
  if (!Array.isArray(raw)) return
  const out: WireMessage[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const id = readId(item.id)
    const role = typeof item.role === "string" ? item.role : undefined
    if (!id || !role) continue
    const parts = Array.isArray(item.parts) ? item.parts.map(readPart).filter(isDefined) : []
    const info = readMessageInfo(item.info)
    out.push(info === undefined ? { id, role, parts } : { id, role, info, parts })
  }
  return out
}

function readPart(raw: unknown): WirePart | undefined {
  if (!isRecord(raw)) return
  const id = readId(raw.id)
  const messageID = readId(raw.messageID)
  const type = typeof raw.type === "string" ? raw.type : undefined
  if (!id || !messageID || !type) return
  const text = typeof raw.text === "string" ? raw.text : undefined
  return text === undefined ? { ...raw, id, messageID, type } : { ...raw, id, messageID, type, text }
}

function readSeq(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return
  return Math.trunc(raw)
}

function readId(raw: unknown): string | undefined {
  if (typeof raw !== "string") return
  const value = raw.trim()
  if (!value || value.length > MAX_ID_LENGTH) return
  return value
}

function readName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return
  const value = raw.trim()
  if (!value || value.length > MAX_NAME_LENGTH) return
  return value
}

function readText(raw: unknown): string | undefined {
  if (typeof raw !== "string") return
  const value = raw.trim()
  if (!value || value.length > MAX_TEXT_LENGTH) return
  return value
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}
