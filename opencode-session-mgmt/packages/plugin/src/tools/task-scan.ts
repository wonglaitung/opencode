/**
 * code_review 子任务的可选 regex 扫描工具（纯只读）。
 * 只扫描改动文件/显式文件/全项目文本，不执行 build/test/lint，不联网，不写项目文件。
 */
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import {
  TASK_SCAN_SEVERITIES,
  isCodeReviewTask,
  type TaskScanReport,
  type TaskScanSeverity,
  type WorkflowState,
} from "sm-shared"
import type { Store } from "../db"
import { projectRoot } from "../fs-safe"
import { listCandidateFiles, readChangedFiles, scanFiles } from "../review-scan"
import { WorkflowOpError } from "../workflow-ops"

const z = tool.schema

const SEVERITY_LABEL: Record<TaskScanSeverity, string> = {
  blocker: "阻断",
  critical: "严重",
  major: "重要",
  minor: "次要",
  info: "提示",
}

function requireCodeReview(workflow: WorkflowState | null | undefined): WorkflowState {
  if (!workflow || workflow.type !== "task") {
    throw new WorkflowOpError("task_scan 仅适用于一般任务工作流")
  }
  if (!isCodeReviewTask(workflow)) {
    throw new WorkflowOpError("代码扫描只适用于 code_review 分类任务")
  }
  if (workflow.stages.execute?.status !== "in_progress") {
    throw new WorkflowOpError("代码审核任务当前不在进行中，不能扫描")
  }
  return workflow
}

function formatReport(report: TaskScanReport): string {
  if (report.status === "skipped") {
    return `⏭️ 代码扫描跳过：${report.skippedReason ?? "未知原因"}。可改用 task_check 读取 git 信息，或直接读取文件做人工判断。`
  }
  const head = `✅ 代码扫描完成（engine=${report.engine}）：扫描 ${report.scannedFiles} 个文件，发现 ${report.findingCount} 条（阻断 ${report.bySeverity.blocker} / 严重 ${report.bySeverity.critical} / 重要 ${report.bySeverity.major} / 次要 ${report.bySeverity.minor} / 提示 ${report.bySeverity.info}）。`
  const stats = report.diffStats
    ? `\n改动规模：${report.diffStats.files} 文件，+${report.diffStats.insertions}/-${report.diffStats.deletions} 行。`
    : report.reviewSize
      ? `\n审核规模：${report.reviewSize.files} 文件/${report.reviewSize.lines} 行。`
      : ""
  const top = report.findings
    .slice(0, 20)
    .map(
      (finding) =>
        `- [${SEVERITY_LABEL[finding.severity]}] ${finding.ruleId} ${finding.file}:${finding.line} ${finding.title}`,
    )
    .join("\n")
  const more = report.findingCount > 20 ? `\n……另有 ${report.findingCount - 20} 条，见 taskScan 状态。` : ""
  const warnings = report.warnings.length > 0 ? `\n规则/扫描提示：${report.warnings.slice(0, 5).join("；")}` : ""
  return `${head}${stats}${top ? `\n${top}` : ""}${more}${warnings}`
}

export function createTaskScanTool(store: Store): Record<string, ToolDefinition> {
  const task_scan = tool({
    description:
      "对 code_review 任务做可选的纯只读 regex 扫描（不执行 build/test/lint，不联网，不写文件）。" +
      "默认扫描工作区 diff 改动文件；也可指定 files 或 all。扫描结果会记入 taskScan；" +
      "高严重度（blocker/critical）问题必须在 task_review 的 findings 中逐条提及 ruleId。",
    args: {
      scope: z.enum(["diff", "files", "all"]).optional().describe("diff=改动文件（默认）；files=显式文件；all=项目文本文件"),
      files: z.array(z.string().min(1)).optional().describe("scope=files 时的文件列表（相对项目根）"),
      rules: z.array(z.string().min(1)).optional().describe("只运行指定规则 id；省略运行全部规则"),
      severity: z.enum(TASK_SCAN_SEVERITIES).optional().describe("最低严重度阈值；省略返回全部"),
    },
    async execute(args, context) {
      requireCodeReview(store.get(context.sessionID)?.workflow)
      const root = projectRoot(context)
      const scope = args.scope ?? "diff"
      const warnings: string[] = []
      let report: TaskScanReport

      if (scope === "diff") {
        const changed = await readChangedFiles(root)
        if (!changed) {
          report = scanFiles(root, {
            scope: ["diff"],
            files: [],
            ruleIds: args.rules,
            severity: args.severity,
            skippedReason: "不是 Git 仓库，无法读取 diff 改动文件",
          })
        } else {
          report = scanFiles(root, {
            scope: ["diff"],
            files: changed.files,
            ruleIds: args.rules,
            severity: args.severity,
            diffStats: changed.diffStats,
          })
        }
      } else if (scope === "files") {
        if (!args.files || args.files.length === 0) {
          throw new WorkflowOpError("scope=files 时必须提供 files（至少一个文件）")
        }
        report = scanFiles(root, {
          scope: args.files,
          files: args.files,
          ruleIds: args.rules,
          severity: args.severity,
        })
      } else {
        // 非 Git 项目只允许显式 files，避免把整个目录当作隐式审核范围。
        if (!(await readChangedFiles(root))) {
          report = scanFiles(root, {
            scope: ["all"],
            files: [],
            ruleIds: args.rules,
            severity: args.severity,
            skippedReason: "不是 Git 仓库，scope=all 不可用；请用 scope=files 显式指定文件",
          })
        } else {
          const files = listCandidateFiles(root, warnings)
          report = scanFiles(root, {
            scope: ["all"],
            files,
            ruleIds: args.rules,
            severity: args.severity,
          })
          report.warnings = [...warnings, ...report.warnings]
        }
      }

      if (args.rules?.length) {
        const found = new Set(report.findings.map((finding) => finding.ruleId))
        const missing = args.rules.filter((id) => !found.has(id))
        if (missing.length > 0) {
          report.warnings = [...report.warnings, `未命中规则：${missing.join("、")}`]
        }
      }

      store.mutateWorkflow(context.sessionID, (workflow) => {
        requireCodeReview(workflow)
        workflow.taskScan = report
      })
      return formatReport(report)
    },
  })

  return { task_scan }
}
