/**
 * reqdoc 记忆读写内核（设计文档 3 章「记忆分层」第 1 层实现，纯函数、零 IO）。
 *
 * 分工：本文件只做**类型定义与纯决策**（写不写、怎么合并、怎么匹配、怎么裁决），
 * 文件读写留给插件工具层（`~/.config/opencode/session-mgmt/memory/<层级>/<条目>.json`，
 * 按条文件、删文件即遗忘——3.4）。这样阶段 1 的每个决策都能直接单测。
 *
 * 贯穿全文件的三条纪律（3.5/3.6）：
 * - **只有 L1 身份性事实能消缺口**，其余层级只影响措辞或带默认猜测
 * - **静默接受不入库**（origin=accepted_default 不写）
 * - **同名不同义是预期情况**，不静默覆盖，走冲突裁决（3.3.1）
 */
import type { ReqdocSlot, SlotSource } from "./reqdoc-slots"

// ---------------------------------------------------------------------------
// 3.4 记忆条目 schema
// ---------------------------------------------------------------------------

/** 作用域：org=两工作流共享；reqdoc / sdlc=各工作流专属。 */
export type MemoryScope = "org" | "reqdoc" | "sdlc"

/** 来源类别（不是槽位状态——A5 词汇消歧：记忆侧 origin 与槽位 status 是两套词汇）。 */
export type MemoryOrigin = "restated" | "accepted_default" | "explicit" | "inferred"

/** 术语分类（复用 `conventions/reqdoc/00-术语与命名.md` 第 2 条既有区分，不新造标准）。 */
export type TermKind = "行业通用" | "系统口径" | "内部简称"

/** 语境：business=当业务/领域概念讨论；code=纯代码标识符语境（后者不入 L1，3.3.1）。 */
export type OriginContext = "business" | "code"

export interface L1Term {
  term: string
  definition: string
  kind: TermKind
  scope: MemoryScope
  origin: MemoryOrigin
  originContext: OriginContext
  fromProject: string
  confirmedAt: number
  retired?: boolean
}

export interface L2Fact {
  /** 组织知识正文（如"本行核心系统含信贷系统/ESB"） */
  content: string
  /** 该知识的来源类别（文档/问答/缺省），与槽位来源同名但语义是"这条知识哪来的" */
  source: SlotSource
  scope: MemoryScope
  origin: MemoryOrigin
  fromProject: string
  confirmedAt: number
  /** 时效：超期可在 CLI 提示复核（3.8） */
  lastVerifiedAt?: number
  retired?: boolean
}

export interface L4Preference {
  key: string
  value: string
  scope: MemoryScope
  /** 观察次数，供用户判断可信度；显式陈述为 1 */
  evidence: number
  origin: MemoryOrigin
  fromProject: string
  confirmedAt: number
  retired?: boolean
}

/** 观测型记忆在项目内的待确认计数（3.3.2：只统计不写全局，但必须可见）。 */
export interface PendingObservation {
  key: string
  pattern: string
  count: number
  firstSeenAt: number
  askedAt?: number
}

// ---------------------------------------------------------------------------
// 3.5 写入决策：静默接受不入库、代码语境不入 L1
// ---------------------------------------------------------------------------

export type WriteAction = "write" | "skip"

export interface WriteDecision {
  action: WriteAction
  /** 写入时的 origin（仅 action=write 时有值） */
  origin?: MemoryOrigin
  reason: string
}

/**
 * 决定一条陈述是否写入记忆（3.5 的机器化）。
 * 三条硬纪律在此收口：
 * 1. `accepted_default`（业务只是点了默认）→ **不写**——业务没真的认可
 * 2. `originContext=code`（纯代码标识符语境）→ **不入 L1**（3.3.1，k8s CRD 污染风险）
 * 3. 其余（restated / explicit）→ 写
 */
export function decideL1Write(input: {
  kind: TermKind
  origin: MemoryOrigin
  originContext: OriginContext
}): WriteDecision {
  if (input.origin === "accepted_default") {
    return { action: "skip", reason: "静默接受不入库：业务未真正认可，不污染后续需求（3.5）" }
  }
  if (input.originContext === "code") {
    return { action: "skip", reason: "纯代码标识符语境不入 L1：避免同名不同义跨工作流污染（3.3.1）" }
  }
  if (input.origin === "restated" || input.origin === "explicit") {
    return { action: "write", origin: input.origin, reason: "用户主动陈述/纠正，即时确认写入" }
  }
  return { action: "skip", reason: "origin=inferred 不足以支撑 L1 术语（需用户复述或明说）" }
}

/** 负向偏好（"别再问我 X"）——显式陈述即写，并把被撤销的同 key 条目标 retired（3.5）。 */
export function decideL4Write(input: { origin: MemoryOrigin }): WriteDecision {
  if (input.origin === "accepted_default") {
    return { action: "skip", reason: "静默接受不写偏好" }
  }
  return { action: "write", origin: input.origin, reason: "显式偏好陈述" }
}

