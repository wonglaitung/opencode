/**
 * 提交门禁硬拦截（设计文档 §3.4、§7.3）。
 * tool.execute.before hook：识别 bash 工具中的 git commit，
 * 未通过 commit_gate_check（有未 approved 阶段）时抛错阻断。
 * 这是插件层硬约束，不依赖 LLM 自觉。
 */
import { STAGE_LABELS, type StageName } from "sm-shared"
import type { Store } from "./db"
import { recomputeCommit } from "./workflow-ops"

/** 判断某工具调用是否为 git commit（bash 工具的 command 参数）。 */
export function isCommitCommand(toolName: string, args: unknown): boolean {
  if (toolName !== "bash") return false
  if (typeof args !== "object" || args === null) return false
  const command = (args as { command?: unknown }).command
  if (typeof command !== "string") return false
  return /\bgit\s+commit\b/.test(command)
}

/** 生成 tool.execute.before 处理器（闭包持有 store）。 */
export function createCommitGate(store: Store) {
  return async (input: { tool: string; sessionID: string }, output: { args: unknown }): Promise<void> => {
    if (!isCommitCommand(input.tool, output.args)) return
    const row = store.get(input.sessionID)
    // 未被工作流追踪的会话（无记录）不拦截
    if (!row || !row.workflow) return
    const gate = recomputeCommit(row.workflow).commit
    if (gate.status === "allowed") return
    const pending = gate.blocked_by.map((s) => STAGE_LABELS[s as StageName]).join("、")
    throw new Error(
      `🔒 提交门禁：工作流尚有阶段未完成（${pending}）。` +
        `请先在对话中完成并通过审查（review_submit），再提交。`,
    )
  }
}
