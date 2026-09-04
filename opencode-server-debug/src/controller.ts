/**
 * 调试会话编排(设计文档 3.4)。
 * createServerDebugController:connect → verify → 活动会话;闭包持有连接信息与 SshClient。
 * 状态(conn / client / 日志环形缓冲)由闭包持有——插件规范:不在模块顶层持有状态。
 * 连接信息(地址/用户/密码)仅存内存,disconnect / dispose 即清空,退出 opencode 即失,绝不落盘(设计文档 6)。
 */
import { createSshClient, type ServerConnection, type SshClient } from "./ssh"
import { ServerDebugError } from "./errors"
import {
  bucketByTime,
  buildContextCommand,
  buildErrorSearchCommand,
  buildFindLineCommand,
  buildListFilesCommand,
  buildTailCommand,
  createRingBuffer,
  groupErrors,
  parseLogEvents,
  rankRootCause,
  truncateText,
} from "./logs"

/** 单次日志查看在内存缓冲的行数上限。 */
const MAX_LOGS = 500

export interface GetLogsInput {
  path?: string
  lines?: number
  level?: string
  grep?: string
  since?: string
}

export interface SearchInput {
  path?: string
  since?: string
  contextLines?: number
  topN?: number
}

export interface ContextInput {
  path: string
  line?: number
  match?: string
  contextLines?: number
}

export interface AnalyzeInput {
  path?: string
  topN?: number
}

export interface ServerDebugController {
  /** 建立 SSH 连接并验证可达、列出日志文件;幂等。返回供工具回显的中文结果。 */
  connect(conn: ServerConnection): Promise<string>
  /** 清空内存连接与缓冲;未连接返回 false。 */
  disconnect(): boolean
  isConnected(): boolean
  getServerLogs(input: GetLogsInput): Promise<string>
  searchErrors(input: SearchInput): Promise<string>
  getContext(input: ContextInput): Promise<string>
  analyze(input: AnalyzeInput): Promise<string>
}

