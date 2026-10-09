import type { Store } from "../db"

// 开发者在对话中明确给出的基线预估工时表述（6.3 防 AI 杜撰）。
// 仅捕获「数字 + 工时单位」；「天 / 人天」折算为 8 小时。
const HOURS_RE = /(\d+(?:\.\d+)?)\s*(?:个)?\s*(人天|天|小时|工时|人时|h)\b/i

export function extractBaselineHours(text: string): number | null {
  const m = text.match(HOURS_RE)
  if (!m) return null
  let n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  if (/人天|天/.test(m[2] ?? "")) n *= 8
  return n
}

// 由 chat.message hook 调用：开发者消息含工时表述时，把证据写入 workflow 状态，
// 供 workflow_baseline 在 developer_confirmed=true 时校验（服务端防线，防模型自造基线
// 毒化 6.3 AI 提效对比分母）。
export function applyBaselineProposal(
  store: Store,
  sessionID: string,
  text: string,
  messageID: string,
): void {
  const hours = extractBaselineHours(text)
  if (hours === null) return
  const wf = store.get(sessionID)?.workflow
  if (!wf) return
  store.mutateWorkflow(sessionID, (w) => {
    w.baselineProposedByDev = { hours, messageID, at: Date.now() }
  })
}
