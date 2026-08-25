/**
 * 日志纯函数层(设计文档 3.2、3.3)。
 * 环形缓冲、网络降噪过滤、console 参数序列化——
 * 全部为无副作用纯逻辑,独立于 CDP 与进程,便于单元测试。
 */

/** 每类日志最多保留的条数,超出则丢弃最旧(设计文档 3.3)。 */
export const MAX_LOGS = 50

export interface ConsoleEntry {
  time: string
  level: string
  text: string
}

export interface NetworkEntry {
  time: string
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