export function createServerDebugController(opts?: {
  /** 注入 SshClient 工厂(测试用);默认走真实 createSshClient。 */
  createClient?: () => Promise<SshClient>
}): ServerDebugController {
  let conn: ServerConnection | null = null
  let client: SshClient | null = null
  const logBuffer = createRingBuffer<string>(MAX_LOGS)

  const NOT_CONNECTED = "尚未连接服务器。请先调用 connect_server 建立连接。"

  function resolvePath(c: ServerConnection, path?: string): string {
    if (path) return path
    if (c.logPaths.length === 1) return c.logPaths[0]
    throw new ServerDebugError(
      `未指定日志路径,且配置了多个日志文件(${c.logPaths.join("、")})。请在 path 参数中明确指定其一。`,
    )
  }

  return {
    async connect(input) {
      if (conn) {
        return "服务器调试会话已在运行中,无需重复连接。可用 get_server_logs / search_server_errors 查看日志,get_log_context 查看错误上下文,analyze_server_errors 分析错误。"
      }
      const factory = opts?.createClient ?? (() => createSshClient())
      const created = await factory()
      await created.verify(input)
      client = created
      conn = input
      const listing = await created.run(input, buildListFilesCommand(input.logPaths))
      return `已通过 SSH 连接 ${input.user}@${input.host}:${input.port} 并建立日志调试会话。日志文件清单:\n${listing}\n可用 get_server_logs / search_server_errors / get_log_context / analyze_server_errors 进行错误分析。`
    },

    disconnect() {
      if (!conn && !client) return false
      conn = null
      client = null
      logBuffer.clear()
      return true
    },

    isConnected() {
      return conn !== null
    },

    async getServerLogs(input) {
      if (!conn || !client) return NOT_CONNECTED
      const path = resolvePath(conn, input.path)
      const cmd = buildTailCommand(path, input.lines ?? 200, {
        level: input.level,
        grep: input.grep,
        since: input.since,
      })
      const raw = await client.run(conn, cmd)
      if (raw.trim() === "") return "该日志文件在过滤条件下没有内容。"
      const lines = raw.split(/\r?\n/).filter((l) => l !== "")
      lines.forEach((l) => logBuffer.push(l))
      return truncateText(lines.join("\n"))
    },

    async searchErrors(input) {
      if (!conn || !client) return NOT_CONNECTED
      const path = resolvePath(conn, input.path)
      const raw = await client.run(conn, buildErrorSearchCommand(path))
      const events = parseLogEvents(raw)
      const groups = groupErrors(events, input.topN ?? 20)
      if (groups.length === 0) return "最近窗口内未检测到 ERROR/FATAL 或异常堆栈。"
      return JSON.stringify(groups, null, 2)
    },

    async getContext(input) {
      if (!conn || !client) return NOT_CONNECTED
      const contextLines = input.contextLines ?? 3
      let centerLine = input.line
      if (centerLine === undefined) {
        if (!input.match) {
          throw new ServerDebugError("get_log_context 需提供 line(行号)或 match(子串)其一。")
        }
        const found = await client.run(conn, buildFindLineCommand(input.path, input.match))
        const num = found.match(/^(\d+):/m)
        if (!num) return "未找到匹配该子串的日志行。"
        centerLine = Number(num[1])
      }
      const raw = await client.run(conn, buildContextCommand(input.path, centerLine, contextLines))
      return truncateText(raw)
    },

    async analyze(input) {
      if (!conn || !client) return NOT_CONNECTED
      const path = resolvePath(conn, input.path)
      const raw = await client.run(conn, buildErrorSearchCommand(path))
      const events = parseLogEvents(raw)
      const groups = groupErrors(events, input.topN ?? 20)
      if (groups.length === 0) {
        return "最近窗口内未检测到 ERROR/FATAL 或异常堆栈,暂无需要分析的错误。"
      }

      const buckets = bucketByTime(events)
      const root = rankRootCause(groups)
      const components = [...new Set(groups.map((g) => g.component).filter((c): c is string => Boolean(c)))]

      const lines: string[] = []
      lines.push(`共发现 ${groups.length} 类错误${components.length ? `,涉及模块: ${components.join("、")}` : ""}。`)

      if (root) {
        const seen = [root.firstSeen, root.lastSeen].filter(Boolean).join(" → ")
        const matchLine = (root.firstLine ?? root.signature).slice(0, 60)
        lines.push("", "最可能根因:" +
          `[${root.level}] 出现 ${root.count} 次${seen ? `(${seen})` : ""}`)
        lines.push(`  签名: ${root.signature}`)
        lines.push(`  样例首行: ${root.firstLine ?? "(无)"}`)
        lines.push(`  建议: 用 get_log_context 传 match="${matchLine}" 查看完整堆栈`)
      }

      if (buckets.length > 0) {
        const max = Math.max(...buckets.map((b) => b.count))
        lines.push("", "时间分布:")
        for (const b of buckets) {
          const peak = buckets.length > 1 && b.count === max ? "  ← 峰值" : ""
          lines.push(`  ${b.bucket} : ${b.count} 条${peak}`)
        }
      }

      lines.push("", "各错误类型(按计数降序):")
      groups.forEach((g, i) => {
        const seen = [g.firstSeen, g.lastSeen].filter(Boolean).join(" → ")
        lines.push(
          `${i + 1}. [${g.level}] 出现 ${g.count} 次${seen ? `(${seen})` : ""}${g.component ? ` 模块:${g.component}` : ""}`,
        )
        lines.push(`   签名: ${g.signature}`)
        lines.push(`   样例:\n${g.sample}`)
      })

      lines.push(
        "",
        "建议下一步:挑选出现次数最多或首次出现的错误,使用 get_log_context 传入其行号/子串查看完整堆栈,再结合代码定位根因。",
      )
      return truncateText(lines.join("\n"))
    },
  }
}
