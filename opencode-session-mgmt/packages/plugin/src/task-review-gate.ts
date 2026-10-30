/**
 * code_review 子任务只读门禁（仅 TASK 的 code_review 分类）。
 * tool.execute.before：禁止任何命令执行、代码编辑与 git commit；
 * diff/status/log/show/ls-files 只能走 task_check 的固定只读命令。
 * 不关联 sdlc/reqdoc，也不影响其他 task 分类。
 */
import type { Store } from "./db"
import { isCommitCommand } from "./gate"
import { CODE_EDIT_TOOLS } from "./tools/quality"

export function createTaskReviewGate(store: Store) {
  return async (input: { tool: string; sessionID: string }, output: { args: unknown }): Promise<void> => {
    const workflow = store.get(input.sessionID)?.workflow
    if (!workflow || workflow.type !== "task" || workflow.task?.category !== "code_review") return
    if (input.tool === "bash") {
      throw new Error(
        "🔒 代码审核任务为只读：不得执行 bash（不跑 build/test/lint）。git 变更请用 task_check，regex 扫描请用 task_scan，然后调用 task_review 提交报告。",
      )
    }
    if (CODE_EDIT_TOOLS.has(input.tool) || isCommitCommand(input.tool, output.args)) {
      throw new Error(
        "🔒 代码审核任务为只读：不得修改代码或提交；请只读取代码/测试并调用 task_review 提交审核报告。",
      )
    }
  }
}
