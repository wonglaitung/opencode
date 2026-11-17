import {
  MAX_PART_TEXT,
  type ServerMessage,
  type WireMessage,
  type WireMessageInfo,
  type WirePart,
  type WirePermission,
  type WireQuestion,
  type WireState,
} from "./protocol"

export type GuestRoom = {
  connection: "connecting" | "open" | "closed"
  notice?: string
  error?: string
  room: string
  title?: string
  seq: number
  info: WireState
  messages: WireMessage[]
  approval?: WirePermission
  question?: WireQuestion
  /** 主机侧会话错误（provider 失败、上下文溢出等），下一条助手消息出现后清除。 */
  sessionError?: { name: string; message?: string }
}

export function createGuestRoom(): GuestRoom {
  return {
    connection: "connecting",
    room: "",
    seq: 0,
    info: { status: "idle", peers: 0, queue: [] },
    messages: [],
  }
}

export function applyServerMessage(room: GuestRoom, message: ServerMessage): GuestRoom {
  switch (message.type) {
    case "hello":
      return {
        ...room,
        connection: "open",
        room: message.room,
        title: message.sessionTitle,
        info: message.state,
      }
    case "snapshot":
      return { ...room, connection: "open", seq: message.seq, messages: message.messages }
    case "message.updated":
      if (message.seq <= room.seq) return room
      return {
        ...room,
        seq: message.seq,
        messages: upsertMessage(room.messages, message.id, message.role, message.info),
        // 新的助手消息代表主机恢复输出，旧错误不再挡住视线
        sessionError: message.role === "assistant" ? undefined : room.sessionError,
      }
    case "part.updated":
      if (message.seq <= room.seq) return room
      return { ...room, seq: message.seq, messages: upsertPart(room.messages, message.messageID, message.part) }
    case "part.delta":
      if (message.seq <= room.seq) return room
      return {
        ...room,
        seq: message.seq,
        messages: appendDelta(room.messages, message.messageID, message.partID, message.field, message.delta),
      }
    case "state":
      return { ...room, info: message.state }
    case "permission":
      return { ...room, approval: message.request }
    case "permission.result":
      return room.approval?.id === message.id ? { ...room, approval: undefined } : room
    case "question":
      return { ...room, question: message.request }
    case "question.result":
      return room.question?.id === message.id ? { ...room, question: undefined } : room
    case "session.error":
      return message.error === undefined ? room : { ...room, sessionError: message.error }
    case "bye":
      return { ...room, connection: "closed", notice: message.reason }
  }
}

function upsertMessage(
  messages: WireMessage[],
  id: string,
  role: string | undefined,
  info?: WireMessageInfo,
): WireMessage[] {
  const index = messages.findIndex((message) => message.id === id)
  if (index < 0) {
    const created: WireMessage = { id, role: role ?? "assistant", parts: [] }
    if (info) created.info = info
    return [...messages, created]
  }
  const existing = messages[index]!
  const nextRole = role ?? existing.role
  const nextInfo = info ? { ...existing.info, ...info } : existing.info
  if (nextRole === existing.role && nextInfo === existing.info) return messages
  const next = messages.slice()
  const merged: WireMessage = { ...existing, role: nextRole }
  if (nextInfo) merged.info = nextInfo
  next[index] = merged
  return next
}

function upsertPart(messages: WireMessage[], messageID: string, part: WirePart): WireMessage[] {
  const withMessage = upsertMessage(messages, messageID, undefined)
  const index = withMessage.findIndex((message) => message.id === messageID)
  if (index < 0) return messages
  const message = withMessage[index]!
  const partIndex = message.parts.findIndex((entry) => entry.id === part.id)
  const parts = message.parts.slice()
  if (partIndex < 0) parts.push(part)
  else parts[partIndex] = part
  const next = withMessage.slice()
  next[index] = { ...message, parts }
  return next
}

function appendDelta(messages: WireMessage[], messageID: string, partID: string, field: string, delta: string) {
  const messageIndex = messages.findIndex((message) => message.id === messageID)
  if (messageIndex < 0) return messages
  const message = messages[messageIndex]!
  const partIndex = message.parts.findIndex((part) => part.id === partID)
  if (partIndex < 0) return messages
  const part = message.parts[partIndex]!
  const existing = typeof part[field] === "string" ? (part[field] as string) : ""
  // 超长流式文本在访客侧截断，避免一条粘贴内容把内存撑爆
  if (existing.length >= MAX_PART_TEXT) return messages
  const nextText = (existing + delta).slice(0, MAX_PART_TEXT)
  const parts = message.parts.slice()
  parts[partIndex] = { ...part, [field]: nextText }
  const next = messages.slice()
  next[messageIndex] = { ...message, parts }
  return next
}
