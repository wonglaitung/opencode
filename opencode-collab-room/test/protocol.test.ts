import { describe, expect, test } from "bun:test"
import {
  formatInvite,
  MAX_NAME_LENGTH,
  MAX_TEXT_LENGTH,
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

    expect(parseServerMessage({ type: "permission", id: "a1", tool: "bash" })).toMatchObject({
      type: "permission",
      id: "a1",
    })
    expect(parseServerMessage({ type: "permission.result", id: "a1", reply: "maybe" })).toBeUndefined()
    expect(parseServerMessage({ type: "permission.result", id: "a1", reply: "reject" })).toMatchObject({
      type: "permission.result",
      reply: "reject",
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
