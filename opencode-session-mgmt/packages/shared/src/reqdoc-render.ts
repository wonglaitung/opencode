/**
 * reqdoc 渲染结构校验（质量飞轮 P2「渲染可测化」）。
 * 把「渲染严格逐字遵循模板」（reqdoc-r20 铁律）从纯规则文本升级为结构 schema + 渲染 diff 校验：
 * - REQDOC_TEMPLATE_CHAPTERS：模板章节骨架（章节树 + 必填小节），校验出现 + 顺序。
 * - REQDOC_TEMPLATE_FIELDS：r20 扣分项→字段映射表结构化（7 条，全部 feature-scoped），
 *   兼作「必填字段须标来源」清单与「[缺省]↔满分」矛盾映射。
 * - parseRenderStructure：纯函数解析渲染 md（标题/功能点块/来源标注），运行时 reqdoc_check 工具
 *   与评测 render 判定类共用同一函数（同源，避免两份漂移）。
 * 模板演进须同步本文件 schema（13.6 已承诺），docs/reqdoc-prd-template.md 本身不动。
 */
import type { ReqdocScore, ReqdocScoreDimKey } from "./workflow"

/** 模板章节（骨架，渲染 diff 校验用）：meta 章只查出现，sections 章查子小节齐全。 */
export interface ReqdocTemplateSection {
  key: string
  title: string
}

export interface ReqdocTemplateChapter {
  key: string
  title: string
  /** 元数据章（项目信息/文档变更过程）：渲染时留空占位，不查来源标注 */
  meta?: boolean
  /** 章节子小节（第一章 1.1-1.6、第二章 2.1/2.2） */
  sections?: readonly ReqdocTemplateSection[]
}

/** reqdoc PRD 模板章节骨架（docs/reqdoc-prd-template.md 的有序章节树）。 */
export const REQDOC_TEMPLATE_CHAPTERS: readonly ReqdocTemplateChapter[] = [
  { key: "project_info", title: "一、项目信息", meta: true },
  { key: "doc_change", title: "二、文档变更过程", meta: true },
  {
    key: "overview",
    title: "第一章 需求概述",
    sections: [
      { key: "1.1", title: "需求类型" },
      { key: "1.2", title: "属于流程优化项目" },
      { key: "1.3", title: "涉及跨部门项目" },
      { key: "1.4", title: "涉及总行开发" },
      { key: "1.5", title: "希望完成时间" },
      { key: "1.6", title: "需求提出原因及功能概述" },
    ],
  },
  {
    key: "terms",
    title: "第二章 术语定义与业务规则",
    sections: [
      { key: "2.1", title: "术语定义" },
      { key: "2.2", title: "业务规则" },
    ],
  },
  { key: "details", title: "第三章 需求功能详述" },
]

/**
 * 打分卡扣分项→模板字段映射（reqdoc-r20 铁律内嵌映射表的结构化，逐功能点出现）。
 * 同时是「必填字段须标来源」清单（covered 检查）与「[缺省]↔满分」矛盾映射（renderGapViolations）。
 * 单点定义：reqdoc_check 工具、reqdoc-r23 规则文本、状态条、评测共用——经 renderCheckRubric() 生成文本注入。
 */
export interface ReqdocTemplateField {
  key: string
  title: string
  /** 映射打分卡维度：该字段标 [缺省] 而维度打满分 = 渲染缺口与自评矛盾 */
  dims: readonly ReqdocScoreDimKey[]
}

export const REQDOC_TEMPLATE_FIELDS: readonly ReqdocTemplateField[] = [
  // 留痕与双人复核 → 1.2 控制要求；数据边界与岗位权限 → 1.2 控制要求/2.1 输入要素的检查
  { key: "1.2", title: "控制要求", dims: ["compliance", "authority"] },
  { key: "2.1", title: "输入要素的检查", dims: ["authority"] },
  // 异常边界（网络超时/操作失败/并发重复提交/逆向撤销驳回）→ 2.3 异常处理要求/2.6 清算处理/2.7 差错处理
  { key: "2.3", title: "异常处理要求", dims: ["edgeControl"] },
  { key: "2.6", title: "清算处理", dims: ["edgeControl"] },
  { key: "2.7", title: "差错处理", dims: ["edgeControl"] },
  // 脱敏规则（手机号/身份证遮罩）→ 2.8 交易安全性/2.9 数据存贮和清理
  { key: "2.8", title: "交易安全性", dims: ["compliance"] },
  { key: "2.9", title: "数据存贮和清理", dims: ["compliance"] },
]

