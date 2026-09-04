/**
 * 插件入口(设计文档 2)。
 * 铁律:入口文件只允许 default export 插件函数——
 * 上游 legacy loader 会遍历模块全部导出,其他命名导出会导致加载失败。
 */
import { tool, type Plugin } from "@opencode-ai/plugin"
import { createServerDebugController } from "./controller"

const z = tool.schema

const ServerDebugPlugin: Plugin = async () => {
  const controller = createServerDebugController()

  const connectServer = tool({
    description:
      "经 SSH 连接远端 Linux 服务器并建立日志调试会话(按需调试,非自动化框架)。连接信息(地址/用户/密码)仅存内存,退出 opencode 即失,不会落盘。连接后可:get_server_logs 取最近日志、search_server_errors 聚类错误、get_log_context 看错误上下文、analyze_server_errors 汇总分析,用 disconnect_server 断开。",
    args: {
      host: z.string().describe("服务器地址(IP 或域名)"),
      port: z.number().optional().describe("SSH 端口,默认 22"),
      user: z.string().describe("登录用户名"),
      password: z.string().describe("登录密码(仅存内存,退出即失,不落盘)"),
      logPaths: z.array(z.string()).describe("要分析的日志文件绝对路径列表,如 [\"/var/log/app/app.log\"]"),
      identityFile: z
        .string()
        .optional()
        .describe("私钥路径(可选,与 password 二选一;提供了 password 时优先用密码认证)"),
    },
    async execute(args) {
      return await controller.connect({
        host: args.host,
        port: args.port ?? 22,
        user: args.user,
        password: args.password,
        identityFile: args.identityFile,
        logPaths: args.logPaths,
      })
    },
  })

  const disconnectServer = tool({
    description: "断开服务器调试会话并清空内存中的连接信息与日志缓冲。未连接时不会报错。",
    args: {},
    async execute() {
      const closed = controller.disconnect()
      return closed ? "🛑 已断开服务器连接,内存中的连接信息与日志缓冲已清空。" : "ℹ️ 当前并未建立服务器调试会话,无需断开。"
    },
  })

  const getServerLogs = tool({
    description:
      "获取远端日志文件最近的内容,可按级别/子串/时间前缀过滤。需先调用 connect_server。返回文本(超 2 万字符截断)。",
    args: {
      path: z.string().optional().describe("日志文件路径;未填且只配置了一个文件时自动使用"),
      lines: z.number().optional().describe("拉取最近行数,默认 200"),
      level: z.string().optional().describe("按级别过滤(TRACE/DEBUG/INFO/WARN/ERROR/FATAL,不区分大小写)"),
      grep: z.string().optional().describe("按子串过滤(远端 grep -i -F)"),
      since: z.string().optional().describe("按时间前缀子串过滤,如 \"2024-01-15 10:\"(远端 grep -F)"),
    },
    async execute(args) {
      if (!controller.isConnected()) {
        return "尚未连接服务器。请先调用 connect_server 建立连接。"
      }
      return await controller.getServerLogs({
        path: args.path,
        lines: args.lines,
        level: args.level,
        grep: args.grep,
        since: args.since,
      })
    },
  })

  const searchServerErrors = tool({
    description:
      "在远端日志最近窗口内搜索 ERROR/FATAL 与异常堆栈,按错误签名聚类(去重计数、首末出现、样例),返回结构化 JSON。需先调用 connect_server。",
    args: {
      path: z.string().optional().describe("日志文件路径;未填且只配置了一个文件时自动使用"),
      since: z.string().optional().describe("按时间前缀子串过滤(远端 grep -F)"),
      contextLines: z.number().optional().describe("预留:当前聚类在本地完成,此参数暂不影响结果"),
      topN: z.number().optional().describe("返回错误类型数量上限,默认 20"),
    },
    async execute(args) {
      if (!controller.isConnected()) {
        return "尚未连接服务器。请先调用 connect_server 建立连接。"
      }
      return await controller.searchErrors({ path: args.path, since: args.since, topN: args.topN })
    },
  })

  const getLogContext = tool({
    description:
      "按行号或子串定位一条日志,返回其前后若干行上下文(对标 get_browser_response_detail)。需先调用 connect_server。",
    args: {
      path: z.string().describe("日志文件路径"),
      line: z.number().optional().describe("行号(与 match 二选一)"),
      match: z.string().optional().describe("子串,用于定位首个匹配行号(与 line 二选一)"),
      contextLines: z.number().optional().describe("上下文行数(前后各取),默认 3"),
    },
    async execute(args) {
      if (!controller.isConnected()) {
        return "尚未连接服务器。请先调用 connect_server 建立连接。"
      }
      return await controller.getContext({
        path: args.path,
        line: args.line,
        match: args.match,
        contextLines: args.contextLines,
      })
    },
  })

  const analyzeServerErrors = tool({
    description:
      "汇总分析远端日志最近窗口内的错误:按类型归类与计数、按时间分桶标出突增尖峰、结合计数与最近出现排序给出最可能根因(含模块与下一步 get_log_context 建议)、列出各错误类型与样例堆栈。需先调用 connect_server。",
    args: {
      path: z.string().optional().describe("日志文件路径;未填且只配置了一个文件时自动使用"),
      topN: z.number().optional().describe("返回错误类型数量上限,默认 20"),
    },
    async execute(args) {
      if (!controller.isConnected()) {
        return "尚未连接服务器。请先调用 connect_server 建立连接。"
      }
      return await controller.analyze({ path: args.path, topN: args.topN })
    },
  })

  return {
    tool: {
      connect_server: connectServer,
      disconnect_server: disconnectServer,
      get_server_logs: getServerLogs,
      search_server_errors: searchServerErrors,
      get_log_context: getLogContext,
      analyze_server_errors: analyzeServerErrors,
    },
    dispose: async () => {
      // 插件卸载(会话结束/opencode 退出)时兜底清空内存连接与日志缓冲
      controller.disconnect()
    },
  }
}

export default ServerDebugPlugin
