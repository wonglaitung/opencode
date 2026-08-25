/**
 * logs.ts 纯函数层测试(零 mock,直接验证真实实现)。
 */
import { describe, expect, test } from "bun:test"
import {
  MAX_LOGS,
  createRingBuffer,
  formatConsoleArgs,
  formatRemoteObject,
  nowTime,
  shouldKeepResponse,
} from "../src/logs"

describe("createRingBuffer", () => {
  test("容量内按序保留", () => {
    const buffer = createRingBuffer<number>(3)
    buffer.push(1)
    buffer.push(2)
    expect(buffer.snapshot()).toEqual([1, 2])
    expect(buffer.size()).toBe(2)
  })

  test("超出容量丢弃最旧条目", () => {
    const buffer = createRingBuffer<number>(3)
    for (const item of [1, 2, 3, 4, 5]) buffer.push(item)
    expect(buffer.size()).toBe(3)
    expect(buffer.snapshot()).toEqual([3, 4, 5])
  })

  test("默认容量为 MAX_LOGS", () => {
    const buffer = createRingBuffer<number>()
    for (let i = 0; i < MAX_LOGS + 10; i++) buffer.push(i)
    expect(buffer.size()).toBe(MAX_LOGS)
    expect(buffer.snapshot()[0]).toBe(10)
  })

  test("clear 清空且 snapshot 是副本", () => {
    const buffer = createRingBuffer<number>(3)
    buffer.push(1)
    const snap = buffer.snapshot()
    snap.push(99)
    expect(buffer.snapshot()).toEqual([1])
    buffer.clear()
    expect(buffer.size()).toBe(0)
    expect(buffer.snapshot()).toEqual([])
  })
})

describe("shouldKeepResponse", () => {
  test("4xx/5xx 一律保留", () => {
    expect(shouldKeepResponse({ status: 404, url: "http://a/x.css", mimeType: "text/css" })).toBe(true)
    expect(shouldKeepResponse({ status: 500, url: "http://a/static.png", mimeType: "image/png" })).toBe(true)
  })

  test("疑似 API 请求保留", () => {
    expect(shouldKeepResponse({ status: 200, url: "http://a/api/users", mimeType: "text/html" })).toBe(true)
    expect(shouldKeepResponse({ status: 200, url: "http://a/data", mimeType: "application/json" })).toBe(true)
  })

  test("成功的静态资源丢弃", () => {
    expect(shouldKeepResponse({ status: 200, url: "http://a/app.css", mimeType: "text/css" })).toBe(false)
    expect(shouldKeepResponse({ status: 200, url: "http://a/logo.png", mimeType: "image/png" })).toBe(false)
    expect(shouldKeepResponse({ status: 304, url: "http://a/font.woff2", mimeType: "font/woff2" })).toBe(false)
  })
})

describe("formatRemoteObject / formatConsoleArgs", () => {
  test("字符串 value 原样输出", () => {
    expect(formatRemoteObject({ type: "string", value: "你好" })).toBe("你好")
  })

  test("非字符串 value 走 JSON 序列化", () => {
    expect(formatRemoteObject({ type: "number", value: 42 })).toBe("42")
    expect(formatRemoteObject({ type: "object", value: { a: 1 } })).toBe(`{"a":1}`)
  })

  test("无 value 时取 description", () => {
    expect(formatRemoteObject({ type: "object", description: "Object" })).toBe("Object")
  })

  test("兜底取类型名 / unknown", () => {
    expect(formatRemoteObject({ type: "undefined" })).toBe("undefined")
    expect(formatRemoteObject({})).toBe("unknown")
  })

  test("多参数以空格连接", () => {
    const text = formatConsoleArgs([
      { type: "string", value: "count:" },
      { type: "number", value: 3 },
      { type: "object", description: "{id: 1}" },
    ])
    expect(text).toBe("count: 3 {id: 1}")
  })

  test("空参数列表返回空串", () => {
    expect(formatConsoleArgs([])).toBe("")
  })
})

describe("nowTime", () => {
  test("输出 HH:MM:SS 格式", () => {
    expect(nowTime(new Date("2026-08-04T09:08:07"))).toMatch(/^\d{2}:\d{2}:\d{2}$/)
  })
})