/** 功能点块内子小节（模板「功能点 N」的固定骨架：输入要素 1.1/1.2 + 处理要求 2.1-2.10）。 */
const FEATURE_SUB_SECTIONS: readonly { key: string; title: string }[] = [
  { key: "1.1", title: "简要概述" },
  { key: "1.2", title: "控制要求" },
  { key: "2.1", title: "输入要素的检查" },
  { key: "2.2", title: "系统处理过程" },
  { key: "2.3", title: "异常处理要求" },
  { key: "2.4", title: "提示信息" },
  { key: "2.5", title: "其他要求" },
  { key: "2.6", title: "清算处理" },
  { key: "2.7", title: "差错处理" },
  { key: "2.8", title: "交易安全性" },
  { key: "2.9", title: "数据存贮和清理" },
  { key: "2.10", title: "附件" },
]

/** 来源标注标签（渲染时逐字段标来源，同 reqdoc-r14/r20）：「补」= 模板无对应字段的补充内容。 */
const SOURCE_TAG_RE = /(\[文档\]|\[问答\]|\[缺省\]|「补」)/g

/** 渲染结构解析产物（parseRenderStructure 返回，运行时与评测共用）。 */
export interface RenderStructure {
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
}

/** reqdoc 渲染校验记录（reqdoc_check 工具写入 WorkflowState.render；Review 时重读源复核）。 */
export interface ReqdocRender extends RenderStructure {
  /** 校验的 PRD md 相对项目根路径 */
  source: string
  checkedAt: number
  /** 已确认功能点数（WorkflowState.features.length），用于块数比对 */
  expectedFeatures: number
}

