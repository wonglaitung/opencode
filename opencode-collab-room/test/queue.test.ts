import { describe, expect, test } from "bun:test"
import { cancel, createQueue, enqueue, MAX_QUEUE, peek, queueSize, shift, type QueueItem } from "../src/queue"

function item(id: string, text = "task"): QueueItem {
  return { id, by: "Bob", text, queuedAt: 1 }
}

describe("queue", () => {
  test("先进先出", () => {
    const queue = createQueue()
    enqueue(queue, item("a"))
    enqueue(queue, item("b"))
    expect(queueSize(queue)).toBe(2)
    expect(peek(queue)?.id).toBe("a")
    expect(shift(queue)?.id).toBe("a")
    expect(shift(queue)?.id).toBe("b")
    expect(shift(queue)).toBeUndefined()
  })

  test("拒绝重复 id 与超限", () => {
    const queue = createQueue()
    expect(enqueue(queue, item("a"))).toEqual({ ok: true })
    expect(enqueue(queue, item("a"))).toEqual({ ok: false, reason: "duplicate" })
    for (let index = 1; index < MAX_QUEUE; index++) enqueue(queue, item(`q${index}`))
    expect(enqueue(queue, item("overflow"))).toEqual({ ok: false, reason: "full" })
  })

  test("取消指定项", () => {
    const queue = createQueue()
    enqueue(queue, item("a"))
    enqueue(queue, item("b"))
    expect(cancel(queue, "b")?.id).toBe("b")
    expect(cancel(queue, "missing")).toBeUndefined()
    expect(queueSize(queue)).toBe(1)
  })
})
