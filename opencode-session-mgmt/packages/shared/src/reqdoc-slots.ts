/**
 * reqdoc 需求知识库内核（设计文档 6 章「派生算法」第 1 层实现，纯函数、零外部依赖）。
 *
 * 核心抽象是**填槽位**：模板 schema 本身定义了"哪些槽位必填"，模型的全部产出就是把槽位
 * 填上并声明来源（设计 2.2）。五份平行表示（probes/score/fieldDict/render/provenance）
 * 在这一层坍缩为"哪些槽位被填、来源是什么"。
 *
 * 本文件只做**派生与判定**，不做 IO、不组装文档正文（assembleDoc 在阶段 2 与工具层一起做）——
 * 这样阶段 1 的每个函数都能用冻结 golden 直接验证（阶段 0 交付的
 * `test/reqdoc-open-questions.golden.ts`）。
 *
 * 关键设计（选项 B，见 6.2.1.1）：
 * - **叶子必填**（进开放项）：模板 sections（去容器）+ 映射字段叶子 + 简要概述
 * - **容器必填**（聚合判定，不进开放项）：`4.1` 术语、`5.k.2.1` 字段——≥1 个 confirmed 子项即覆盖
 * - 容器无候选时须声明 `required: false` + 理由（可为空通道），有候选却声明为空 → 报错（防绕过）
 */
import {
  featureAddr,
  isFeatureAddr,
  isFeatureSubAddr,
  templateSchemaOrEmpty,
  TERM_CONTAINER_TITLE,
  type TemplateSchema,
} from "./reqdoc-template-schema"
import type { ReqdocFeature, ReqdocScoreDimKey } from "./workflow"

/** 槽位来源（与 Option A 来源标签同源）。 */
export type SlotSource = "文档" | "问答" | "缺省"

/** 槽位状态：draft=AI/记忆起草待确认；confirmed=业务确认；conflict=记忆与材料冲突待裁决；retired=已作废留痕。 */
export type SlotStatus = "draft" | "confirmed" | "conflict" | "retired"

/** 槽位种类：prose=模板小节正文；term=术语条目；field=字段定义。 */
export type SlotKind = "prose" | "term" | "field"

export interface ReqdocSlot {
  kind: SlotKind
  /** prose=模板声明的小节地址（如 3.1、5.k.1.1）；term/field=容器地址 + 名称作子键
   *  （容器地址由模板结构派生，见 reqdoc-template-schema）*/
  address: string
  /** prose=正文文本；term/field=结构化定义的正文形态（人类可读部分）。 */
  content: string
  source: SlotSource
  status: SlotStatus
  /** 材料出处（仅本机，不上行汇报）。 */
  ref?: string
  /** source=缺省 时必填（等价裸 [缺省] 门禁，结构内置）。 */
  reason?: string
  /** 连续出现在不同轮次开放项中的次数（追问终止用，见 6.3）；同一轮重复调用不累加。 */
  askCount?: number
  /** 冲突时的两侧来源（6.4）：记忆版与材料版都不装进 content，仅存这里待裁决。 */
  conflict?: { memory?: string; material?: string }
}

/** 容器声明：某容器是否必填（可为空通道）。缺省视为必填。 */
export interface ContainerDecl {
  required: boolean
  reason?: string
}

/** 停问阈值：同一槽位连续出现在 N 轮开放项后即移出清单（6.3）。 */
export const STOP_ASK_AFTER = 2

/** 每轮返回给模型的开放项上限（7.4「只注入当前该填的」；7.5 要求封顶在服务端强制，故在此单点定义）。 */
export const QUESTIONS_PER_TURN = 8

// ---------------------------------------------------------------------------
// 6.2 地址空间：文档地址（恒 4 段或模板键）与槽位地址（可带子键）
// ---------------------------------------------------------------------------

/** 剥掉子键取文档地址：`4.1.CRD` → `4.1`；`5.1.2.1.客户号` → `5.1.2.1`；无子键原样返回。 */
export function docAddrOf(slotAddr: string, schema: TemplateSchema = templateSchemaOrEmpty()): string {
  const i = slotAddr.lastIndexOf(".")
  if (i < 0) return slotAddr
  const head = slotAddr.slice(0, i)
  // 仅当剥掉后仍是合法文档地址时才剥（功能点子节 `5.1.2.13` 不可被剥成 `5.1.2`）
  return isDocAddr(head, schema) ? head : slotAddr
}

/** 取子键：`4.1.CRD` → `CRD`；无子键返回 null。 */
export function slotSubKey(slotAddr: string, schema: TemplateSchema = templateSchemaOrEmpty()): string | null {
  const doc = docAddrOf(slotAddr, schema)
  return doc === slotAddr ? null : slotAddr.slice(doc.length + 1)
}

/** 是否为文档地址（模板声明的章内小节，或模板声明组号内的功能点子小节）。
 *  判定依据全部来自模板解析结果，不再有写死的章号/组号正则。 */
export function isDocAddr(addr: string, schema: TemplateSchema = templateSchemaOrEmpty()): boolean {
  return isContainerAddr(addr, schema) || schema.docSectionAddrs.has(addr) || isFeatureSubAddr(schema, addr)
}

