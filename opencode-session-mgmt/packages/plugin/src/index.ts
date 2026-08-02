/**
 * 插件入口（设计文档 2.4、8）。
 * 由 opencode config.plugin 加载，运行于 daemon 进程内。
 * 注册 5 类 hooks：
 *   - experimental.chat.system.transform  每轮注入规则 + WorkflowState（7.1）
 *   - tool                                工作流工具集（4.1）
 *   - tool.execute.before                 提交门禁硬拦截（7.3）
 *   - tool.execute.after                  迭代计数
 *   - chat.message                        会话首次活动打 account_id（3.1）+ 汇报触发
 */
import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { readIdentity } from "sm-shared"
import { Store } from "./db"
import { createCommitGate } from "./gate"
import { stampSessionAccount } from "./identity"
import { createSystemTransform } from "./prompt"
import { createReporter, type Usage } from "./report"
import { createIterationCounter, createQualityTools } from "./tools/quality"
import { createReviewTools } from "./tools/review"
import { createWorkflowTools } from "./tools/workflow"

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
 * 惰性清理孤儿记录（3.1）：移除插件库中上游已删除的会话。
 * 保守策略：拿不到确切的非空会话列表时不清理，避免上游瞬时不可达导致误删。
 */
async function cleanupOrphans(store: Store, client: PluginInput["client"]): Promise<void> {
  try {
    const res = await client.session.list()
    const sessions = res.data
    if (!sessions || sessions.length === 0) return
    const valid = new Set(sessions.map((s) => s.id))
    const orphans = store
      .listAll()
      .map((r) => r.session_id)
      .filter((id) => !valid.has(id))
    if (orphans.length > 0) store.removeSessions(orphans)
  } catch {
    // 上游不可达：跳过本次清理（不影响功能）
  }
}

const SessionMgmtPlugin: Plugin = async (input) => {
  const store = Store.open(input.directory)
  const usageProvider = createUsageProvider(input.client)
  const reporter = createReporter(store, () => readIdentity(), usageProvider)

  // 启动时补推缓冲汇报，并定时刷新（收集服务不可用期间本地暂存，2.4）。
  void reporter.flushOutbox()
  // 启动时惰性清理孤儿记录（3.1）。
  void cleanupOrphans(store, input.client)
  const timer = setInterval(() => {
    void reporter.flushOutbox()
  }, 5 * 60 * 1000)

  return {
    "experimental.chat.system.transform": createSystemTransform(store),

    tool: {
      ...createWorkflowTools(store),
      ...createReviewTools(store),
      ...createQualityTools(store),
    },

    "tool.execute.before": createCommitGate(store),

    "tool.execute.after": createIterationCounter(store),

    "chat.message": async (hookInput) => {
      stampSessionAccount(store, hookInput.sessionID)
      await reporter.enqueueReport(hookInput.sessionID)
    },

    dispose: async () => {
      clearInterval(timer)
      await reporter.flushOutbox()
      store.close()
    },
  }
}

export default SessionMgmtPlugin
