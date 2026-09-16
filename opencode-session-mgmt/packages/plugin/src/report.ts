/**
 * 会话摘要汇报（设计文档 session-management.md 2.4、4.3、12 章）。
 * 推送至 identity.collector_url：阶段事件触发 + 定时，增量汇报。
 * 收集服务不可用时写本地缓冲（插件库 outbox 表），恢复后补推。
 * 仅流程摘要（经 summarizeWorkflow 剥离代码内容），不含代码。
 */
import { hashApiKey, summarizeWorkflow, type Identity, type SessionReport } from "sm-shared"
import type { Store } from "./db"
import type { WorkflowSessionRow } from "./db/schema"

/** 会话的 cost/tokens（经上游 SDK 取得，3.1：插件不直读上游库）。 */
export interface Usage {
  cost: number | null
  tokensInput: number | null
  tokensOutput: number | null
}

export type UsageProvider = (sessionID: string) => Promise<Usage>

/** 组装一条汇报（apiKeyHash 为 api_key 的 SHA-256，由调用方先行计算，3.1、12）。 */
export function buildReport(row: WorkflowSessionRow, apiKeyHash: string, usage: Usage): SessionReport | null {
  if (!row.workflow) return null
  return {
    sessionID: row.session_id,
    apiKey: apiKeyHash,
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
  /** 将 outbox 中未送达汇报推送到收集服务；失败则保留待下次补推。返回成功条数。exit 为 true 时输出警告（退出时），否则静默。 */
  flushOutbox(options?: { exit?: boolean }): Promise<number>
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
      const apiKeyHash = await hashApiKey(identity.apiKey)
      const row = store.get(sessionID)
      if (!row) return
      const usage = await usageProvider(sessionID)
      const report = buildReport(row, apiKeyHash, usage)
      if (report) store.enqueueReport(report)
    },

    async flushOutbox(options?: { exit?: boolean }) {
      const identity = getIdentity()
      if (!identity || !identity.collector_url) return 0 // 退化为仅本机统计（12）
      const pending = store.pendingReports()
      let sent = 0
      for (const item of pending) {
        try {
          const res = await fetch(`${identity.collector_url.replace(/\/$/, "")}/api/report`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: item.payload,
            // 收集服务不可达时不无界挂起：5 秒未响应即放弃（启动慢根因之一：
            // 无超时的 fetch 在不可达地址上会挂到 TCP 连接超时，可达数十秒）。
            signal: AbortSignal.timeout(5_000),
          })
          if (!res.ok) {
            if (res.status >= 400 && res.status < 500) {
              if ((item.retry_count ?? 0) >= 10) {
                console.error(`[session-mgmt] outbox#${item.id} 重试 ${item.retry_count} 次仍失败，停试，需修复 identity.json`)
                store.markFailed(item.id)
                continue
              }
              // 4xx 为客户端问题（鉴权/payload），标记 failed 保留待重试
              // 修复配置后下次 flushOutbox 会重新尝试
              const hint =
                res.status === 401 || res.status === 403
                  ? "（鉴权失败，请核对 identity.json）"
                  : "（payload 非法）"
              console.warn(`[session-mgmt] 汇报被拒绝 HTTP ${res.status}${hint}，标记 failed outbox#${item.id}`)
              store.markFailed(item.id)
              continue
            }
            break // 5xx：服务异常，留待下次补推
          }
          store.markSent(item.id)
          sent++
        } catch (e) {
          const msg = `[session-mgmt] flushOutbox 网络异常，保留待补推: ${e instanceof Error ? e.message : e}`
          const hint = "提示：报告已本地缓冲，恢复后自动补推。如持续失败请检查 ~/.config/opencode/session-mgmt/identity.json 收集服务地址与网络连通性。"
          if (options?.exit) {
            console.warn(`${msg}\n${hint}`)
          } else {
            console.debug(msg)
          }
          store.touchAttempt(item.id)
          break // 网络不可达，保留 outbox 待恢复补推
        }
      }
      return sent
    },
  }
}
