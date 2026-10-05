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
 * - 一问 = 一个**含问号**的行（**不要求问号在行尾**——实测真实输出是
 *   `**问题 1：您这边手头有没有现成的资料？**`，行尾是被加粗的 `**`；
 *   早先按「行尾必须是问号」写，真实输出里一个都解析不出，观测直接失效）；
 * - 选项行 = 以 `A.` `A、` `A)` `A：` 或 `- A.` / `* A.`（列表符）等开头的行，
 *   直到空行或下一个问句行；
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

/**
 * 兜底出口的识别——**必须是完整句式，不能是单词**。
 *
 * 踩过的坑：第一版按单词表匹配（`其他` / `没有` / `都不是`），实测 7 个「看起来像兜底、
 * 其实不是」的选项里 **6 个被误判**——「没有额外要求」「其他章节无需改动」根本不是出口，
 * 但它们含「没有」「其他」。这让兜底率虚高（一度报 35%，实际远低于此）。
 *
 * 故改为锚定的句式：必须以「以上/都/另有」起头并**以否定或列举收尾**，或整项就是
 * 「其他」。这样「其他章节无需改动」不再命中（它不以列举词起头收尾），
 * 「以上都不是」仍然命中。
 */
const FALLBACK_PATTERNS = [
  // 整项就是「其他 / 其它」（允许带补充说明，如「其他（请补充）」）
  /^其[他它](（.*）|\(.*\)|$)/,
  // 「以上都不是」「都不是」等——列举词起头 + 否定，**且不再接别的内容**
  //（接了内容就变成陈述句，如「以上都没有提到 X」不是出口）
  /^(以上|都|上述|这些)?(是)?都(不是|不对|没有|无需|不需要)(以上)?([。！!]?)$/,
  /^(以上|上述|这些)(都)?(不是|不对|没有|无)([。！!]?)$/,
  /^(不是|都不对|都不需要|没有需要)([。！!]?)$/,
  // 整项就是「以上都不是 / 以上都要另说」这类，允许尾部只跟标点
  /^(以上|都|上述)?(是)?都?(不是|不对)(要|需要)?另?(说|问|填|写)?([。！!]?)$/,
  // 「以上都有…吗」这类反向确认（选项写成问句时）
  /^(以上|都).{0,4}都有/,
  // 「请补充」「另说」「换一个」等明确要求换答法
  /^(请补充|补充说明|另说|换个|换一种|都不合适)/,
]

/** 选项行：A. / A、/ A) / A：/ **A** / - A. / * A) 等（可带列表符与加粗） */
const OPTION_LINE = /^\s*(?:[-*]\s*)?(?:\*\*)?([A-H])(?:[.、)）:：]|\s*\*\*)/
/** 问句行：含问号即可——不要求在行尾（加粗/列表符都可能跟在问号后面） */
const QUESTION_LINE = /[?？]/
/** 「问题 N：」这类显式问句标题（即使整行没有问号也算一问，如「问题 3：」后面另起一行才是问句） */
const NUMBERED_QUESTION = /^\s*(?:[-*]\s*)?\**\s*(?:问题\s*\d+|\d+[.、)）])/

/**
 * 把一段文本里的**所有**选项标记剥出来，返回选项文字数组。
 *
 * 必须处理「一行多个选项」——实测真实输出既有 `- A. x B. y C. z`（列表符 + 同行多选项），
 * 也有每项各占一行。早先只剥第一个标记，把 `B. y C. z` 整段当成 A 的文字，
 * 于是「只有 1 个选项」——观测直接失真（再次印证：探针必须拿真实输出自证）。
 */
function splitInlineOptions(text: string): string[] {
  const out: string[] = []
  // 在任意大写字母标记前切。用 (?=[A-H][.、)）]) 而非 \b——标记前可能是中文
  // （"只有柜员 B. 只有客户"），\b 在中文与字母之间不成立，会整段切不开。
  for (const seg of text.split(/(?=[A-H][.、)）])/)) {
    const m = OPTION_LINE.exec(seg.trim())
    if (m) out.push(seg.trim().slice(m[0].length).trim())
  }
  return out
}

function isFallback(text: string): boolean {
  const t = text.trim()
  return FALLBACK_PATTERNS.some((p) => p.test(t))
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
    if (QUESTION_LINE.test(line) || NUMBERED_QUESTION.test(line)) {
      flush() // 遇到下一个问句，先收束上一问
      // 选项可能与问句同行（实测出现过），先摘掉同行里问号之后的选项段
      const inline = line.match(/([?？])([^?？]*)$/)
      const head = inline ? line.slice(0, line.indexOf(inline[1]) + 1) : line
      const tail = inline ? inline[2]!.trim() : ""
      cur = { question: head.trim(), options: [] }
      if (tail) cur.options.push(...splitInlineOptions(tail))
      continue
    }
    if (cur && OPTION_LINE.test(line)) {
      // 一行可能含多个选项（`- A. x B. y`），逐个剥开
      cur.options.push(...splitInlineOptions(line))
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

/**
 * 默认推荐限流观测（阶段 3，纯观察）。
 *
 * `reqdoc-r27` 规定「业务连续 2 轮选默认后必须改为开放式追问」，但**这条是否被执行
 * 一直只有文字、没有观测**。本函数给出唯一能机械判的信号：**模型这一轮还带不带
 * 【默认推荐】**。带了 = 没转开放式（限流未生效）；没带 = 转了。
 *
 * 只报事实、不判对错——「该不该转」含语义成分（也许该问的正好不是那三项），
 * 且设成门禁会重演「判据与规则反向」。先拿数据。
 */
export interface DefaultLoadReport {
  /** 本轮是否出现默认推荐字样 */
  hasDefault: boolean
  /** 命中文件里的判据词 */
  markers: string[]
}

const DEFAULT_MARKERS = ["默认推荐", "默认项", "建议选", "我建议"]

export function reportDefaultLoad(text: string): DefaultLoadReport {
  const markers = DEFAULT_MARKERS.filter((m) => text.includes(m))
  return { hasDefault: markers.length > 0, markers }
}

/** 汇总成一行可读观测，写进 per-scenario detail。 */
export function formatOptionQuality(r: OptionQualityReport): string {
  if (r.questions === 0) return "选项质量：未解析出问句（该场景本就少提问，或模型只调工具不说话）"
  return (
    `选项质量（观察项，不计通过率）：问 ${r.questions} 个｜选项数 3~4 的 ${r.optionCountOk}｜` +
    `带兜底出口的 ${r.withFallback}｜有机械重复的 ${r.withDuplicate}`
  )
}
