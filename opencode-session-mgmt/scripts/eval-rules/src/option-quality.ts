/**
 * 选项质量观测（阶段 1：**只测量、不判定**）。
 *
 * 背景：reqdoc 的角色是「AI 当业务需求分析师、业务出领域知识」。分析师的价值一半在
 * **问得好不好**——而「问得好」里唯一能被机械检查的那部分就是选项集：数量、是否互斥、
 * 有没有兜底出口。非专家业务若被端上一组没有出口的选项，只能勉强挑一个（挑的往往是
 * 排第一的那个），于是 `[问答]` 来源越来越多——这正是「分析师没干活」的证据。
 *
 * **为什么不做成门禁**：语义质量（选项是否真覆盖主要分支、是否真互斥）服务端判不了——
 * 它不懂那个领域。而机械项若设成门禁，又会重演「判据与规则反向」那类问题（本次已栽过
 * 四次）。故本模块**只产出观测数据**，先拿基线，再决定要不要改提示词或加约束。
 *
 * 解析口径（与既有 `optionsABC` 判据对齐，但逐问解析而非全文计数）：
 * - 一问 = 一个问句（以 `?` / `？` 结尾的行）；
 * - 该问之后的选项行 = 以 `A.` `A、` `A)` `A：` `**A**` 等开头的行，直到空行或下一个问句；
 * - 兜底项 = 选项文字含「以上都不是 / 其他 / 都不是 / 以上都不是以上 / 有其它」等；
 * - 重复 = 两个选项文字 trim 后完全相同（只查机械重复，不查语义近似）。
 */
export interface ParsedQuestion {
  /** 问句原文（截断） */
  question: string
  /** 该问的选项（按标记顺序） */
  options: string[]
  /** 是否含兜底出口 */
  hasFallback: boolean
  /** 机械重复的选项文字 */
  duplicates: string[]
}

export interface OptionQualityReport {
  /** 解析出的问句数 */
  questions: number
  /** 逐问明细 */
  parsed: ParsedQuestion[]
  /** 汇总：选项数落在 [min,max] 的问数 */
  optionCountOk: number
  /** 汇总：带兜底出口的问数 */
  withFallback: number
  /** 汇总：有机械重复选项的问数 */
  withDuplicate: number
}

/** 兜底出口的识别词——刻意做成可扩充的字面表，不做语义推断。 */
const FALLBACK_PATTERNS = [
  "以上都不是",
  "都不是",
  "以上都不是以上",
  "其他",
  "其它",
  "都不对",
  "没有",
  "以上都有",
  "以上都不",
]

/** 选项行：A. / A、/ A) / A：/ **A** / A) 等 */
const OPTION_LINE = /^\s*(?:[-*]\s*)?(?:\*\*)?([A-H])(?:[.、)）:：]|\s\*\*)/
const QUESTION_LINE = /[?？]\s*$/

function isFallback(text: string): boolean {
  return FALLBACK_PATTERNS.some((p) => text.includes(p))
}

/** 解析模型输出里的「问 → 选项集」。解析不出来时返回空报告（不是错误）。 */
export function parseOptionSets(text: string): OptionQualityReport {
  const lines = text.split(/\r?\n/)
  const parsed: ParsedQuestion[] = []
  let cur: { question: string; options: string[] } | null = null
  const flush = (): void => {
    if (!cur) return
    const seen = new Map<string, number>()
    const duplicates: string[] = []
    for (const o of cur.options) {
      const k = o.trim()
      if (seen.has(k)) {
        if (!duplicates.includes(k)) duplicates.push(k)
      }
      seen.set(k, (seen.get(k) ?? 0) + 1)
    }
    parsed.push({
      question: cur.question.slice(0, 80),
      options: cur.options,
      hasFallback: cur.options.some(isFallback),
      duplicates,
    })
    cur = null
  }
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (line.trim() === "") {
      flush() // 空行视为该问的选项块结束
      continue
    }
    if (QUESTION_LINE.test(line.trim())) {
      flush() // 遇到下一个问句，先收束上一问
      cur = { question: line.trim(), options: [] }
      continue
    }
    const m = OPTION_LINE.exec(line)
    if (cur && m) {
      // 去掉标记本身，只留选项文字（兜底判断与重复检查都只看文字）
      cur.options.push(line.slice(m[0].length).trim())
    }
  }
  flush()
  return {
    questions: parsed.length,
    parsed,
    optionCountOk: parsed.filter((q) => q.options.length >= 3 && q.options.length <= 4).length,
    withFallback: parsed.filter((q) => q.hasFallback).length,
    withDuplicate: parsed.filter((q) => q.duplicates.length > 0).length,
  }
}

/** 汇总成一行可读观测，写进 per-scenario detail。 */
export function formatOptionQuality(r: OptionQualityReport): string {
  if (r.questions === 0) return "选项质量：未解析出问句（该场景本就少提问，或模型只调工具不说话）"
  return (
    `选项质量（观察项，不计通过率）：问 ${r.questions} 个｜选项数 3~4 的 ${r.optionCountOk}｜` +
    `带兜底出口的 ${r.withFallback}｜有机械重复的 ${r.withDuplicate}`
  )
}
