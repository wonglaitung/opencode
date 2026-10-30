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
  TASK_SCAN_SEVERITIES,
  type TaskReviewFinding,
  type TaskReviewReport,
  type TaskScanSeverity,
  type TaskScanSummary,
  type WorkflowState,
} from "sm-shared"
import type { Store } from "../db"
import { WorkflowOpError } from "../workflow-ops"

const z = tool.schema

const dimension = z.object({
  status: z.enum(["pass", "fail"]),
  notes: z.string().min(1).describe("该维度的结论与证据（必填，不能只填 pass/fail）"),
})

const finding = z.object({
  severity: z.enum(TASK_SCAN_SEVERITIES).describe("严重度：blocker/critical/major/minor/info"),
  file: z.string().min(1).optional().describe("文件路径（可选）"),
  line: z.number().int().positive().optional().describe("行号（可选）"),
  issue: z.string().min(1).describe("找到了什么问题（必填）"),
  suggestion: z.string().min(1).describe("建议怎么改（必填，不能只写问题）"),
  ruleId: z.string().min(1).optional().describe("来自 task_scan 时填对应 ruleId"),
})

const SEVERITY_ORDER: Record<TaskScanSeverity, number> = {
  blocker: 0,
  critical: 1,
  major: 2,
  minor: 3,
  info: 4,
}

const SEVERITY_LABEL: Record<TaskScanSeverity, string> = {
  blocker: "阻断",
  critical: "严重",
  major: "重要",
  minor: "次要",
  info: "提示",
}

function formatDimensions(dimensions: TaskReviewReport["dimensions"]): string {
  return TASK_REVIEW_DIMENSION_KEYS.map((key) => {
    const item = dimensions[key]
    return `- ${TASK_REVIEW_DIMENSION_LABELS[key]}：${item.status === "pass" ? "通过" : "未通过"} — ${item.notes}`
  }).join("\n")
}

function formatScan(scan: TaskScanSummary | undefined): string {
  if (!scan) return "- 状态：未运行"
  const lines = [`- 状态：${scan.status === "completed" ? "已完成" : "跳过"}`]
  if (scan.status === "completed") {
    lines.push(
      `- 文件：${scan.scannedFiles}；发现：${scan.findingCount} 条（阻断 ${scan.bySeverity.blocker} / 严重 ${scan.bySeverity.critical} / 重要 ${scan.bySeverity.major} / 次要 ${scan.bySeverity.minor} / 提示 ${scan.bySeverity.info}）`,
    )
    if (scan.diffStats) {
      lines.push(
        `- 改动规模：${scan.diffStats.files} 文件，+${scan.diffStats.insertions}/-${scan.diffStats.deletions} 行`,
      )
    }
    if (scan.reviewSize) lines.push(`- 审核规模：${scan.reviewSize.files} 文件/${scan.reviewSize.lines} 行`)
  } else {
    lines.push(`- 原因：${scan.skippedReason ?? "未知"}`)
  }
  if (scan.warnings.length > 0) lines.push(`- 提示：${scan.warnings.join("；")}`)
  return lines.join("\n")
}

