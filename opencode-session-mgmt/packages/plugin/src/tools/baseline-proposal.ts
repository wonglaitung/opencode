import type { Store } from "../db"

// 开发者在对话中明确给出的基线预估工时表述（6.3 防 AI 杜撰）。
// 仅捕获「数字 + 工时单位」；「天 / 人天 / 工作日」折算为 8 小时。
// 单位后不用 \b（CJK 非单词字符，\b 永不成立），改用「后接非字母数字」边界，
// 兼容中英文单位且避免 "8http" / "8公顷" 误匹配。
const HOURS_RE = /(\d+(?:\.\d+)?)\s*(?:个)?\s*(人天|天|小时|工时|人时|工作日|h)(?![\p{L}\p{N}])/iu

// 估值意图锚定：弱单位（小时 / 天 / h）须出现在「预估 / 基线 / 估计…」语境，
// 避免闲聊误捕获（如「会议 2 小时」「3 天试用期」）污染证据。强估值单位
// （工时 / 人天 / 人时 / 工作日）本身即意图，直接认。
const STRONG_UNITS = new Set(["工时", "人天", "人时", "工作日"])
const INTENT_RE = /(预估|基线|估计|大概|需要|约|估|预算|周期|排期|计划|工时|人天|人时|工作日)/

export function extractBaselineHours(text: string): number | null {
  const m = text.match(HOURS_RE)
  if (!m) return null
  const unit = m[2] ?? ""
  if (!STRONG_UNITS.has(unit) && !INTENT_RE.test(text)) return null
  let n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  if (/人天|天|工作日/.test(unit)) n *= 8
  return n
}

// 由 chat.message hook 调用：开发者消息含（带意图的）工时表述时写入证据，供
// workflow_baseline 在 developer_confirmed=true 时校验（服务端防线，防模型自造基线
// 毒化 6.3 AI 提效对比分母）。最新一条开发者消息若不含此类表述，则清空旧证据——
// 确保基线须由「最近一次」开发者表述给出，杜绝陈旧数字被复用。
export function applyBaselineProposal(
  store: Store,
  sessionID: string,
  text: string,
  messageID: string,
): void {
  const hours = extractBaselineHours(text)
  const wf = store.get(sessionID)?.workflow
  if (!wf) return
  store.mutateWorkflow(sessionID, (w) => {
    w.baselineProposedByDev = hours === null ? undefined : { hours, messageID, at: Date.now() }
  })
}
