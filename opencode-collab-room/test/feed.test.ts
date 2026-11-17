import { describe, expect, test } from "bun:test"
import { applyServerMessage, createGuestRoom } from "../src/feed"
import { MAX_PART_TEXT, type ServerMessage } from "../src/protocol"

const hello: ServerMessage = {
  type: "hello",
  room: "r1",
  sessionTitle: "T",
  state: { status: "idle", peers: 0, queue: [] },
}

describe("feed", () => {
  test("初始状态", () => {
    const room = createGuestRoom()
    expect(room.connection).toBe("connecting")
    expect(room.messages).toEqual([])
  })

  test("hello 建立连接并带状态", () => {
    const room = applyServerMessage(createGuestRoom(), hello)
    expect(room.connection).toBe("open")
    expect(room.room).toBe("r1")
    expect(room.title).toBe("T")
  })

  test("snapshot 覆盖消息", () => {
    const room = applyServerMessage(createGuestRoom(), {
      type: "snapshot",
      seq: 4,
      messages: [{ id: "m1", role: "user", parts: [{ id: "p1", messageID: "m1", type: "text", text: "hi" }] }],
    })
    expect(room.seq).toBe(4)
    expect(room.messages).toHaveLength(1)
  })

  test("message.updated 追加并按 seq 丢弃旧消息", () => {
    let room = applyServerMessage(createGuestRoom(), { type: "snapshot", seq: 1, messages: [] })
    room = applyServerMessage(room, { type: "message.updated", seq: 2, id: "m1", role: "assistant" })
    expect(room.messages[0]).toEqual({ id: "m1", role: "assistant", parts: [] })

    const stale = applyServerMessage(room, { type: "message.updated", seq: 2, id: "m2", role: "user" })
    expect(stale).toBe(room)
  })

  test("part.updated 建消息并 upsert 部件", () => {
    let room = applyServerMessage(createGuestRoom(), { type: "snapshot", seq: 1, messages: [] })
    room = applyServerMessage(room, {
      type: "part.updated",
      seq: 2,
      messageID: "m1",
      part: { id: "p1", messageID: "m1", type: "text", text: "a" },
    })
    expect(room.messages[0]?.parts[0]?.text).toBe("a")

    room = applyServerMessage(room, {
      type: "part.updated",
      seq: 3,
      messageID: "m1",
      part: { id: "p1", messageID: "m1", type: "text", text: "b" },
    })
    expect(room.messages[0]?.parts).toHaveLength(1)
    expect(room.messages[0]?.parts[0]?.text).toBe("b")
  })

  test("part.delta 累加文本并忽略未知部件", () => {
    let room = applyServerMessage(createGuestRoom(), { type: "snapshot", seq: 1, messages: [] })
    room = applyServerMessage(room, {
      type: "part.updated",
      seq: 2,
      messageID: "m1",
      part: { id: "p1", messageID: "m1", type: "text", text: "a" },
    })
    room = applyServerMessage(room, {
      type: "part.delta",
      seq: 3,
      messageID: "m1",
      partID: "p1",
      field: "text",
      delta: "b",
    })
    expect(room.messages[0]?.parts[0]?.text).toBe("ab")

    const unknown = applyServerMessage(room, {
      type: "part.delta",
      seq: 4,
      messageID: "m1",
      partID: "missing",
      field: "text",
      delta: "x",
    })
    expect(unknown.messages[0]?.parts[0]?.text).toBe("ab")
  })

  test("状态与审批", () => {
    let room = applyServerMessage(createGuestRoom(), hello)
    room = applyServerMessage(room, {
      type: "state",
      state: { status: "waiting_approval", peers: 2, queue: [{ id: "q1", by: "Bob", text: "x" }] },
    })
    expect(room.info.peers).toBe(2)

    room = applyServerMessage(room, {
      type: "permission",
      request: { id: "a1", tool: "bash", patterns: ["rm -rf build"], always: [], metadata: {} },
    })
    expect(room.approval?.tool).toBe("bash")
    expect(room.approval?.patterns).toEqual(["rm -rf build"])

    const other = applyServerMessage(room, { type: "permission.result", id: "zzz", reply: "once" })
    expect(other).toBe(room)

    room = applyServerMessage(room, { type: "permission.result", id: "a1", reply: "once" })
    expect(room.approval).toBeUndefined()
  })

  test("消息 info 合并且不丢已有字段", () => {
    let room = applyServerMessage(createGuestRoom(), { type: "snapshot", seq: 1, messages: [] })
    room = applyServerMessage(room, {
      type: "message.updated",
      seq: 2,
      id: "m1",
      role: "assistant",
      info: { agent: "build", created: 1000 },
    })
    room = applyServerMessage(room, {
      type: "message.updated",
      seq: 3,
      id: "m1",
      role: "assistant",
      info: { finish: "stop", cost: 0.5 },
    })
    expect(room.messages[0]?.info).toEqual({ agent: "build", created: 1000, finish: "stop", cost: 0.5 })
  })

  test("提问与会话错误", () => {
    let room = applyServerMessage(createGuestRoom(), hello)
    room = applyServerMessage(room, {
      type: "question",
      request: { id: "q1", questions: [{ question: "继续吗？", options: [{ label: "继续" }] }] },
    })
    expect(room.question?.id).toBe("q1")
    room = applyServerMessage(room, { type: "question.result", id: "zzz" })
    expect(room.question?.id).toBe("q1")
    room = applyServerMessage(room, { type: "question.result", id: "q1", rejected: true })
    expect(room.question).toBeUndefined()

    room = applyServerMessage(room, { type: "session.error", error: { name: "ApiError", message: "401" } })
    expect(room.sessionError?.name).toBe("ApiError")
    // 主机恢复输出后错误提示消失
    room = applyServerMessage(room, { type: "message.updated", seq: 9, id: "m9", role: "assistant" })
    expect(room.sessionError).toBeUndefined()
  })

  test("流式文本到上限后停止追加", () => {
    let room = applyServerMessage(createGuestRoom(), {
      type: "snapshot",
      seq: 1,
      messages: [
        {
          id: "m1",
          role: "assistant",
          parts: [{ id: "p1", messageID: "m1", type: "text", text: "x".repeat(MAX_PART_TEXT - 1) }],
        },
      ],
    })
    room = applyServerMessage(room, {
      type: "part.delta",
      seq: 2,
      messageID: "m1",
      partID: "p1",
      field: "text",
      delta: "abc",
    })
    expect(room.messages[0]?.parts[0]?.text).toHaveLength(MAX_PART_TEXT)
  })

  test("bye 结束房间", () => {
    const room = applyServerMessage(applyServerMessage(createGuestRoom(), hello), {
      type: "bye",
      reason: "closed",
    })
    expect(room.connection).toBe("closed")
    expect(room.notice).toBe("closed")
  })
})
