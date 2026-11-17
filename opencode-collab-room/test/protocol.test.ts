import { describe, expect, test } from "bun:test"
import {
  formatInvite,
  MAX_NAME_LENGTH,
  MAX_PART_TEXT,
  MAX_TEXT_LENGTH,
  MAX_TOOL_OUTPUT,
  parseClientJson,
  parseClientMessage,
  parseInvite,
  parseServerJson,
  parseServerMessage,
  parseState,
} from "../src/protocol"

describe("invite", () => {
  test("拼装与解析往返", () => {
    const invite = formatInvite("192.168.1.5", 54321, "abc123")
    expect(invite).toBe("ws://192.168.1.5:54321?token=abc123")
    expect(parseInvite(invite)).toEqual({ url: invite, token: "abc123" })
  })

  test("拒绝非 ws 与缺 token", () => {
    expect(parseInvite("http://1.2.3.4:1?token=x")).toBeUndefined()
    expect(parseInvite("ws://1.2.3.4:1")).toBeUndefined()
    expect(parseInvite("not a url")).toBeUndefined()
  })
})

describe("parseClientMessage", () => {
  test("接受合法消息", () => {
    expect(parseClientMessage({ type: "hello", name: "  Bob " })).toEqual({ type: "hello", name: "Bob" })
    expect(parseClientMessage({ type: "suggest", text: "加个索引" })).toEqual({ type: "suggest", text: "加个索引" })
    expect(parseClientMessage({ type: "queue", id: "q1", text: "补单测" })).toEqual({
      type: "queue",
      id: "q1",
      text: "补单测",
    })
    expect(parseClientMessage({ type: "queue.cancel", id: "q1" })).toEqual({ type: "queue.cancel", id: "q1" })
    expect(parseClientMessage({ type: "ping" })).toEqual({ type: "ping" })
  })

  test("拒绝缺字段与超长", () => {
    expect(parseClientMessage({ type: "hello" })).toBeUndefined()
    expect(parseClientMessage({ type: "hello", name: "x".repeat(MAX_NAME_LENGTH + 1) })).toBeUndefined()
    expect(parseClientMessage({ type: "suggest", text: "   " })).toBeUndefined()
    expect(parseClientMessage({ type: "suggest", text: "x".repeat(MAX_TEXT_LENGTH + 1) })).toBeUndefined()
    expect(parseClientMessage({ type: "queue", text: "no id" })).toBeUndefined()
    expect(parseClientMessage(null)).toBeUndefined()
  })

  test("JSON 入口拒绝坏 JSON", () => {
    expect(parseClientJson("{")).toBeUndefined()
  })
})

