import { describe, expect, test } from "bun:test"
import { gzipSync } from "node:zlib"
import { decodeHandoff, encodeHandoff, HANDOFF_FORMAT, handoffSummary, parseHandoff } from "../src/handoff"

const file = {
  format: HANDOFF_FORMAT,
  exportedAt: 1731000000000,
  exportedBy: { user: "zhang", machine: "HP-Laptop" },
  note: "登录鉴权卡住了",
  session: {
    id: "ses_1",
    title: "支付网关重构",
    directory: "${PROJECT_DIR}",
    path: "sub",
    time: { created: 1000, updated: 2000 },
  },
  messages: [{ info: { id: "msg_1", role: "user" }, parts: [{ id: "part_1", type: "text", text: "hi" }] }],
}

describe("交接文件格式", () => {
  test("编码后可解码，内容一致", () => {
    const decoded = decodeHandoff(encodeHandoff(file as never))
    expect(decoded.session.id).toBe("ses_1")
    expect(decoded.messages).toHaveLength(1)
    expect(decoded.messages[0]!.parts).toHaveLength(1)
  })

  test("压缩后体积小于原文", () => {
    const plain = Buffer.from(JSON.stringify(file), "utf8")
    expect(encodeHandoff(file as never).length).toBeLessThan(plain.length)
  })

  test("版本不符时拒绝", () => {
    expect(() => parseHandoff({ ...file, format: "ocshare/9" })).toThrow(/版本不匹配/)
  })

  test("缺少会话 id 时拒绝", () => {
    expect(() => parseHandoff({ ...file, session: { ...file.session, id: "" } })).toThrow(/会话 id/)
  })

  test("缺少消息列表时拒绝", () => {
    expect(() => parseHandoff({ ...file, messages: undefined })).toThrow(/消息列表/)
  })

  test("缺少导出时间时拒绝", () => {
    expect(() => parseHandoff({ ...file, exportedAt: "x" })).toThrow(/导出时间/)
  })

  test("消息结构无效时拒绝", () => {
    expect(() => parseHandoff({ ...file, messages: [{ info: null, parts: [] }] })).toThrow(/第 1 条消息/)
  })

  test("不是 gzip 时拒绝", () => {
    expect(() => decodeHandoff(Buffer.from("plain text"))).toThrow(/压缩文件/)
  })

  test("gzip 里不是 JSON 时拒绝", () => {
    expect(() => decodeHandoff(gzipSync(Buffer.from("not json")))).toThrow(/JSON/)
  })

  test("摘要给出交接单要素", () => {
    const summary = handoffSummary(file as never)
    expect(summary.sessionTitle).toBe("支付网关重构")
    expect(summary.messageCount).toBe(1)
    expect(summary.from.user).toBe("zhang")
  })
})
