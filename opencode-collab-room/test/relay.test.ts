import { afterEach, describe, expect, test } from "bun:test"
import type { ClientMessage, ServerMessage } from "../src/protocol"
import { startRelay, type Relay } from "../src/relay"

const relays: Relay[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close()
  for (const relay of relays.splice(0)) await relay.stop()
})

type Client = {
  ws: WebSocket
  messages: ServerMessage[]
  wait: (type: ServerMessage["type"], timeoutMs?: number) => Promise<ServerMessage>
}

function connect(url: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    sockets.push(ws)
    const messages: ServerMessage[] = []
    const waiters: Array<{ type?: ServerMessage["type"]; resolve: (message: ServerMessage) => void }> = []
    ws.addEventListener("message", (event) => {
      const parsed = JSON.parse(String(event.data)) as ServerMessage
      messages.push(parsed)
      for (let index = waiters.length - 1; index >= 0; index--) {
        const waiter = waiters[index]
        if (!waiter) continue
        if (waiter.type && waiter.type !== parsed.type) continue
        waiters.splice(index, 1)
        waiter.resolve(parsed)
      }
    })
    const wait = (type: ServerMessage["type"], timeoutMs = 2_000) =>
      new Promise<ServerMessage>((done, fail) => {
        const existing = messages.find((message) => message.type === type)
        if (existing) return done(existing)
        const timer = setTimeout(() => fail(new Error(`timeout waiting for ${type}`)), timeoutMs)
        waiters.push({
          type,
          resolve: (message) => {
            clearTimeout(timer)
            done(message)
          },
        })
      })
    ws.addEventListener("open", () => resolve({ ws, messages, wait }))
    ws.addEventListener("error", () => reject(new Error("websocket error")))
  })
}

async function eventually(check: () => boolean, timeoutMs = 2_000) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("eventually timeout")
    await Bun.sleep(10)
  }
}

function setup(overrides: Partial<Parameters<typeof startRelay>[0]> = {}) {
  const received: ClientMessage[] = []
  const peers: string[][] = []
  const relay = startRelay({
    token: "secret",
    room: "test-room",
    snapshot: () => ({ seq: 7, messages: [{ id: "m1", role: "user", parts: [] }] }),
    state: (names) => ({ status: "idle", peers: names.length, queue: [] }),
    onMessage: (message) => received.push(message),
    onPeers: (names) => peers.push(names),
    ...overrides,
  })
  relays.push(relay)
  return { relay, received, peers }
}

describe("relay", () => {
  test("错误 token 被拒绝", async () => {
    const { relay } = setup()
    const response = await fetch(`http://127.0.0.1:${relay.port}/?token=wrong`)
    expect(response.status).toBe(401)
  })

  test("连接后收到 hello 与 snapshot", async () => {
    const { relay } = setup()
    const client = await connect(`ws://127.0.0.1:${relay.port}?token=secret`)

    const hello = await client.wait("hello")
    expect(hello).toMatchObject({ type: "hello", room: "test-room" })
    if (hello.type === "hello") expect(hello.state.peers).toBe(0)

    const snapshot = await client.wait("snapshot")
    expect(snapshot).toMatchObject({ type: "snapshot", seq: 7 })
  })

  test("hello 更新成员并转发业务消息", async () => {
    const { relay, received, peers } = setup()
    const client = await connect(`ws://127.0.0.1:${relay.port}?token=secret`)

    client.ws.send(JSON.stringify({ type: "hello", name: "Bob" }))
    await eventually(() => relay.peers().includes("Bob"))
    await eventually(() => peers.some((names) => names.includes("Bob")))

    client.ws.send(JSON.stringify({ type: "queue", id: "q1", text: "补单测" }))
    await eventually(() => received.length === 1)
    expect(received[0]).toEqual({ type: "queue", id: "q1", text: "补单测" })

    client.ws.send("not json")
    await Bun.sleep(20)
    expect(received).toHaveLength(1)
  })

  test("广播到达客户端，ping 不转发", async () => {
    const { relay, received } = setup()
    const client = await connect(`ws://127.0.0.1:${relay.port}?token=secret`)

    client.ws.send(JSON.stringify({ type: "ping" }))
    relay.broadcast({ type: "bye", reason: "closed" })

    const bye = await client.wait("bye")
    expect(bye).toEqual({ type: "bye", reason: "closed" })
    expect(received).toHaveLength(0)
  })
})
