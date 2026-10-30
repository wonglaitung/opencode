/**
 * code_review 子任务只读门禁（仅 TASK 的 code_review 分类）。
 * tool.execute.before：禁止代码编辑与 git commit；读取、bash 跑测试/diff 不受影响。
 * 不关联 sdlc/reqdoc，也不影响其他 task 分类。
 */
import type { Store } from "./db"
import { isCommitCommand } from "./gate"
import { CODE_EDIT_TOOLS } from "./tools/quality"

export function createTaskReviewGate(store: Store) {
  return async (input: { tool: string; sessionID: string }, output: { args: unknown }): Promise<void> => {
    const workflow = store.get(input.sessionID)?.workflow
    if (!workflow || workflow.type !== "task" || workflow.task?.category !== "code_review") return
    if (CODE_EDIT_TOOLS.has(input.tool) || isCommitCommand(input.tool, output.args)) {
      throw new Error(
        "🔒 代码审核任务为只读：不得修改代码或提交；请只读取/测试并调用 task_review 提交审核报告。",
      )
    }
  }
}
