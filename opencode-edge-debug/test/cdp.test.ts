/**
 * cdp.ts 测试:用 Bun.serve 起一个假 CDP 服务(真实 HTTP + WebSocket,零 mock),
 * 验证 id 配对、错误拒绝、事件分发、关闭语义与 HTTP 助手。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Server, ServerWebSocket } from "bun"
import { CdpClient, getPageTargetWsUrl, probeVersion, waitForCdp } from "../src/cdp"
import { EdgeDebugError } from "../src/errors"

let server: Server<undefined>
let wsUrl: string

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return
      return new Response("无法升级 WebSocket", { status: 400 })
    },
    websocket: {
      message(ws: ServerWebSocket, raw: string | Buffer) {
        const msg = JSON.parse(String(raw)) as { id: number; method: string; params?: unknown }
        switch (msg.method) {
          case "Echo.ok":
            ws.send(JSON.stringify({ id: msg.id, result: { echoed: msg.params } }))
            break
          case "Echo.fail":
            ws.send(JSON.stringify({ id: msg.id, error: { message: "模拟失败" } }))
            break
          case "Never.reply":
            // 故意不回复,用于验证 close 时 pending 被拒绝
            break
          case "Notify.listen":
            ws.send(JSON.stringify({ id: msg.id, result: {} }))
            ws.send(JSON.stringify({ method: "Test.event", params: { n: 1 } }))
            break
          default:
            ws.send(JSON.stringify({ id: msg.id, result: {} }))
        }
      },
    },
  })
  wsUrl = `ws://127.0.0.1:${server.port}/`
})

afterAll(() => {
  server.stop(true)
})

describe("CdpClient", () => {
  test("命令调用按 id 配对返回 result(含并发)", async () => {
    const client = await CdpClient.connect(wsUrl)
    const [a, b] = await Promise.all([
      client.call("Echo.ok", { who: "a" }),
      client.call("Echo.ok", { who: "b" }),
    ])
    expect(a).toEqual({ echoed: { who: "a" } })
    expect(b).toEqual({ echoed: { who: "b" } })
    client.close()
  })

  test("协议错误以 EdgeDebugError 拒绝", async () => {
    const client = await CdpClient.connect(wsUrl)
    await expect(client.call("Echo.fail")).rejects.toThrow("CDP 命令失败:模拟失败")
    client.close()
  })

  test("事件分发到订阅的 handler", async () => {
    const client = await CdpClient.connect(wsUrl)
    const events: Record<string, unknown>[] = []
    client.on("Test.event", (params) => events.push(params))
    await client.call("Notify.listen")
    await Bun.sleep(50)
    expect(events).toEqual([{ n: 1 }])
    client.close()
  })

  test("close 时未完成的命令被拒绝", async () => {
    const client = await CdpClient.connect(wsUrl)
    const pending = client.call("Never.reply")
    client.close()
    await expect(pending).rejects.toThrow("CDP 客户端已关闭")
  })

  test("close 之后的调用快速失败", async () => {
    const client = await CdpClient.connect(wsUrl)
    client.close()
    await expect(client.call("Echo.ok")).rejects.toThrow(EdgeDebugError)
  })

  test("onClose 回调只触发一次", async () => {
    const client = await CdpClient.connect(wsUrl)
    let fired = 0
    client.onClose(() => {
      fired++
    })
    client.close()
    await Bun.sleep(50)
    expect(fired).toBe(1)
  })

  test("连接到不可达地址时拒绝", async () => {
    await expect(CdpClient.connect("ws://127.0.0.1:1/")).rejects.toThrow(EdgeDebugError)
  })
})

describe("HTTP 助手", () => {
  let httpServer: Server<undefined>
  let ready = false
  const targets = [
    { id: "1", type: "other", url: "about:blank" },
    { id: "2", type: "page", url: "http://localhost:3000/", webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/2" },
  ]

  beforeAll(() => {
    httpServer = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname
        if (path === "/json/version") {
          if (!ready) return new Response("未就绪", { status: 503 })
          return Response.json({ Browser: "Edge/126.0" })
        }
        if (path === "/json") return Response.json(targets)
        return new Response("未找到", { status: 404 })
      },
    })
  })

  afterAll(() => {
    httpServer.stop(true)
  })

  test("probeVersion 按响应状态判定", async () => {
    ready = false
    expect(await probeVersion(httpServer.port!)).toBe(false)
    ready = true
    expect(await probeVersion(httpServer.port!)).toBe(true)
  })

  test("getPageTargetWsUrl 取第一个 page target", async () => {
    expect(await getPageTargetWsUrl(httpServer.port!)).toBe("ws://127.0.0.1:1/devtools/page/2")
  })

  test("waitForCdp 从不就绪轮询到就绪", async () => {
    ready = false
    const waiting = waitForCdp(httpServer.port!, 30, 3000)
    await Bun.sleep(80)
    ready = true
    await waiting
  })

  test("waitForCdp 超时拒绝", async () => {
    // 端口 1 无服务:探测始终失败直至超时
    await expect(waitForCdp(1, 30, 120)).rejects.toThrow("就绪超时")
  })
})