/** 标题归一化：忽略所有空白差异（模型渲染时空白/全角空格可能有出入）。 */
function norm(s: string): string {
  return s.replace(/\s+/g, "").trim()
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
export function parseRenderStructure(md: string): RenderStructure {
  const lines = md.split(/\r?\n/)
  const headings: { level: number; text: string; idx: number }[] = []
  lines.forEach((raw, idx) => {
    const h = headingAt(raw)
    if (h) headings.push({ level: h.level, text: h.text, idx })
  })

  // 1) 章节出现 + 顺序
  const chaptersPresent: string[] = []
  for (const h of headings) {
    if (h.level !== 2) continue
    const si = REQDOC_TEMPLATE_CHAPTERS.findIndex((c) => norm(c.title) === norm(h.text))
    if (si >= 0 && !chaptersPresent.includes(REQDOC_TEMPLATE_CHAPTERS[si].title)) {
      chaptersPresent.push(REQDOC_TEMPLATE_CHAPTERS[si].title)
    }
  }
  const missing = REQDOC_TEMPLATE_CHAPTERS.map((c) => c.title).filter((t) => !chaptersPresent.includes(t))
  const orderIdx = chaptersPresent.map((t) => REQDOC_TEMPLATE_CHAPTERS.findIndex((c) => c.title === t))
  const outOfOrder: string[] = []
  for (let i = 1; i < orderIdx.length; i++) {
    if (orderIdx[i] <= orderIdx[i - 1]) outOfOrder.push(chaptersPresent[i])
  }

  // 2) 第一章/第二章 子小节齐全（按章节出现顺序切块，下一章节前即本章范围）
  const missingSections: string[] = []
  const l2 = headings.filter((h) => h.level === 2)
  for (const ch of REQDOC_TEMPLATE_CHAPTERS) {
    if (!ch.sections?.length) continue
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
        // 标题行可能带来源标注（弱模型常写成「### 1.1 需求类型 [文档]」），匹配时剥掉
        return !!h && h.level === 3 && norm(h.text.replace(SOURCE_TAG_RE, "")) === norm(`${s.key} ${s.title}`)
      })
      if (!present) missingSections.push(`${ch.title} ${s.key} ${s.title}`)
    }
  }

  // 3) 功能点块切分（### 功能点 N 起，到下一个该行或 EOF 止）
  const featureHeadingRe = /^###\s+功能点\s*(\d+)\s*$/
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
  for (const f of REQDOC_TEMPLATE_FIELDS) {
    covered[f.key] = 0
    defaults[f.key] = 0
  }
  let featureOk = true
  const missingFeatureSections: string[] = []
  blocks.forEach((blockLines, bi) => {
    const label = `功能点 ${bi + 1}`
    const isHeading = (l: string, level: number, text: string) => {
      const h = headingAt(l)
      // 标题行可能带来源标注（「##### 2.1 输入要素的检查 [文档]」），匹配时剥掉，弱模型渲染更稳
      return !!h && h.level === level && norm(h.text.replace(SOURCE_TAG_RE, "")) === norm(text)
    }
    if (!blockLines.some((l) => isHeading(l, 4, "1. 功能点输入要素"))) {
      featureOk = false
      missingFeatureSections.push(`${label} 缺「1. 功能点输入要素」`)
    }
    if (!blockLines.some((l) => isHeading(l, 4, "2. 功能点处理要求"))) {
      featureOk = false
      missingFeatureSections.push(`${label} 缺「2. 功能点处理要求」`)
    }
    for (const s of FEATURE_SUB_SECTIONS) {
      if (!blockLines.some((l) => isHeading(l, 5, `${s.key} ${s.title}`))) {
        featureOk = false
        missingFeatureSections.push(`${label} 缺 ${s.key} ${s.title}`)
      }
    }
    for (const f of REQDOC_TEMPLATE_FIELDS) {
      const fi = blockLines.findIndex((l) => isHeading(l, 5, `${f.key} ${f.title}`))
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
      if (tags.includes("[缺省]")) defaults[f.key] += 1
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
    missingFeatureSections,
    covered,
    defaults,
  }
}

/**
 * 渲染结构违规（定稿复核门禁）：缺章节/小节、章节乱序、功能点块数 ≠ 已确认功能点数、
 * 映射字段漏标来源（必填字段须逐功能点带 [文档]/[问答]/[缺省]）。无 render 返回空（柔性放行）。
 */
export function renderStructureViolations(render: ReqdocRender | undefined): string[] {
  if (!render) return []
  const v: string[] = []
  if (render.missing.length) v.push(`缺章节：${render.missing.join("、")}`)
  if (render.missingSections.length) v.push(`缺小节：${render.missingSections.join("、")}`)
  if (render.outOfOrder.length) v.push(`章节顺序错：${render.outOfOrder.join("、")}`)
  if (render.featureCount !== render.expectedFeatures) {
    v.push(`功能点块数 ${render.featureCount} ≠ 已确认功能点 ${render.expectedFeatures}（第三章须每功能点一段）`)
  }
  if (!render.featureOk) v.push(`功能点块骨架不完整：${render.missingFeatureSections.join("、")}`)
  for (const f of REQDOC_TEMPLATE_FIELDS) {
    const covered = render.covered[f.key] ?? 0
    if (covered < render.featureCount) {
      v.push(`字段 ${f.key} ${f.title} 有 ${render.featureCount - covered}/${render.featureCount} 个功能点未标来源（须 [文档]/[问答]/[缺省]）`)
    }
  }
  return v
}

/**
 * 渲染缺口-扣分一致性校验（定稿复核门禁，镜像 P1 probeGapViolations）：
 * 对每个标 [缺省] 的映射字段（渲染留白 = 该内容尚未获得），若其映射打分卡维度打了满分，
 * 说明渲染缺口与自评矛盾（标缺却打满分 = 不诚实）。无 render / 无 score / 无 [缺省] → 返回空。
 */
export function renderGapViolations(
  render: ReqdocRender | undefined,
  score: ReqdocScore | undefined,
): string[] {
  if (!render || !score) return []
  const v: string[] = []
  for (const f of REQDOC_TEMPLATE_FIELDS) {
    const n = render.defaults[f.key] ?? 0
    if (n <= 0) continue
    for (const dim of f.dims) {
      const ds = score.dims[dim]
      if (ds && ds.score >= ds.max) {
        v.push(`字段 ${f.key} ${f.title} 标 [缺省]（${n} 个功能点渲染留白），但维度 ${dim} 打了满分（${ds.score}/${ds.max}）`)
      }
    }
  }
  return v
}

/**
 * 渲染结构校验标准文本（质量飞轮 P2）：reqdoc-r23 规则文本与 reqdoc_check 工具描述共用同一来源，
 * 避免「规则说一套、工具查一套」漂移。@see reqdocScoreRubric / reqdocProbeRubric
 */
export function renderCheckRubric(): string {
  const fields = REQDOC_TEMPLATE_FIELDS.map((f) => `${f.key} ${f.title}（对应 ${f.dims.join("/")}）`).join("、")
  return (
    `章节骨架（须齐全、顺序正确）：一、项目信息；二、文档变更过程；第一章 需求概述（1.1 需求类型~1.6 需求提出原因及功能概述）；` +
    `第二章 术语定义与业务规则（2.1 术语定义/2.2 业务规则）；第三章 需求功能详述（每功能点：输入要素 1.1/1.2，` +
    `处理要求 2.1 输入要素的检查~2.10 附件，编号连续）。\n必填字段（逐功能点须标来源 [文档]/[问答]/[缺省]，同 reqdoc-r14/r20）：${fields}。\n` +
    `[缺省] 字段对应打分卡维度打满分 = 渲染缺口与自评矛盾，review_submit 定稿会被拦。`
  )
}
