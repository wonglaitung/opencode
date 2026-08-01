/**
 * 质量指标工具与迭代计数（设计文档 §3.2、§4.3、§7.4 规则 15-20）。
 * quality_report —— Agent 上报 acceptanceRate，增量合并写 workflow.quality
 * 迭代计数 —— tool.execute.after 统计代码编辑轮次，达 3 轮由 system prompt 提示人工介入
 */
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { Store } from "../db"

const z = tool.schema

/**
 * 视为"AI 代码编辑"的上游工具名（计入迭代轮次）。
 * 上游 packages/opencode/src/tool/ 实际注册的代码编辑工具为 write / edit / apply_patch
 * （shell 工具名是 "bash"，read/grep 等只读工具不计）。
 */
export const CODE_EDIT_TOOLS = new Set(["write", "edit", "apply_patch"])

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
 * 从工具入参提取文件键：write/edit 携带 filePath；无单一文件路径的工具
 * （如 apply_patch，入参为 patchText）归入 "(<工具名>)" 工具级桶。
 */
function fileKey(toolName: string, args: unknown): string {
  if (typeof args === "object" && args !== null) {
    const a = args as Record<string, unknown>
    const p = a.filePath ?? a.file_path ?? a.path
    if (typeof p === "string" && p !== "") return p
  }
  return `(${toolName})`
}

/**
 * 生成 tool.execute.after 处理器：按文件累计 AI 代码编辑轮次。
 *
 * 计数语义（§3.2 / §7.4 规则 17）：iterationCount 是「同一段代码/文件」的
 * 生成-修改循环次数，而非全会话编辑总数——故按 input.args 的文件路径分桶，
 * iterationCount 取各文件最大值。这样"达到 3 轮"指某文件被 AI 连改 3 次，
 * 与文档"第 4 轮起人工重写该段"的含义一致。
 *
 * 重置规则受限说明（§3.2 重置表 / §7.4 规则 20）：三条重置条件均需"文件级
 * 实际变更证据"（非 Agent 的 diff 来源 / >50% 行变更 + 非 Agent commit author），
 * 这超出插件 Hook 的能力面（需文件系统监听或 git author 检查），列为 Phase 3+。
 * 本实现刻意不提供"口头/工具重置"——规则 20 明确"仅靠对话中说'已修改'不足以
 * 触发重置，必须有文件级证据"，以防开发者口头绕过迭代上限。
 */
export function createIterationCounter(store: Store) {
  return async (input: { tool: string; sessionID: string; args?: unknown }): Promise<void> => {
    if (!CODE_EDIT_TOOLS.has(input.tool)) return
    const key = fileKey(input.tool, input.args)
    store.mutateWorkflow(input.sessionID, (workflow) => {
      const byFile = workflow.quality.iterationByFile ?? {}
      byFile[key] = (byFile[key] ?? 0) + 1
      workflow.quality.iterationByFile = byFile
      workflow.quality.iterationCount = Math.max(...Object.values(byFile))
    })
  }
}

/** 供测试与提示：迭代轮次上限（§3.2，达 3 轮拒绝继续生成）。 */
export const ITERATION_LIMIT = 3
