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

/** 预估类问题锚定：只有问题本身在问工时/工作量，才允许把裸「2 小时」当证据。 */
const ESTIMATE_QUESTION_RE = /(预估|工时|工作量|人工|人天|人时|工作日|工期)/u

function parseHours(text: string): { hours: number; unit: string } | null {
  const m = text.match(HOURS_RE)
  if (!m) return null
  const unit = m[2] ?? ""
  let n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  if (/人天|天|工作日/.test(unit)) n *= 8
  return { hours: n, unit }
}

export function extractBaselineHours(text: string): number | null {
  const parsed = parseHours(text)
  if (!parsed) return null
  if (!STRONG_UNITS.has(parsed.unit) && !INTENT_RE.test(text)) return null
  return parsed.hours
}

/**
 * question 工具的答案提取：问题本身已锚定“预估/工时”，因此允许裸「2 小时」。
 * 先按普通消息规则解析（支持「预估 2 小时」「2 人天」），再按问题上下文兜底。
 */
export function extractQuestionBaselineHours(question: string, answer: string): number | null {
  const direct = extractBaselineHours(answer)
  if (direct !== null) return direct
  if (!ESTIMATE_QUESTION_RE.test(question)) return null
  return parseHours(answer)?.hours ?? null
}

// 由 chat.message hook 调用（文本取自 hook 传入的**当前**消息，不回读库——上游先触发后落库）：
// 开发者消息含（带意图的）工时表述时写入证据，供 workflow_baseline 在
// developer_confirmed=true 时校验（服务端防线，防模型自造基线毒化 6.3 AI 提效对比分母）。
// 最新一条开发者消息若不含此类表述，则清空旧证据——确保基线须由「最近一次」开发者
// 表述给出，杜绝陈旧数字被复用。
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

/**
 * 由 tool.execute.after 对 question 工具调用：选择菜单的答案是开发者输入，
 * 但不会触发 chat.message。这里从 args.questions + output.metadata.answers
 * 提取预估值，写入与聊天消息相同的证据字段，供 workflow_baseline 放行。
 * 未命中预估类问题时不改动已有证据（避免无关问答清掉合法证据）。
 */
export function applyQuestionBaselineProposal(
  store: Store,
  sessionID: string,
  args: unknown,
  metadata: unknown,
  callID: string,
): void {
  const wf = store.get(sessionID)?.workflow
  if (!wf) return
  const questions = isRecord(args) && Array.isArray(args.questions) ? args.questions : []
  const answers = isRecord(metadata) && Array.isArray(metadata.answers) ? metadata.answers : []
  for (let i = 0; i < questions.length && i < answers.length; i++) {
    const prompt = questions[i]
    const question = isRecord(prompt) && typeof prompt.question === "string" ? prompt.question : ""
    const group = answers[i]
    if (!Array.isArray(group)) continue
    for (const answer of group) {
      if (typeof answer !== "string") continue
      const hours = extractQuestionBaselineHours(question, answer)
      if (hours === null) continue
      store.mutateWorkflow(sessionID, (w) => {
        w.baselineProposedByDev = { hours, messageID: callID, at: Date.now() }
      })
      return
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