// ---------------------------------------------------------------------------
// 3.3.1 同名不同义：不静默覆盖
// ---------------------------------------------------------------------------

export type TermConflictKind = "same-term-different-definition" | "none"

/**
 * 同名术语冲突检测：术语相同但释义不同 → 冲突（预期情况，非异常）。
 * `kind` 不同也算冲突候选（如 k8s CRD=CustomResourceDefinition vs 内部 CRD=信贷审批部）。
 */
export function detectTermConflict(
  existing: readonly L1Term[],
  incoming: Pick<L1Term, "term" | "definition" | "kind">,
): { conflict: TermConflictKind; existing?: L1Term } {
  const same = existing.find((t) => t.term === incoming.term && !t.retired)
  if (!same) return { conflict: "none" }
  const sameMeaning = same.definition.trim() === incoming.definition.trim() && same.kind === incoming.kind
  return sameMeaning
    ? { conflict: "none", existing: same }
    : { conflict: "same-term-different-definition", existing: same }
}

/** 冲突时不静默覆盖：把两条都标为待裁决（`conflict` 语义），由业务/用户裁决（3.3.1）。 */
export interface TermMergeResult {
  terms: L1Term[]
  /** 待人工裁决的冲突（业务在对话中选"采纳哪边"） */
  pendingAdjudication: { term: string; kept: L1Term; incoming: Pick<L1Term, "definition" | "kind"> }[]
}

/**
 * 合并新术语到既有集合（3.4 去重合并）：
 * - 无冲突且释义相同 → 幂等（复用既有条目，不产生重复）
 * - 同名不同义 → **不覆盖**，两条并存待裁决
 */
export function mergeL1Terms(existing: readonly L1Term[], incoming: readonly L1Term[]): TermMergeResult {
  const terms = [...existing]
  const pendingAdjudication: TermMergeResult["pendingAdjudication"] = []
  for (const t of incoming) {
    const { conflict, existing: same } = detectTermConflict(terms, t)
    if (conflict === "none") {
      if (same) continue // 幂等：已存在且释义一致
      terms.push(t)
      continue
    }
    pendingAdjudication.push({ term: t.term, kept: same!, incoming: { definition: t.definition, kind: t.kind } })
    // 并存待裁决：新条目也入库，但 origin 标 inferred 表明未经确认
    terms.push({ ...t, origin: "inferred" })
  }
  return { terms, pendingAdjudication }
}

// ---------------------------------------------------------------------------
// 3.6 读取：材料驱动的记忆匹配（7.1 的封顶保证在此兑现）
// ---------------------------------------------------------------------------

/**
 * 从材料文本里匹配 L1 术语（**由材料驱动**——这是 7.1 封顶保证的基础：
 * 记忆库再大，注入的永远只是本材料出现过的那些）。
 * 匹配规则：术语（及其别名）作为词边界子串出现。行业通用缩写命中即**不要求定义**。
 */
export function matchL1ByMaterial(
  materialText: string,
  terms: readonly L1Term[],
): { hit: L1Term; requiresDefinition: boolean }[] {
  const hits: { hit: L1Term; requiresDefinition: boolean }[] = []
  for (const t of terms) {
    if (t.retired) continue
    if (!containsTerm(materialText, t.term)) continue
    // 行业通用属正常行话、允许使用（3.2）——命中不产生定义要求
    hits.push({ hit: t, requiresDefinition: t.kind !== "行业通用" })
  }
  return hits
}

/** 词边界子串匹配（英文缩写需避免嵌在更长单词里；中文直接子串）。 */
function containsTerm(text: string, term: string): boolean {
  if (!term) return false
  const idx = text.indexOf(term)
  if (idx < 0) return false
  if (!/[A-Za-z]/.test(term[0]!)) return true // 中文/数字：直接子串
  const before = idx === 0 ? "" : text[idx - 1]!
  const after = text[idx + term.length] ?? ""
  return !/[A-Za-z0-9]/.test(before) && !/[A-Za-z0-9]/.test(after)
}

// ---------------------------------------------------------------------------
// 6.2.2 聚合来源标签取最弱档
// ---------------------------------------------------------------------------

/** 来源强弱：缺省 < 问答 < 文档（数值越大越"强"）。 */
const SOURCE_RANK: Record<SlotSource, number> = { 缺省: 0, 问答: 1, 文档: 2 }

/**
 * 容器节的来源标签 = 各子槽位来源的**最弱档**（6.2.2）。
 * 只要有任一子项为 `缺省`，整节不得标 `[文档]`——否则 Option A 的来源保证被绕过。
 */
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
// 6.3 停问收敛：draft 不丢弃也不保留原样，诚实标未确认
// ---------------------------------------------------------------------------

