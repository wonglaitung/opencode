import { afterEach, describe, expect, test } from "bun:test"
import { backoff, MAX_BACKOFF_MS, startGuestClient } from "../src/client"
import type { ClientMessage } from "../src/protocol"
import { startRelay, type Relay } from "../src/relay"

const relays: Relay[] = []

afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.stop()
})

async function eventually(check: () => boolean, timeoutMs = 3_000) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("eventually timeout")
    await Bun.sleep(10)
  }
}

function setup() {
  const received: ClientMessage[] = []
  const relay = startRelay({
    token: "tok",
    room: "room-1",
    sessionTitle: () => "demo",
    snapshot: () => ({ seq: 1, messages: [] }),
    state: (peers) => ({ status: "idle", peers: peers.length, queue: [] }),
    onMessage: (message) => received.push(message),
  })
  relays.push(relay)
  return { relay, received }
}

describe("backoff", () => {
  test("指数退避有上限", () => {
    expect(backoff(0)).toBe(500)
    expect(backoff(1)).toBe(1_000)
    expect(backoff(10)).toBe(MAX_BACKOFF_MS)
  })
})

describe("guest client", () => {
  test("连接后进入 open 并上报昵称", async () => {
    const { relay } = setup()
    const client = startGuestClient({ url: `ws://127.0.0.1:${relay.port}?token=tok`, name: "Bob" })
    try {
      await eventually(() => client.room().connection === "open")
      await eventually(() => relay.peers().includes("Bob"))
      expect(client.room().room).toBe("room-1")
      expect(client.room().title).toBe("demo")
    } finally {
      client.dispose()
    }
  })

  test("接收广播并发送业务消息", async () => {
    const { relay, received } = setup()
    const client = startGuestClient({ url: `ws://127.0.0.1:${relay.port}?token=tok`, name: "Bob" })
    try {
      await eventually(() => client.room().connection === "open")

      relay.broadcast({ type: "message.updated", seq: 2, id: "m1", role: "assistant" })
      relay.broadcast({
        type: "part.updated",
        seq: 3,
        messageID: "m1",
        part: { id: "p1", messageID: "m1", type: "text", text: "hello" },
      })
      relay.broadcast({ type: "part.delta", seq: 4, messageID: "m1", partID: "p1", field: "text", delta: " world" })

      await eventually(() => client.room().messages[0]?.parts[0]?.text === "hello world")

      expect(client.send({ type: "suggest", text: "建议加索引" })).toBe(true)
      await eventually(() => received.length === 1)
      expect(received[0]).toEqual({ type: "suggest", text: "建议加索引" })
    } finally {
      client.dispose()
    }
  })

  test("bye 之后不再重连", async () => {
    const { relay } = setup()
    const client = startGuestClient({ url: `ws://127.0.0.1:${relay.port}?token=tok`, name: "Bob" })
    try {
      await eventually(() => client.room().connection === "open")
      relay.broadcast({ type: "bye", reason: "closed" })
      await eventually(() => client.room().connection === "closed")
      await Bun.sleep(50)
      expect(client.room().connection).toBe("closed")
    } finally {
      client.dispose()
    }
  })

  test("断线后重连并恢复", async () => {
    const { relay } = setup()
    const client = startGuestClient({ url: `ws://127.0.0.1:${relay.port}?token=tok`, name: "Bob" })
    try {
      await eventually(() => client.room().connection === "open")
      await relay.stop()
      await eventually(() => client.room().connection === "connecting")
    } finally {
      client.dispose()
    }
  })
})
