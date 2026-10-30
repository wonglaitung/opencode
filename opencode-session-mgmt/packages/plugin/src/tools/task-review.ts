/**
 * 独立代码审核子任务（task 工作流 code_review 分类）的报告工具。
 *
 * 它只属于 TASK：不读写 sdlc/reqdoc 状态，不创建/关联任何其他任务。
 * 报告提交是本子任务的完成条件；不约束任何编码任务。
 */
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import {
  TASK_REVIEW_DIMENSION_KEYS,
  TASK_REVIEW_DIMENSION_LABELS,
  type TaskReviewReport,
  type WorkflowState,
} from "sm-shared"
import type { Store } from "../db"
import { WorkflowOpError } from "../workflow-ops"

const z = tool.schema

const dimension = z.object({
  status: z.enum(["pass", "fail"]),
  notes: z.string().min(1).describe("该维度的结论与证据（必填，不能只填 pass/fail）"),
})

const check = z.object({
  name: z.string().min(1).describe("检查名称，如 typecheck / unit-test / lint / 手工验证"),
  command: z.string().optional().describe("实际执行的命令；手工检查可省略"),
  status: z.enum(["passed", "failed", "skipped"]),
  evidence: z.string().min(1).describe("结果摘要或未执行原因（skipped 必填）"),
})

/** 当前会话是否是 code_review 任务；不是则给出明确错误。 */
function requireCodeReviewTask(workflow: WorkflowState | null | undefined): WorkflowState {
  if (!workflow || workflow.type !== "task") {
    throw new WorkflowOpError("task_review 仅适用于一般任务工作流")
  }
  if (workflow.task?.category !== "code_review") {
    throw new WorkflowOpError(
      "代码审核报告只适用于 code_review 分类；请另开一般任务并归类为代码审核，不要关联其他任务。",
    )
  }
  if (workflow.stages.execute?.status !== "in_progress") {
    throw new WorkflowOpError("代码审核任务当前不在进行中，不能提交报告")
  }
  return workflow
}

export function createTaskReviewTool(store: Store): Record<string, ToolDefinition> {
  const task_review = tool({
    description:
      "提交一次独立代码审核任务的报告（仅 task 工作流的 code_review 分类）。" +
      "审核任务只读，不修改代码；必须先确认范围、运行/读取项目检查，并按六维给出结论。" +
      "报告提交后审核任务才能完成；结论可以是 approved 或 changes_requested。" +
      "不涉及 sdlc/reqdoc，也不约束任何编码任务。",
    args: {
      scope: z.array(z.string().min(1)).min(1).describe("审核范围：diff / commit / PR / 文件"),
      checks: z.array(check).min(1).describe("自动化或手工检查结果"),
      dimensions: z.object({
        correctness: dimension.describe(TASK_REVIEW_DIMENSION_LABELS.correctness),
        security: dimension.describe(TASK_REVIEW_DIMENSION_LABELS.security),
        design: dimension.describe(TASK_REVIEW_DIMENSION_LABELS.design),
        tests: dimension.describe(TASK_REVIEW_DIMENSION_LABELS.tests),
        impact: dimension.describe(TASK_REVIEW_DIMENSION_LABELS.impact),
        readability: dimension.describe(TASK_REVIEW_DIMENSION_LABELS.readability),
      }),
      findings: z.array(z.string().min(1)).optional().describe("问题/风险清单（有未通过项时必填）"),
    },
    async execute(args, context) {
      const current = store.get(context.sessionID)?.workflow
      requireCodeReviewTask(current)
      const failed =
        args.checks.some((c) => c.status === "failed") ||
        TASK_REVIEW_DIMENSION_KEYS.some((key) => args.dimensions[key].status === "fail")
      const findings = args.findings ?? []
      if (failed && findings.length === 0) {
        throw new WorkflowOpError("审核有未通过项时必须提供 findings，不能只标记 fail")
      }
      const verdict = failed ? "changes_requested" : "approved"
      const report: TaskReviewReport = {
        status: "submitted",
        scope: args.scope,
        checks: args.checks,
        dimensions: args.dimensions,
        findings,
        verdict,
        submittedAt: Date.now(),
      }
      store.mutateWorkflow(context.sessionID, (workflow) => {
        requireCodeReviewTask(workflow)
        workflow.taskReview = report
      })
      const passDims = TASK_REVIEW_DIMENSION_KEYS.filter(
        (key) => args.dimensions[key].status === "pass",
      ).length
      const passedChecks = args.checks.filter((c) => c.status === "passed").length
      return (
        `✅ 代码审核报告已提交：${
          verdict === "approved" ? "通过" : "发现问题，需修改"
        }；维度 ${passDims}/6 通过；检查 ${passedChecks}/${args.checks.length} 通过；` +
        `findings ${findings.length} 条。审核任务现在可以完成。`
      )
    },
  })

  return { task_review }
}
