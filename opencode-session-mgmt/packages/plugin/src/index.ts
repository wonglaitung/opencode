/**
 * 插件入口（设计文档 session-management.md 2.4、8 章；open-ide 合并 4、5）。
 * 由 opencode config.plugin 加载，运行于 daemon 进程内。
 * 注册 5 类 hooks + open-ide 合并部分：
 *   - experimental.chat.system.transform  每轮注入规则 + WorkflowState（7.1）‖ 锁定提示（open-ide 5.4）
 *   - tool                                工作流工具集（4.1）+ open_ide 打开/人工文件锁（open-ide 4、5）
 *   - tool.execute.before                 提交门禁硬拦截（7.3）‖ 人工文件锁拦截（open-ide 5.2，先行）
 *   - tool.execute.after                  迭代计数 + 状态变更后汇报入队（工具返回前落盘）
 *   - chat.message                        会话首次活动汇报触发 ‖ 工时证据捕获（取本次消息文本）
 *   - event                               session.status=idle 时可选刷新汇报（best-effort）
 * 启动后台任务（孤儿清理/标题回填/补推汇报）延后触发，见 startup.ts。
 * 合并后 open-ide 源码在 src/open-ide/；锁持久化进 Store（file_lock 表，重启自动恢复）。
 */
import { join } from "node:path"
import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"
import { readIdentity, resolveWorkflowType } from "sm-shared"
import { Store, isPlaceholderTitle } from "./db"
import { createCommitGate } from "./gate"
import { createTaskReviewGate } from "./task-review-gate"
import { resolveIdentity } from "./identity"
import { createSystemTransform } from "./prompt"
import { createReporter, type Usage } from "./report"
import { createIdleReportHook, createToolReportHook, enqueueReportSafe } from "./report-trigger"
import { STARTUP_DELAY_MS, deferredStartup } from "./startup"
import { createIterationCounter } from "./tools/quality"
import { markBusy, markIdle, recordActivity } from "./stats"
import { finishTask } from "./task-lifecycle"
import { createToolset } from "./tools/toolset"
import { applyBaselineProposal, applyQuestionBaselineProposal } from "./tools/baseline-proposal"
import { makeSubagentChecker } from "./subagent"
import { loadIdeConfig } from "./open-ide/config"
import { createLockRegistry } from "./open-ide/lock"
import { createLockGate } from "./open-ide/lock-gate"
import { createLockHintTransform } from "./open-ide/lock-hint"

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

/** 记录工作流活跃时间；未启动工作流的会话不建行。busySince 用于补记 workflow_start 前的 AI 运行。 */
function recordSessionActivity(store: Store, sessionID: string, busySince?: number): void {
  if (!store.get(sessionID)?.workflow) return
  store.mutateWorkflow(sessionID, (workflow) => {
    if (busySince !== undefined) markBusy(workflow, busySince)
    recordActivity(workflow)
  })
}

/** session.status：busy/retry 完整计时，idle 结算并暂停。 */
function recordSessionStatus(store: Store, sessionID: string, busy: boolean, at: number): void {
  if (!store.get(sessionID)?.workflow) return
  store.mutateWorkflow(sessionID, (workflow) => {
    if (busy) markBusy(workflow, at)
    else markIdle(workflow, at)
  })
}

