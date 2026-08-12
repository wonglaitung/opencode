/**
 * 插件入口（设计文档 2.4、8）。
 * 由 opencode config.plugin 加载，运行于 daemon 进程内。
 * 注册 5 类 hooks：
 *   - experimental.chat.system.transform  每轮注入规则 + WorkflowState（7.1）
 *   - tool                                工作流工具集（4.1）
 *   - tool.execute.before                 提交门禁硬拦截（7.3）
 *   - tool.execute.after                  迭代计数
 *   - chat.message                        会话首次活动打 account_id（3.1）+ 汇报触发
 * 启动后台任务（孤儿清理/标题回填/补推汇报）延后触发，见 startup.ts。
 */
import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { readIdentity, resolveWorkflowType } from "sm-shared"
import { Store, isPlaceholderTitle } from "./db"
import { createCommitGate } from "./gate"
import { stampSessionAccount } from "./identity"
import { createSystemTransform } from "./prompt"
import { createReporter, type Usage } from "./report"
import { STARTUP_DELAY_MS, deferredStartup } from "./startup"
import { createIterationCounter } from "./tools/quality"
import { createReviewTools } from "./tools/review"
import { createWorkflowTools } from "./tools/workflow"
import { makeSubagentChecker } from "./subagent"

/** 经上游 SDK 汇总会话 cost/tokens（step-finish 分段求和；失败返回空值，3.1）。 */
function createUsageProvider(client: PluginInput["client"]) {
  return async (sessionID: string): Promise<Usage> => {
    const empty: Usage = { cost: null, tokensInput: null, tokensOutput: null }
    try {
      const res = await client.session.messages({ path: { id: sessionID } })
      const messages = res.data
      if (!messages) return empty
      let cost = 0
      let input = 0
      let output = 0
      let seen = false
      for (const msg of messages) {
        for (const part of msg.parts) {
          if (part.type !== "step-finish") continue
          seen = true
          cost += part.cost
          input += part.tokens.input
          output += part.tokens.output
        }
      }
      if (!seen) return empty
      return { cost, tokensInput: input, tokensOutput: output }
    } catch {
      return empty
    }
  }
}

/**
 * chat.message 时补当前会话标题（5.2）：仅库内标题为空或为占位符（New session - …）时才经
 * session.get 拉取，避免每消息都调远程；真实标题已同步则跳过。占位符非真实标题，
 * 必须视为未同步照常刷新，否则会停留在过期占位符导致 stats/list 标题对不上。
 * 失败静默。
 * 注意：内部辅助函数**不要加 export**——opencode 的 legacy 插件加载器会把模块
 * 「所有函数导出」都当作插件工厂，以 (input, options) 逐一调用，曾致插件加载失败
 * （见 CLAUDE.md 铁律）。
 */
async function syncSessionTitle(store: Store, client: PluginInput["client"], sessionID: string): Promise<void> {
  const cur = store.get(sessionID)?.title
  if (cur && !isPlaceholderTitle(cur)) return
  try {
    const res = await client.session.get({ path: { id: sessionID } })
    const title = res.data?.title
    store.setTitle(sessionID, title ?? "")
  } catch {
    // 上游瞬时不可达：跳过，下次 chat.message 再补
  }
}

const SessionMgmtPlugin: Plugin = async (input) => {
  // 用户级流程选择（3.1）：新建会话时读 identity.workflowType（缺省 sdlc），身份快照语义。
  const store = Store.open(input.directory, () => resolveWorkflowType(readIdentity()?.workflowType))
  const usageProvider = createUsageProvider(input.client)
  const reporter = createReporter(store, () => readIdentity(), usageProvider)
  // 子代理会话识别器（2.4 统计纯净度）：对子代理跳过建记录/打标/汇报/规则注入
  const isSubagent = makeSubagentChecker(input.client)

  // 启动后台任务延后执行（错开 TUI 首屏 / daemon 启动竞态，启动慢根因之一）：
  // 一次 session.list 完成 孤儿清理 + 标题回填（startup.ts），随后补推缓冲汇报。
  const startup = setTimeout(() => {
    void deferredStartup(store, input.client)
    void reporter.flushOutbox()
  }, STARTUP_DELAY_MS)
  // 定时补推缓冲汇报（收集服务不可用期间本地暂存，2.4）。
  const timer = setInterval(() => {
    void reporter.flushOutbox()
  }, 5 * 60 * 1000)

  return {
    "experimental.chat.system.transform": createSystemTransform(store, isSubagent),

    tool: {
      ...createWorkflowTools(store),
      ...createReviewTools(store),
    },

    "tool.execute.before": createCommitGate(store),

    "tool.execute.after": createIterationCounter(store, isSubagent),

    "chat.message": async (hookInput) => {
      // 子代理会话不追踪：不建记录、不打标、不汇报（2.4 统计纯净度）
      if (await isSubagent(hookInput.sessionID)) return
      stampSessionAccount(store, hookInput.sessionID)
      await syncSessionTitle(store, input.client, hookInput.sessionID)
      await reporter.enqueueReport(hookInput.sessionID)
    },

    dispose: async () => {
      clearTimeout(startup)
      clearInterval(timer)
      await reporter.flushOutbox()
      store.close()
    },
  }
}

export default SessionMgmtPlugin
