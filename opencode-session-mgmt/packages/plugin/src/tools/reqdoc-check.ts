/**
 * reqdoc 渲染结构校验工具（质量飞轮 P2「渲染可测化」，设计文档 workflow-reqdoc.md 7 章、10 章）。
 * reqdoc_check —— PRD 渲染完成并写入 06_需求规格产出 后调用，对照模板结构 schema
 * （REQDOC_TEMPLATE_CHAPTERS / REQDOC_TEMPLATE_FIELDS，同源 renderCheckRubric）做渲染 diff 校验：
 * 章节齐全/顺序、功能点块数与已确认功能点一致、映射字段逐功能点带来源标注。
 * 校验结果写入 workflow.render；review_submit 定稿时重读源 md 复核（柔性：不调用则放行）。
 * 仅 reqdoc 工作流有效。
 */
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import {
  REQDOC_TEMPLATE_CHAPTERS,
  REQDOC_TEMPLATE_FIELDS,
  FEATURE_SUB_SECTIONS,
  getDefinition,
  parseRenderStructure,
  renderCheckRubric,
  renderStructureViolations,
  type ReqdocRender,
} from "sm-shared"
import type { Store } from "../db"
import { WorkflowOpError } from "../workflow-ops"
import { resolveWithinWorktree, projectRoot } from "../fs-safe"

const z = tool.schema

export function createReqdocCheckTools(store: Store): Record<string, ToolDefinition> {
  const reqdoc_check = tool({
    description:
      `reqdoc 渲染校验：PRD 渲染完成并写入 06_需求规格产出 后，对照模板结构 schema 校验渲染 diff（章节齐全/顺序、功能点块数、必填字段来源标注）：\n${renderCheckRubric()}\n` +
      "source 填 PRD Markdown 相对项目根路径（如 06_需求规格产出/N_名称/xxx.md）。" +
      "校验有违规须修正后重调复查；结构合规后再 review_submit 定稿。仅 reqdoc 工作流有效。",
    args: {
      source: z.string().describe("PRD Markdown 相对项目根路径（06_需求规格产出/N_名称/xxx.md）"),
      feature: z
        .string()
        .optional()
        .describe("增量诊断（P3.7）：仅聚焦某个功能点（填功能点序号如 '1' 或 '功能点 1'），输出该块的期望 vs 实际逐项差异；缺省校验整篇"),
    },
    async execute(args, context) {
      // 仅 reqdoc + 已确认功能点数（异步文件读取在 mutateWorkflow 回调外，回调同步约束）
      let expectedFeatures = 0
      store.mutateWorkflow(context.sessionID, (workflow) => {
        const def = getDefinition(workflow.type)
        if (def.type !== "reqdoc") {
          throw new WorkflowOpError(`reqdoc_check 仅用于 reqdoc 工作流（当前为 ${def.type}）`)
        }
        expectedFeatures = workflow.features?.length ?? 0
      })
      const mdPath = resolveWithinWorktree(projectRoot(context), args.source)
      let md: string
      try {
        md = await Bun.file(mdPath).text()
      } catch {
        throw new WorkflowOpError(`源文件不存在或不可读：${args.source}。请先完成 PRD 渲染（write 到 06_需求规格产出）再调用校验。`)
      }
      const structure = parseRenderStructure(md)
      const render: ReqdocRender = {
        ...structure,
        source: args.source,
        checkedAt: Date.now(),
        expectedFeatures,
      }
      const violations = renderStructureViolations(render)
      // 连续失败计数（P3.9）：有违规累加，合规清零；≥3 时卡片提示人工介入 + 格式诊断
      let fails = 0
      store.mutateWorkflow(context.sessionID, (workflow) => {
        workflow.render = render
        const prev = workflow.renderCheckFails ?? 0
        fails = violations.length > 0 ? prev + 1 : 0
        workflow.renderCheckFails = fails
      })
      const focused = args.feature ? focusFeatureDiff(render, args.feature) : undefined
      return formatRenderCard(render, violations, fails, focused)
    },
  })

  return { reqdoc_check }
}

