/**
 * reqdoc 模板结构解析（模板 md 成为唯一结构事实源，方案阶段 A：解析器 + 一致性告警）。
 *
 * 背景：模板结构此前有**两份手抄本**——`docs/reqdoc-prd-template.md`（交付文本本体）
 * 与 `reqdoc-render.ts` 的 `REQDOC_TEMPLATE_CHAPTERS` / `FEATURE_SUB_SECTIONS` /
 * `MAPPED_FIELD_KEYS`（代码常量）。换模板要同步 12 处独立事实，漏改不报错：
 * 模板里的地址代码不认 → 槽位被拒；代码要求的地址模板里没有 → 组装静默填占位符、
 * 槽位收了但不进交付件、零告警（正是 P1-a 想防的最坏组合，而当时防线只建在 ingest 侧）。
 *
 * 本文件把这件事拆成两层：
 * - **结构**（有哪些章、顺序、编号、每章小节、功能点块内子节）：从 md 标题树**解析**，
 *   换模板只改 md，不再是手工同步。
 * - **政策**（哪些子节必填、哪些必标来源、哪些是容器、哪个容器是「术语」）：
 *   模板文本告诉不了我们这些——它只说明「5.1.2.6 清算处理存在」，说明不了
 *   「它必填、必须标来源、或者它可以整节删掉」。故留在此处。
 *
 * **政策按标题匹配、不按编号匹配**：章节重排后 `2.6 清算处理` 可能变成 `2.5 清算处理`，
 * 按编号表达政策会在重排瞬间失效。标题被改（如「清算处理」→「清算与差错处理」）则
 * `unresolvedPolicy` 非空、consistency 告警报错——这是正确的失败方向：
 * 制度口径变了就该人工确认一次，而不是让代码静默按错编号追问业务。
 *
 * 本阶段（阶段 A）**不改动任何生产路径**：常量仍在原处消费，本文件只提供
 * 解析结果与「解析结果 vs 现有常量」的双向差异报告，供测试与后续阶段 B 切换。
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

// ---------------------------------------------------------------------------
// 政策层：换模板几乎不变的部分（~15 行，不是模板的镜像）
// ---------------------------------------------------------------------------

/** 功能点块内**必填叶子**的子小节标题（进开放项、计入覆盖率分母）。
 *  含「简要概述」——它在 `requiredFeatureLeafAddrs` 里是单独拼上去的，不在映射字段表内。 */
export const REQUIRED_SUB_TITLES = [
  "简要概述",
  "控制要求",
  "异常处理要求",
  "清算处理",
  "差错处理",
  "交易安全性",
  "数据存贮和清理",
  "接口与数据源",
  "权限与最小授权",
  "流程图",
] as const

/** 功能点块内**必标来源**的子小节标题（空节也须带来源标签）。
 *  比必填集多一个「输入要素的检查」——它是字段容器，必填但走聚合判定（不进开放项）。 */
export const TAGGED_SUB_TITLES = [
  "控制要求",
  "输入要素的检查",
  "异常处理要求",
  "清算处理",
  "差错处理",
  "交易安全性",
  "数据存贮和清理",
  "接口与数据源",
  "权限与最小授权",
  "流程图",
] as const

/** 功能点块内的容器子小节标题：聚合判定、永不进开放项、可整节省略。 */
export const CONTAINER_SUB_TITLES = ["输入要素的检查"] as const

/** 章级容器的小节标题：术语容器（聚合判定 + 开放项 kind=term）。 */
export const CONTAINER_CHAPTER_TITLES = ["术语定义"] as const

/** 术语容器标题（`deriveQuestions` 里 kind=term 与 kind=field 的判据）。 */
export const TERM_CONTAINER_TITLE = "术语定义"

// ---------------------------------------------------------------------------
// 解析产物
// ---------------------------------------------------------------------------

/** 模板小节（章内 `###` 级）。 */
export interface SchemaSection {
  /** 槽位地址（如 `3.1`、`6.4`） */
  key: string
  title: string
}

/** 模板章（`##` 级）。 */
export interface SchemaChapter {
  /** 完整标题行（如「第三章 需求概述」），与渲染产物里 `## ` 那一行逐字比对 */
  title: string
  /** 章号（阿拉伯数字，从中文数字转换而来）；`## 附录` 这类无章号的章为 null */
  number: number | null
  /** 章内小节；为空即 meta 章（表格式，不提问） */
  sections: SchemaSection[]
}

/** 功能点块内子小节（`#####` 级，相对键 `g.s`）。 */
export interface SchemaFeatureSub {
  /** 组内相对键（如 `2.6`），绝对地址 = `${功能点章号}.${k}.${rel}` */
  rel: string
  title: string
}

