/**
 * 插件入口(设计文档 2)。
 * 铁律:入口文件只允许 default export 插件函数——
 * 上游 legacy loader 会遍历模块全部导出,其他命名导出会导致加载失败。
 */
import { tool, type Plugin } from "@opencode-ai/plugin"
import { createEdgeDebugController } from "./controller"
import { toNetworkSummary } from "./logs"

const z = tool.schema

const EdgeDebugPlugin: Plugin = async (input) => {
  // directory:当前会话所在项目目录,专用浏览器 profile 落在此目录下
  const controller = createEdgeDebugController(input.directory)

  const startEdgeBrowser = tool({
    description:
      "启动 Microsoft Edge 浏览器并建立调试监听(按需调试,非自动化框架)。启动后可用 get_browser_console_logs / get_browser_network_logs 抓取日志,get_page_info / get_page_text / evaluate_in_page 读取页面信息,get_browser_response_detail 查看网络请求详情,用 close_edge_browser 关闭。",
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
      "获取已启动的 Edge 浏览器中页面的网络请求日志(仅保留 4xx/5xx 错误与疑似 API 请求,最多最近 50 条)。返回条目含 requestId,可传给 get_browser_response_detail 查看请求/响应头与响应体。需先调用 start_edge_browser。",
    args: {},
    async execute() {
      if (!controller.isRunning()) {
        return "Edge 调试未启动。请先调用 start_edge_browser 启动浏览器并建立监听。"
      }
      const logs = controller.networkLogs().map(toNetworkSummary)
      if (logs.length === 0) return "暂无符合条件的网络请求(仅记录 4xx/5xx 错误与疑似 API 请求)。"
      return JSON.stringify(logs, null, 2)
    },
  })

  const evaluateInPage = tool({
    description:
      "在页面上下文执行任意 JavaScript 并返回结果(等同在 DevTools Console 执行)。支持 await(如 await fetch('/api/x').then(r => r.json()))读取接口数据、DOM 内容、JS 运行时状态、localStorage 等。结果超过 2 万字符会截断。仅作用于 start_edge_browser 启动/接入的那个页面,新开标签页不在范围。",
    args: {
      expression: z.string().describe("要在页面中执行的 JavaScript 表达式"),
    },
    async execute(args) {
      if (!controller.isRunning()) {
        return "Edge 调试未启动。请先调用 start_edge_browser 启动浏览器并建立监听。"
      }
      return await controller.evaluate(args.expression)
    },
  })

  const getPageInfo = tool({
    description:
      "获取当前页面的元信息:URL、标题、readyState、视口尺寸(JSON)。适合先确认浏览器停在哪个页面。需先调用 start_edge_browser。",
    args: {},
    async execute() {
      if (!controller.isRunning()) {
        return "Edge 调试未启动。请先调用 start_edge_browser 启动浏览器并建立监听。"
      }
      return await controller.pageInfo()
    },
  })

  const getPageText = tool({
    description:
      "获取当前页面正文的可见文本(document.body.innerText,超过 2 万字符截断)。适合快速了解页面渲染出了什么内容。需要 DOM 细节时改用 evaluate_in_page 执行自定义表达式。需先调用 start_edge_browser。",
    args: {},
    async execute() {
      if (!controller.isRunning()) {
        return "Edge 调试未启动。请先调用 start_edge_browser 启动浏览器并建立监听。"
      }
      return await controller.pageText()
    },
  })

  const getBrowserResponseDetail = tool({
    description:
      "按 requestId 查看一条网络请求的完整详情:请求/响应头、请求体(POST payload)、响应体(二进制内容只给出大小)。requestId 取自 get_browser_network_logs 返回的条目。需先调用 start_edge_browser。",
    args: {
      requestId: z.string().describe("网络请求 id,来自 get_browser_network_logs 的条目"),
    },
    async execute(args) {
      if (!controller.isRunning()) {
        return "Edge 调试未启动。请先调用 start_edge_browser 启动浏览器并建立监听。"
      }
      return await controller.responseDetail(args.requestId)
    },
  })

  return {
    tool: {
      start_edge_browser: startEdgeBrowser,
      close_edge_browser: closeEdgeBrowser,
      get_browser_console_logs: getBrowserConsoleLogs,
      get_browser_network_logs: getBrowserNetworkLogs,
      evaluate_in_page: evaluateInPage,
      get_page_info: getPageInfo,
      get_page_text: getPageText,
      get_browser_response_detail: getBrowserResponseDetail,
    },
    dispose: async () => {
      // 插件卸载(会话结束/opencode 退出)时兜底清理浏览器进程
      await controller.stop()
    },
  }
}

export default EdgeDebugPlugin
