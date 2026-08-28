/**
 * reqdoc 打分卡工具（实施方案第三节，重构核心补齐）。
  * reqdoc_score —— AI 对照打分卡（8 维权重，满分 100）逐维打分，附扣分明细与证据引用，
 * 先向业务展示、业务明确认可后调用本工具记录（写入 workflow.score）。作为「进入 prd 阶段」
 * 与定稿（review_submit）的质量门禁依据：total ≥ REQDOC_SCORE_PASS（85）且业务确认方可推进。
 * 可多次重打覆盖（<85 按扣分明细回 edge 追问补缺后重打）。仅 reqdoc 工作流有效。
 */
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import {
  REQDOC_SCORE_DIMS,
  REQDOC_SCORE_PASS,
  getDefinition,
  reqdocScoreRubric,
  type ReqdocScore,
  type ReqdocScoreDeduction,
  type ReqdocScoreDimKey,
} from "sm-shared"
import type { Store } from "../db"
import { WorkflowOpError } from "../workflow-ops"

const z = tool.schema

const dimKeys = REQDOC_SCORE_DIMS.map((d) => d.key) as [ReqdocScoreDimKey, ...ReqdocScoreDimKey[]]

export function createReqdocScoreTools(store: Store): Record<string, ToolDefinition> {
  const reqdoc_score = tool({
    description:
      `reqdoc 打分卡：AI 对照评分标准逐维打分，评分标准（满分 100）：\n${reqdocScoreRubric()}\n` +
      "必须先向业务展示各维得分与扣分明细，业务明确认可后才调用本工具记录；total 由服务端计算。" +
      "**prd 门禁：workflow_advance(stage=prd, action=enter) 之前必须先调用本工具并获业务确认（business_confirmed=true），total≥85 才可推进**。" +
      "仅 reqdoc 工作流有效；<85 分可按扣分明细回 edge 追问补缺后重打覆盖。",
    args: {
       dims: z
        .array(
          z.object({
            key: z.enum(dimKeys).describe("维度键（各维度之一）"),
            score: z.number().int().min(0).describe("该维度实得分（0~该维度满分）"),
            deductions: z
              .array(
                z.object({
                  reason: z.string().describe("扣分原因（如「未提及任何异常流程」）"),
                  points: z.number().int().positive().describe("该条扣分数（≤该维度满分）"),
                  evidence: z
                    .string()
                    .optional()
                    .describe("证据引用：文档路径/段落或 [问答] 轮次（本机留痕，含路径不上行）"),
                }),
              )
              .optional()
              .describe("该维度扣分明细（无扣分可省略）"),
          }),
        )
        .min(8)
        .max(8)
        .describe("各维度实得分，须全部给出（含 material/nfr/acceptability 可实施性三维度）"),
      business_confirmed: z
        .boolean()
        .describe("业务是否已明确认可本打分结果与扣分明细；仅业务在对话中明确认可后才能为 true，防止 AI 自评自批"),
    },
    async execute(args, context) {
      if (args.business_confirmed !== true) {
        throw new WorkflowOpError("打分结果须业务明确认可：business_confirmed 必须为 true（先向业务展示扣分明细，再请其确认）")
      }
      const saved = store.mutateWorkflow(context.sessionID, (workflow) => {
        const def = getDefinition(workflow.type)
        if (def.type !== "reqdoc") {
          throw new WorkflowOpError(`reqdoc_score 仅用于 reqdoc 工作流（当前为 ${def.type}）`)
        }
        // 服务端校验：八维齐全、0 ≤ score ≤ 该维度满分；total = Σ 各维，不信任模型自报总分。
        const dims = {} as Record<ReqdocScoreDimKey, { score: number; max: number }>
        const deductions: ReqdocScoreDeduction[] = []
        let total = 0
        for (const dim of REQDOC_SCORE_DIMS) {
          const input = args.dims.find((d) => d.key === dim.key)
          if (!input) {
            throw new WorkflowOpError(`打分卡缺少维度 ${dim.key}（${dim.label}），各维度须全部打分`)
          }
          if (input.score > dim.max) {
            throw new WorkflowOpError(`维度 ${dim.key}（${dim.label}）得分 ${input.score} 超出满分 ${dim.max}`)
          }
          dims[dim.key] = { score: input.score, max: dim.max }
          total += input.score
          for (const d of input.deductions ?? []) {
            if (d.points > dim.max) {
              throw new WorkflowOpError(`维度 ${dim.key} 扣分 ${d.points} 超出该维度满分 ${dim.max}`)
            }
            deductions.push({ key: dim.key, points: d.points, reason: d.reason, evidence: d.evidence })
          }
        }
        workflow.score = {
          dims,
          deductions,
          total,
          confirmed: true,
          confirmedAt: Date.now(),
          updatedAt: Date.now(),
        }
      })
      return formatScoreCard(saved.score!)
    },
  })

  return { reqdoc_score }
}

/** 把打分卡格式化为工具返回文本：各维得分 + 扣分明细 + 总分 + 达标/门禁提示（弱模型直接可见）。 */
function formatScoreCard(score: ReqdocScore): string {
  const dimLines = REQDOC_SCORE_DIMS.map((dim) => {
    // 兜底：工具恒写 8 维，但防御旧/异常数据不致渲染崩溃
    const d = score.dims[dim.key] ?? { score: 0, max: dim.max }
    return `  ${dim.label}(${dim.key})：${d.score}/${d.max}${d.score < dim.max ? `（扣 ${dim.max - d.score}）` : ""}`
  }).join("\n")
  const deductionLines = score.deductions.length
    ? score.deductions.map((d) => `  - ${d.key}：-${d.points} ${d.reason}${d.evidence ? `（证据：${d.evidence}）` : ""}`).join("\n")
    : "  （无扣分明细）"
  const passed = score.total >= REQDOC_SCORE_PASS
  // 质量得分进度条（实施方案第四节：如 [▓▓▓▓▓░░░░░ 50%]；10 格，进度直观反映达标）
  const barLen = 10
  const totalMax = REQDOC_SCORE_DIMS.reduce((s, d) => s + d.max, 0)
  const filled = Math.round((score.total / totalMax) * barLen)
  const bar = "▓".repeat(filled) + "░".repeat(barLen - filled)
  return (
    `📊 已记录 PRD 质量打分（业务已确认，total 由服务端计算）：\n${dimLines}\n` +
    `扣分明细：\n${deductionLines}\n质量得分进度：[${bar}] ${Math.round((score.total / totalMax) * 100)}%（${score.total}/${totalMax}）\n` +
    `→ ${passed ? `达标（≥${REQDOC_SCORE_PASS}）✓，可 workflow_advance(stage=prd, action=enter) 进入渲染。` : `未达标（<${REQDOC_SCORE_PASS}）✗，请按扣分明细回 edge 追问补缺后重打 reqdoc_score。`}`
  )
}
