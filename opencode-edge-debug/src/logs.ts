/**
 * 日志纯函数层(设计文档 3.2、3.3、3.5)。
 * 环形缓冲、网络降噪过滤、console 参数序列化、页面求值结果格式化、
 * 网络详情组装——全部为无副作用纯逻辑,独立于 CDP 与进程,便于单元测试。
 */
import { EdgeDebugError } from "./errors"

/** 每类日志最多保留的条数,超出则丢弃最旧(设计文档 3.3)。 */
export const MAX_LOGS = 50

/** 求值结果、页面正文、响应体、请求体等文本输出的字符上限,超出截断(设计文档 3.5)。 */
export const MAX_TEXT_CHARS = 20_000

export interface ConsoleEntry {
  time: string
  level: string
  text: string
}

/** CDP header 对象的最小子集(键值均为字符串)。 */
export type HeadersLike = Record<string, string>

export interface NetworkEntry {
  time: string
  /** CDP 请求 id,供 get_browser_response_detail 按条目取详情(设计文档 3.5)。 */
  requestId: string
  method: string
  url: string
  status: number
  mimeType: string
  /** 请求体(POST payload,来自 requestWillBeSent 事件;流式/二进制等场景可能缺省)。 */
  postData?: string
  requestHeaders?: HeadersLike
  responseHeaders?: HeadersLike
}

/** 网络日志列表的精简条目(headers/postData 不入列表,详情走 get_browser_response_detail)。 */
export interface NetworkEntrySummary {
  time: string
  requestId: string
  method: string
  url: string
  status: number
  mimeType: string
}

/** CDP Runtime.RemoteObject 的最小子集(仅本插件用到的字段)。 */
export interface RemoteObjectLike {
  value?: unknown
  description?: string
  type?: string
}

/**
 * 环形缓冲:容量固定,写入超出时丢弃最旧条目。
 * 返回快照读方法,避免外部直接持有内部数组。
 */
export function createRingBuffer<T>(capacity: number = MAX_LOGS) {
  const items: T[] = []
  return {
    push(item: T): void {
      items.push(item)
      if (items.length > capacity) items.shift()
    },
    snapshot(): T[] {
      return [...items]
    },
    clear(): void {
      items.length = 0
    },
    size(): number {
      return items.length
    },
  }
}

export type RingBuffer<T> = ReturnType<typeof createRingBuffer<T>>

/** 当前时间的 HH:MM:SS 字符串(供日志条目时间戳)。 */
export function nowTime(date: Date = new Date()): string {
  return date.toTimeString().slice(0, 8)
}

/**
 * 网络降噪:判断一条响应是否值得记录(设计文档 3.3)。
 * 规则:状态码 >= 400 一律保留;否则仅保留疑似 API 的请求
 * (URL 含 /api/ 或 MIME 为 json);静态资源(css/png/字体等)丢弃。
 */
export function shouldKeepResponse(input: { status: number; url: string; mimeType: string }): boolean {
  if (input.status >= 400) return true
  if (input.url.includes("/api/")) return true
  if (input.mimeType.includes("json")) return true
  return false
}

/**
 * 将 CDP console 参数对象序列化为可读文本(设计文档 3.2)。
 * 优先取 value;否则取 description(对象/函数的摘要);最后兜底为类型名。
 */
export function formatRemoteObject(obj: RemoteObjectLike): string {
  if (obj.value !== undefined) {
    if (typeof obj.value === "string") return obj.value
    try {
      return JSON.stringify(obj.value)
    } catch {
      return String(obj.value)
    }
  }
  if (obj.description !== undefined) return obj.description
  return obj.type ?? "unknown"
}

/** 将一组 console 参数序列化为单行文本,以空格连接。 */
export function formatConsoleArgs(args: RemoteObjectLike[]): string {
  return args.map(formatRemoteObject).join(" ")
}

/**
 * 截断超长文本并附标注,用于 evaluate 结果、页面正文、响应体、请求体等输出(设计文档 3.5)。
 */
export function truncateText(text: string, max: number = MAX_TEXT_CHARS): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…[内容过长已截断,原始长度 ${text.length} 字符]`
}

/** 网络日志条目 → 列表精简条目(headers/postData 仅入详情,为 Agent 降噪)。 */
export function toNetworkSummary(entry: NetworkEntry): NetworkEntrySummary {
  return {
    time: entry.time,
    requestId: entry.requestId,
    method: entry.method,
    url: entry.url,
    status: entry.status,
    mimeType: entry.mimeType,
  }
}

/** Runtime.evaluate 返回中 exceptionDetails 的最小子集。 */
interface ExceptionDetailsLike {
  text?: string
  exception?: { description?: string; value?: unknown }
}

/**
 * 格式化 Runtime.evaluate 的返回(设计文档 3.5)。
 * 页面内抛错时以带堆栈摘要的 EdgeDebugError 呈现,便于 Agent 修正表达式后重试;
 * 正常结果复用 console 参数的序列化规则并截断。
 */
export function formatEvaluateOutcome(raw: unknown): string {
  const { result, exceptionDetails } = (raw ?? {}) as {
    result?: RemoteObjectLike
    exceptionDetails?: ExceptionDetailsLike
  }
  if (exceptionDetails) {
    const exception = exceptionDetails.exception
    const detail =
      exception?.description ??
      (exception?.value !== undefined ? String(exception.value) : undefined) ??
      exceptionDetails.text ??
      "未知异常"
    throw new EdgeDebugError(`页面求值出错:${detail}`)
  }
  return truncateText(formatRemoteObject(result ?? {}))
}

/** Network.getResponseBody 返回的最小子集。 */
export interface ResponseBodyLike {
  body?: string
  base64Encoded?: boolean
}

/** base64 编码串解码后的字节数(纯算术,避免引入编码解码依赖)。 */
function base64ByteLength(encoded: string): number {
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((encoded.length * 3) / 4) - padding)
}

/**
 * 格式化网络响应体(设计文档 3.5)。
 * 文本原样返回(截断);二进制内容不倾倒乱码,以占位说明代替。
 */
export function formatResponseBody(response: ResponseBodyLike): string {
  const body = response.body ?? ""
  if (response.base64Encoded) return `[二进制内容, 共 ${base64ByteLength(body)} 字节]`
  return truncateText(body)
}

/**
 * 按 requestId 从网络日志快照中取条目(设计文档 3.5)。
 * 未找到(被环形缓冲淘汰或 id 有误)时报错并引导 Agent 先获取网络日志。
 */
export function requireNetworkEntry(entries: NetworkEntry[], requestId: string): NetworkEntry {
  const entry = entries.find((item) => item.requestId === requestId)
  if (!entry) {
    throw new EdgeDebugError(
      `未在网络日志中找到 requestId ${requestId}。请先调用 get_browser_network_logs 获取当前条目的 requestId(条目可能已被环形缓冲淘汰)。`,
    )
  }
  return entry
}

/** 页面元信息求值表达式:一次取齐 url/title/readyState/viewport(JSON 字符串结果,保证可序列化)。 */
export const PAGE_INFO_EXPRESSION =
  'JSON.stringify({url: location.href, title: document.title, readyState: document.readyState, viewport: {width: innerWidth, height: innerHeight}})'

/** 页面正文求值表达式:取 body 的 innerText(无 body 时返回空串)。 */
export const PAGE_TEXT_EXPRESSION = 'document.body?.innerText ?? ""'
