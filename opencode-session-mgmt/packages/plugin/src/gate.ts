/**
 * 提交门禁硬拦截（设计文档 session-management.md 3.4、7.3）。
 * tool.execute.before hook：识别 bash 工具中的 git commit，
 * 未通过 commit_gate_check（有未 approved 阶段）时抛错阻断。
 * 这是插件层硬约束，不依赖 LLM 自觉。
 */
import { getDefinition } from "sm-shared"
import type { Store } from "./db"
import { recomputeCommit } from "./workflow-ops"

/**
 * 匹配 bash 命令中的 git commit 子调用：
 * - git 与 commit 之间允许夹带 -x/--xxx 选项（如 `git -c user.name=x commit`）；
 * - commit 后须紧跟行尾或空白，排除 commit-tree / commit-graph 等子命令误伤；
 * - git 前须为命令起点或分隔符（; & | ` 空白 左括号），少误判参数里的字面量。
 */
const GIT_COMMIT_RE = /(?:^|[;&|`\s(])git(\s+--?\S+(?:[= ]\S+)?)*\s+commit(?![\w-])/

/** 判断某工具调用是否为 git commit（bash 工具的 command 参数）。 */
export function isCommitCommand(toolName: string, args: unknown): boolean {
  if (toolName !== "bash") return false
  if (typeof args !== "object" || args === null) return false
  const command = (args as { command?: unknown }).command
  if (typeof command !== "string") return false
  return GIT_COMMIT_RE.test(command)
}

/** 生成 tool.execute.before 处理器（闭包持有 store）。 */
export function createCommitGate(store: Store) {
  return async (input: { tool: string; sessionID: string }, output: { args: unknown }): Promise<void> => {
    if (!isCommitCommand(input.tool, output.args)) return
    const row = store.get(input.sessionID)
    // 未被工作流追踪的会话（无记录）不拦截
    if (!row || !row.workflow) return
    // 无提交门禁的工作流类型（reqdoc 定稿）直接放行（3.2 hasCommitGate）
    if (!getDefinition(row.workflow.type).hasCommitGate) return
    const gate = recomputeCommit(row.workflow).commit
    if (gate.status === "allowed") return
    // 一次性强制提交授权（3.4 逃生口）：放行一次并标记已用（留痕，不删除）
    if (gate.force && !gate.force.used) {
      store.mutateWorkflow(input.sessionID, (wf) => {
        if (wf.commit.force) wf.commit.force.used = true
      })
      return
    }
    const def = getDefinition(row.workflow.type)
    const pending = gate.blocked_by.map((s) => def.labels[s] ?? s).join("、")
    throw new Error(
      `🔒 提交门禁：工作流尚有阶段未完成（${pending}）。` +
        `请先在对话中完成并通过审查（review_submit）再提交；` +
        `如确需强制提交，说明原因并经开发者确认后调用 commit_force_unlock。`,
    )
  }
}
