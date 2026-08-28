/**
 * evaluateOnPage / fetchResponseBody 契约测试(零 mock):
 * 用 Bun.serve 起假 CDP 服务(真实 HTTP + WebSocket),
 * 验证 Runtime.evaluate 的命令参数约定与 Network.getResponseBody 的文本/base64 分支。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Server, ServerWebSocket } from "bun"
import { CdpClient } from "../src/cdp"
import { evaluateOnPage, fetchResponseBody } from "../src/controller"
import { EdgeDebugError } from "../src/errors"

let server: Server<undefined>
let wsUrl: string
let lastEvaluateParams: Record<string, unknown> | undefined

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return
      return new Response("无法升级 WebSocket", { status: 400 })
    },
    websocket: {
      message(ws: ServerWebSocket, raw: string | Buffer) {
        const msg = JSON.parse(String(raw)) as { id: number; method: string; params?: Record<string, unknown> }
        if (msg.method === "Runtime.evaluate") {
          lastEvaluateParams = msg.params
          const expression = String(msg.params?.["expression"] ?? "")
          if (expression.includes("boom")) {
            ws.send(
              JSON.stringify({
                id: msg.id,
                result: {
                  result: { type: "object" },
                  exceptionDetails: {
                    text: "Uncaught",
                    exception: { description: "ReferenceError: boom is not defined\n    at <anonymous>:1:1" },
                  },
                },
              }),
            )
            return
          }
          ws.send(JSON.stringify({ id: msg.id, result: { result: { type: "string", value: `echo:${expression}` } } }))
          return
        }
        if (msg.method === "Network.getResponseBody") {
          const requestId = String(msg.params?.["requestId"] ?? "")
          if (requestId === "text-1") {
            ws.send(JSON.stringify({ id: msg.id, result: { body: '{"ok":true}', base64Encoded: false } }))
          } else if (requestId === "bin-1") {
            ws.send(JSON.stringify({ id: msg.id, result: { body: "aGVsbG8=", base64Encoded: true } }))
          } else {
            ws.send(
              JSON.stringify({ id: msg.id, error: { message: "Could not find resource with given identifier" } }),
            )
          }
          return
        }
        ws.send(JSON.stringify({ id: msg.id, result: {} }))
      },
    },
  })
  wsUrl = `ws://127.0.0.1:${server.port}/`
})

afterAll(() => {
  server.stop(true)
})

describe("evaluateOnPage", () => {
  test("命令参数符合约定且结果格式化", async () => {
    const client = await CdpClient.connect(wsUrl)
    expect(await evaluateOnPage(client, "1+1")).toBe("echo:1+1")
    expect(lastEvaluateParams).toEqual({
      expression: "1+1",
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    client.close()
  })

  test("页面抛错时以 EdgeDebugError 呈现堆栈摘要", async () => {
    const client = await CdpClient.connect(wsUrl)
    await expect(evaluateOnPage(client, "boom()")).rejects.toThrow(EdgeDebugError)
    await expect(evaluateOnPage(client, "boom()")).rejects.toThrow("ReferenceError: boom is not defined")
    client.close()
  })
})

describe("fetchResponseBody", () => {
  test("文本响应体原样返回", async () => {
    const client = await CdpClient.connect(wsUrl)
    expect(await fetchResponseBody(client, "text-1")).toBe('{"ok":true}')
    client.close()
  })

  test("base64 响应体给出字节占位而非乱码", async () => {
    const client = await CdpClient.connect(wsUrl)
    expect(await fetchResponseBody(client, "bin-1")).toBe("[二进制内容, 共 5 字节]")
    client.close()
  })

  test("资源不存在时错误冒泡", async () => {
    const client = await CdpClient.connect(wsUrl)
    await expect(fetchResponseBody(client, "gone")).rejects.toThrow("Could not find resource")
    client.close()
  })
})
