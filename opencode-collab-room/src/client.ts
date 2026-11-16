import { appendFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
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
export const OPEN_TIMEOUT_MS = 8_000

export function backoff(attempt: number) {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.min(attempt, 5), MAX_BACKOFF_MS)
}

export function describeSocketError(readyState: number) {
  if (readyState === 0) return "连接超时：主机未响应（确认同一网络、防火墙放行，且房间仍在开着）"
  return "连接中断，正在重试…"
}

function log(line: string) {
  try {
    const dir = path.join(os.homedir(), ".local", "share", "opencode", "log")
    appendFileSync(path.join(dir, "collab-room.log"), `${new Date().toISOString()} [guest] ${line}\n`)
  } catch {}
}

export function startGuestClient(input: { url: string; name: string }): GuestClient {
  const [room, setRoom] = createSignal<GuestRoom>(createGuestRoom())
  let socket: WebSocket | undefined
  let disposed = false
  let attempts = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let openTimer: ReturnType<typeof setTimeout> | undefined

  const clearOpenTimer = () => {
    if (openTimer) clearTimeout(openTimer)
    openTimer = undefined
  }

  const connect = () => {
    if (disposed) return
    const ws = new WebSocket(input.url)
    socket = ws
    log(`connect #${attempts}`)
    // 首次连接迟迟不 open 时给出可操作的提示，而不是一直停在“连接中”。
    openTimer = setTimeout(() => {
      if (ws.readyState === 0) {
        log("open timeout (readyState=0)")
        setRoom({ ...room(), error: describeSocketError(0) })
      }
    }, OPEN_TIMEOUT_MS)
    ws.addEventListener("open", () => {
      clearOpenTimer()
      log("open")
      attempts = 0
      if (room().error) setRoom({ ...room(), error: undefined })
      ws.send(JSON.stringify({ type: "hello", name: input.name } satisfies ClientMessage))
    })
    ws.addEventListener("message", (event) => {
      const message = parseServerJson(String(event.data))
      if (!message) return
      setRoom(applyServerMessage(room(), message))
    })
    ws.addEventListener("error", (event) => {
      log(`error ${(event as { message?: string })?.message ?? ""}`)
    })
    ws.addEventListener("close", (event) => {
      clearOpenTimer()
      socket = undefined
      log(`close ${event.code} ${event.reason}`)
      if (disposed || room().connection === "closed") return
      setRoom({ ...room(), connection: "connecting", error: describeSocketError(1) })
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
      clearOpenTimer()
      if (timer) clearTimeout(timer)
      socket?.close()
    },
  }
}