/** 是否容器地址（章级容器如术语定义，或功能点级字段容器如 `{章}.k.g.s`）。 */
export function isContainerAddr(addr: string, schema: TemplateSchema = templateSchemaOrEmpty()): boolean {
  const s = schema
  if (s.chapterContainers.includes(addr)) return true
  const segs = addr.split(".")
  if (segs.length !== 4) return false
  // 功能点序号须为正整数且**禁前导零**：`5.01.2.1` 会被 `Number()` 归一成 1 而绕过
  // 范围检查，产出不可渲染的地址却零告警（对抗审查 F-2 实测）。
  // 归一化序号做结构比对之前必须先在这里校验，否则归一会把 `01` 洗成 `1`、
  // 让前导零地址被误判为合法容器（这正是 F-2 回归过一次的地方）。
  if (!/^[1-9]\d*$/.test(segs[1]!)) return false
  // 组号/子号同样禁前导零
  if (/^0\d/.test(segs[2]!) || /^0\d/.test(segs[3]!)) return false
  return isFeatureSubAddr(s, addr) && s.featureContainerRels.includes(`${segs[2]}.${segs[3]}`)
}

/**
 * 是否**合法槽位地址**（工具入参校验用）。
 *
 * 三类合法：必填叶子、容器本身、容器叶子（`<容器地址>.<子键>`，子键为任意非空串）。
 * 具体地址一律取工具返回的「本轮该填」清单，勿自造。
 *
 * 存在的理由（对抗审查 P1-a）：此前 `reqdoc_ingest` 对地址零校验，
 * 提交 `9.9.999.这不是服务端派生的地址` 会被**接受并落库**，但组装时无法投影——
 * 结果是「唯一事实源收了事实、交付件里没有、零告警」的最坏组合。
 */
