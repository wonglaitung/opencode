/**
 * 极简 CDP 客户端(设计文档 3.1、决策记录 D1)。
 * 零依赖:HTTP 探测用 fetch,WebSocket 用 bun 原生实现。
 * 只覆盖本插件所需:命令调用(id 配对)、事件订阅、关闭,不实现完整协议。
 */
import { EdgeDebugError } from "./errors"

/** 单条 CDP 命令的默认超时(毫秒)。 */
export const CDP_CALL_TIMEOUT_MS = 10_000
/** CDP 就绪探测:轮询间隔与总超时(毫秒)。 */
export const PROBE_INTERVAL_MS = 300
export const PROBE_TIMEOUT_MS = 15_000

export type CdpEventHandler = (params: Record<string, unknown>) => void

interface PendingCall {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface CdpMessage {
  id?: number
  result?: unknown
  error?: { message?: string }
  method?: string
  params?: Record<string, unknown>
}

/** 极简 CDP 客户端:命令调用、事件订阅、关闭。 */
export class CdpClient {
  private nextId = 1
  private pending = new Map<number, PendingCall>()
  private handlers = new Map<string, CdpEventHandler[]>()
  private closeCallbacks: Array<() => void> = []

  private constructor(private ws: WebSocket) {
    ws.onmessage = (event) => {
      this.dispatch(String(event.data))
    }
    ws.onclose = () => {
      this.failAll(new EdgeDebugError("CDP WebSocket 连接已断开"))
      this.fireCloseCallbacks()
    }
    ws.onerror = () => {
      this.failAll(new EdgeDebugError("CDP WebSocket 连接出错"))
    }
  }

  /** 连接到指定 CDP WebSocket 地址;握手失败时拒绝。 */
  static connect(wsUrl: string): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl)
      let settled = false
      ws.onopen = () => {
        settled = true
        resolve(new CdpClient(ws))
      }
      ws.onerror = () => {
        if (!settled) reject(new EdgeDebugError(`无法连接 CDP WebSocket:${wsUrl}`))
      }
    })
  }

  /** 发送一条 CDP 命令,返回其 result;连接不可用、协议错误或超时拒绝。 */
  call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      // WHATWG 规范下 CLOSING/CLOSED 状态 send 静默丢弃,须先行判定快速失败
      if (this.ws.readyState !== WebSocket.OPEN) {
        reject(new EdgeDebugError(`CDP 连接不可用,无法发送命令:${method}`))
        return
      }
      const id = this.nextId++
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch {
        reject(new EdgeDebugError(`CDP 连接不可用,无法发送命令:${method}`))
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new EdgeDebugError(`CDP 命令超时:${method}`))
      }, CDP_CALL_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
    })
  }

  /** 订阅一个 CDP 事件(如 Runtime.consoleAPICalled)。 */
  on(method: string, handler: CdpEventHandler): void {
    const list = this.handlers.get(method) ?? []
    list.push(handler)
    this.handlers.set(method, list)
  }

  /** 注册连接关闭回调(浏览器被手动关闭、Browser.close 等场景)。 */
  onClose(callback: () => void): void {
    this.closeCallbacks.push(callback)
  }

  /** 关闭连接:未完成的命令以错误结束,随后关闭 WebSocket。 */
  close(): void {
    this.failAll(new EdgeDebugError("CDP 客户端已关闭"))
    try {
      this.ws.close()
    } catch {
      // 连接可能已断开,忽略
    }
    this.fireCloseCallbacks()
  }

  private fireCloseCallbacks(): void {
    const callbacks = this.closeCallbacks
    this.closeCallbacks = []
    for (const callback of callbacks) callback()
  }

  private dispatch(raw: string): void {
    let message: CdpMessage
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (message.id !== undefined) {
      const call = this.pending.get(message.id)
      if (!call) return
      this.pending.delete(message.id)
      clearTimeout(call.timer)
      if (message.error) call.reject(new EdgeDebugError(`CDP 命令失败:${message.error.message ?? "未知错误"}`))
      else call.resolve(message.result)
      return
    }
    if (!message.method) return
    for (const handler of this.handlers.get(message.method) ?? []) {
      handler(message.params ?? {})
    }
  }

  private failAll(error: Error): void {
    for (const [, call] of this.pending) {
      clearTimeout(call.timer)
      call.reject(error)
    }
    this.pending.clear()
  }
}

/** 探测指定端口的 CDP HTTP 端点是否就绪(启动等待与实例复用判定)。 */
export async function probeVersion(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`)
    return res.ok
  } catch {
    return false
  }
}

export interface CdpTarget {
  id?: string
  type?: string
  url?: string
  webSocketDebuggerUrl?: string
}

/** 取第一个 page 类型 target 的 WebSocket 地址;无可用 target 返回 null。 */
export async function getPageTargetWsUrl(port: number): Promise<string | null> {
  let res: Response
  try {
    res = await fetch(`http://127.0.0.1:${port}/json`)
  } catch {
    throw new EdgeDebugError(`无法获取 CDP target 列表(端口 ${port} 未响应)`)
  }
  if (!res.ok) throw new EdgeDebugError(`获取 CDP target 列表失败:HTTP ${res.status}`)
  const targets = (await res.json()) as CdpTarget[]
  const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl)
  return page?.webSocketDebuggerUrl ?? null
}

/**
 * 轮询等待 CDP 端点就绪,直到成功或超时(超时间隔与时长可注入以便测试)。
 */
export function waitForCdp(
  port: number,
  intervalMs: number = PROBE_INTERVAL_MS,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      void probeVersion(port).then((ready) => {
        if (ready) {
          clearInterval(timer)
          resolve()
          return
        }
        if (Date.now() - started >= timeoutMs) {
          clearInterval(timer)
          reject(new EdgeDebugError(`等待 Edge CDP 端口 ${port} 就绪超时(${Math.round(timeoutMs / 1000)} 秒)`))
        }
      })
    }, intervalMs)
  })
}
