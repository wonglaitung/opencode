/**
 * 工作流工具（设计文档 §4.1）。
 * workflow_advance   —— 进入下一阶段 / 标记 approved（校验开发者确认语义）
 * workflow_revisit   —— 回退阶段（revision++）
 * commit_gate_check  —— 提交门禁检查，返回未完成阶段列表
 */
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { STAGE_LABELS, STAGE_ORDER, type StageName } from "sm-shared"
import type { Store } from "../db"
import { WorkflowOpError, applyTransition, recomputeCommit } from "../workflow-ops"

const z = tool.schema

const stageEnum = z.enum(STAGE_ORDER)

export function createWorkflowTools(store: Store): Record<string, ToolDefinition> {
  const workflow_advance = tool({
    description:
      "推进工作流阶段：enter 进入某阶段（in_progress），approve 在开发者明确确认后标记该阶段完成。" +
      "审查阶段（review）不可用本工具 approve，必须经 review_submit。",
    args: {
      stage: stageEnum.describe("目标阶段"),
      action: z.enum(["enter", "approve"]).describe("enter=开始该阶段；approve=确认完成"),
      developer_confirmed: z
        .boolean()
        .describe("approve 时必须为 true，表示开发者已在对话中明确确认；否则调用将被拒绝"),
      note: z.string().optional().describe("本次转换的备注"),
    },
    async execute(args, context) {
      if (args.action === "approve") {
        if (args.stage === "review") {
          throw new WorkflowOpError("审查阶段不可由 AI 自行 approve，请改用 review_submit 工具")
        }
        if (args.developer_confirmed !== true) {
          throw new WorkflowOpError("approve 需开发者明确确认：developer_confirmed 必须为 true")
        }
      }
      const saved = store.mutateWorkflow(context.sessionID, (workflow) => {
        applyTransition(workflow, args.stage as StageName, args.action, Date.now(), args.note)
      })
      const stage = saved.stages[args.stage as StageName]
      return (
        `✅ ${STAGE_LABELS[args.stage as StageName]} → ${stage.status}\n` +
        `提交门禁：${saved.commit.status}` +
        (saved.commit.blocked_by.length ? `（未完成：${saved.commit.blocked_by.join("、")}）` : "")
      )
    },
  })

  const workflow_revisit = tool({
    description: "回退到指定阶段（该阶段 revision++，状态回到 in_progress）。开发者说『回到XX』时调用。",
    args: {
      stage: stageEnum.describe("要回退到的阶段"),
      note: z.string().optional().describe("回退原因"),
    },
    async execute(args, context) {
      const saved = store.mutateWorkflow(context.sessionID, (workflow) => {
        applyTransition(workflow, args.stage as StageName, "revisit", Date.now(), args.note)
      })
      return `↩ 已回退到 ${STAGE_LABELS[args.stage as StageName]}（revision=${saved.stages[args.stage as StageName].revision}）`
    },
  })

  const commit_gate_check = tool({
    description: "提交门禁检查：返回五个阶段的完成状况；未全部 approved 时列出未完成阶段。提交前应调用。",
    args: {},
    async execute(_args, context) {
      const saved = store.mutateWorkflow(context.sessionID, (workflow) => {
        recomputeCommit(workflow)
      })
      if (saved.commit.status === "allowed") {
        return "✓ 全部五个阶段已 approved，允许提交。"
      }
      const pending = saved.commit.blocked_by.map((s) => STAGE_LABELS[s as StageName]).join("、")
      return `✗ 尚不可提交，未完成阶段：${pending}`
    },
  })

  return { workflow_advance, workflow_revisit, commit_gate_check }
}
