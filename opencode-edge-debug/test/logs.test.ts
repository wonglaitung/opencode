/**
 * logs.ts 纯函数层测试(零 mock,直接验证真实实现)。
 */
import { describe, expect, test } from "bun:test"
import { EdgeDebugError } from "../src/errors"
import {
  MAX_LOGS,
  MAX_TEXT_CHARS,
  PAGE_INFO_EXPRESSION,
  PAGE_TEXT_EXPRESSION,
  createRingBuffer,
  formatConsoleArgs,
  formatEvaluateOutcome,
  formatRemoteObject,
  formatResponseBody,
  nowTime,
  requireNetworkEntry,
  shouldKeepResponse,
  toNetworkSummary,
  truncateText,
  type NetworkEntry,
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

describe("truncateText", () => {
  test("不超上限原样返回", () => {
    expect(truncateText("你好", 10)).toBe("你好")
    expect(truncateText("12345", 5)).toBe("12345")
  })

  test("默认上限为 MAX_TEXT_CHARS", () => {
    const text = "a".repeat(MAX_TEXT_CHARS + 1)
    const result = truncateText(text)
    expect(result.startsWith("a".repeat(MAX_TEXT_CHARS))).toBe(true)
    expect(result).toContain(`原始长度 ${MAX_TEXT_CHARS + 1} 字符`)
  })

  test("超限截断并附标注", () => {
    const result = truncateText("abcdefghij", 4)
    expect(result).toBe("abcd\n…[内容过长已截断,原始长度 10 字符]")
  })
})

describe("toNetworkSummary", () => {
  test("保留列表字段,剔除 headers/postData 详情", () => {
    const entry: NetworkEntry = {
      time: "10:00:00",
      requestId: "42",
      method: "POST",
      url: "http://a/api/users",
      status: 200,
      mimeType: "application/json",
      postData: '{"name":"x"}',
      requestHeaders: { cookie: "a=1" },
      responseHeaders: { "content-type": "application/json" },
    }
    expect(toNetworkSummary(entry)).toEqual({
      time: "10:00:00",
      requestId: "42",
      method: "POST",
      url: "http://a/api/users",
      status: 200,
      mimeType: "application/json",
    })
  })
})

describe("formatEvaluateOutcome", () => {
  test("字符串 value 原样返回", () => {
    expect(formatEvaluateOutcome({ result: { type: "string", value: "ok" } })).toBe("ok")
  })

  test("对象 value 走 JSON 序列化", () => {
    expect(formatEvaluateOutcome({ result: { type: "object", value: { a: 1 } } })).toBe(`{"a":1}`)
  })

  test("无 value 时取 description(如 undefined 结果)", () => {
    expect(formatEvaluateOutcome({ result: { type: "undefined" } })).toBe("undefined")
  })

  test("空返回兜底", () => {
    expect(formatEvaluateOutcome(undefined)).toBe("unknown")
  })

  test("页面抛错时以 EdgeDebugError 呈现堆栈摘要", () => {
    const raw = {
      result: { type: "object" },
      exceptionDetails: {
        text: "Uncaught",
        exception: { description: "TypeError: x is not a function\n    at <anonymous>:1:1" },
      },
    }
    expect(() => formatEvaluateOutcome(raw)).toThrow(EdgeDebugError)
    expect(() => formatEvaluateOutcome(raw)).toThrow("TypeError: x is not a function")
  })

  test("异常仅有 value 时取其字符串", () => {
    const raw = { exceptionDetails: { exception: { value: "boom" } } }
    expect(() => formatEvaluateOutcome(raw)).toThrow("页面求值出错:boom")
  })

  test("异常仅有 text 时兜底", () => {
    expect(() => formatEvaluateOutcome({ exceptionDetails: { text: "SyntaxError" } })).toThrow("SyntaxError")
  })

  test("超长结果截断", () => {
    const result = formatEvaluateOutcome({ result: { type: "string", value: "x".repeat(MAX_TEXT_CHARS + 5) } })
    expect(result).toContain("已截断")
  })
})

describe("formatResponseBody", () => {
  test("文本响应体原样返回", () => {
    expect(formatResponseBody({ body: '{"ok":true}', base64Encoded: false })).toBe('{"ok":true}')
  })

  test("文本超长截断", () => {
    expect(formatResponseBody({ body: "y".repeat(MAX_TEXT_CHARS + 1), base64Encoded: false })).toContain("已截断")
  })

  test("base64 响应体给出字节占位而非乱码", () => {
    // "hello" 的 base64 为 aGVsbG8=,解码 5 字节
    expect(formatResponseBody({ body: "aGVsbG8=", base64Encoded: true })).toBe("[二进制内容, 共 5 字节]")
  })

  test("body 缺省返回空串", () => {
    expect(formatResponseBody({})).toBe("")
  })
})

describe("requireNetworkEntry", () => {
  const entries: NetworkEntry[] = [
    { time: "10:00:00", requestId: "a", method: "GET", url: "http://a/api/1", status: 200, mimeType: "application/json" },
  ]

  test("按 requestId 命中返回条目", () => {
    expect(requireNetworkEntry(entries, "a").url).toBe("http://a/api/1")
  })

  test("未找到时抛错并引导先看网络日志", () => {
    expect(() => requireNetworkEntry(entries, "nope")).toThrow(EdgeDebugError)
    expect(() => requireNetworkEntry(entries, "nope")).toThrow("get_browser_network_logs")
  })
})

describe("页面求值表达式常量", () => {
  test("PAGE_INFO_EXPRESSION 产出含 url/title/readyState/viewport 的 JSON", () => {
    const json = new Function(
      "location",
      "document",
      "innerWidth",
      "innerHeight",
      `return (${PAGE_INFO_EXPRESSION})`,
    )({ href: "http://a/" }, { title: "首页", readyState: "complete" }, 1280, 720) as string
    expect(JSON.parse(json)).toEqual({
      url: "http://a/",
      title: "首页",
      readyState: "complete",
      viewport: { width: 1280, height: 720 },
    })
  })

  test("PAGE_TEXT_EXPRESSION 取 body.innerText,无 body 时为空串", () => {
    const run = new Function("document", `return (${PAGE_TEXT_EXPRESSION})`)
    expect(run({ body: { innerText: "正文" } })).toBe("正文")
    expect(run({})).toBe("")
  })
})
