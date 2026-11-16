import type { ServerMessage, WireMessage, WirePart, WireState } from "./protocol"

export type GuestRoom = {
  connection: "connecting" | "open" | "closed"
  notice?: string
  error?: string
  room: string
  title?: string
  seq: number
  info: WireState
  messages: WireMessage[]
  approval?: { id: string; tool?: string }
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
      return { ...room, seq: message.seq, messages: upsertMessage(room.messages, message.id, message.role) }
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
      return { ...room, approval: { id: message.id, tool: message.tool } }
    case "permission.result":
      return room.approval?.id === message.id ? { ...room, approval: undefined } : room
    case "bye":
      return { ...room, connection: "closed", notice: message.reason }
  }
}

function upsertMessage(messages: WireMessage[], id: string, role: string | undefined): WireMessage[] {
  const index = messages.findIndex((message) => message.id === id)
  if (index < 0) return [...messages, { id, role: role ?? "assistant", parts: [] }]
  const existing = messages[index]!
  if (!role || existing.role === role) return messages
  const next = messages.slice()
  next[index] = { ...existing, role }
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
  const parts = message.parts.slice()
  parts[partIndex] = { ...part, [field]: existing + delta }
  const next = messages.slice()
  next[messageIndex] = { ...message, parts }
  return next
}
