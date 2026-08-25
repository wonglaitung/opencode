/**
 * 调试会话编排(设计文档 3.4)。
 * createEdgeDebugController:启动 → 等待就绪 → attach → 监听;幂等 start/stop。
 * 状态(child / cdp / 缓冲)由闭包持有——插件规范:不在模块顶层持有状态。
 */
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import type { ChildProcess } from "node:child_process"
import { killProcessTree, launchEdge, resolveEdgeBinary } from "./browser"
import { CdpClient, getPageTargetWsUrl, probeVersion, waitForCdp } from "./cdp"
import { EdgeDebugError } from "./errors"
import {
  createRingBuffer,
  formatConsoleArgs,
  nowTime,
  shouldKeepResponse,
  type ConsoleEntry,
  type NetworkEntry,
  type RemoteObjectLike,
} from "./logs"

/** Edge 远程调试端口(固定值,v1 不开放配置,设计文档 7)。 */
export const DEBUG_PORT = 9222
/** 未指定 url 时的默认加载地址。 */
export const DEFAULT_URL = "http://localhost:3000"

export interface EdgeDebugController {
  /** 启动/复用 Edge 并建立 CDP 监听;幂等。返回供工具回显的中文结果。 */
  start(url?: string): Promise<string>
  /** 优雅关闭;未运行时返回 false。 */
  stop(): Promise<boolean>
  consoleLogs(): ConsoleEntry[]
  networkLogs(): NetworkEntry[]
  isRunning(): boolean
}

export function createEdgeDebugController(directory: string): EdgeDebugController {
  let child: ChildProcess | null = null
  let cdp: CdpClient | null = null
  const consoleBuffer = createRingBuffer<ConsoleEntry>()
  const networkBuffer = createRingBuffer<NetworkEntry>()
  // requestId → HTTP method(CDP 的 responseReceived 事件不携带 method,3.2)
  const requestMethods = new Map<string, string>()

  function listen(client: CdpClient): void {
    client.on("Runtime.consoleAPICalled", (params) => {
      const args = (params["args"] ?? []) as RemoteObjectLike[]
      consoleBuffer.push({
        time: nowTime(),
        level: String(params["type"] ?? "log").toUpperCase(),
        text: formatConsoleArgs(args),
      })
    })
    client.on("Runtime.exceptionThrown", (params) => {
      const details = params["exceptionDetails"] as
        | { text?: string; exception?: { description?: string } }
        | undefined
      consoleBuffer.push({
        time: nowTime(),
        level: "UNCAUGHT_EXCEPTION",
        text: details?.exception?.description ?? details?.text ?? "未知异常",
      })
    })
    client.on("Network.requestWillBeSent", (params) => {
      const requestId = params["requestId"]
      const request = params["request"] as { method?: string } | undefined
      if (typeof requestId === "string" && request?.method) requestMethods.set(requestId, request.method)
    })
    client.on("Network.responseReceived", (params) => {
      const requestId = params["requestId"]
      const response = params["response"] as
        | { status?: number; url?: string; mimeType?: string }
        | undefined
      if (!response || typeof response.status !== "number" || !response.url) return
      if (!shouldKeepResponse({ status: response.status, url: response.url, mimeType: response.mimeType ?? "" })) {
        return
      }
      const method = typeof requestId === "string" ? requestMethods.get(requestId) : undefined
      if (typeof requestId === "string") requestMethods.delete(requestId)
      networkBuffer.push({
        time: nowTime(),
        method: method ?? "GET",
        url: response.url,
        status: response.status,
        mimeType: response.mimeType ?? "",
      })
    })
    // 浏览器被手动关闭等场景:连接断开即复位会话状态
    client.onClose(() => {
      if (cdp !== client) return
      cdp = null
      child = null
      console.log("[edge-debug] CDP 连接断开(浏览器可能已被手动关闭),调试会话已结束")
    })
  }

  async function attach(port: number): Promise<CdpClient> {
    const wsUrl = await getPageTargetWsUrl(port)
    if (!wsUrl) {
      throw new EdgeDebugError("未找到可调试的页面 target(浏览器可能没有打开任何页面)。请在浏览器中打开页面后重试。")
    }
    const client = await CdpClient.connect(wsUrl)
    await Promise.all([client.call("Runtime.enable"), client.call("Network.enable")])
    listen(client)
    cdp = client
    return client
  }

  return {
    async start(url = DEFAULT_URL) {
      if (cdp) return "Edge 调试已在运行,无需重复启动。可用 get_browser_console_logs / get_browser_network_logs 查看日志。"
      if (await probeVersion(DEBUG_PORT)) {
        // 端口已有 CDP 服务(其他调试实例):直接复用,不再拉起进程
        const client = await attach(DEBUG_PORT)
        await client.call("Page.enable")
        await client.call("Page.navigate", { url })
        return `检测到端口 ${DEBUG_PORT} 已有 Edge 调试实例,已直接接入并导航到 ${url}。`
      }
      const binary = resolveEdgeBinary()
      const userDataDir = join(directory, ".opencode", "edge-debug", "profile")
      mkdirSync(userDataDir, { recursive: true })
      child = launchEdge(binary, { port: DEBUG_PORT, url, userDataDir })
      try {
        await waitForCdp(DEBUG_PORT)
        await attach(DEBUG_PORT)
      } catch (error) {
        killProcessTree(child)
        child = null
        throw error
      }
      return `已启动 Edge 并建立 Console/Network 调试监听,已加载 ${url}。`
    },

    async stop() {
      const client = cdp
      cdp = null
      if (!client && !child) return false
      if (client) {
        try {
          // 优雅关闭:Browser.close 让浏览器自行退出(决策记录 D3)
          await client.call("Browser.close")
        } catch {
          // 优雅关闭失败(或连接已断):由下方进程树清理兜底
        }
        client.close()
      }
      killProcessTree(child)
      child = null
      consoleBuffer.clear()
      networkBuffer.clear()
      requestMethods.clear()
      console.log("[edge-debug] Edge 浏览器及 CDP 监听已安全关闭")
      return true
    },

    consoleLogs() {
      return consoleBuffer.snapshot()
    },

    networkLogs() {
      return networkBuffer.snapshot()
    },

    isRunning() {
      return cdp !== null
    },
  }
}
