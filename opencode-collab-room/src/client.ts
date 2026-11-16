import { createSignal } from "solid-js"
import { applyServerMessage, createGuestRoom, type GuestRoom } from "./feed"
import { parseServerJson, type ClientMessage } from "./protocol"

export type GuestClient = {
  room: () => GuestRoom
  send: (message: ClientMessage) => boolean
  dispose: () => void
}

export const MAX_BACKOFF_MS = 15_000
export const BASE_BACKOFF_MS = 500

export function backoff(attempt: number) {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.min(attempt, 5), MAX_BACKOFF_MS)
}

export function startGuestClient(input: { url: string; name: string }): GuestClient {
  const [room, setRoom] = createSignal<GuestRoom>(createGuestRoom())
  let socket: WebSocket | undefined
  let disposed = false
  let attempts = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const connect = () => {
    if (disposed) return
    const ws = new WebSocket(input.url)
    socket = ws
    ws.addEventListener("open", () => {
      attempts = 0
      ws.send(JSON.stringify({ type: "hello", name: input.name } satisfies ClientMessage))
    })
    ws.addEventListener("message", (event) => {
      const message = parseServerJson(String(event.data))
      if (!message) return
      setRoom(applyServerMessage(room(), message))
    })
    ws.addEventListener("close", () => {
      socket = undefined
      if (disposed || room().connection === "closed") return
      setRoom({ ...room(), connection: "connecting" })
      timer = setTimeout(connect, backoff(attempts++))
    })
  }

  connect()

  return {
    room,
    send(message) {
      if (!socket || socket.readyState !== WebSocket.OPEN) return false
      socket.send(JSON.stringify(message))
      return true
    },
    dispose() {
      disposed = true
      if (timer) clearTimeout(timer)
      socket?.close()
    },
  }
}