/** 增量诊断（P3.7）：把某功能点的期望子小节与实际情况逐项对比，输出缺失清单。 */
function focusFeatureDiff(render: ReqdocRender, featureArg: string): { label: string; present: string[]; missing: string[] } | string {
  const m = featureArg.match(/(\d+)/)
  if (!m) return `未解析到功能点序号：${featureArg}（请填 '1' 或 '功能点 1'）`
  const idx = parseInt(m[1], 10)
  const label = `功能点 ${idx}`
  const missing = render.missingFeatureSections
    .filter((s) => s.startsWith(`${label} 缺`))
    .map((s) => s.replace(`${label} 缺 `, ""))
  const present = FEATURE_SUB_SECTIONS.map((s) => `${s.key} ${s.title}`).filter((t) => !missing.includes(t))
  return { label, present, missing }
}

/** 期望功能点块骨架（同源 renderCheckRubric，避免漂移），供 check 卡片展示"期望 vs 实际"。 */
function expectedSkeleton(): string {
  const subs = FEATURE_SUB_SECTIONS.map((s) => `${s.key} ${s.title}`).join("、")
  const fields = REQDOC_TEMPLATE_FIELDS.map((f) => `${f.key} ${f.title}`).join("、")
  return (
    `期望每功能点块：${subs}；主分组标题「1. 功能点输入要素」「2. 功能点处理要求」为可选分组标签（可纯文本/省略），` +
    `小节层级 3~5 均可，标题须含编号+名称；映射字段须逐功能点标来源 [文档]/[问答]/[缺省]（可包全角括号，如「2.1 输入要素的检查（[问答]）」）：${fields}。`
  )
}

/** 把渲染校验记录格式化为工具返回文本：章节/功能点骨架、必填字段来源覆盖、10 格进度条（弱模型直接可见）。 */
function formatRenderCard(
  render: ReqdocRender,
  violations: string[],
  fails: number,
  focused?: { label: string; present: string[]; missing: string[] } | string,
): string {
  const chapterOk = render.missing.length === 0 && render.outOfOrder.length === 0
  const featureOk = render.featureCount === render.expectedFeatures && render.featureOk
  const totalFields = REQDOC_TEMPLATE_FIELDS.length * render.featureCount
  const coveredCount = REQDOC_TEMPLATE_FIELDS.reduce((sum, f) => sum + (render.covered[f.key] ?? 0), 0)
  const barLen = 10
  const filled = totalFields > 0 ? Math.round((coveredCount / totalFields) * barLen) : barLen
  const bar = "▓".repeat(filled) + "░".repeat(barLen - filled)
  const chapterLine = chapterOk
    ? `章节骨架 ✓ 齐全且顺序正确（${render.chaptersPresent.length}/${REQDOC_TEMPLATE_CHAPTERS.length} 章）`
    : `章节骨架 ✗ ${[render.missing.map((t) => `缺 ${t}`), render.outOfOrder.map((t) => `乱序 ${t}`)].flat().join("、")}`
  const focusedBlock =
    focused === undefined
      ? ""
      : typeof focused === "string"
        ? `\n🔍 增量诊断：${focused}`
        : `\n🔍 增量诊断（${focused.label} 期望 vs 实际）：\n  期望子小节：${FEATURE_SUB_SECTIONS.map((s) => `${s.key} ${s.title}`).join("、")}\n  ✓ 已具备：${focused.present.join("、") || "（无）"}\n  ✗ 缺失：${focused.missing.join("、") || "（无）"}`
  const iterateNote =
    fails >= 3
      ? `\n⚠ 已连续 ${fails} 次校验不通过：建议人工介入核对模板格式/结构（章节标题须为 ##/###、功能点块须 ### 起头带序号），或请业务补充材料后重渲染，避免模型在错误结构上反复打磨。`
      : ""
  return (
    `📐 已校验 PRD 渲染结构（${render.source}）：\n` +
    `${chapterLine}\n` +
    `功能点块：${render.featureCount}/${render.expectedFeatures}（已确认功能点数）${featureOk ? " ✓" : " ✗ 骨架不完整"}\n` +
    `必填字段来源覆盖：${coveredCount}/${totalFields} 处\n` +
    `期望骨架：${expectedSkeleton()}\n` +
    `覆盖进度：[${bar}] ${totalFields > 0 ? Math.round((coveredCount / totalFields) * 100) : 100}%\n` +
    focusedBlock +
    (violations.length > 0
      ? `\n⚠ 渲染违规 ${violations.length} 项：\n  - ${violations.join("\n  - ")}\n→ 请修正后重调 reqdoc_check 复查；[缺省] 字段须在 reqdoc_score 对应维度如实扣分。`
      : `\n✓ 结构合规，可 review_submit 定稿（渲染校验记录已在定稿时复核）。`) +
    iterateNote
  )
}
