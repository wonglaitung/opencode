/**
 * reqdoc 渲染结构校验（质量飞轮 P2「渲染可测化」）。
 * 把「渲染严格逐字遵循模板」（reqdoc-r20 铁律）从纯规则文本升级为结构校验 + 渲染 diff 校验。
 *
 * 模板结构**不在本文件**——它由 `reqdoc-template-schema.ts` 从
 * `docs/reqdoc-prd-template.md` 解析得到（唯一事实源）。此前此处有一份手抄本
 * （REQDOC_TEMPLATE_CHAPTERS / FEATURE_SUB_SECTIONS / MAPPED_FIELD_KEYS / REQDOC_TEMPLATE_FIELDS），
 * 与 md 之间没有任何交叉校验：换模板漏改不报错，模板里的地址代码不认会被静默拒收，
 * 代码要求的地址模板里没有则组装时填占位符——正是「槽位收了、交付件里没有、零告警」。
 * 现改为：结构解析一次，本文件与评测判定共用同一份解析结果。
 *
 * - parseRenderStructure：纯函数解析渲染 md（标题/功能点块/来源标注），运行时与
 *   评测 render 判定类共用同一函数（同源，避免两份漂移）。
 * - 换模板只需改 md；小节标题改名会经 schema 的 unresolvedPolicy 报出来，要求人工确认口径。
 */
import type { ReqdocFeature } from "./workflow"
import {
  featureAddr,
  requireTemplateSchema,
  type TemplateSchema,
} from "./reqdoc-template-schema"

/**
 * 模板结构改由 `reqdoc-template-schema.ts` 从 md 解析得到（唯一事实源），
 * 本文件只保留**校验与计数**逻辑。以下两个取值器把解析结果投影成
 * 「与旧常量同形」的结构，让既有校验代码与评测判定零改动。
 */

/** 模板章节骨架（供渲染 diff 校验与评测 judge 遍历）：meta 章即无小节的章。 */
export function reqdocChapters(): readonly { title: string; sections: { key: string; title: string }[] }[] {
  return requireTemplateSchema().chapters.map((c) => ({ title: c.title, sections: c.sections }))
}

/**
 * 必标来源的字段清单（逐功能点计数用）。
 *
 * 取代旧 `REQDOC_TEMPLATE_FIELDS`：那份表把「相对键 + 标题」写死成手抄本，
 * 模板重排即失效。相对键现由政策（按标题）∩ 模板（按编号）解析得出，
 * 编号变了自动跟随；`dims` 一并去掉——全仓无消费点（实测），留着只会诱使人以为它有用。
 */
export function reqdocTaggedFields(): readonly { key: string; title: string }[] {
  return requireTemplateSchema().taggedSubs.map((s) => ({ key: s.rel, title: s.title }))
}

/**
 * 来源标注标签（规范形 + 兜底归一化）。
 * - 规范形：服务端写入 [文档]/[问答]/[缺省：理由]，有界匹配；
 * - 兜底：覆盖 write 路径/人工编辑的装饰变体（全/半角括号、空格等）。
 */
const SOURCE_TAG_RE = /\[文档\]|\[问答\]|\[缺省(?:\s*[：:][^\]]*)?\]|「补」/g

/** 裸 [缺省]（含空理由 [缺省：] / [缺省:]）：仅此触发完整性门禁（render.defaults 计数）。 */
const NAKED_DEFAULT_RE = /\[缺省\s*(?:[：:]\s*)?\]/g

