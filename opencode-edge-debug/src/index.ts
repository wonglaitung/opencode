/**
 * 插件入口(设计文档 2)。
 * 铁律:入口文件只允许 default export 插件函数——
 * 上游 legacy loader 会遍历模块全部导出,其他命名导出会导致加载失败。
 */
import { tool, type Plugin } from "@opencode-ai/plugin"
import { createEdgeDebugController } from "./controller"

const z = tool.schema

const EdgeDebugPlugin: Plugin = async (input) => {
  // directory:当前会话所在项目目录,专用浏览器 profile 落在此目录下
  const controller = createEdgeDebugController(input.directory)

  const startEdgeBrowser = tool({
    description:
      "启动 Microsoft Edge 浏览器并建立调试监听(按需调试,非自动化框架)。启动后可用 get_browser_console_logs / get_browser_network_logs 抓取日志,用 close_edge_browser 关闭。",
    args: {
      url: z.string().optional().describe("要打开的页面地址,默认 http://localhost:3000"),
    },
    async execute(args) {
      return await controller.start(args.url)
    },
  })

  const closeEdgeBrowser = tool({
    description: "安全关闭由 start_edge_browser 启动的 Edge 浏览器及调试监听。未运行时不会报错。",
    args: {},
    async execute() {
      const closed = await controller.stop()
      return closed
        ? "🛑 Edge 浏览器已安全关闭,调试监听已停止。"
        : "ℹ️ 当前 Edge 浏览器并未在调试模式下运行,无需关闭。"
    },
  })

  const getBrowserConsoleLogs = tool({
    description:
      "获取已启动的 Edge 浏览器中页面的 console 日志(含未捕获异常),最多保留最近 50 条。需先调用 start_edge_browser。",
    args: {},
    async execute() {
      if (!controller.isRunning()) {
        return "Edge 调试未启动。请先调用 start_edge_browser 启动浏览器并建立监听。"
      }
      const logs = controller.consoleLogs()
      if (logs.length === 0) return "暂无 console 日志。"
      return JSON.stringify(logs, null, 2)
    },
  })

  const getBrowserNetworkLogs = tool({
    description:
      "获取已启动的 Edge 浏览器中页面的网络请求日志(仅保留 4xx/5xx 错误与疑似 API 请求,最多最近 50 条)。需先调用 start_edge_browser。",
    args: {},
    async execute() {
      if (!controller.isRunning()) {
        return "Edge 调试未启动。请先调用 start_edge_browser 启动浏览器并建立监听。"
      }
      const logs = controller.networkLogs()
      if (logs.length === 0) return "暂无符合条件的网络请求(仅记录 4xx/5xx 错误与疑似 API 请求)。"
      return JSON.stringify(logs, null, 2)
    },
  })

  return {
    tool: {
      start_edge_browser: startEdgeBrowser,
      close_edge_browser: closeEdgeBrowser,
      get_browser_console_logs: getBrowserConsoleLogs,
      get_browser_network_logs: getBrowserNetworkLogs,
    },
    dispose: async () => {
      // 插件卸载(会话结束/opencode 退出)时兜底清理浏览器进程
      await controller.stop()
    },
  }
}

export default EdgeDebugPlugin
