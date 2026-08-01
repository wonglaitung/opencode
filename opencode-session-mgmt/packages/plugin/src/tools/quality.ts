/**
 * 质量指标工具与迭代计数（设计文档 §3.2、§4.3、§7.4 规则 15-20）。
 * quality_report —— Agent 上报 acceptanceRate，增量合并写 workflow.quality
 * 迭代计数 —— tool.execute.after 统计代码编辑轮次，达 3 轮由 system prompt 提示人工介入
 */
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { Store } from "../db"

const z = tool.schema

/** 视为"AI 代码编辑"的上游工具名（计入迭代轮次）。 */
export const CODE_EDIT_TOOLS = new Set(["write", "edit", "multiedit", "patch"])

/** 业界健康采纳率上限；超过则提示可能未充分审查（§7.4 规则 16）。 */
export const ACCEPTANCE_WARN_THRESHOLD = 45

export function createQualityTools(store: Store): Record<string, ToolDefinition> {
  const quality_report = tool({
    description:
      "上报会话内质量指标（acceptanceRate 采纳率 0-100、iterationCount 迭代轮次），增量合并写入 workflow.quality。",
    args: {
      acceptanceRate: z.number().min(0).max(100).optional().describe("代码建议采纳率（%）"),
      iterationCount: z.number().int().min(0).optional().describe("当前迭代轮次"),
    },
    async execute(args, context) {
      const patch: { quality: { acceptanceRate?: number; iterationCount?: number } } = { quality: {} }
      if (args.acceptanceRate !== undefined) patch.quality.acceptanceRate = args.acceptanceRate
      if (args.iterationCount !== undefined) patch.quality.iterationCount = args.iterationCount
      const saved = store.updateWorkflow(context.sessionID, patch)
      const rate = saved.quality.acceptanceRate
      const warning =
        rate !== null && rate > ACCEPTANCE_WARN_THRESHOLD
          ? `\n⚠ 采纳率 ${rate}% 超过健康阈值（${ACCEPTANCE_WARN_THRESHOLD}%），请逐段回顾变更，确认能独立解释其原理。`
          : ""
      return `已记录质量指标：acceptanceRate=${rate ?? "N/A"}，iterationCount=${saved.quality.iterationCount ?? "N/A"}${warning}`
    },
  })

  return { quality_report }
}

/**
 * 生成 tool.execute.after 处理器：每次 AI 代码编辑使迭代轮次 +1。
 * 重置规则（人工编辑证据，§3.2）依赖文件级 diff 来源判断，超出计数职责，由审查流程人工触发。
 */
export function createIterationCounter(store: Store) {
  return async (input: { tool: string; sessionID: string }): Promise<void> => {
    if (!CODE_EDIT_TOOLS.has(input.tool)) return
    store.mutateWorkflow(input.sessionID, (workflow) => {
      workflow.quality.iterationCount = (workflow.quality.iterationCount ?? 0) + 1
    })
  }
}

/** 供测试与提示：迭代轮次上限（§3.2，达 3 轮拒绝继续生成）。 */
export const ITERATION_LIMIT = 3