/** 渲染结构解析产物（parseRenderStructure 返回，运行时与评测共用）。 */
export interface RenderStructure {
  /** 槽位摘要（组装时内嵌于 md 头注释；未定稿时为 undefined） */
  kbDigest?: string
  /** 结构达标：无缺章节、无缺小节、无乱序、功能点块骨架齐全（不含 expectedFeatures 对比与来源覆盖） */
  ok: boolean
  /** 出现的章节标题（按 schema 顺序） */
  chaptersPresent: string[]
  /** 缺失的章节标题 */
  missing: string[]
  /** 乱序的章节标题（出现顺序违反 schema） */
  outOfOrder: string[]
  /** 第一章/第二章 缺失的子小节（「章 编号 标题」格式） */
  missingSections: string[]
  /** 功能点块数（### 功能点 N） */
  featureCount: number
  /** 每个功能点块输入要素/处理要求子小节齐全 */
  featureOk: boolean
  /** 功能点块内缺失的子小节（「功能点 N 缺 2.4 提示信息」格式） */
  missingFeatureSections: string[]
  /** 映射字段 → 带来源标注（[文档]/[问答]/[缺省]/「补」）的功能点块数 */
  covered: Record<string, number>
  /** 映射字段 → 标 [缺省] 的功能点块数（渲染留白 = 该字段内容尚未获得） */
  defaults: Record<string, number>
  /** 带来源标注 [文档] 的功能点块数（至少一处标 [文档] 即计；用于"全 [问答] 无文档支撑"定稿门禁 Z） */
  docBlocks: number
  /** 映射字段来源标注出现总次数（[文档]/[问答]，供状态条展示覆盖度，软提示 X） */
  docCount: number
  qaCount: number
}

/** reqdoc 渲染校验记录（reqdoc_check 工具写入 WorkflowState.render；Review 时重读源复核）。 */
/**
 * 槽位摘要的产物内嵌标记：`<!-- kb-digest: <hex> -->`（组装时写入 PRD 头部，
 * parseRenderStructure 解析回来）。定稿据此区分「过期构建产物」与「产物被手改」（9.3 三分支）。
 */
const KB_DIGEST_RE = /^<!--\s*kb-digest:\s*([0-9a-f]+)\s*-->$/m

/** 正则元字符转义（章号虽是数字，保留此函数以防将来允许字母编号）。 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** 标题归一化：忽略所有空白差异（模型渲染时空白/全角空格可能有出入）。 */
function norm(s: string): string {
  return s.replace(/\s+/g, "").trim()
}

/** 标题归一化：剥来源标签（含 [缺省：理由]）、全/半角括号与连接符，忽略空白。用于标题匹配。 */
function cleanHeading(s: string): string {
  return norm(s.replace(SOURCE_TAG_RE, "").replace(/[（）()\[\]【】［］「」『』+、，,]/g, ""))
}

