import { timingSafeEqual } from "node:crypto"
import { parseClientJson, type ClientMessage, type ServerMessage, type WireMessage, type WireState } from "./protocol"

type SocketData = { name: string }

export type RelayPeer = { name: string; rename: (name: string) => void }

export type RelayHandlers = {
  token: string
  room: string
  port?: number
  sessionTitle?: () => string | undefined
  snapshot: () => { seq: number; messages: WireMessage[] }
  state: (peers: string[]) => WireState
  onMessage: (message: ClientMessage, peer: RelayPeer) => void
  onPeers?: (peers: string[]) => void
}

export type Relay = {
  port: number
  peers: () => string[]
  broadcast: (message: ServerMessage) => void
  stop: () => Promise<void>
}

export function startRelay(handlers: RelayHandlers): Relay {
  const sockets = new Set<Bun.ServerWebSocket<SocketData>>()
  const peers = () =>
    [...sockets]
      .map((ws) => ws.data.name)
      .filter((name) => name.length > 0)

  const server = Bun.serve<SocketData, never>({
    port: handlers.port ?? 0,
    fetch(req, srv) {
      const url = new URL(req.url)
      if (!matches(url.searchParams.get("token") ?? "", handlers.token)) {
        return new Response("unauthorized", { status: 401 })
      }
      if (srv.upgrade(req, { data: { name: "" } })) return
      return new Response("websocket required", { status: 426 })
    },
    websocket: {
      open(ws) {
        sockets.add(ws)
        ws.send(
          JSON.stringify({
            type: "hello",
            room: handlers.room,
            sessionTitle: handlers.sessionTitle?.(),
            state: handlers.state(peers()),
          } satisfies ServerMessage),
        )
        ws.send(JSON.stringify({ type: "snapshot", ...handlers.snapshot() } satisfies ServerMessage))
        handlers.onPeers?.(peers())
      },
      message(ws, raw) {
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw)
        const message = parseClientJson(text)
        if (!message) return
        if (message.type === "ping") return
        if (message.type === "hello") {
          ws.data.name = message.name
          handlers.onPeers?.(peers())
          return
        }
        handlers.onMessage(message, {
          get name() {
            return ws.data.name
          },
          rename(name) {
            ws.data.name = name
            handlers.onPeers?.(peers())
          },
        })
      },
      close(ws) {
        sockets.delete(ws)
        handlers.onPeers?.(peers())
      },
    },
  })

  return {
    port: server.port ?? 0,
    peers,
    broadcast(message) {
      const text = JSON.stringify(message)
      for (const ws of sockets) ws.send(text)
    },
    async stop() {
      await server.stop(true)
    },
  }
}

function matches(given: string, expected: string) {
  const actual = Buffer.from(given)
  const want = Buffer.from(expected)
  if (actual.length !== want.length) return false
  return timingSafeEqual(actual, want)
}