export function isValidSlotAddr(
  addr: string,
  features: readonly ReqdocFeature[],
  schema: TemplateSchema = templateSchemaOrEmpty(),
): boolean {
  if (!addr || addr.length > 80) return false
  // 这两处必须传 schema：漏传会退回真实模板，使显式传入的 schema 只生效一半
  //（异构模板下 2.2/3.1.2.1 之类的新地址会被误判为非法）。
  const doc = docAddrOf(addr, schema)
  const sub = slotSubKey(addr, schema)
  // 容器叶子：`4.1.CRD` / `5.1.2.1.客户号`
  if (sub !== null) {
    // 子键会**原样插值进 markdown**（容器渲染时形如 `- **子键**：内容`），
    // 因此必须排除换行与 markdown 结构字符——否则子键里塞一个换行加标题行
    // 就是一个能绕过 kbDigest / LCS / 定稿三道校验的注入（对抗审查 N-4 实测）。
    if (!sub.trim()) return false
    if (/[\r\n]/.test(sub)) return false
    if (/[#|`<>*_[\]\/\\]/.test(sub)) return false
    if (sub.trim().length > 40) return false
    // 文档地址必须合法，且功能点下标须在范围内（防 5.9.2.1 这类越界）
    if (!isDocAddr(doc, schema)) return false
    if (isFeatureAddr(schema, doc)) {
      const bi = Number(doc.split(".")[1])
      if (!Number.isInteger(bi) || bi < 1 || bi > features.length) return false
    }
    return true
  }
  return requiredSlots(features, schema).includes(addr) || isContainerAddr(addr, schema)
}

// ---------------------------------------------------------------------------
// 6.2.0 必填集：从模板 schema 派生，不人工枚举
// ---------------------------------------------------------------------------

/** 章内必填小节（去 meta 章——即无小节的表格式章、去容器）。 */
export function requiredChapterAddrs(schema: TemplateSchema = templateSchemaOrEmpty()): string[] {
  return [...schema.docSectionAddrs]
}

/** 功能点级必填**叶子**（第 bi 块，bi 从 0 起）：政策声明的必填子节（不含容器）。 */
export function requiredFeatureLeafAddrs(bi: number, schema: TemplateSchema = templateSchemaOrEmpty()): string[] {
  return schema.requiredSubRels.map((rel) => featureAddr(schema, bi, rel))
}

/**
 * 全部必填叶子（进开放项），**按文档顺序**排列。
 * 顺序有意义：它就是模型填充与业务逐项确认的天然顺序，也是 golden 逐地址比对的基准。
 * 容器不在此列（6.2.1.1）。
 *
 * 功能点块插在**功能点章所在位置**——由模板章序决定，不再用「章号小于 6」这种魔数
 * 把功能点硬塞到第四章与第六章之间（换模板把功能点挪到第八章时会插错位置）。
 */
export function requiredSlots(
  features: readonly ReqdocFeature[],
  schema: TemplateSchema = templateSchemaOrEmpty(),
): string[] {
  const s = schema
  const out: string[] = []
  for (const c of s.chapters) {
    if (c.number === s.featureChapter) {
      for (let bi = 0; bi < features.length; bi++) out.push(...requiredFeatureLeafAddrs(bi, schema))
    }
    for (const key of c.sections.map((x) => x.key)) {
      if (!s.docSectionAddrs.has(key)) continue
      out.push(key)
    }
  }
  return out
}

/** 全部必填容器（聚合判定，不进开放项）。 */
export function requiredContainers(
  features: readonly ReqdocFeature[],
  schema: TemplateSchema = templateSchemaOrEmpty(),
): string[] {
  const s = schema
  return [
    ...s.chapterContainers,
    ...features.flatMap((_, bi) => s.featureContainerRels.map((rel) => featureAddr(s, bi, rel))),
  ]
}

// ---------------------------------------------------------------------------
// 定点修订（乙）：章作用域辅助（纯函数，独立于存储）
// ---------------------------------------------------------------------------

/** 取槽位/地址所属章号：`4.1.CRD`/`5.1.2.1.客户号`/`3.1` → 首段数字。 */
export function chapterOf(addr: string): number {
  const n = Number(addr.split(".")[0])
  return Number.isFinite(n) ? n : NaN
}

/** 章内全部槽位。 */
export function slotsByChapter(slots: readonly ReqdocSlot[], ch: number): ReqdocSlot[] {
  return slots.filter((s) => chapterOf(s.address) === ch)
}

/**
 * 解析业务指的「第 N 章 / 章名 / 内容词」→ PRD 章号（数字），解析不到返回 null。
 * 三输入：①「第 2 章」数字；②章标题或小节标题命中；③小节标题含该词 → 归属章。
 * 解析不到上层须列候选让用户认领（防错章 rubber-stamp），不在此做兜底猜测。
 */
export function resolveChapterLabel(
  label: string,
  schema: TemplateSchema = templateSchemaOrEmpty(),
): number | null {
  const m = label.match(/第\s*(\d+)\s*章/)
  if (m) {
    const n = Number(m[1])
    if (schema.chapters.some((c) => c.number === n)) return n
  }
  const norm = label.trim()
  for (const c of schema.chapters) {
    if (c.title.includes(norm) || norm.includes(c.title)) return c.number
    for (const s of c.sections) {
      if (s.title.includes(norm) || norm.includes(s.title)) return c.number
    }
  }
  return null
}

/** 编辑某章时，该章内被其他章引用的术语/字段名（跨章影响提示，只列不阻断）。 */
export function crossChapterImpact(
  slots: readonly ReqdocSlot[],
  ch: number,
  schema: TemplateSchema = templateSchemaOrEmpty(),
): string[] {
  const inCh = slotsByChapter(slots, ch).filter((s) => s.kind !== "prose")
  const names = inCh
    .map((s) => slotSubKey(s.address, schema) ?? docAddrOf(s.address, schema))
    .filter((x): x is string => x !== null && x.length > 0)
  const out: string[] = []
  for (const other of slots) {
    if (chapterOf(other.address) === ch) continue
    for (const n of names) {
      if (other.content.includes(n)) out.push(`${n}（被 ${other.address} 引用）`)
    }
  }
  return [...new Set(out)]
}

/** 某章 retired 占比（含本次拟 retire 的地址），>0.5 触发 confirmRetire 守卫。 */
export function chapterRetireRatio(
  slots: readonly ReqdocSlot[],
  ch: number,
  proposedRetires: readonly string[] = [],
): number {
  const inCh = slotsByChapter(slots, ch)
  if (inCh.length === 0) return 0
  const nowRetired = inCh.filter((s) => s.status === "retired").length
  const proposed = proposedRetires.filter((a) => chapterOf(a) === ch).length
  return (nowRetired + proposed) / inCh.length
}

/** 单章 diff（地址级增/改/删），导出定点差异用。 */
export interface ChapterDiff {
  added: string[]
  changed: string[]
  removed: string[]
}

export function chapterDiff(
  before: readonly ReqdocSlot[],
  after: readonly ReqdocSlot[],
  ch: number,
): ChapterDiff {
  const bin = new Map(before.filter((s) => chapterOf(s.address) === ch).map((s) => [s.address, s]))
  const ain = new Map(after.filter((s) => chapterOf(s.address) === ch).map((s) => [s.address, s]))
  const out: ChapterDiff = { added: [], changed: [], removed: [] }
  for (const [a, s] of ain) {
    const b = bin.get(a)
    if (!b) out.added.push(a)
    else if (b.content !== s.content) out.changed.push(a)
  }
  for (const [a, b] of bin) {
    const now = ain.get(a)
    if (!now || now.status === "retired") out.removed.push(a)
  }
  return out
}

// ---------------------------------------------------------------------------
// 6.2.1 覆盖判定：叶子 confirmed + 容器聚合
// ---------------------------------------------------------------------------

/**
 * 某地址的有效槽位（排除 retired——已作废留痕不计覆盖，6.2.1.1）。
 *
 * **schema 必填（不给缺省值）**：`docAddrOf` 缺省取已加载的真实模板，一旦漏传，
 * 异构模板下算的就是另一套地址空间（对照 `isValidSlotAddr` 里的同源告警）。
 * 本函数私有、无外部调用者，故不必给缺省值——把兜底口堵在最低层，
 * 漏传即刻编译报错。导出函数仍留缺省值：调用点约 83 处（测试占多），强制显式
 * 会把噪声摊到每一处测试，收益不抵成本。
 */
function activeSlots(slots: readonly ReqdocSlot[], addr: string, schema: TemplateSchema): ReqdocSlot[] {
  return slots.filter((s) => docAddrOf(s.address, schema) === addr && s.status !== "retired")
}

/** 叶子覆盖：存在 `confirmed` 槽位（只认 confirmed——draft 不消缺口，防刷覆盖率，6.2.1）。 */
export function leafCovered(
  slots: readonly ReqdocSlot[],
  addr: string,
  schema: TemplateSchema = templateSchemaOrEmpty(),
): boolean {
  return activeSlots(slots, addr, schema).some((s) => s.status === "confirmed")
}

/**
 * 容器覆盖（6.2.1.1 选项 B）：
 * - 有 confirmed 子项 → 覆盖
 * - 无子项且显式声明 `required: false` + 理由 → 视为覆盖（可为空通道）
 * - 有子项但都未确认 → **不覆盖**（有候选却未确认，不能拿"声明为空"绕过）
 * - 无子项且未声明 → 不覆盖
 */
export function containerCovered(
  slots: readonly ReqdocSlot[],
  addr: string,
  decl?: ContainerDecl,
  schema: TemplateSchema = templateSchemaOrEmpty(),
): boolean {
  const children = activeSlots(slots, addr, schema)
  if (children.some((s) => s.status === "confirmed")) return true
  if (children.length > 0) return false
  return decl?.required === false && Boolean(decl.reason)
}

/** 防绕过校验：容器有候选却声明 `required: false` → 违规（6.2.1.1 A3）。 */
export function containerDeclViolations(
  slots: readonly ReqdocSlot[],
  decls: Readonly<Record<string, ContainerDecl>>,
  schema: TemplateSchema = templateSchemaOrEmpty(),
): string[] {
  const out: string[] = []
  for (const [addr, decl] of Object.entries(decls)) {
    if (decl.required !== false) continue
    if (!decl.reason) {
      out.push(`容器 ${addr} 声明 required:false 但未给理由`)
      continue
    }
    if (activeSlots(slots, addr, schema).length > 0) {
      out.push(`容器 ${addr} 有候选子项却声明 required:false（仅候选为空时允许）`)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 6.2.2 覆盖率与门禁
// ---------------------------------------------------------------------------

export interface SlotCoverage {
  leafTotal: number
  leafFilled: number
  containerTotal: number
  containerFilled: number
  /** 叶子覆盖率 0~1（容器不计入分母——防"声明为空"压低分母，A3）。 */
  pct: number
  /** 任一必填容器未覆盖（供 kbGate 判定"必填为 0"）。 */
  uncoveredContainers: string[]
}

export function slotCoverage(
  slots: readonly ReqdocSlot[],
  features: readonly ReqdocFeature[],
  decls: Readonly<Record<string, ContainerDecl>> = {},
  schema: TemplateSchema = templateSchemaOrEmpty(),
): SlotCoverage {
  const leaves = requiredSlots(features, schema)
  const containers = requiredContainers(features, schema)
  const leafFilled = leaves.filter((a) => leafCovered(slots, a, schema)).length
  const uncoveredContainers = containers.filter((a) => !containerCovered(slots, a, decls[a], schema))
  return {
    leafTotal: leaves.length,
    leafFilled,
    containerTotal: containers.length,
    containerFilled: containers.length - uncoveredContainers.length,
    pct: leaves.length ? leafFilled / leaves.length : 0,
    uncoveredContainers,
  }
}

export interface GateResult {
  pass: boolean
  coverage: SlotCoverage
  reasons: string[]
}

/**
 * 唯一门禁（取代现有 7 个违规校验函数）。
 * - 只读 confirmed 集合；L2 记忆带来的 draft 不计分子也不计分母
 * - 必填叶子趋近 0 时改判"逐项核"并禁止空文档（6.4.1 B1 守卫）
 * - 存在未收口项（停问/conflict）时需 force
 */
export function kbGate(
  slots: readonly ReqdocSlot[],
  features: readonly ReqdocFeature[],
  opts: {
    threshold?: number
    decls?: Readonly<Record<string, ContainerDecl>>
    /** 6.3 停问项与 6.4 conflict 项：地址列表 */
    unclosed?: readonly string[]
    force?: boolean
    /** 模板结构；缺省取已加载的模板。异构模板场景必须显式传入，否则覆盖率按真实模板算。 */
    schema?: TemplateSchema
  } = {},
): GateResult {
  const decls = opts.decls ?? {}
  const schema = opts.schema ?? templateSchemaOrEmpty()
  const coverage = slotCoverage(slots, features, decls, schema)
  const reasons: string[] = []
  const threshold = opts.threshold ?? 1

  // B1 守卫一：必填叶子为 0 → 空文档不是交付物
  if (coverage.leafTotal === 0) {
    reasons.push("必填叶子槽位为 0：无任何必填内容，需求不可实施（B1 守卫）")
  }
  // B1 守卫二：容器未覆盖 → 不放行（"全声明为空"不能绕过）
  if (coverage.uncoveredContainers.length > 0) {
    reasons.push(`必填容器未覆盖（无 confirmed 子项且未声明可为空）：${coverage.uncoveredContainers.join("、")}`)
  }
  // 叶子覆盖率
  if (coverage.leafTotal > 0 && coverage.pct < threshold && !opts.force) {
    reasons.push(`必填叶子覆盖率 ${Math.round(coverage.pct * 100)}% < 阈值 ${Math.round(threshold * 100)}%`)
  }
  // 未收口项：需 force
  const unclosed = (opts.unclosed ?? []).filter((a) => {
    const s = activeSlots(slots, a, schema)
    return s.length === 0 || s.every((x) => x.status !== "confirmed")
  })
  if (unclosed.length > 0 && !opts.force) {
    reasons.push(`存在未收口项（停问/conflict）：${unclosed.join("、")}`)
  }
  // 防绕过
  reasons.push(...containerDeclViolations(slots, decls, schema))

  return { pass: reasons.length === 0, coverage, reasons }
}

// ---------------------------------------------------------------------------


/**
 * 容器节的来源标签 = 各子槽位来源的**最弱档**（6.2.2）。
 * 只要有任一子项为 `缺省`，整节不得标 `[文档]`——否则 Option A 的来源保证被绕过。
 */
/** 来源强弱：缺省 < 问答 < 文档（数值越大越"强"）。 */
const SOURCE_RANK: Record<SlotSource, number> = { 缺省: 0, 问答: 1, 文档: 2 }

export function aggregateSourceTag(
  children: readonly Pick<ReqdocSlot, "source" | "reason" | "status">[],
): { tag: string; weakest: SlotSource | null } {
  const active = children.filter((c) => c.status !== "retired")
  if (active.length === 0) return { tag: "[缺省：无内容]", weakest: "缺省" }
  let weakest: SlotSource = active[0]!.source
  for (const c of active) if (SOURCE_RANK[c.source] < SOURCE_RANK[weakest]) weakest = c.source
  if (weakest === "文档") return { tag: "[文档]", weakest }
  if (weakest === "问答") return { tag: "[问答]", weakest }
  const reason = active.find((c) => c.source === "缺省")?.reason
  return { tag: reason ? `[缺省：${reason}]` : "[缺省]", weakest }
}

// ---------------------------------------------------------------------------
// 6.2.3 开放项派生：少问的机制核心
// ---------------------------------------------------------------------------

/** 记忆条目最小形态（3.4 schema 精简，字段全量见设计文档）。 */
export interface MemoryTerm {
  term: string
  definition: string
  kind: "行业通用" | "系统口径" | "内部简称"
  scope: "org" | "reqdoc" | "sdlc"
  origin: "restated" | "accepted_default" | "explicit" | "inferred"
  confirmedAt: number
  fromProject: string
  /**
   * 业务原话（origin=restated 时必填，写入即校验）。
   *
   * 存在的理由是**污染成本不对称**：L1 命中即免问，而免问项只需模型自己
   * `reqdoc_answer` 落定、业务全程不参与——一条伪造的「业务复述」可以永久消掉
   * 未来需求里一个本该问的问题，且旧格式条目里只有模型的释义、无从追查谁说的。
   * 与 `force_kb.force_reason` / `adopt_baseline.confirm_note` 同构：理由必须来自
   * 业务，模型不得代填。旧条目无此字段（optional），仅影响可审计性、不影响读取。
   */
  businessQuote?: string
  retired?: boolean
}

/** 记忆条目最小形态（L2 组织知识：只作 draft、不消缺口）。 */
export interface MemoryFact {
  content: string
  source: "文档" | "问答" | "缺省"
  scope: "org" | "reqdoc" | "sdlc"
  origin: string
  confirmedAt: number
  fromProject: string
  retired?: boolean
}

export interface OpenQuestion {
  /** 槽位地址（叶子或容器子项） */
  address: string
  kind: SlotKind
  /** 映射打分维（同探针 dim 口径） */
  dim?: ReqdocScoreDimKey
  /** 默认猜测（如 L2 命中时的"上次提到【X】，是这个吗？"）；模型据此转述为确认式提问 */
  guess?: string
  /** 猜测来源：L1 记忆 / L2 记忆 */
  from?: "memory-L1" | "memory-L2"
  /** 已问轮次（6.3 追问终止） */
  askCount: number
}

export interface DeriveOptions {
  /** L1 术语记忆（消缺口） */
  l1?: readonly MemoryTerm[]
  /** L2 组织知识（只 draft、不消缺口） */
  l2?: readonly MemoryFact[]
  /** 候选清单：容器下的术语/字段叶子（6.2.1.1，服务端不预置） */
  candidates?: Readonly<Record<string, readonly string[]>>
  /** 容器声明（可为空通道）。别名 decls；两者等价，传 containers 亦可。 */
  decls?: Readonly<Record<string, ContainerDecl>>
  containers?: Readonly<Record<string, ContainerDecl>>
  /** 已填槽位 */
  slots?: readonly ReqdocSlot[]
  /** 地址 → 已连续出现在开放项的轮次（6.3；**按轮次计不按调用计**——同一轮重复调用不累加，由调用方按轮推进）。 */
  askCounts?: Readonly<Record<string, number>>
  /** 模板结构；缺省取已加载的模板。仅测试与「换模板」场景显式传入。 */
  schema?: TemplateSchema
  /** 定点修订：仅派生该章的开放项（其余章不进 batch/stopped/all）。 */
  chapter?: number
}

/**
 * 派生开放项（6.2.3）——少问的结构性机制：
 * 必填叶子中未被 confirmed 占的，加上候选清单中未确认的容器子项。
 * 两条记忆规则（3.6）：
 * - **L1 命中 → 消缺口**（不再问），其叶子视为已确认
 * - **L2 命中 → 不消缺口**，但带默认猜测问一次
 */
/** 派生结果：把"该问什么"拆成本轮批次、停问项、未收口项三部分（6.3/6.5/7.4 的单一事实源）。 */
export interface DerivedQuestions {
  /** 本轮返回给模型的批次（已剔除停问项、已按 QUESTIONS_PER_TURN 封顶） */
  batch: OpenQuestion[]
  /** 本轮该问的全量（未分批）——状态条/调试用，不直接进模型 */
  all: OpenQuestion[]
  /** 因连续 N 轮未确认被移出清单的项（6.3） */
  stopped: OpenQuestion[]
  /** 未收口项 = 停问项 + conflict 项；供 kbGate 拦门禁（6.5） */
  unclosed: string[]
  /** 本次因 L1 记忆命中而消缺口的地址（3.6 规则 1）——**必须对模型可见**，
   *  否则它会重复追问已被记忆确认过的项，等于「少问」机制失效。 */
  l1Applied: string[]
}

/**
 * 派生开放项全量（不分批、不剔除停问项）——`deriveQuestions` 的内核。
 * 停问判定：槽位自身 `askCount` 或调用方传入的 `askCounts[addr]` 达到 STOP_ASK_AFTER 即停问。
 */
function deriveAll(
  features: readonly ReqdocFeature[],
  opts: DeriveOptions,
): { questions: OpenQuestion[]; l1Applied: string[] } {
  const slots = opts.slots ?? []
  // 容错：调用方传错类型（如把 matchMemory 的整个返回值当数组传）退化为空，
  // 而不是让 .filter 抛错——这条路径在 system prompt 构建里，一个笔误会拖垮所有请求。
  //
  // scope 过滤（P2-b）：此前 scope 只写不读，设计声称的「sdlc 记忆不影响 reqdoc 判定」
  // 没有任何代码执行——一条 scope:"sdlc" 的 L1 条目会照常参与 reqdoc 消缺口。
  // 现在只有 org/reqdoc 作用域的记忆能在 reqdoc 生效。
  const usable = (x: { retired?: boolean; scope?: string }): boolean =>
    !x.retired && x.scope !== "sdlc"
  const l1 = Array.isArray(opts.l1) ? opts.l1.filter(usable) : []
  const l2 = Array.isArray(opts.l2) ? opts.l2.filter(usable) : []
  const out: OpenQuestion[] = []
  const l1Applied: string[] = []

  // 1) 必填叶子（容器不进来——6.2.1.1）
  const schema = opts.schema ?? templateSchemaOrEmpty()
  for (const addr of requiredSlots(features, schema)) {
    if (leafCovered(slots, addr, schema)) continue
    out.push({
      address: addr,
      kind: "prose",
      askCount: askCountOf(addr, slots, schema, opts.askCounts),
    })
  }

  // 2) 容器候选子项：L1 命中消缺口；行业通用不要求定义；L2 命中带默认猜测
  for (const [container, list] of Object.entries(opts.candidates ?? {})) {
    for (const name of list) {
      const addr = `${container}.${name}`
      if (activeSlots(slots, addr, schema).some((s) => s.status === "confirmed")) continue
      const term = l1.find((t) => t.term === name)
      // L1 消缺口：内部简称已被业务复述确认过；行业通用属正常行话、允许使用（3.2）
      if (term && (term.kind === "内部简称" || term.kind === "行业通用")) {
        l1Applied.push(addr)
        continue
      }
      // L2 猜测必须**带出记忆内容**，否则等于让业务对空默认值点头（P1-c）：
      // 原实现只说「组织记忆里有相关记录（X）」——一个字都不露，
      // 而规则又规定「回同意默认即视为确认」，等于系统性把业务推向闭眼签字。
      const l2hit = l2.find((f) => containsWord(f.content, name))
      const guess = term
        ? `${term.term} 我理解是${term.definition}，对吗？`
        : l2hit
          ? `上次在别的需求里见过「${excerptAround(l2hit.content, name)}」，是这样吗？`
          : undefined
      out.push({
        address: addr,
        kind: isTermContainer(container, opts.schema ?? templateSchemaOrEmpty()) ? "term" : "field",
        askCount: askCountOf(addr, slots, schema, opts.askCounts),
        ...(guess ? { guess, from: l2.length && !term ? "memory-L2" : "memory-L1" } : {}),
      })
    }
  }
  // 定点修订：只保留目标章的开放项（其余章不进 batch/stopped/all）
  if (opts.chapter !== undefined) {
    return { questions: out.filter((q) => chapterOf(q.address) === opts.chapter), l1Applied }
  }
  return { questions: out, l1Applied }
}

/** 候选词是否出现在文本中（朴素包含；候选由服务端抽取，粒度已受控）。 */
function containsWord(text: string, word: string): boolean {
  return text.includes(word)
}

/** 截取命中词所在的一句作为「默认值」露出——业务要看到具体内容才能判断。 */
function excerptAround(content: string, word: string): string {
  const i = content.indexOf(word)
  if (i < 0) return content.slice(0, 60)
  // 取命中词所在的一句（句号/分号/换行分隔）
  const from = Math.max(0, content.lastIndexOf("。", i) + 1, content.lastIndexOf("\n", i) + 1)
  const candidates = [content.indexOf("。", i), content.indexOf("\n", i)].filter((x) => x > i)
  const to = candidates.length > 0 ? Math.min(...candidates) + 1 : Math.min(content.length, i + 60)
  return content.slice(from, to).trim().slice(0, 80)
}

/** 是否术语容器（模板里标题为「术语定义」的章级容器）；字段容器返回 false。
 *  按**标题**而非地址判定——换模板把术语章从 4.1 挪到 2.2 时无需改代码。 */
function isTermContainer(addr: string, schema: TemplateSchema): boolean {
  const termKey = schema.chapters
    .flatMap((c) => c.sections)
    .find((x) => x.title === TERM_CONTAINER_TITLE)?.key
  return termKey !== undefined && docAddrOf(addr, schema) === termKey
}

/** 某地址的已问轮次：调用方传入优先，其次槽位自带（6.3 按轮次计）。 */
function askCountOf(
  addr: string,
  slots: readonly ReqdocSlot[],
  schema: TemplateSchema,
  askCounts?: Readonly<Record<string, number>>,
): number {
  if (askCounts && addr in askCounts) return askCounts[addr]!
  const slot = activeSlots(slots, addr, schema)[0]
  return slot?.askCount ?? 0
}

/**
 * 派生开放项（6.2.3）——少问的结构性机制。
 * 保留此函数作为**回归基线接口**：返回本轮该问的全量地址（等价 `deriveQuestions().all`），
 * 供阶段 0 冻结清单逐地址比对（漏问检测）。
 */
export function deriveOpenQuestions(
  features: readonly ReqdocFeature[],
  opts: DeriveOptions = {},
): OpenQuestion[] {
  return deriveQuestions(features, opts).all
}

/**
 * 派生本轮提问（6.3 + 6.5 + 7.4 的单一事实源）：
 * - **停问**：连续 `STOP_ASK_AFTER` 轮未确认的项移出 `batch`（仍在 `stopped` 里可查）
 * - **未收口**：停问项 + `conflict` 项，供 `kbGate` 拦门禁
 * - **封顶**：`batch` 按 `QUESTIONS_PER_TURN` 截断（7.5 要求封顶在服务端强制）
 */
export function deriveQuestions(features: readonly ReqdocFeature[], opts: DeriveOptions = {}): DerivedQuestions {
  const slots = opts.slots ?? []
  const { questions, l1Applied } = deriveAll(features, opts)
  const active = questions.filter((q) => q.askCount < STOP_ASK_AFTER)
  const stopped = questions.filter((q) => q.askCount >= STOP_ASK_AFTER)
  // conflict 项：未收口，但不由 deriveAll 产出（它们是已存在的槽位，非开放项）
  const conflicts = slots.filter((s) => s.status === "conflict").map((s) => s.address)
  const unclosed = [...new Set([...stopped.map((q) => q.address), ...conflicts])]
  return {
    all: questions,
    stopped,
    batch: active.slice(0, QUESTIONS_PER_TURN),
    unclosed,
    l1Applied,
  }
}

/** 推进一轮：把本轮展示过的地址的 askCount +1（**按轮次计不按调用计**——由调用方每轮调一次，6.3）。 */
export function advanceAskCounts(
  askCounts: Readonly<Record<string, number>>,
  shown: readonly string[],
): Record<string, number> {
  const next = { ...askCounts }
  for (const addr of shown) next[addr] = (next[addr] ?? 0) + 1
  return next
}

/** 槽位是否落在功能点地址域（`{功能点章号}.{序号}.*`：5.k.1.1 必填叶子、5.k.2.1.<字段> 容器叶子）。
 *  用它判断「功能点清单被重排是否已有实际后果」——没有槽位时重排只是改目录，无副作用。 */
export function hasFeatureScopedSlots(
  slots: readonly ReqdocSlot[],
  schema: TemplateSchema = templateSchemaOrEmpty(),
): boolean {
  return slots.some((x) => isFeatureAddr(schema, x.address))
}

/**
 * 功能点清单纯追加校验：返回 `null` 表示通过，否则返回可直接展示的错误文案（含修复指引）。
 *
 * 背景：功能点地址 `5.{序号}.*` **按序号索引**，而 `reqdoc_confirm_features` 与
 * `reqdoc_ingest(features:)` 都是「整体替换 + 按序重编号」。一旦已有槽位落在功能点地址域，
 * 插入/删除/改名/重排都会让既有槽位地址漂移、内容错位，门禁判成未填 → 业务被迫重述整份需求，
 * 且全程无报错说明原因（历史缺陷：这两处曾各写一份功能点列表，见 reqdoc-features 头注）。
 *
 * `hasFeatureSlots=false`（拆解阶段尚无功能点槽位）时放行任意调整——那正是 prd 前
 * 与业务反复调整清单的正常窗口，硬拒绝会把模型卡死。优先级可改（不进地址）。
 *
 * 两处写功能点的工具共用本函数与同一份措辞：同一约束两处各写一遍必然漂移。
 */
export function featuresAppendViolation(
  old: readonly ReqdocFeature[],
  next: readonly { name: string; priority: ReqdocFeature["priority"] }[],
  hasFeatureSlots: boolean,
): string | null {
  if (!hasFeatureSlots) return null
  for (let i = 0; i < old.length; i++) {
    if (next[i]?.name === old[i].name) continue
    const got = next[i]?.name ?? "（清单被截断，未提交这一项）"
    return (
      `功能点清单必须纯追加：第 ${i + 1} 项期望「${old[i].name}」，收到「${got}」。\n` +
      // 不写死功能点章号（曾写 `5.{序号}.*`）：换模板后该章号会变（如挪到 3），而这是
      // **模型可见**的工具错误文案——照着错误章号填地址等于把模型带进死路。
      // 也因此写不成「点接数字」形态，地址护栏正则抓不到，只能靠这条注释守住。
      `功能点地址按「功能点章号.序号.*」索引（章号见本轮「该填」清单），插入/删除/改名/重排会让已确认槽位的地址漂移、内容错位，` +
      `门禁判成未填 → 业务被迫重述整份需求，且不会报错说明原因。\n` +
      `要加功能请传「原清单 + 末尾追加」，如 ${JSON.stringify([...old.map((f) => f.name), "新功能名"])}；` +
      `优先级可以改（不进地址），顺序不可以。当前已有 ${old.length} 个功能点地址带槽位，故不接受重排。`
    )
  }
  return null
}

/** 相对基线的差异（分支二定稿时给业务看「这次到底改了什么」）。 */
export interface BaselineDiff {
  /** 基线里没有、本轮新增并已确认的地址 */
  added: string[]
  /** 基线里有、本轮内容被改写的地址 */
  changed: string[]
  /** 基线里已确认、本轮不再需要的地址（retired 或消失） */
  removed: string[]
  /** 相对基线新增的功能点名称（末尾追加的那些） */
  featuresAdded: string[]
}

/**
 * 基线差异：拿承认基线时冻结的快照与当前知识库逐地址比对。
 *
 * 为什么必须有快照：`kb.slots` 是**原地覆盖**的（`reqdoc_answer` 直接改同地址），
 * 系统不留历史，定稿时无法回答「这次改了哪些」。承认基线时冻结一次（`baselineSnapshot`）。
 *
 * 只认 `confirmed`：草稿不算「已交付的改动」，否则清单里会混进半成品。
 * 无快照（分支一全新需求）返回 null——没有基线就没有「变更」可言。
 */
export function diffAgainstBaseline(kb: {
  slots: readonly ReqdocSlot[]
  features: readonly ReqdocFeature[]
  baselineSnapshot?: { slots: ReqdocSlot[]; features: ReqdocFeature[] }
}): BaselineDiff | null {
  const snap = kb.baselineSnapshot
  if (!snap) return null
  const before = new Map(snap.slots.map((s) => [s.address, s]))
  const after = new Map(kb.slots.map((s) => [s.address, s]))
  const diff: BaselineDiff = { added: [], changed: [], removed: [], featuresAdded: [] }
  for (const [addr, now] of after) {
    if (now.status !== "confirmed") continue
    const prev = before.get(addr)
    if (!prev) {
      diff.added.push(addr)
      continue
    }
    if (prev.content !== now.content) diff.changed.push(addr)
  }
  for (const [addr, prev] of before) {
    if (prev.status !== "confirmed") continue
    const now = after.get(addr)
    if (!now || now.status === "retired") diff.removed.push(addr)
  }
  const oldNames = new Set(snap.features.map((f) => f.name))
  diff.featuresAdded = kb.features.filter((f) => !oldNames.has(f.name)).map((f) => f.name)
  const byAddr = (x: string, y: string) => x.localeCompare(y, "en")
  diff.added.sort(byAddr)
  diff.changed.sort(byAddr)
  diff.removed.sort(byAddr)
  return diff
}

/** 变更清单的一行式摘要（定稿回执用，业务评审就看这一句）。 */
export function baselineDiffSummary(diff: BaselineDiff): string {
  const parts: string[] = []
  if (diff.featuresAdded.length > 0) parts.push(`新增功能点 ${diff.featuresAdded.length} 个（${diff.featuresAdded.join("、")}）`)
  if (diff.added.length > 0) parts.push(`新增内容 ${diff.added.length} 项（${diff.added.join("、")}）`)
  if (diff.changed.length > 0) parts.push(`改写 ${diff.changed.length} 项（${diff.changed.join("、")}）`)
  if (diff.removed.length > 0) parts.push(`不再需要 ${diff.removed.length} 项（${diff.removed.join("、")}）`)
  return parts.length > 0 ? parts.join("；") : "内容与基线一致（本次无实际改动）"
}
