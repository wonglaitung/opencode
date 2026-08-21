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
      store.mutateWorkflow(context.sessionID, (workflow) => {
        workflow.render = render
      })
      return formatRenderCard(render, violations)
    },
  })

  return { reqdoc_check }
}

/** 把渲染校验记录格式化为工具返回文本：章节/功能点骨架、必填字段来源覆盖、10 格进度条（弱模型直接可见）。 */
function formatRenderCard(render: ReqdocRender, violations: string[]): string {
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
  return (
    `📐 已校验 PRD 渲染结构（${render.source}）：\n` +
    `${chapterLine}\n` +
    `功能点块：${render.featureCount}/${render.expectedFeatures}（已确认功能点数）${featureOk ? " ✓" : " ✗ 骨架不完整"}\n` +
    `必填字段来源覆盖：${coveredCount}/${totalFields} 处\n` +
    `覆盖进度：[${bar}] ${totalFields > 0 ? Math.round((coveredCount / totalFields) * 100) : 100}%\n` +
    (violations.length > 0
      ? `⚠ 渲染违规 ${violations.length} 项：\n  - ${violations.join("\n  - ")}\n→ 请修正后重调 reqdoc_check 复查；[缺省] 字段须在 reqdoc_score 对应维度如实扣分。`
      : `✓ 结构合规，可 review_submit 定稿（渲染校验记录已在定稿时复核）。`)
  )
}