/**
 * 停问收敛（6.3）：问满 2 轮仍未确认的槽位——
 * - 有 draft 内容 → 强制转 `[缺省：业务未确认；依据 <来源>@<日期>]`，**保留但诚实标注**
 * - 无 draft → `[缺省：业务未确认]`
 * 关键：PRD 中不得出现无来源标签的正文——这是 A1 修复确立的硬不变量。
 */
export function applyStopAsking(
  slot: ReqdocSlot,
  opts: { memoryFrom?: { fromProject: string; confirmedAt: number } },
): ReqdocSlot {
  const reason = opts.memoryFrom
    ? `业务未确认；依据 ${opts.memoryFrom.fromProject}@${new Date(opts.memoryFrom.confirmedAt).toISOString().slice(0, 10)}`
    : "业务未确认"
  return { ...slot, source: "缺省", status: "draft", reason }
}

// ---------------------------------------------------------------------------
// 6.4 冲突裁决：两侧都不装
// ---------------------------------------------------------------------------

/**
 * 检出记忆与材料冲突 → 槽位进入 `conflict`，**两侧内容都不装进 content**
 * （6.4 第一行：冲突期间若先装一边，PRD 会带着未经确认的一侧进交付件）。
 */
export function detectSlotConflict(input: {
  slot: ReqdocSlot
  memoryContent?: string
  materialContent?: string
}): ReqdocSlot {
  const { slot, memoryContent, materialContent } = input
  if (!memoryContent || !materialContent) return slot
  if (memoryContent.trim() === materialContent.trim()) return slot
  return {
    ...slot,
    status: "conflict",
    content: "", // 两侧都不装
    conflict: { memory: memoryContent, material: materialContent },
  }
}

/** 裁决结果：采纳材料（更新记忆）/ 采纳记忆（材料侧退役）/ 暂不裁决（force 放行，内容仍空）。 */
export type AdjudicationChoice = "take-material" | "take-memory" | "defer"

/**
 * 冲突裁决（6.4）：只有 `take-material` / `take-memory` 会产出内容；
 * `defer` 保持内容为空（供 force 放行时渲染空节，见 6.5「force 不能解决 conflict」）。
 */
export function adjudicateConflict(
  slot: ReqdocSlot,
  choice: AdjudicationChoice,
): { slot: ReqdocSlot; memoryUpdate?: "rewrite-with-material" | "keep" } {
  if (slot.status !== "conflict" || !slot.conflict) return { slot }
  if (choice === "defer") return { slot }
  if (choice === "take-material") {
    return {
      slot: { ...slot, status: "confirmed", source: "文档", content: slot.conflict.material ?? "", conflict: undefined },
      memoryUpdate: "rewrite-with-material", // 记忆为陈旧 → 用材料重写
    }
  }
  return {
    slot: { ...slot, status: "confirmed", source: "问答", content: slot.conflict.memory ?? "", conflict: undefined },
    memoryUpdate: "keep", // 采纳记忆 → 材料侧旧值由调用方转 retired
  }
}

// ---------------------------------------------------------------------------
// A6 遗忘语义：删文件前先看谁在引用
// ---------------------------------------------------------------------------

/** 某条记忆被哪些未完成槽位引用（L1 消缺口时填充的槽位，其来源即该记忆）。 */
export interface ForgettingImpact {
  term: string
  /** 受影响槽位地址（confirmed 且来源为该记忆） */
  affectedSlots: string[]
  /** 是否需要用户决策：引用它的项目尚未定稿 */
  needsDecision: boolean
}

/**
 * 遗忘（删文件）前的引用检查（A6）：若该记忆正被未完成项目的 confirmed 槽位引用，
 * 直接删会留下悬空来源。必须列出受影响槽位让用户选"一并作废"或"先回填为项目内 draft"。
 */
export function forgettingImpact(
  term: L1Term,
  slots: readonly ReqdocSlot[],
  opts: { projectFinalized: boolean },
): ForgettingImpact {
  const affected = slots
    .filter((s) => s.status === "confirmed" && s.ref === term.term)
    .map((s) => s.address)
  return { term: term.term, affectedSlots: affected, needsDecision: !opts.projectFinalized && affected.length > 0 }
}

// ---------------------------------------------------------------------------
// 3.4 文件名规范化（B8：中文/空格/括号/设备名/长度）
// ---------------------------------------------------------------------------

/**
 * 术语 → 文件名 slug（按条文件存储，删文件即遗忘）。
 * 规则与 `reqdoc-dirs.ts` 的 `sanitizeDirName` 一致：过滤 Windows 非法字符与设备名，
 * 保留中文（术语多为中文），限长避免超路径限制。
 */
export function slugForTerm(term: string, maxLen = 60): string {
  const cleaned = term
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/, "")
    .trim()
  const device = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(cleaned)
  const base = cleaned === "" ? "_" : device ? `${cleaned}_` : cleaned
  return base.slice(0, maxLen)
}
