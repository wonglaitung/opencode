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
import { MAPPED_FIELD_KEYS, REQDOC_TEMPLATE_CHAPTERS, absoluteFieldKey } from "./reqdoc-render"
import type { ReqdocFeature, ReqdocScoreDimKey } from "./workflow"

/** 槽位来源（与 Option A 来源标签同源）。 */
export type SlotSource = "文档" | "问答" | "缺省"

/** 槽位状态：draft=AI/记忆起草待确认；confirmed=业务确认；conflict=记忆与材料冲突待裁决；retired=已作废留痕。 */
export type SlotStatus = "draft" | "confirmed" | "conflict" | "retired"

/** 槽位种类：prose=模板小节正文；term=术语条目；field=字段定义。 */
export type SlotKind = "prose" | "term" | "field"

export interface ReqdocSlot {
  kind: SlotKind
  /** prose=模板地址（3.1~3.6、4.2、5.k.1.1、5.k.2.3~2.13、6.1~6.4、7.1/7.2）
   *  term=4.1 + 术语名作子键 | field=5.k.2.1 + 字段名作子键 */
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

/** 容器型地址（6.2.1.1 选项 B）：必填但只聚合，永不进开放项。 */
export const CONTAINER_ADDRS = ["4.1", "2.1"] as const

/** 剥掉子键取文档地址：`4.1.CRD` → `4.1`；`5.1.2.1.客户号` → `5.1.2.1`；无子键原样返回。 */
export function docAddrOf(slotAddr: string): string {
  const i = slotAddr.lastIndexOf(".")
  if (i < 0) return slotAddr
  const head = slotAddr.slice(0, i)
  // 仅当剥掉后仍是合法文档地址时才剥（`5.1.2.13` 不可被剥成 `5.1.2`）
  return isDocAddr(head) ? head : slotAddr
}

/** 取子键：`4.1.CRD` → `CRD`；无子键返回 null。 */
export function slotSubKey(slotAddr: string): string | null {
  const doc = docAddrOf(slotAddr)
  return doc === slotAddr ? null : slotAddr.slice(doc.length + 1)
}

/** 是否为文档地址（模板章节键或 5.k.g.s 四段功能点子小节）。 */
export function isDocAddr(addr: string): boolean {
  if (isContainerAddr(addr)) return true
  if (REQDOC_TEMPLATE_CHAPTERS.some((c) => c.sections?.some((s) => s.key === addr))) return true
  return /^5\.\d+\.[12]\.\d+$/.test(addr)
}

/** 是否容器地址（4.1 术语 / 5.k.2.1 字段，组感知后者形如 5.1.2.1）。 */
export function isContainerAddr(addr: string): boolean {
  return addr === "4.1" || /^5\.\d+\.2\.1$/.test(addr)
}

// ---------------------------------------------------------------------------
// 6.2.0 必填集：从模板 schema 派生，不人工枚举
// ---------------------------------------------------------------------------

/** 章节级必填小节（去 meta 章、去容器 4.1）。 */
export function requiredChapterAddrs(): string[] {
  const out: string[] = []
  for (const c of REQDOC_TEMPLATE_CHAPTERS) {
    if (c.meta) continue
    for (const s of c.sections ?? []) {
      if (isContainerAddr(s.key)) continue
      out.push(s.key)
    }
  }
  return out
}

/** 功能点级必填**叶子**（第 bi 块，bi 从 0 起）：简要概述 + 映射字段叶子（去容器 2.1）。 */
export function requiredFeatureLeafAddrs(bi: number): string[] {
  return [
    `5.${bi + 1}.1.1`,
    ...MAPPED_FIELD_KEYS.filter((k) => !isContainerRelKey(k)).map((k) => absoluteFieldKey(bi, k)),
  ]
}

/** 相对键是否为容器（`2.1` 是字段容器）。 */
function isContainerRelKey(rel: string): boolean {
  return CONTAINER_ADDRS.includes(rel as (typeof CONTAINER_ADDRS)[number])
}

/**
 * 全部必填叶子（进开放项），**按文档顺序**排列（三章→四章→五章→六章→七章）。
 * 顺序有意义：它就是模型填充与业务逐项确认的天然顺序，也是 golden 逐地址比对的基准。
 * 容器不在此列（6.2.1.1）。
 */
export function requiredSlots(features: readonly ReqdocFeature[]): string[] {
  const chapter = requiredChapterAddrs()
  // 第三章之前插入功能点块（功能点属第五章，排在 4.2 之后、6.1 之前）
  const beforeCh6 = chapter.filter((a) => Number(a.split(".")[0]) < 6)
  const fromCh6 = chapter.filter((a) => Number(a.split(".")[0]) >= 6)
  return [
    ...beforeCh6,
    ...features.flatMap((_, bi) => requiredFeatureLeafAddrs(bi)),
    ...fromCh6,
  ]
}

/** 全部必填容器（聚合判定，不进开放项）。 */
export function requiredContainers(features: readonly ReqdocFeature[]): string[] {
  return ["4.1", ...features.map((_, bi) => absoluteFieldKey(bi, "2.1"))]
}

// ---------------------------------------------------------------------------
// 6.2.1 覆盖判定：叶子 confirmed + 容器聚合
// ---------------------------------------------------------------------------

/** 某地址的有效槽位（排除 retired——已作废留痕不计覆盖，6.2.1.1）。 */
function activeSlots(slots: readonly ReqdocSlot[], addr: string): ReqdocSlot[] {
  return slots.filter((s) => docAddrOf(s.address) === addr && s.status !== "retired")
}

/** 叶子覆盖：存在 `confirmed` 槽位（只认 confirmed——draft 不消缺口，防刷覆盖率，6.2.1）。 */
export function leafCovered(slots: readonly ReqdocSlot[], addr: string): boolean {
  return activeSlots(slots, addr).some((s) => s.status === "confirmed")
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
): boolean {
  const children = activeSlots(slots, addr)
  if (children.some((s) => s.status === "confirmed")) return true
  if (children.length > 0) return false
  return decl?.required === false && Boolean(decl.reason)
}

/** 防绕过校验：容器有候选却声明 `required: false` → 违规（6.2.1.1 A3）。 */
export function containerDeclViolations(
  slots: readonly ReqdocSlot[],
  decls: Readonly<Record<string, ContainerDecl>>,
): string[] {
  const out: string[] = []
  for (const [addr, decl] of Object.entries(decls)) {
    if (decl.required !== false) continue
    if (!decl.reason) {
      out.push(`容器 ${addr} 声明 required:false 但未给理由`)
      continue
    }
    if (activeSlots(slots, addr).length > 0) {
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
): SlotCoverage {
  const leaves = requiredSlots(features)
  const containers = requiredContainers(features)
  const leafFilled = leaves.filter((a) => leafCovered(slots, a)).length
  const uncoveredContainers = containers.filter((a) => !containerCovered(slots, a, decls[a]))
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
  } = {},
): GateResult {
  const decls = opts.decls ?? {}
  const coverage = slotCoverage(slots, features, decls)
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
    const s = activeSlots(slots, a)
    return s.length === 0 || s.every((x) => x.status !== "confirmed")
  })
  if (unclosed.length > 0 && !opts.force) {
    reasons.push(`存在未收口项（停问/conflict）：${unclosed.join("、")}`)
  }
  // 防绕过
  reasons.push(...containerDeclViolations(slots, decls))

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
}

