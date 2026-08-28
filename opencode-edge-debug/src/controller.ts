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
  formatEvaluateOutcome,
  formatResponseBody,
  nowTime,
  PAGE_INFO_EXPRESSION,
  PAGE_TEXT_EXPRESSION,
  requireNetworkEntry,
  shouldKeepResponse,
  truncateText,
  type ConsoleEntry,
  type HeadersLike,
  type NetworkEntry,
  type RemoteObjectLike,
  type ResponseBodyLike,
} from "./logs"

/** Edge 远程调试端口(固定值,v1 不开放配置,设计文档 7)。 */
export const DEBUG_PORT = 9222
/** 未指定 url 时的默认加载地址。 */
export const DEFAULT_URL = "http://localhost:3000"
/**
 * 页面求值超时:awaitPromise 会等待页面异步操作(fetch 等),须长于普通 CDP 命令(设计文档 3.5)。
 */
export const EVALUATE_TIMEOUT_MS = 30_000

export interface EdgeDebugController {
  /** 启动/复用 Edge 并建立 CDP 监听;幂等。返回供工具回显的中文结果。 */
  start(url?: string): Promise<string>
  /** 优雅关闭;未运行时返回 false。 */
  stop(): Promise<boolean>
  consoleLogs(): ConsoleEntry[]
  networkLogs(): NetworkEntry[]
  /** 在页面上下文执行任意 JS,返回格式化结果(截断);页面抛错时以中文错误呈现。 */
  evaluate(expression: string): Promise<string>
  /** 取页面元信息(url/title/readyState/viewport)的 JSON 字符串。 */
  pageInfo(): Promise<string>
  /** 取页面正文 innerText(截断)。 */
  pageText(): Promise<string>
  /** 按 requestId 取网络条目详情(请求/响应头、请求体、响应体)。 */
  responseDetail(requestId: string): Promise<string>
  isRunning(): boolean
}

export function createEdgeDebugController(directory: string): EdgeDebugController {
  let child: ChildProcess | null = null
  let cdp: CdpClient | null = null
  const consoleBuffer = createRingBuffer<ConsoleEntry>()
  const networkBuffer = createRingBuffer<NetworkEntry>()
  // requestId → 待回填的请求信息(responseReceived 不携带 method/postData/请求头,3.2、3.5)
  const pendingRequests = new Map<string, { method: string; postData?: string; requestHeaders?: HeadersLike }>()

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
      const request = params["request"] as
        | { method?: string; postData?: string; headers?: HeadersLike }
        | undefined
      if (typeof requestId !== "string" || !request?.method) return
      pendingRequests.set(requestId, {
        method: request.method,
        // 请求体在入映射时即截断,约束环形缓冲外的暂存内存
        postData: request.postData ? truncateText(request.postData) : undefined,
        requestHeaders: request.headers,
      })
    })
    client.on("Network.responseReceived", (params) => {
      const requestId = params["requestId"]
      const response = params["response"] as
        | { status?: number; url?: string; mimeType?: string; headers?: HeadersLike }
        | undefined
      if (!response || typeof response.status !== "number" || !response.url || typeof requestId !== "string") return
      if (!shouldKeepResponse({ status: response.status, url: response.url, mimeType: response.mimeType ?? "" })) {
        return
      }
      const pending = pendingRequests.get(requestId)
      pendingRequests.delete(requestId)
      networkBuffer.push({
        time: nowTime(),
        requestId,
        method: pending?.method ?? "GET",
        url: response.url,
        status: response.status,
        mimeType: response.mimeType ?? "",
        postData: pending?.postData,
        requestHeaders: pending?.requestHeaders,
        responseHeaders: response.headers,
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

  /** 取当前 CDP 连接;未启动(或刚断开)时报错并引导先启动。 */
  function requireClient(): CdpClient {
    if (!cdp) {
      throw new EdgeDebugError("Edge 调试未启动。请先调用 start_edge_browser 启动浏览器并建立监听。")
    }
    return cdp
  }

  function runEvaluate(expression: string): Promise<string> {
    return evaluateOnPage(requireClient(), expression)
  }

  return {
    async start(url = DEFAULT_URL) {
      if (cdp) return "Edge 调试已在运行,无需重复启动。可用 get_browser_console_logs / get_browser_network_logs 查看日志,get_page_info / get_page_text / evaluate_in_page 读取页面,get_browser_response_detail 查看请求详情。"
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
      pendingRequests.clear()
      console.log("[edge-debug] Edge 浏览器及 CDP 监听已安全关闭")
      return true
    },

    consoleLogs() {
      return consoleBuffer.snapshot()
    },

    networkLogs() {
      return networkBuffer.snapshot()
    },

    evaluate(expression: string) {
      return runEvaluate(expression)
    },

    pageInfo() {
      return runEvaluate(PAGE_INFO_EXPRESSION)
    },

    pageText() {
      return runEvaluate(PAGE_TEXT_EXPRESSION)
    },

    async responseDetail(requestId: string) {
      const client = requireClient()
      const entry = requireNetworkEntry(networkBuffer.snapshot(), requestId)
      let body: string
      try {
        body = await fetchResponseBody(client, requestId)
      } catch (error) {
        // 资源可能已从浏览器缓冲淘汰(如导航后),补充语义与修复路径后抛出
        throw new EdgeDebugError(
          `获取响应体失败(requestId ${requestId},资源可能已被浏览器丢弃):${error instanceof Error ? error.message : String(error)}`,
        )
      }
      return JSON.stringify(
        {
          time: entry.time,
          method: entry.method,
          url: entry.url,
          status: entry.status,
          requestHeaders: entry.requestHeaders ?? {},
          responseHeaders: entry.responseHeaders ?? {},
          postData: entry.postData,
          body,
        },
        null,
        2,
      )
    },

    isRunning() {
      return cdp !== null
    },
  }
}

/** 页面求值与响应体拉取所需的最小客户端能力(便于零 mock 测试经假 CDP 服务注入)。 */
type EvaluateClient = Pick<CdpClient, "call">

/**
 * 在页面上下文执行 JS 并格式化结果(设计文档 3.5)。
 * 独立导出:配合假 CDP 服务做零 mock 契约测试。
 * 参数约定:returnByValue 直接取值、awaitPromise 支持页面内 await 异步、userGesture 模拟用户手势。
 */
export async function evaluateOnPage(client: EvaluateClient, expression: string): Promise<string> {
  const raw = await client.call(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true, userGesture: true },
    EVALUATE_TIMEOUT_MS,
  )
  return formatEvaluateOutcome(raw)
}

/** 拉取并格式化指定请求的响应体(独立导出以便零 mock 契约测试,设计文档 3.5)。 */
export async function fetchResponseBody(client: EvaluateClient, requestId: string): Promise<string> {
  const raw = await client.call("Network.getResponseBody", { requestId })
  return formatResponseBody(raw as ResponseBodyLike)
}