function formatFindings(findings: TaskReviewFinding[]): string {
  if (findings.length === 0) return "未发现需要修复的问题。"
  return [...findings]
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        (a.file ?? "").localeCompare(b.file ?? "") ||
        (a.line ?? 0) - (b.line ?? 0),
    )
    .map((item, index) => {
      const location = item.file ? ` ${item.file}${item.line ? `:${item.line}` : ""}` : ""
      const rule = item.ruleId ? ` · ${item.ruleId}` : ""
      return `${index + 1}. [${SEVERITY_LABEL[item.severity]}]${location}${rule}\n   发现：${item.issue}\n   建议：${item.suggestion}`
    })
    .join("\n\n")
}

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
      "审核任务只读，不执行项目 build/test/lint 或任何命令；只读代码、测试代码，可先调用 task_scan 做 regex 扫描。" +
      "按六维给出静态审查结论；findings 每条写清 issue（发现）和 suggestion（建议怎么改），报告会按严重度逐条展示；结论可以是 approved 或 changes_requested。" +
      "报告提交后审核任务才能完成。" +
      "不涉及 sdlc/reqdoc，也不约束任何编码任务。",
    args: {
      scope: z.array(z.string().min(1)).min(1).describe("审核范围：diff / commit / PR / 文件"),
      dimensions: z.object({
        correctness: dimension.describe(TASK_REVIEW_DIMENSION_LABELS.correctness),
        security: dimension.describe(TASK_REVIEW_DIMENSION_LABELS.security),
        design: dimension.describe(TASK_REVIEW_DIMENSION_LABELS.design),
        tests: dimension.describe(TASK_REVIEW_DIMENSION_LABELS.tests),
        impact: dimension.describe(TASK_REVIEW_DIMENSION_LABELS.impact),
        readability: dimension.describe(TASK_REVIEW_DIMENSION_LABELS.readability),
      }),
      findings: z.array(finding).optional().describe("问题/风险清单（有未通过项时必填；每条必须包含 issue 与 suggestion）"),
    },
    async execute(args, context) {
      const current = store.get(context.sessionID)?.workflow
      requireCodeReviewTask(current)
      const failed = TASK_REVIEW_DIMENSION_KEYS.some((key) => args.dimensions[key].status === "fail")
      const findings = args.findings ?? []
      if (failed && findings.length === 0) {
        throw new WorkflowOpError("审核有未通过项时必须提供 findings，不能只标记 fail")
      }
      // 扫描是可选证据；critical/blocker（高严重度）必须逐条提及，不能静默忽略。
      const highFindings = (current?.taskScan?.findings ?? []).filter(
        (finding) => finding.severity === "blocker" || finding.severity === "critical",
      )
      const missing = highFindings.filter(
        (finding) =>
          !findings.some(
            (text) => text.ruleId === finding.ruleId || text.issue.includes(finding.ruleId),
          ),
      )
      if (missing.length > 0) {
        throw new WorkflowOpError(
          `扫描发现高严重度问题，必须在 findings 中逐条提及 ruleId：${missing
            .map((finding) => finding.ruleId)
            .join("、")}`,
        )
      }
      const size = current?.taskScan?.reviewSize
      if (size && (size.files > 50 || size.lines > 1500)) {
        const rationale = [
          ...args.scope,
          ...findings.flatMap((item) => [item.issue, item.suggestion]),
        ].join(" ")
        if (!/(拆分|规模|超|分批)/.test(rationale)) {
          throw new WorkflowOpError(
            `审核规模超过 50 文件/1500 行（${size.files} 文件/${size.lines} 行）：请在 findings 或 scope 中说明拆分理由，或拆成多次审核。`,
          )
        }
      }
      const scan: TaskScanSummary | undefined = current?.taskScan
        ? {
            status: current.taskScan.status,
            scannedFiles: current.taskScan.scannedFiles,
            findingCount: current.taskScan.findings.length,
            bySeverity: current.taskScan.bySeverity,
            byDimension: current.taskScan.byDimension,
            diffStats: current.taskScan.diffStats,
            reviewSize: current.taskScan.reviewSize,
            skippedReason: current.taskScan.skippedReason,
            warnings: current.taskScan.warnings,
          }
        : undefined
      const verdict = failed ? "changes_requested" : "approved"
      const report: TaskReviewReport = {
        status: "submitted",
        scope: args.scope,
        dimensions: args.dimensions,
        findings,
        verdict,
        scan,
        submittedAt: Date.now(),
      }
      store.mutateWorkflow(context.sessionID, (workflow) => {
        requireCodeReviewTask(workflow)
        workflow.taskReview = report
      })
      const passDims = TASK_REVIEW_DIMENSION_KEYS.filter(
        (key) => args.dimensions[key].status === "pass",
      ).length
      return (
        `✅ 代码审核报告已提交\n` +
        `结论：${verdict === "approved" ? "approved（通过）" : "changes_requested（发现问题，需修改）"}\n` +
        `范围：${args.scope.join("、")}\n` +
        `维度：${passDims}/6 通过\n\n` +
        `六维报告\n${formatDimensions(args.dimensions)}\n\n` +
        `扫描\n${formatScan(scan)}\n\n` +
        `审核发现与修复建议\n${formatFindings(findings)}\n\n` +
        `审核任务现在可以完成。`
      )
    },
  })

  return { task_review }
}