describe("parseServerMessage", () => {
  test("hello 与 snapshot", () => {
    const hello = parseServerMessage({
      type: "hello",
      room: "r",
      state: { status: "idle", peers: 1, queue: [] },
    })
    expect(hello).toMatchObject({ type: "hello", room: "r" })

    const snapshot = parseServerMessage({
      type: "snapshot",
      seq: 3,
      messages: [
        { id: "m1", role: "user", parts: [{ id: "p1", messageID: "m1", type: "text", text: "hi" }] },
        { id: "bad" },
      ],
    })
    expect(snapshot).toMatchObject({ type: "snapshot", seq: 3 })
    if (snapshot?.type === "snapshot") expect(snapshot.messages).toHaveLength(1)
  })

  test("part.delta 与 permission", () => {
    expect(parseServerMessage({ type: "message.updated", seq: 2, id: "m1", role: "assistant" })).toEqual({
      type: "message.updated",
      seq: 2,
      id: "m1",
      role: "assistant",
    })
    expect(parseServerMessage({ type: "message.updated", seq: 2, id: "m1" })).toBeUndefined()
    expect(
      parseServerMessage({
        type: "part.delta",
        seq: 1,
        messageID: "m1",
        partID: "p1",
        field: "text",
        delta: "x",
      }),
    ).toMatchObject({ type: "part.delta", seq: 1 })

    // 旧 host 的顶层 id/tool/detail 仍要能解析
    expect(parseServerMessage({ type: "permission", id: "a1", tool: "bash" })).toMatchObject({
      type: "permission",
      request: { id: "a1", tool: "bash" },
    })
    expect(parseServerMessage({ type: "permission.result", id: "a1", reply: "maybe" })).toBeUndefined()
    expect(parseServerMessage({ type: "permission.result", id: "a1", reply: "reject" })).toMatchObject({
      type: "permission.result",
      reply: "reject",
    })
  })

  test("消息级信息与截断边界", () => {
    const parsed = parseServerMessage({
      type: "message.updated",
      seq: 3,
      id: "m1",
      role: "assistant",
      info: {
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude", variant: "high" },
        cost: 0.12,
        tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 1, write: 2 } },
        created: 1000,
        completed: 2000,
        finish: "stop",
        error: { name: "ApiError", message: "boom" },
      },
    })
    expect(parsed).toMatchObject({
      type: "message.updated",
      info: {
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude", variant: "high" },
        tokens: { input: 10, output: 20, cacheRead: 1, cacheWrite: 2 },
        finish: "stop",
        error: { name: "ApiError", message: "boom" },
      },
    })
    // 没有可用字段时不附带空 info
    expect(parseServerMessage({ type: "message.updated", seq: 1, id: "m1", role: "user" })).toEqual({
      type: "message.updated",
      seq: 1,
      id: "m1",
      role: "user",
    })
    expect(MAX_PART_TEXT).toBeGreaterThan(MAX_TOOL_OUTPUT)
  })

  test("权限请求：新格式与旧格式", () => {
    const next = parseServerMessage({
      type: "permission",
      request: {
        id: "a1",
        tool: "edit",
        patterns: ["src/**"],
        always: ["src/**"],
        metadata: { filepath: "src/a.ts", diff: "+x", nested: { skip: true }, list: ["a", 1] },
        callID: "call_1",
      },
    })
    expect(next).toMatchObject({
      type: "permission",
      request: { id: "a1", tool: "edit", patterns: ["src/**"], callID: "call_1" },
    })
    // 未知类型与嵌套对象不进 metadata，避免把任意结构转发给访客
    expect(next).toMatchObject({ type: "permission", request: { metadata: { filepath: "src/a.ts", list: ["a"] } } })
  })

  test("提问与会话错误", () => {
    const question = parseServerMessage({
      type: "question",
      request: {
        id: "q1",
        questions: [
          {
            question: "要跑全量还是增量？",
            header: "范围",
            options: [{ label: "全量", description: "更慢" }, { label: "增量" }, { label: "" }],
            multiple: false,
            custom: true,
          },
        ],
      },
    })
    expect(question).toMatchObject({
      type: "question",
      request: { id: "q1", questions: [{ header: "范围", options: [{ label: "全量" }, { label: "增量" }] }] },
    })
    expect(parseServerMessage({ type: "question", request: { id: "q1", questions: [] } })).toBeUndefined()
    expect(parseServerMessage({ type: "question.result", id: "q1", answers: [["全量"]] })).toMatchObject({
      type: "question.result",
      answers: [["全量"]],
    })
    expect(parseServerMessage({ type: "session.error", error: { name: "ApiError", message: "401" } })).toMatchObject({
      type: "session.error",
      error: { name: "ApiError", message: "401" },
    })
  })

  test("state 校验", () => {
    expect(parseState({ status: "busy", peers: 2.8, queue: [{ id: "q1", by: "Bob", text: "x" }] })).toEqual({
      status: "busy",
      peers: 2,
      queue: [{ id: "q1", by: "Bob", text: "x" }],
    })
    expect(parseState({ status: "nope" })).toBeUndefined()
  })

  test("JSON 入口", () => {
    expect(parseServerJson('{"type":"bye","reason":"closed"}')).toEqual({ type: "bye", reason: "closed" })
  })
})