const SessionMgmtPlugin: Plugin = async (input) => {
  // 用户级流程选择（3.1）：插件加载时读 identity.workflowType（缺省 sdlc），切换后需重启。
  const workflowType = resolveWorkflowType(readIdentity()?.workflowType)
  const store = Store.open(input.directory, () => workflowType)
  store.resetBusyTiming()
  const usageProvider = createUsageProvider(input.client)
  const reporter = createReporter(store, () => resolveIdentity(), usageProvider)
  // 子代理会话识别器（2.4 统计纯净度）：对子代理跳过建记录/打标/汇报/规则注入
  const isSubagent = makeSubagentChecker(input.client)
  // 会话启动时可能还没有 WorkflowState，先暂存 busy 起点，等 workflow_start 后补记。
  const busySince = new Map<string, number>()

  // ---- open-ide 合并部分：config.json（插件根，上溯一层）+ 人工文件锁（SQLite 持久化） ----
  const entries = loadIdeConfig(join(import.meta.dir, ".."))
  const registry = createLockRegistry(input.directory, store)
  const lockGate = createLockGate(registry, input.directory)
  const lockHint = createLockHintTransform(registry)
  const systemTransform = createSystemTransform(store, isSubagent, input.directory)
  const commitGate = createCommitGate(store)
  const reviewGate = createTaskReviewGate(store)
  const iterationCounter = createIterationCounter(store, isSubagent)
  const toolReport = createToolReportHook(reporter, isSubagent)
  const idleReport = createIdleReportHook(reporter, isSubagent)
  // 上游 event hook 不 await 调用方；串行化 busy/idle，避免并发时 idle 先于 busy 落地。
  let statusQueue = Promise.resolve()
  const statusTiming = (hookInput: { event: Event }) => {
    statusQueue = statusQueue
      .then(async () => {
        if (hookInput.event.type !== "session.status") return
        const sessionID = hookInput.event.properties.sessionID
        const at = Date.now()
        if (await isSubagent(sessionID)) return
        if (hookInput.event.properties.status.type === "idle") {
          busySince.delete(sessionID)
          recordSessionStatus(store, sessionID, false, at)
          return
        }
        const since = busySince.get(sessionID) ?? at
        busySince.set(sessionID, since)
        recordSessionStatus(store, sessionID, true, since)
      })
      .catch((error) => {
        console.warn(`[session-mgmt] 状态计时失败：${error instanceof Error ? error.message : String(error)}`)
      })
    return statusQueue
  }

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
    "experimental.chat.system.transform": async (hookInput, output) => {
      // 锁定提示对子代理照常生效（合并决策：保留 open-ide 全局拦截行为）
      await lockHint(hookInput, output)
      await systemTransform(hookInput, output)
    },

    tool: createToolset({
      store,
      workflowType,
      ideEntries: entries,
      lockRegistry: registry,
    }),

    // 人工文件锁拦截先行，提交门禁随后；任一 throw 即阻断本次工具调用。
    "tool.execute.before": async (hookInput, output) => {
      await lockGate(hookInput, output)
      await reviewGate(hookInput, output)
      await commitGate(hookInput, output)
    },

    "tool.execute.after": async (hookInput, output) => {
      const subagent = await isSubagent(hookInput.sessionID)
      if (!subagent) recordSessionActivity(store, hookInput.sessionID, busySince.get(hookInput.sessionID))
      if (hookInput.tool === "question" && !subagent) {
        applyQuestionBaselineProposal(
          store,
          hookInput.sessionID,
          hookInput.args,
          output.metadata,
          hookInput.callID,
        )
      }
      await iterationCounter(hookInput)
      await toolReport(hookInput)
    },

    event: async (hookInput) => {
      await statusTiming(hookInput)
      await idleReport(hookInput)
    },

    "chat.message": async (hookInput, output) => {
      // 子代理会话不追踪：不建记录、不汇报（2.4 统计纯净度）
      if (await isSubagent(hookInput.sessionID)) return
      const text = output.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
      // task：与 sdlc/reqdoc 一致，由模型调用 workflow_start 启动；这里只建行（不启动），
      // 供本次消息的工时证据与汇报使用。整句完成声明的自动收口仍在此处理。
      if (workflowType === "task") store.ensure(hookInput.sessionID)
      recordSessionActivity(store, hookInput.sessionID, busySince.get(hookInput.sessionID))
      finishTask(store, hookInput.sessionID, text)
      await syncSessionTitle(store, input.client, hookInput.sessionID)
      await enqueueReportSafe(reporter, hookInput.sessionID, "chat.message")
      // 6.3 防 AI 杜撰基线：工时证据取**本次** hook 消息的文本。不得回读历史消息
      // ——上游 chat.message 在消息落库前触发（prompt.ts 先 trigger 后 updateMessage），
      // 回读恒少当前这条：证据滞后一条，且会被上一条无工时消息清空，workflow_baseline
      // 就会连续拒收开发者已报出的数字（线上 P1，护栏见 test/baseline-hook.test.ts）。
      applyBaselineProposal(store, hookInput.sessionID, text, output.message.id)
    },

    dispose: async () => {
      clearTimeout(startup)
      clearInterval(timer)
      await statusQueue
      for (const sessionID of busySince.keys()) {
        if (store.get(sessionID)?.workflow) store.mutateWorkflow(sessionID, (workflow) => markIdle(workflow))
      }
      busySince.clear()
      await reporter.flushOutbox({ exit: true })
      store.close()
    },
  }
}

export default SessionMgmtPlugin