/** 解析一行 Markdown 标题；非标题返回 null。 */
function headingAt(line: string): { level: number; text: string } | null {
  const m = line.match(/^(#{1,6})\s+(.*)$/)
  if (!m) return null
  return { level: m[1].length, text: m[2].trim() }
}

/**
 * 渲染 diff 校验：解析渲染的 PRD md，对照模板结构 schema 检查章节出现/顺序、功能点块骨架、
 * 映射字段来源标注与 [缺省] 提取。纯函数，运行时 reqdoc_check 与评测 render 判定类共用。
 */
export function parseRenderStructure(md: string, schema: TemplateSchema = requireTemplateSchema()): RenderStructure {
  const lines = md.split(/\r?\n/)
  const digestMatch = md.match(/^<!--\s*kb-digest:\s*([0-9a-f]+)\s*-->$/m)
  const headings: { level: number; text: string; idx: number }[] = []
  lines.forEach((raw, idx) => {
    const h = headingAt(raw)
    if (h) headings.push({ level: h.level, text: h.text, idx })
  })

  // 1) 章节出现 + 顺序
  const chaptersPresent: string[] = []
  for (const h of headings) {
    if (h.level !== 2) continue
    const si = schema.chapters.findIndex((c) => norm(c.title) === norm(h.text))
    if (si >= 0 && !chaptersPresent.includes(schema.chapters[si].title)) {
      chaptersPresent.push(schema.chapters[si].title)
    }
  }
  const missing = schema.chapters.map((c) => c.title).filter((t) => !chaptersPresent.includes(t))
  const orderIdx = chaptersPresent.map((t) => schema.chapters.findIndex((c) => c.title === t))
  const outOfOrder: string[] = []
  for (let i = 1; i < orderIdx.length; i++) {
    if (orderIdx[i] <= orderIdx[i - 1]) outOfOrder.push(chaptersPresent[i])
  }

  // 2) 第一章/第二章 子小节齐全（按章节出现顺序切块，下一章节前即本章范围）
  const missingSections: string[] = []
  const l2 = headings.filter((h) => h.level === 2)
  for (const ch of schema.chapters) {
    if (!ch.sections.length) continue
    const cIdx = l2.findIndex((h) => norm(h.text) === norm(ch.title))
    if (cIdx < 0) {
      for (const s of ch.sections) missingSections.push(`${ch.title} ${s.key} ${s.title}`)
      continue
    }
    const start = l2[cIdx].idx
    const end = cIdx + 1 < l2.length ? l2[cIdx + 1].idx : lines.length
    const block = lines.slice(start, end)
    for (const s of ch.sections) {
      const present = block.some((l) => {
        const h = headingAt(l)
        // 标题行可能带来源标注（弱模型常写成「### 1.1 需求类型 [文档]」），匹配时归一化
        return !!h && h.level === 3 && cleanHeading(h.text) === cleanHeading(`${s.key} ${s.title}`)
      })
      if (!present) missingSections.push(`${ch.title} ${s.key} ${s.title}`)
    }
  }

// 3) 功能点块切分（### 起，到下一个该行或 EOF 止）。
  // 标题兼容三种约定：
  //   - 「### {功能点章号}.{数字} 名称」（新格式，与章节编号一致，如「### 5.1 知识入库管理」）
  //   - 「### 功能点 N」或「### 功能点 N：名称」「### 功能点 N 名称」（旧格式）
  //   - 「### N_名称」（与系统建档目录 06_功能点/N_名称 一致的编号_名称 形式，如「### 1_故障应急智能检索」）
  //   - 「### N. 名称」（点号后接空格/非数字，例如「### 1. 故障应急智能检索」）
  // 须三级标题（###）；排除章内小节「### N.M …」（点号后接数字，如 1.1 需求类型）以免误计数。
  // 排除「### N. 功能点…」（块内主小节，点号后接「功能点」字样），避免与功能点块误并；保留「### N. 名称」。
  // 章号取自模板（此前写死 `5\\.`）：换模板把功能点挪到第八章后，这里会一个块都切不出来。
  const chRe = escapeRe(String(schema.featureChapter ?? -1))
  const featureHeadingRe = new RegExp(
    `^###\\s+(?:${chRe}\\.(\\d+)\\s+|(?:功能点\\s*)?(\\d+)(?:[：:_\\s].*|\\.(?!\\s*功能点)[^\\d].*|)$)`,
  )
  const blocks: string[][] = []
  let cur: string[] | null = null
  for (const raw of lines) {
    if (featureHeadingRe.test(raw)) {
      if (cur) blocks.push(cur)
      cur = [raw]
    } else if (cur) {
      cur.push(raw)
    }
  }
  if (cur) blocks.push(cur)

   // 4) 每块骨架 + 映射字段来源提取
   const covered: Record<string, number> = {}
   const defaults: Record<string, number> = {}
for (const f of reqdocTaggedFields()) {
      covered[f.key] = 0
      defaults[f.key] = 0
    }
   let featureOk = true
   const missingFeatureSections: string[] = []
   let docBlocks = 0
   let docCount = 0
   let qaCount = 0
   blocks.forEach((blockLines, bi) => {
      const label = `功能点 ${bi + 1}`
      // 块内小节层级不拘：弱模型渲染常用三级/四级/五级标题皆可，故按 maxLevel 匹配（不强制四级/五级）。
      // 标题归一化：剥来源标签（含 [缺省：理由]）与全/半角括号包裹，确保「2.1 检查（[文档]+[问答]）」命中。
      const matchHeading = (l: string, maxLevel: number, text: string) => {
        const h = headingAt(l)
        return !!h && h.level <= maxLevel && cleanHeading(h.text) === cleanHeading(text)
      }
      // 主分组标题（输入要素/处理要求）为可选分组标签（模型常写为纯文本或省略），
      // 其下子节齐全即视为结构完整，故不再硬要求。子节清单取自模板解析结果，
      // 绝对地址 = `{功能点章号}.{bi+1}.{rel}`——模板重排编号后自动跟随。
      for (const sub of schema.featureSubs) {
        const absKey = featureAddr(schema, bi, sub.rel)
        if (!blockLines.some((l) => matchHeading(l, 5, `${absKey} ${sub.title}`))) {
          featureOk = false
          missingFeatureSections.push(`${label} 缺 ${absKey} ${sub.title}`)
        }
      }
     // 块内任何位置出现 [文档] 即视为本块有文档支撑（用于定稿门禁 Z）；标题或内容里的都算
     if (blockLines.join("\n").includes("[文档]")) docBlocks += 1
      for (const f of reqdocTaggedFields()) {
        const absKey = featureAddr(schema, bi, f.key)
        const fi = blockLines.findIndex((l) => matchHeading(l, 5, `${absKey} ${f.title}`))
        if (fi < 0) continue // 结构缺失已在上报
        // 来源标注可能在标题行上（「##### 2.1 … [文档]」）或标题下内容里，两者都算；到下一级 ≤5 标题止
        let body = blockLines[fi] + "\n"
        for (let j = fi + 1; j < blockLines.length; j++) {
          const h = headingAt(blockLines[j])
          if (h && h.level <= 5) break
          body += blockLines[j] + "\n"
        }
        const tags: string[] = body.match(SOURCE_TAG_RE) ?? []
        if (tags.length > 0) covered[f.key] += 1
        // 裸 [缺省]（无理由）触发完整性门禁；[缺省：理由] 是规范形、不计为裸缺省
        if ((body.match(NAKED_DEFAULT_RE) ?? []).length > 0) defaults[f.key] += 1
        if (tags.includes("[文档]")) docCount += 1
        if (tags.includes("[问答]")) qaCount += 1
     }
   })

  return {
    // 全骨架（用户定）：缺章节/缺小节/乱序/功能点块骨架任一不满足都算结构不达标
    ok:
      missing.length === 0 &&
      outOfOrder.length === 0 &&
      missingSections.length === 0 &&
      featureOk,
    chaptersPresent,
    missing,
    outOfOrder,
    missingSections,
    featureCount: blocks.length,
    featureOk,
    ...(digestMatch ? { kbDigest: digestMatch[1] } : {}),
    missingFeatureSections,
    covered,
    defaults,
    docBlocks,
    docCount,
    qaCount,
  }
}

// ---- 渲染目标结构摘要（P3 上下文瘦身：替代模板全文注入） ----

// ---- 骨架生成（P1 服务端生成，消除模型巨型 write） ----

/** 优先级勾选行（与模板 5.k 块一致）。 */
function priorityLine(p: ReqdocFeature["priority"]): string {
  const hit = p === "high" ? "高" : p === "low" ? "低" : "中"
  return `- 优先级：${["高", "中", "低"].map((x) => `${x === hit ? "●" : "○"} ${x}`).join("　")}`
}

/**
 * 服务端生成 PRD 骨架（P1）：非功能点章节逐字取自模板正文，功能点章按已确认功能点生成 N 个块
 * （以模板首个功能点块为骨架，替换编号/名称/优先级）。模型不再手写整篇骨架，避免单次输出过长被截断。
 * templateText 为 null（模板读不到）或功能点为空时返回 null。
 *
 * 三个刻意的改动（换模板时会踩到的坑，此处一并修掉）：
 * 1. **章锚点取自解析结果**（原写死「## 第一章」「## 第五章」「## 第六章」）——
 *    模板把功能点挪到第八章、或删掉某一章时，这里会直接 `return null`，组装静默退化为失败。
 * 2. **块模板切到下一个功能点块或功能点章末**（原要求模板必须写死第2 个样例块，
 *    `secondFeat < 0` 即返回 null）——只需一个功能点块也能工作。
 * 3. **块编号按首块实际章号替换**（原 `.replace(/5\.1/g, ...)` 把「5.1」焊死在代码里）。
 */
export function buildPrdSkeleton(
  templateText: string | null,
  features: readonly ReqdocFeature[],
  schema: TemplateSchema = requireTemplateSchema(),
): string | null {
  if (!templateText || features.length === 0) return null
  if (schema.featureChapter === null || schema.chapters.length === 0) return null
  const ch = schema.featureChapter
  const lines = templateText.split(/\r?\n/)
  const headingLine = (title: string): number => {
    const want = norm(title)
    return lines.findIndex((l) => {
      const h = headingAt(l)
      return !!h && h.level === 2 && norm(h.text) === want
    })
  }
  // 章锚点按**实际出现在模板里的**二级标题定位，而不是要求 schema 的每一章都命中：
  // 组装只需要「首个章起点、功能点章、功能点章之后」三个锚点，缺中间某章不影响投影。
  // （此前写死「## 第一章/第五章/第六章」，模板删章或换编号即 return null。）
  const chapterAt = schema.chapters
    .map((c) => ({ number: c.number, at: headingLine(c.title) }))
    .filter((c) => c.at >= 0)
  if (chapterAt.length === 0) return null
  const firstAt = chapterAt[0]!.at
  const featurePos = chapterAt.findIndex((c) => c.number === ch)
  if (featurePos < 0) return null
  const featureAt = chapterAt[featurePos]!.at
  const afterFeatureAt = featurePos + 1 < chapterAt.length ? chapterAt[featurePos + 1]!.at : lines.length

  // 功能点块：`### {章号}.{数字} `（排除 `### {章号}.N` 字母示意块）。
  // 刻意**不要求**块下有更深一级标题——最小模板（无 `####` 分组行）也应能投影；
  // 代价是「章内恰好有形如 5.1 的三级小节」会被误当功能点块，但那种模板
  // 本就不是本模板的形态（真模板的功能点块必有子节），且不会静默丢内容。
  const isFeatureHeading = (l: string): boolean => {
    const h = headingAt(l)
    if (!h || h.level !== 3) return false
    return new RegExp(`^${ch}\\.\\d+\\s`).test(h.text)
  }
  const featureLines = lines
    .map((l, i) => ({ l, i }))
    .filter((x) => x.i > featureAt && x.i < afterFeatureAt && isFeatureHeading(x.l))
  const firstFeat = featureLines[0]?.i ?? -1
  if (firstFeat < 0) return null
  const blockEnd = featureLines[1]?.i ?? afterFeatureAt
  const firstFeatNo = headingAt(lines[firstFeat]!)!.text.match(new RegExp(`^${ch}\\.(\\d+)\\s`))![1]!

  // 封面：首章之前、跳过开头说明性引用与文档标题后的行（项目名 / 业务需求说明书 / 日期）
  const cover: string[] = []
  for (let i = firstAt - 1; i >= 0; i--) {
    const l = lines[i]!
    if (l.startsWith(">") || l.startsWith("# ")) break
    cover.unshift(l)
  }
  while (cover.length > 0 && cover[0]!.trim() === "") cover.shift()
  while (cover.length > 0 && cover[cover.length - 1]!.trim() === "") cover.pop()

  const blockTemplate = lines.slice(firstFeat, blockEnd).join("\n")
  // 块内所有 `{章}.{首块序号}` 前缀都要换成新序号——不只是行首：`##### 5.1.2.6` 也带此前缀。
  // 边界用「后面不接数字」，不能用 `\b`：`5.1` 与 `.` 之间没有词边界（`.` 非词字符），
  // 用 `\b` 会一个都替换不到，表现为「第 2 个功能点仍写着 5.1.2.6」。
  const numRe = new RegExp(`^(\\s*#{1,6}\\s*)?${ch}\\.${firstFeatNo}(?!\\d)`, "gm")
  const blocks = features.flatMap((f, idx) => {
    const k = idx + 1
    const block = blockTemplate
      .replace(numRe, (_m, hash: string) => `${hash ?? ""}${ch}.${k}`)
      .replace(new RegExp(`^(### ${ch}\\.\\d+\\s+)功能点名称\\s*$`, "m"), (_m, p1: string) => `${p1}${f.name}`)
      .replace(/功能点编号：\s*\d+/, `功能点编号：${k}`)
      .replace(/功能名称：\s*X+/, () => `功能名称：${f.name}`)
      .replace(/^- 优先级：.*$/m, priorityLine(f.priority))
    return [...block.split("\n"), ""]
  })

  return [
    ...cover,
    "",
    ...lines.slice(firstAt, featureAt),
    // 功能点章的章首说明（编号规则那类引用行）保留，样例块整段丢弃
    ...lines.slice(featureAt, firstFeat),
    ...blocks,
    // 功能点章内首个样例块之后的行**全部丢弃**：那里只剩模板自带的样例块
    // （真实模板有 5.1/5.2/5.N 三块），它们是「块模板」而非交付内容。
    // 旧实现用「切到第六章」间接丢弃；这里改为显式丢弃，语义更清楚，
    // 且不依赖「功能点章之后紧跟哪一章」。
    ...lines.slice(afterFeatureAt),
  ].join("\n")
}


