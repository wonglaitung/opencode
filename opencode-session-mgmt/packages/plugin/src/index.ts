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
import { createIterationCounter } from "./tools/quality"
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

/**
 * 启动一次性回填会话标题（5.2）：经 session.list 取全部标题，写入插件库。
 * 与 cleanupOrphans 共用一次 list 调用；仅补空标题、不覆盖已有值。
 * 失败静默（上游不可达时不影响功能，标题下次再补）。
 */
// 注意：以下两个标题同步辅助函数仅供插件工厂内部调用，**不要加 export**。
// opencode 的 legacy 插件加载器会把模块「所有函数导出」都当作插件工厂，
// 依次以 (input, options) 调用：syncSessionTitle(input,…) 首行 store.get(sessionID)
// 会因 input 无 get 方法而抛 "store.get is not a function"，导致插件加载失败、
// opencode 启动报 "Unexpected server error"（曾踩坑，见 5.2）。
async function backfillSessionTitles(store: Store, client: PluginInput["client"]): Promise<void> {
  try {
    const res = await client.session.list()
    const sessions = res.data
    if (!sessions || sessions.length === 0) return
    const titles = new Map<string, string>()
    for (const s of sessions) if (s.title) titles.set(s.id, s.title)
    store.backfillTitles(titles)
  } catch {
    // 上游不可达：跳过本次回填（不影响功能）
  }
}

/**
 * chat.message 时补当前会话标题（5.2）：仅库内标题为空时才经 session.get 拉取，
 * 避免每条消息都调远程；标题在会话早期生成，拉取到非空即写库、后续跳过。
 * 失败静默。
 */
async function syncSessionTitle(store: Store, client: PluginInput["client"], sessionID: string): Promise<void> {
  if (store.get(sessionID)?.title) return
  try {
    const res = await client.session.get({ path: { id: sessionID } })
    const title = res.data?.title
    store.setTitle(sessionID, title ?? "")
  } catch {
    // 上游瞬时不可达：跳过，下次 chat.message 再补
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
  // 启动时一次性回填存量会话标题（5.2，daemon 不可达时 CLI 仍可读标题）。
  void backfillSessionTitles(store, input.client)
  const timer = setInterval(() => {
    void reporter.flushOutbox()
  }, 5 * 60 * 1000)

  return {
    "experimental.chat.system.transform": createSystemTransform(store),

    tool: {
      ...createWorkflowTools(store),
      ...createReviewTools(store),
    },

    "tool.execute.before": createCommitGate(store),

    "tool.execute.after": createIterationCounter(store),

    "chat.message": async (hookInput) => {
      stampSessionAccount(store, hookInput.sessionID)
      await syncSessionTitle(store, input.client, hookInput.sessionID)
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
