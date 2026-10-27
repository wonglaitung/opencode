/**
 * 一般任务生命周期（task 工作流）：整句完成声明自动收口。
 * 启动与其他工作流一致，由模型调用 workflow_start；本模块不再自动开始计时。
 * 只认「本次任务已完成」「任务完成了」这类带任务范围的整句；裸「完成/完成了」等
 * 未点明任务的说法只算进行中，交给模型按 task-r3 先确认一次。
 * 长篇句子（如「第一部分完成了」）与问句（如「本次任务已完成？」）不自动收口。
 */
import { getDefinition } from "sm-shared"
import type { Store } from "./db"
import { applyTransition } from "./workflow-ops"

/** 整句点明「任务」的完成声明才自动收口；问号是提问，不能收口。 */
const COMPLETION_RE = /^\s*(?:本次|这个|当前)?任务(?:已经|已)?(?:完成|做完|搞定|结束)了?\s*[。.!！]?\s*$/u

export function isTaskCompletionMessage(text: string): boolean {
  return COMPLETION_RE.test(text)
}

/** 用户整句声明本次任务已完成时自动 approve；返回是否触发。 */
export function finishTask(store: Store, sessionID: string, text: string): boolean {
  if (!isTaskCompletionMessage(text)) return false
  const workflow = store.get(sessionID)?.workflow
  if (!workflow || workflow.type !== "task") return false
  const stage = getDefinition("task").stages[0]!
  if (workflow.stages[stage]?.status !== "in_progress") return false
  // 与 sdlc 的基线门禁一致：未录入预估不得收口，先让模型补问预估。
  if (!workflow.baseline) return false
  store.mutateWorkflow(sessionID, (w) => {
    applyTransition(w, stage, "approve", Date.now(), "开发者明确说完成（自动收口）")
  })
  return true
}
