/**
 * code_review 子任务的只读 git 信息工具。
 * 只允许 diff/status/log/show/ls-files 五个动作；
 * 固定调用 git，GIT_OPTIONAL_LOCKS=0，不执行 shell，不写仓库。
 */
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { isCodeReviewTask, type WorkflowState } from "sm-shared"
import type { Store } from "../db"
import { projectRoot } from "../fs-safe"
import { runGitReadOnly } from "../review-scan"
import { WorkflowOpError } from "../workflow-ops"

const z = tool.schema
const MAX_OUTPUT = 60_000

function requireCodeReview(workflow: WorkflowState | null | undefined): WorkflowState {
  if (!workflow || workflow.type !== "task") {
    throw new WorkflowOpError("task_check 仅适用于一般任务工作流")
  }
  if (!isCodeReviewTask(workflow)) {
    throw new WorkflowOpError("git 只读检查只适用于 code_review 分类任务")
  }
  if (workflow.stages.execute?.status !== "in_progress") {
    throw new WorkflowOpError("代码审核任务当前不在进行中，不能检查")
  }
  return workflow
}

function skipped(reason: string): string {
  return `⏭️ task_check 跳过：${reason}`
}

function cap(text: string): string {
  if (text.length <= MAX_OUTPUT) return text
  return `${text.slice(0, MAX_OUTPUT)}\n……输出已截断（超过 ${MAX_OUTPUT} 字符）`
}

function validateTarget(target: string | undefined): string {
  if (!target) return "HEAD"
  if (target.startsWith("-") || /[\s;&|`$<>]/.test(target)) {
    throw new WorkflowOpError("target 只能是单个 ref/commit/path，不能包含选项或 shell 字符")
  }
  return target
}

export function createTaskCheckTool(store: Store): Record<string, ToolDefinition> {
  const task_check = tool({
    description:
      "code_review 任务的只读 git 检查：diff/status/log/show/ls-files。" +
      "固定只读命令，GIT_OPTIONAL_LOCKS=0，不执行 build/test/lint，不修改仓库；非 Git 项目返回跳过。",
    args: {
      action: z
        .enum(["diff", "status", "log", "show", "ls-files"])
        .describe("只读动作：工作区 diff/状态/提交日志/展示提交/已跟踪文件"),
      target: z.string().optional().describe("show 的 ref/commit；省略为 HEAD"),
      limit: z.number().int().min(1).max(100).optional().describe("log 的条数（默认 20）"),
    },
    async execute(args, context) {
      requireCodeReview(store.get(context.sessionID)?.workflow)
      const root = projectRoot(context)

      const target = validateTarget(args.target)
      const limit = args.limit ?? 20
      const command =
        args.action === "diff"
          ? ["diff", "--no-ext-diff", "--unified=3", "HEAD", "--"]
          : args.action === "status"
            ? ["status", "--porcelain"]
            : args.action === "log"
              ? ["log", "--oneline", "-n", String(limit)]
              : args.action === "show"
                ? ["show", "--no-ext-diff", "--format=fuller", target]
                : ["ls-files"]
      const result = await runGitReadOnly(root, command)
      if (!result.ok) return skipped(result.stderr || "git 命令失败（可能不是 Git 仓库）")
      const text = result.stdout.trim()
      if (text === "") return `✅ ${args.action}：无输出（工作区干净或没有匹配内容）`
      return cap(text)
    },
  })

  return { task_check }
}
