import { describe, expect, test } from "bun:test"
import {
  awaitApproval,
  cancelRequest,
  createRoom,
  markIdle,
  POISON_RETRY_LIMIT,
  POISON_TIMEOUT_MS,
  request,
  resolveApproval,
  takeNext,
  toWireState,
  watchdog,
} from "../src/room"

const base = { by: "Bob", queuedAt: 0 }

describe("room", () => {
  test("空闲时才推进队首", () => {
    const room = createRoom()
    request(room, { id: "a", text: "one", ...base })
    request(room, { id: "b", text: "two", ...base })

    expect(takeNext(room, 10)?.id).toBe("a")
    expect(room.status).toBe("busy")
    expect(takeNext(room, 20)).toBeUndefined()

    markIdle(room)
    expect(takeNext(room, 30)?.id).toBe("b")
  })

  test("审批期间不推进", () => {
    const room = createRoom()
    awaitApproval(room, { id: "p1", requestedAt: 1 })
    request(room, { id: "a", text: "one", ...base })
    expect(takeNext(room, 2)).toBeUndefined()
    resolveApproval(room)
    expect(room.status).toBe("idle")
    expect(takeNext(room, 3)?.id).toBe("a")
  })

  test("审批结束后回到 busy", () => {
    const room = createRoom()
    request(room, { id: "a", text: "one", ...base })
    takeNext(room, 1)
    awaitApproval(room, { id: "p1", requestedAt: 2 })
    expect(room.status).toBe("waiting_approval")
    resolveApproval(room)
    expect(room.status).toBe("busy")
  })

  test("取消排队项", () => {
    const room = createRoom()
    request(room, { id: "a", text: "one", ...base })
    expect(cancelRequest(room, "a")?.id).toBe("a")
    expect(room.queue.items).toHaveLength(0)
  })

  test("毒丸看门狗先重排一次再丢弃", () => {
    const room = createRoom()
    request(room, { id: "a", text: "one", ...base })
    takeNext(room, 0)

    expect(watchdog(room, POISON_TIMEOUT_MS - 1)).toEqual({ kind: "none" })
    const first = watchdog(room, POISON_TIMEOUT_MS)
    expect(first.kind).toBe("requeue")
    expect(room.queue.items[0]?.attempts).toBe(1)
    expect(room.status).toBe("idle")

    takeNext(room, POISON_TIMEOUT_MS + 1)
    expect(room.active?.attempts).toBe(1)
    const second = watchdog(room, POISON_TIMEOUT_MS * 2 + 10)
    expect(second.kind).toBe("drop")
    expect(room.queue.items).toHaveLength(0)
    expect(POISON_RETRY_LIMIT).toBe(1)
  })

  test("wire state 映射", () => {
    const room = createRoom()
    request(room, { id: "a", text: "one", ...base })
    awaitApproval(room, { id: "p1", tool: "bash", requestedAt: 1 })
    expect(toWireState(room, 2)).toEqual({
      status: "waiting_approval",
      peers: 2,
      queue: [{ id: "a", by: "Bob", text: "one" }],
      pendingApproval: { id: "p1", tool: "bash" },
    })
  })
})