/**
 * 派生开放项全量（不分批、不剔除停问项）——`deriveQuestions` 的内核。
 * 停问判定：槽位自身 `askCount` 或调用方传入的 `askCounts[addr]` 达到 STOP_ASK_AFTER 即停问。
 */
function deriveAll(features: readonly ReqdocFeature[], opts: DeriveOptions): OpenQuestion[] {
  const slots = opts.slots ?? []
  const l1 = (opts.l1 ?? []).filter((t) => !t.retired)
  const l2 = (opts.l2 ?? []).filter((f) => !f.retired)
  const out: OpenQuestion[] = []

  // 1) 必填叶子（容器不进来——6.2.1.1）
  for (const addr of requiredSlots(features)) {
    if (leafCovered(slots, addr)) continue
    out.push({ address: addr, kind: "prose", askCount: askCountOf(addr, slots, opts.askCounts) })
  }

  // 2) 容器候选子项：L1 命中消缺口；行业通用不要求定义；L2 命中带默认猜测
  for (const [container, list] of Object.entries(opts.candidates ?? {})) {
    for (const name of list) {
      const addr = `${container}.${name}`
      if (activeSlots(slots, addr).some((s) => s.status === "confirmed")) continue
      const term = l1.find((t) => t.term === name)
      // L1 消缺口：内部简称已被业务复述确认过；行业通用属正常行话、允许使用（3.2）
      if (term && (term.kind === "内部简称" || term.kind === "行业通用")) continue
      const guess = term
        ? `${term.term} 我理解是${term.definition}，对吗？`
        : l2.find((f) => f.content.includes(name))
          ? `组织记忆里有相关记录（${name}），是这个吗？`
          : undefined
      out.push({
        address: addr,
        kind: isTermContainer(container) ? "term" : "field",
        askCount: askCountOf(addr, slots, opts.askCounts),
        ...(guess ? { guess, from: l2.length && !term ? "memory-L2" : "memory-L1" } : {}),
      })
    }
  }
  return out
}

/** 是否术语容器（`4.1`）；字段容器（`5.k.2.1`）返回 false。 */
function isTermContainer(addr: string): boolean {
  return docAddrOf(addr) === "4.1"
}

/** 某地址的已问轮次：调用方传入优先，其次槽位自带（6.3 按轮次计）。 */
function askCountOf(
  addr: string,
  slots: readonly ReqdocSlot[],
  askCounts?: Readonly<Record<string, number>>,
): number {
  if (askCounts && addr in askCounts) return askCounts[addr]!
  const slot = activeSlots(slots, addr)[0]
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
  const all = deriveAll(features, opts)
  const active = all.filter((q) => q.askCount < STOP_ASK_AFTER)
  const stopped = all.filter((q) => q.askCount >= STOP_ASK_AFTER)
  // conflict 项：未收口，但不由 deriveAll 产出（它们是已存在的槽位，非开放项）
  const conflicts = slots.filter((s) => s.status === "conflict").map((s) => s.address)
  const unclosed = [...new Set([...stopped.map((q) => q.address), ...conflicts])]
  return {
    all,
    stopped,
    batch: active.slice(0, QUESTIONS_PER_TURN),
    unclosed,
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