export interface TemplateSchema {
  /** 章，按 md 出现顺序 */
  chapters: SchemaChapter[]
  /** 功能点块所在章号（从 `### 5.1` 反推）；模板无功能点块时 null */
  featureChapter: number | null
  /** 功能点块内子小节，取首个功能点块（模板里 5.1 与 5.2、5.N 应同构） */
  featureSubs: SchemaFeatureSub[]
  /** 章级容器地址（术语定义 → `4.1`） */
  chapterContainers: string[]
  /** 功能点级容器相对键（输入要素的检查 → `2.1`） */
  featureContainerRels: string[]
  /** 必填叶子相对键（政策 ∩ 模板），按模板顺序 */
  requiredSubRels: string[]
  /** 必标来源的相对键（政策 ∩ 模板） */
  taggedSubRels: string[]
  /** 政策声明但模板里找不到的标题——非空即说明模板改了小节标题，须人工确认口径 */
  unresolvedPolicy: string[]
  /** 解析告警（模板结构本身的问题，如章号重复、功能点块不同构） */
  warnings: string[]
  // ---- 以下为派生索引，供消费方 O(1) 查询，避免各自重算（且重算口径易漂移）----

  /** 全部章内小节地址（`3.1`、`6.4`…），去容器；`isDocAddr` 的判定依据 */
  docSectionAddrs: ReadonlySet<string>
  /** 全部章内小节（含容器），按文档顺序——`parseRenderStructure` 校验齐全性用 */
  allSectionAddrs: ReadonlySet<string>
  /** 相对键 → 功能点子节标题（`2.6` → 「清算处理」），`requiresTag` 等按相对键查表用 */
  subTitleByRel: ReadonlyMap<string, string>
  /** 必标来源的子节（相对键 + 标题），供 `covered`/`defaults` 计数遍历 */
  taggedSubs: readonly { rel: string; title: string }[]
  /** 功能点块内出现的组号（`[1, 2]`），用于地址合法性判定与骨架校验 */
  featureGroups: readonly number[]
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/** 中文数字 → 阿拉伯数字（模板章号「第一章」…「第七章」，含十位写法以防模板扩章）。 */
function cnNum(s: string): number | null {
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  if (/^\d+$/.test(s)) return Number(s)
  // 十 / 十五 / 二十 / 二十三
  const m = s.match(/^([一二三四五六七八九]?)十([一二三四五六七八九])?$/)
  if (m) {
    const tens = m[1] ? (digits[m[1]] ?? 0) : 1
    return tens * 10 + (m[2] ? (digits[m[2]] ?? 0) : 0)
  }
  if (s.length === 1 && s in digits) return digits[s]!
  return null
}

/** 解析一行 Markdown 标题；非标题返回 null。 */
function headingAt(line: string): { level: number; text: string } | null {
  const m = line.match(/^(#{1,6})\s+(.*)$/)
  if (!m) return null
  return { level: m[1]!.length, text: m[2]!.trim() }
}

/** 剥掉围栏代码块的内容（``` / ~~~）。模板里的 mermaid 示例常带 `## 第X章` 注释行，
 *  不剥会被当成真章解析——凭空多出一个章，槽位地址全部错位。 */
function stripFences(lines: readonly string[]): string[] {
  const out: string[] = []
  let fence: string | null = null
  for (const line of lines) {
    const m = line.match(/^\s*(```+|~~~+)/)
    if (fence) {
      // 闭合围栏：同一字符、长度不短于开启处
      if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length) fence = null
      continue
    }
    if (m) {
      fence = m[1]!
      continue
    }
    out.push(line)
  }
  return out
}

/** 标题归一化：剥来源标签（含 `[缺省：理由]`）与全/半角括号、连接符，忽略空白。
 *  与 `reqdoc-render.ts` 的 `cleanHeading` 同口径——解析模板与校验渲染必须用同一把尺。 */
function cleanHeading(s: string): string {
  return s
    .replace(/\[文档\]|\[问答\]|\[缺省(?:\s*[：:][^\]]*)?\]|「补」/g, "")
    .replace(/[\s（）()\[\]【】［］「」『』+、，,]/g, "")
}

/** 剥掉来源标签但保留空白与括号（比对标题文本本身时用，`parseRenderStructure` 同口径）。 */
function norm(s: string): string {
  return s.replace(/\s+/g, "").trim()
}

/** 标题行前的编号与标题：`3.1 需求类型` → (`3.1`, `需求类型`)；`5.N 功能点名称` 的 `N` 占位不参与地址计算。 */
function numAndTitle(text: string): { num: string; title: string } | null {
  const m = text.match(/^([0-9]+(?:\.[0-9]+)*)[.、]?\s*(.*)$/)
  if (!m) return null
  return { num: m[1]!, title: m[2]!.trim() }
}

/** `## 第X章 标题` 的章号与标题；`## 附录`（无章号）返回 number=null。 */
function chapterHead(text: string): { number: number | null; title: string } {
  const m = text.match(/^第\s*([零〇一二三四五六七八九十\d]+)\s*章\s*(.*)$/)
  if (!m) return { number: null, title: text.trim() }
  return { number: cnNum(m[1]!), title: text.trim() }
}

/**
 * 解析模板全文为结构 schema。
 *
 * 判定「`### 5.1` 是功能点块还是章内小节」：**看有没有更深一级的后继编号标题**。
 * `### 3.1 需求类型` 下直接是正文（`- ● 新增功能 ○ 更改功能`），
 * `### 5.1 功能点名称` 下有 `#### 5.1.1 功能点输入要素`——有后继即功能点块。
 * 这是从 md 结构得出的，不依赖章号硬编码（换模板把功能点挪到第八章同样成立）。
 */
export function parseTemplateSchema(templateText: string): TemplateSchema {
  const warnings: string[] = []
  const lines = templateText.split(/\r?\n/)
  // pos 是**heads 数组内的位置**（不是文件行号）——章范围切片全部按它比较，
  // 两者混用会让范围错位（曾把第三章的小节判到第五章名下）。
  const heads: Head[] = []
  stripFences(lines).forEach((raw) => {
    const h = headingAt(raw)
    if (h) heads.push({ level: h.level, text: h.text, pos: heads.length })
  })

  // 章：level 2 且形如「第X章 …」
  const chapterAt = heads
    .map((h, i) => ({ h, i }))
    .filter((x) => x.h.level === 2 && chapterHead(x.h.text).number !== null)
  if (chapterAt.length === 0) warnings.push("模板里没找到「第X章」二级标题，结构无法识别")

  const chapters: SchemaChapter[] = chapterAt.map((c, k) => {
    const start = c.i
    const end = k + 1 < chapterAt.length ? chapterAt[k + 1]!.i : heads.length
    const own = heads.filter((x) => x.pos > start && x.pos < end)
    const sections: SchemaSection[] = []
    const chapterNo = chapterHead(c.h.text).number
    for (const x of own) {
      if (x.level !== 3) continue
      const nt = numAndTitle(x.text)
      // 章内小节必须是 `N.M`（`### 5.1` 在第五章里是功能点块，不是小节）
      if (!nt) continue
      if (nt.num.split(".").length !== 2) continue
      // 小节号的首段与所属章号不符 = 模板自身笔误。仍收进来（地址唯一、不会撞车），
      // 但必须报出来——否则模板写着 `### 4.1` 却在第三章下，业务被问了个无处安放的 4.1。
      if (chapterNo !== null && Number(nt.num.split(".")[0]) !== chapterNo) {
        warnings.push(`小节「${x.text}」的编号首段与其所属章（${c.h.text}）不符，疑似模板笔误`)
      }
      // 有更深一级的后继编号标题 → 功能点块，跳过
      const hasDeeper = own.some(
        (y) => y.pos > x.pos && y.level > 3 && numAndTitle(y.text)?.num.startsWith(`${nt.num}.`),
      )
      if (hasDeeper) continue
      sections.push({ key: nt.num, title: nt.title })
    }
    return { title: c.h.text.trim(), number: chapterNo, sections }
  })

  // 章号重复 → 槽位地址会撞车，必须报出来
  const seen = new Set<number>()
  for (const c of chapters) {
    if (c.number === null) continue
    if (seen.has(c.number)) warnings.push(`章号重复：${c.title}（${c.number}）与前一个同号章冲突，槽位地址会撞车`)
    seen.add(c.number)
  }

  // 功能点章：任一章的 `###` 块下有 `#### N.k.g` 后继，即该块是功能点块
  let featureChapter: number | null = null
  let featureSubs: SchemaFeatureSub[] = []
  for (let k = 0; k < chapterAt.length; k++) {
    const ch = chapterAt[k]!
    const end = k + 1 < chapterAt.length ? chapterAt[k + 1]!.i : heads.length
    // 只认**纯数字**编号的块：模板里的 `### 5.N 功能点名称` 是字面 N 的示意块
    // （`numAndTitle` 会把它读成 num="5"、title="N 功能点名称"），不是第 5 号块。
    // 不排除它，它的骨架算出来是空数组，会误报「与首个块不同构」。
    const blocks = heads.filter(
      (x) => x.level === 3 && x.pos > ch.i && x.pos < end && isNumberedBlock(x) && ownHasDeeper(heads, x.pos, end),
    )
    const first = blocks[0]
    if (!first) continue
    const refTitles = blockSubTitles(heads, first, end).map((s) => `${s.rel} ${s.title}`).join("|")
    for (const b of blocks.slice(1)) {
      const got = blockSubTitles(heads, b, end).map((s) => `${s.rel} ${s.title}`).join("|")
      if (got !== refTitles) {
        warnings.push(`功能点块「${b.text}」的小节骨架与首个块「${first.text}」不一致——组装按首个块复制，会有内容落不进产物`)
        break
      }
    }
    featureChapter = chapterHead(ch.h.text).number
    featureSubs = blockSubTitles(heads, first, end)
    break
  }

  // 政策 ∩ 模板
  const subByTitle = new Map(featureSubs.map((s) => [s.title, s.rel]))
  // 政策标题在三张表里可能重复出现（如「清算处理」既必填又必标来源），
  // 告警按标题去重——同一件事说三遍只会淹没真正的告警。
  const missingSubs = new Set<string>()
  const resolve = (titles: readonly string[]) =>
    titles.map((t) => {
      const rel = subByTitle.get(t)
      if (rel === undefined) missingSubs.add(t)
      return rel
    })
  const requiredSubRels = resolve(REQUIRED_SUB_TITLES).filter((x): x is string => x !== undefined)
  const taggedSubRels = resolve(TAGGED_SUB_TITLES).filter((x): x is string => x !== undefined)
  const featureContainerRels = resolve(CONTAINER_SUB_TITLES).filter((x): x is string => x !== undefined)
  const unresolvedPolicy: string[] = [...missingSubs]
  for (const t of missingSubs) warnings.push(`政策里的子小节「${t}」在模板里找不到`)

  const sectionByTitle = new Map<string, string>()
  for (const c of chapters) for (const s of c.sections) if (!sectionByTitle.has(s.title)) sectionByTitle.set(s.title, s.key)
  const chapterContainers: string[] = []
  for (const t of CONTAINER_CHAPTER_TITLES) {
    const key = sectionByTitle.get(t)
    if (key === undefined) {
      warnings.push(`政策里的容器小节「${t}」在模板里找不到`)
      unresolvedPolicy.push(t)
      continue
    }
    chapterContainers.push(key)
  }
  if (!sectionsHave(chapters, TERM_CONTAINER_TITLE)) {
    warnings.push(`术语容器「${TERM_CONTAINER_TITLE}」在模板里找不到，开放项将无法区分 term 与 field`)
    unresolvedPolicy.push(TERM_CONTAINER_TITLE)
  }

  // 注意查表方向：featureSubs 是 rel→title，`subByTitle` 是 title→rel。
  // 这里必须按 rel 查，否则标题一律取到空串——而空标题会让
  // `parseRenderStructure` 的子节匹配全部落空，表现为「模板明明有这些小节，
  // 校验却说缺 13 个」，且 covered 计数全 0。
  const subByRel = new Map(featureSubs.map((s) => [s.rel, s.title] as const))
  return {
    chapters,
    featureChapter,
    featureSubs,
    chapterContainers,
    featureContainerRels,
    requiredSubRels,
    taggedSubRels,
    unresolvedPolicy: [...new Set(unresolvedPolicy)],
    warnings,
    docSectionAddrs: new Set(
      chapters.flatMap((c) => c.sections.map((s) => s.key)).filter((k) => !chapterContainers.includes(k)),
    ),
    allSectionAddrs: new Set(chapters.flatMap((c) => c.sections.map((s) => s.key))),
    subTitleByRel: subByRel,
    taggedSubs: taggedSubRels.map((rel) => ({ rel, title: subByRel.get(rel) ?? "" })),
    featureGroups: [...new Set(featureSubs.map((s) => Number(s.rel.split(".")[0])))].sort((a, b) => a - b),
  }
}

interface Head {
  level: number
  text: string
  /** heads 数组内的位置 */
  pos: number
}

/** 是否为纯数字两段编号的块（`5.1` 是，`5.N` 示意块不是）。 */
function isNumberedBlock(h: Head): boolean {
  const nt = numAndTitle(h.text)
  if (!nt) return false
  const segs = nt.num.split(".")
  return segs.length === 2 && segs.every((s) => /^\d+$/.test(s))
}

/** 该标题块下是否有更深一级的后继编号标题（功能点块判据）。 */
function ownHasDeeper(heads: readonly Head[], pos: number, end: number): boolean {
  const nt = numAndTitle(heads[pos]!.text)
  if (!nt) return false
  return heads.some((y) => y.pos > pos && y.pos < end && y.level > 3 && numAndTitle(y.text)?.num.startsWith(`${nt.num}.`))
}

/**
 * 一个功能点块（`### 5.1 功能点名称`）内的子小节骨架（`#####` 级，相对键 `g.s`）。
 *
 * 逐级取号而非从 `5.1.2.6` 直接切后两段：`5.1.2` 是**分组标题**（输入要素/处理要求），
 * 组号 `2` 必须与该组下子节编号的前一位一致，否则 `5.9.2.6` 这种跳号会被当成 `2.6`
 * 写进必填集——而组装时它根本不在骨架里，业务被迫白答一遍。
 */
function blockSubTitles(heads: readonly Head[], block: Head, chapterEnd: number): SchemaFeatureSub[] {
  const bt = numAndTitle(block.text)
  if (!bt) return []
  // 范围到**下一个同级块或章末**为止。只按章末截断会把后续功能点块（5.2）的
  // 分组与子节一并收进来，骨架从 15 条变 30 条（每个子节登记两次）。
  const blockEnd = heads.find((x) => x.pos > block.pos && x.pos < chapterEnd && x.level <= block.level)?.pos ?? chapterEnd
  const own = heads.filter((x) => x.pos > block.pos && x.pos < blockEnd)
  const groups = own.filter((x) => x.level === block.level + 1 && numAndTitle(x.text)?.num.split(".").length === 3)
  const out: SchemaFeatureSub[] = []
  for (const g of groups) {
    const gnum = numAndTitle(g.text)!.num
    // 子节的**完整父前缀**必须等于组号全名（`5.1.2.x` 属于组 `5.1.2`）。
    // 只比末段会让 `5.2.1` 组把 `5.1.1.x` 子节也收进来——组号末段在多个块里恒为
    // 1/2，重复命中导致同一子节被登记两次（曾使骨架从 15 条变 30 条）。
    const parent = gnum.split(".").slice(0, 3).join(".")
    const gno = gnum.split(".").pop()!
    for (const s of own) {
      if (s.level !== block.level + 2) continue
      const snt = numAndTitle(s.text)
      if (!snt || snt.num.split(".").length !== 4) continue
      const segs = snt.num.split(".")
      if (segs.slice(0, 3).join(".") !== parent) continue
      out.push({ rel: `${gno}.${segs[3]}`, title: snt.title })
    }
  }
  return out
}

function sectionsHave(chapters: readonly SchemaChapter[], title: string): boolean {
  return chapters.some((c) => c.sections.some((s) => cleanHeading(s.title) === cleanHeading(title)))
}

// ---------------------------------------------------------------------------
// 模板送达（从 plugin 层搬来：路径探测口径与 reqdoc-kb-tools 的组装读取同源）
// ---------------------------------------------------------------------------

const TEMPLATE_FILENAME = "reqdoc-prd-template.md"

/**
 * 候选路径（相对 import.meta.dir，按部署形态排列）：
 *  1. 源码 / 整包运行：<root>/packages/{shared,plugin}/src → ../../../docs → <root>/docs
 *  2. dist 构建：<root>/dist/{shared,plugin} → ../../docs → <root>/docs
 *  3. 运行目录兜底（开发仓库内 cwd=仓库根时生效）
 *
 * `shared/src` 与 `plugin/src` 到仓库根同为上溯三级，故同一份探测对两个包都成立——
 * 这是把加载器搬进 shared 的前提（否则 11 个消费点要加参数传模板文本）。
 */
function templateCandidates(): string[] {
  const here = import.meta.dir
  return [
    join(here, "../../../docs", TEMPLATE_FILENAME),
    join(here, "../../docs", TEMPLATE_FILENAME),
    join(process.cwd(), "docs", TEMPLATE_FILENAME),
  ]
}

// undefined=未读；string|null=已读结果。模板只读一次，避免每轮重复 I/O。
let cachedText: string | null | undefined
// undefined=未解析；null=模板不可用（解析无从谈起）。同样只算一次。
let cachedSchema: TemplateSchema | null | undefined

/** 读取模板全文；null 表示所有候选路径均读不到（安装损坏，不是可降级的情形）。 */
export function loadTemplateText(): string | null {
  if (cachedText !== undefined) return cachedText
  for (const path of templateCandidates()) {
    try {
      if (existsSync(path)) {
        cachedText = readFileSync(path, "utf8").trim()
        return cachedText
      }
    } catch {
      // 单个候选读失败不致命，继续探测下一个
    }
  }
  cachedText = null
  return cachedText
}

/** 模板结构 schema（首次调用时读取并解析，结果缓存）。模板不可用时返回 null。 */
export function templateSchema(): TemplateSchema | null {
  if (cachedSchema !== undefined) return cachedSchema
  const text = loadTemplateText()
  cachedSchema = text === null ? null : parseTemplateSchema(text)
  return cachedSchema
}

/**
 * 空结构：模板不可读时的降级值，让「只出提示」的路径继续返回结果而不是抛错。
 *
 * **仅供提示类路径使用**（状态条、工具回执、覆盖率展示、漂移检测）——
 * 这些每轮都会被系统提示构建路径调到，模板不可读时抛一次就是整个请求失败，
 * 与 pdfjs 静态 import 拖垮插件加载同一类事故（AGENTS.md 有记载）。
 *
 * **绝不可用于需要真实结构的路径**：组装（产物章节、来源标签）、定稿校验、
 * 渲染结构校验——那些地方必须让 `requireTemplateSchema` 抛出，由用户报障，
 * 宁可请求失败也不能悄悄产出一份结构不明的交付件。
 */
export const EMPTY_SCHEMA: TemplateSchema = {
  chapters: [],
  featureChapter: null,
  featureSubs: [],
  chapterContainers: [],
  featureContainerRels: [],
  requiredSubRels: [],
  taggedSubRels: [],
  unresolvedPolicy: [],
  warnings: [],
  docSectionAddrs: new Set(),
  allSectionAddrs: new Set(),
  subTitleByRel: new Map(),
  taggedSubs: [],
  featureGroups: [],
}

/**
 * 模板结构 schema，**模板不可读时降级为空结构**（提示类路径专用）。
 *
 * 与 `requireTemplateSchema` 的分工：
 * - 提示类（状态条 / 回执 / 覆盖率 / 漂移检测）→ 用本函数，绝不抛；
 * - 产物类（组装 / 定稿 / 渲染校验）→ 用 `requireTemplateSchema`，必须抛。
 *
 * 降级为空结构时必填集为空、覆盖率 0%、门禁必不通过——这些都是**安全方向**
 * （看起来「什么都没填」而不是「看起来填完了」），不会误导用户以为能定稿。
 */
export function templateSchemaOrEmpty(): TemplateSchema {
  return templateSchema() ?? EMPTY_SCHEMA
}

/**
 * 模板不可读时的**一句话说明**（可读版错误文案），供提示类路径告知真因。
 *
 * 存在的理由：模板坏掉时用户看到的是「必填叶子为 0，请补齐槽位」，而
 * `reqdoc_ingest` 收不了任何地址、`deriveQuestions` 问不出任何问题——
 * 三重锁死且唯一出路是条死路。提示类路径必须能说「不是你要补，是模板读不到」。
 */
export function templateUnavailableNotice(): string | null {
  if (templateSchema() !== null) return null
  return (
    "⚠ **需求书模板读不到**（插件安装可能不完整，或 docs/reqdoc-prd-template.md 被移动/删除）。" +
    "此时无法确定该问哪些内容、也无法录入任何条目——**请先修复插件安装**，之后重新打开本会话即可继续。" +
    "本次已填的槽位不会丢失。"
  )
}

// ---------------------------------------------------------------------------
// 地址派生：槽位地址空间完全由 schema 决定（不再有写死的正则与魔数）
// ---------------------------------------------------------------------------

/**
 * 取 schema，或在模板不可用时抛错。
 *
 * 刻意**不回退到任何内置常量**：回退等于把两份真相同时留在运行时，
 * 模板与代码漂移时会重演「静默半成品」——那正是本文件要消灭的问题。
 * 模板读不到 = 安装损坏（模板随插件分发，三种部署形态均已覆盖），此时
 * 让 reqdoc 链路显式失败、由用户报障，好过悄悄产出无法校验的交付件。
 */
export function requireTemplateSchema(): TemplateSchema {
  const s = templateSchema()
  if (s) return s
  throw new Error(
    `reqdoc 模板不可读：已探测 ${templateCandidates().length} 个候选路径（相对插件目录 ../../../docs、../../docs、运行目录 docs/）均未找到 ${TEMPLATE_FILENAME}。` +
      "这属于安装损坏而非可降级情形——请重新安装插件包。",
  )
}

/**
 * 模板**必填地址空间**的规范化串（存进 kb 供换模板检测）。
 *
 * 只列「已确认槽位可能挂上去」的地址：必填叶子 + 容器 + 功能点子节相对键 + 功能点章号。
 * **不含标题与正文**：改措辞不该被判成换模板。
 *
 * 为什么存这个串而不是哈希：换模板检测要回答的是**旧槽位还在不在**，
 * 那是个集合包含关系（旧 ⊆ 新？），哈希表达不了。存串才能做成员判定——
 * 「必填集变大」只是多答一节，不必惊动业务；「变小或改址」才是旧槽位作废。
 * 代价是 kb 多存几百字节，可接受（evidence 材料原文进的是几十 KB）。
 */
export function schemaAddressSpace(schema: TemplateSchema): string {
  return [
    `fc=${schema.featureChapter ?? "none"}`,
    `leaf=${[...schema.docSectionAddrs].sort().join(",")}`,
    `cont=${[...schema.chapterContainers, ...schema.featureContainerRels].sort().join(",")}`,
    `sub=${schema.requiredSubRels.join(",")}`,
  ].join("|")
}

/**
 * 换模板检测：**旧会话里已确认的槽位，在新模板下是否已失效**。
 * 返回告警文案；未失效（含必填集变大、或仅改措辞）返回 null。
 *
 * 判据是**集合包含**而非指纹相等：`旧必填叶子 ⊆ 新必填叶子` 且 `旧容器 ⊆ 新容器`
 * 且功能点章号未变 → 旧槽位全部仍可用，只当多了几节要问，不惊动业务。
 * 章内小节在 reqdoc 里本就全必填（`requiredSlots` 即从 `docSectionAddrs` 派生），
 * 所以机构"加一节"会让必填集变大——那不是漂移，别让业务为此重走一遍需求。
 *
 * **只报不自动清**（显式重置）：`kb.slots` 是唯一事实源、原地覆盖不留历史，
 * 自动清空等于替业务决定"这轮问答不算数"；而跨版本搬地址要判断
 * 「旧内容在新模板的哪一节算数」，服务端无法校验语义（与导入旧稿同一类问题）。
 * 故只提示，业务开新会话重走。
 *
 * **本函数永不抛错**：模板不可读时返回 null（当作无漂移）。它被状态条即
 * system prompt 构建路径调用，一次抛错会让整个请求失败——与 pdfjs 静态 import
 * 拖垮插件加载是同一类事故（AGENTS.md 有记载）。模板不可读本身已由
 * `requireTemplateSchema` 在组装等真正需要结构的路径上报错并报障，
 * 不该由这个「提示」函数重复抛。
 */
export function templateDrift(kb: { templateAddressSpace?: string }): string | null {
  const recorded = kb.templateAddressSpace
  if (!recorded) return null
  let now: string
  try {
    now = schemaAddressSpace(requireTemplateSchema())
  } catch {
    return null
  }
  if (now === recorded) return null
  const lost = lostAddresses(recorded, now)
  if (lost.length === 0) return null
  // 旧记录格式被改坏（版本不兼容/手工编辑）时**不报**：那时比对的是垃圾与真实，
  // 任何"差异"都是假的。让业务被一条无法解释的告警逼着重走一遍，比漏报糟得多。
  // 真正需要迁的场合由「章号变了/地址没了」这类可解释的差异触发。
  if (!isAddressSpace(recorded) || !isAddressSpace(now)) return null
  return (
    `⚠ **模板结构已更换**，本会话已确认的 ${lost.length} 个小节在新模板下已不存在` +
    `（${lost.slice(0, 6).join("、")}${lost.length > 6 ? " 等" : ""}）——继续填会出现「地址非法」或内容落不进交付件。` +
    `**建议开新会话重走本需求**（旧交付件已归档在 07_需求规格产出/，不会被覆盖）。` +
    `若确认只是机构改了措辞、没动结构，可忽略本提示。` +
    // 转述边界：这段会出现在状态条里，模型照讲就会把「槽位地址」「07_需求规格产出」
    // 念给业务（07-业务口语 第 1 节禁用「槽位」）。明说怎么讲，避免又造一处口径分裂。
    `（向业务转述时只讲三件事：模板换了、已经写好的那份不会丢、建议换个会话重新走；` +
    `不要提「槽位」「地址」「小节」这些内部说法与目录名。）`
  )
}

/** 地址空间串是否格式完好（四段齐全、fc 非 none 以外的值合法）。 */
function isAddressSpace(s: string): boolean {
  return /^fc=\S+\|leaf=\S*\|cont=\S*\|sub=\S*$/.test(s) && s.split("|").length === 4
}

/** 旧地址空间里、在新地址空间中已失效的叶子与容器地址。 */
function lostAddresses(recorded: string, now: string): string[] {
  const parse = (s: string): { leaf: Set<string>; cont: Set<string>; sub: Set<string>; fc: string } => {
    const get = (k: string): string[] =>
      (s.split("|").find((p) => p.startsWith(`${k}=`)) ?? "").slice(k.length + 1).split(",").filter(Boolean)
    return {
      leaf: new Set(get("leaf")),
      cont: new Set(get("cont")),
      sub: new Set(get("sub")),
      fc: (s.split("|").find((p) => p.startsWith("fc=")) ?? "fc=none").slice(3),
    }
  }
  const a = parse(recorded)
  const b = parse(now)
  // 功能点章号变了 → 全部功能点地址作废（无法逐个比对，保守全部报）
  if (a.fc !== b.fc) return [`功能点章 ${a.fc} → ${b.fc}（功能点下所有地址作废）`]
  const lost: string[] = []
  for (const x of a.leaf) if (!b.leaf.has(x)) lost.push(x)
  for (const c of a.cont) if (!b.cont.has(c)) lost.push(`容器 ${c}`)
  // 功能点必填子节也要比：漏这条会让「模板删掉某个必填子节（如清算处理）」不报警，
  // 而旧会话里挂在该子节的 confirmed 槽位会静默变成孤儿（对抗审查实测）。
  for (const s of a.sub) if (!b.sub.has(s)) lost.push(`功能点子节 ${s}`)
  return lost.sort()
}

/** 功能点子小节的绝对地址：第 bi 块（0 起）的 `g.s` → `5.{bi+1}.g.s`（章号取自模板）。 */
export function featureAddr(schema: TemplateSchema, bi: number, rel: string): string {
  const ch = schema.featureChapter
  if (ch === null) throw new Error("模板里没有功能点块，功能点地址无从派生")
  return `${ch}.${bi + 1}.${rel}`
}

/**
 * 该槽位地址是否落在功能点地址域（`{功能点章号}.{序号}.*`）。
 *
 * 按**前缀**判定而非定长：容器叶子带子键（`5.1.2.1.客户号`）也在功能点域内——
 * 定长匹配会把它们漏掉，表现为「功能点清单已重排」却不报错，已有内容静默错位。
 * 用于判断「功能点清单被重排是否已有实际后果」——没有槽位时重排只是改目录，无副作用。
 */
export function isFeatureAddr(schema: TemplateSchema, addr: string): boolean {
  const ch = schema.featureChapter
  if (ch === null) return false
  const segs = addr.split(".")
  if (segs.length < 3 || Number(segs[0]) !== ch) return false
  return /^[1-9]\d*$/.test(segs[1]!)
}

/**
 * 功能点子小节是否落在模板声明的组内（`{章}.{k}.{组}.{子}`，组号取自模板）。
 *
 * 取代旧代码写死的 `/^5\.(0|[1-9]\d*)\.[12]\.\d+$/`——那条正则把「章号 5、组号 1/2」
 * 焊进了代码，模板把功能点挪到第八章、或增删分组，它就会拒收模板自己的地址。
 */
export function isFeatureSubAddr(schema: TemplateSchema, addr: string): boolean {
  const ch = schema.featureChapter
  if (ch === null) return false
  const m = addr.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return false
  if (Number(m[1]) !== ch) return false
  // 功能点序号与组号均禁前导零（`5.01.2.1` 会被 Number() 归一成 1 而绕过范围检查，
  // 产出不可渲染的地址却零告警——对抗审查 F-2 实测）
  if (/^0\d/.test(m[2]!) || /^0\d/.test(m[3]!) || /^0\d/.test(m[4]!)) return false
  return schema.featureGroups.includes(Number(m[3]))
}

// ---------------------------------------------------------------------------
// 一致性告警（阶段 A 的落点：让「模板与代码互相矛盾」从静默变成会吵）
// ---------------------------------------------------------------------------

export interface ConsistencyReport {
  /** 模板有、但代码常量没有的小节/子节（模板改了、代码没跟上） */
  inTemplateOnly: string[]
  /** 代码常量要求、但模板里没有（代码改了、模板没跟上，或模板已删除该节） */
  inCodeOnly: string[]
  /** 政策声明但模板找不到的标题（模板改了标题，制度口径需人工确认） */
  unresolvedPolicy: string[]
  /** 解析层告警（章号重复、功能点块不同构等） */
  warnings: string[]
  /** 总条数；0 表示两份事实源一致 */
  count: number
}

/**
 * 比对「解析出的结构」与「现有代码常量」。
 *
 * 阶段 A 用它做断言与告警；阶段 B 常量改吃 schema 后本函数自然失效并删除。
 * 存在的意义是：这两份手抄本在阶段 A 期间并存，必须有一个自动比对，
 * 否则阶段 A 自己就引入了新的漂移面。
 */
export function consistencyReport(
  schema: TemplateSchema,
  codeChapters: readonly { title: string; sections?: readonly { key: string; title: string }[] }[],
  codeSubs: readonly { group: number; sub: number; title: string }[],
  codeTaggedRels: readonly string[],
): ConsistencyReport {
  const inTemplateOnly: string[] = []
  const inCodeOnly: string[] = []

  // 章：按标题逐字比对（`## 第一章 项目信息`）
  const tplChapterTitles = schema.chapters.map((c) => norm(c.title))
  const codeChapterTitles = codeChapters.map((c) => norm(c.title))
  for (const t of tplChapterTitles) if (!codeChapterTitles.includes(t)) inTemplateOnly.push(`章：${t}`)
  for (const c of codeChapterTitles) if (!tplChapterTitles.includes(c)) inCodeOnly.push(`章：${c}`)

  // 章内小节：`key 标题`
  const tplSections = new Set<string>()
  for (const c of schema.chapters) for (const s of c.sections) tplSections.add(`${s.key} ${norm(s.title)}`)
  const codeSections = new Set<string>()
  for (const c of codeChapters) for (const s of c.sections ?? []) codeSections.add(`${s.key} ${norm(s.title)}`)
  for (const s of tplSections) if (!codeSections.has(s)) inTemplateOnly.push(`小节：${s}`)
  for (const s of codeSections) if (!tplSections.has(s)) inCodeOnly.push(`小节：${s}`)

  // 功能点子节：`g.s 标题`（代码侧 group/sub 常量，模板侧 rel 拆分）
  const tplSubs = new Set(schema.featureSubs.map((s) => `${s.rel} ${norm(s.title)}`))
  const codeSubSet = new Set(codeSubs.map((s) => `${s.group}.${s.sub} ${norm(s.title)}`))
  for (const s of tplSubs) if (!codeSubSet.has(s)) inTemplateOnly.push(`功能点子节：${s}`)
  for (const s of codeSubSet) if (!tplSubs.has(s)) inCodeOnly.push(`功能点子节：${s}`)

  // 必标来源的相对键集合
  for (const rel of new Set(codeTaggedRels)) {
    if (!schema.taggedSubRels.includes(rel)) inCodeOnly.push(`必标来源相对键：${rel}`)
  }
  for (const rel of schema.taggedSubRels) {
    if (!codeTaggedRels.includes(rel)) inTemplateOnly.push(`必标来源相对键：${rel}`)
  }

  const count = inTemplateOnly.length + inCodeOnly.length + schema.unresolvedPolicy.length + schema.warnings.length
  return { inTemplateOnly, inCodeOnly, unresolvedPolicy: [...schema.unresolvedPolicy], warnings: [...schema.warnings], count }
}