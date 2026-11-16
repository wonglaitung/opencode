export const MAX_NAME_LENGTH = 64
export const MAX_TEXT_LENGTH = 4000
export const MAX_ID_LENGTH = 64

export type WireStatus = "idle" | "busy" | "waiting_approval"

export type WireQueueItem = { id: string; by: string; text: string }

export type WireState = {
  status: WireStatus
  peers: number
  queue: WireQueueItem[]
  pendingApproval?: { id: string; tool?: string }
}

export type WirePart = { id: string; messageID: string; type: string; text?: string; [key: string]: unknown }

export type WireMessage = { id: string; role: string; parts: WirePart[] }

export type ClientMessage =
  | { type: "hello"; name: string }
  | { type: "suggest"; text: string }
  | { type: "queue"; id: string; text: string }
  | { type: "queue.cancel"; id: string }
  | { type: "ping" }

export type ServerMessage =
  | { type: "hello"; room: string; sessionTitle?: string; state: WireState }
  | { type: "snapshot"; seq: number; messages: WireMessage[] }
  | { type: "message.updated"; seq: number; id: string; role: string }
  | { type: "part.delta"; seq: number; messageID: string; partID: string; field: string; delta: string }
  | { type: "part.updated"; seq: number; messageID: string; part: WirePart }
  | { type: "state"; state: WireState }
  | { type: "permission"; id: string; tool?: string; detail?: string }
  | { type: "permission.result"; id: string; reply: "once" | "always" | "reject" | "done" }
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
      return { type: "message.updated", seq, id, role }
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
      const id = readId(raw.id)
      if (!id) return
      const tool = typeof raw.tool === "string" ? raw.tool : undefined
      const detail = typeof raw.detail === "string" ? raw.detail : undefined
      return detail === undefined ? { type: "permission", id, tool } : { type: "permission", id, tool, detail }
    }
    case "permission.result": {
      const id = readId(raw.id)
      const reply = raw.reply
      if (!id) return
      if (reply !== "once" && reply !== "always" && reply !== "reject" && reply !== "done") return
      return { type: "permission.result", id, reply }
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

function readMessages(raw: unknown): WireMessage[] | undefined {
  if (!Array.isArray(raw)) return
  const out: WireMessage[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const id = readId(item.id)
    const role = typeof item.role === "string" ? item.role : undefined
    if (!id || !role) continue
    const parts = Array.isArray(item.parts) ? item.parts.map(readPart).filter(isDefined) : []
    out.push({ id, role, parts })
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
