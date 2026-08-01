/**
 * 会话摘要汇报（设计文档 §2.4、§4.3、§12）。
 * 推送至 identity.collector_url：阶段事件触发 + 定时，增量汇报。
 * 收集服务不可用时写本地缓冲（插件库 outbox 表），恢复后补推。
 * 仅流程摘要（经 summarizeWorkflow 剥离代码内容），不含代码。
 */
import { summarizeWorkflow, type Identity, type SessionReport } from "sm-shared"
import type { Store } from "./db"
import type { WorkflowSessionRow } from "./db/schema"

/** 会话的 cost/tokens（经上游 SDK 取得，§3.1：插件不直读上游库）。 */
export interface Usage {
  cost: number | null
  tokensInput: number | null
  tokensOutput: number | null
}

export type UsageProvider = (sessionID: string) => Promise<Usage>

/** 组装一条汇报（身份取当前快照，§3.1）。 */
export function buildReport(row: WorkflowSessionRow, identity: Identity, usage: Usage): SessionReport | null {
  if (!row.workflow) return null
  return {
    sessionID: row.session_id,
    account: identity.account,
    group: identity.group,
    org: identity.org,
    workflow: summarizeWorkflow(row.workflow),
    cost: usage.cost,
    tokensInput: usage.tokensInput,
    tokensOutput: usage.tokensOutput,
    reportedAt: Date.now(),
  }
}

export interface Reporter {
  /** 组装并入队一条汇报；无身份/无工作流时静默跳过。 */
  enqueueReport(sessionID: string): Promise<void>
  /** 将 outbox 中未送达汇报推送到收集服务；失败则保留待下次补推。返回成功条数。 */
  flushOutbox(): Promise<number>
}

export function createReporter(
  store: Store,
  getIdentity: () => Identity | null,
  usageProvider: UsageProvider,
): Reporter {
  return {
    async enqueueReport(sessionID) {
      const identity = getIdentity()
      if (!identity) return
      const row = store.get(sessionID)
      if (!row) return
      const usage = await usageProvider(sessionID)
      const report = buildReport(row, identity, usage)
      if (report) store.enqueueReport(report)
    },

    async flushOutbox() {
      const identity = getIdentity()
      if (!identity || !identity.collector_url) return 0 // 退化为仅本机统计（§12）
      const pending = store.pendingReports()
      let sent = 0
      for (const item of pending) {
        try {
          const res = await fetch(`${identity.collector_url.replace(/\/$/, "")}/api/report`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: item.payload,
          })
          if (!res.ok) break // 服务异常，留待下次补推
          store.markSent(item.id)
          sent++
        } catch {
          break // 网络不可达，保留 outbox 待恢复补推
        }
      }
      return sent
    },
  }
}
