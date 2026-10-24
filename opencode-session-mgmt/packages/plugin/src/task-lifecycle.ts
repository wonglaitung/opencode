/**
 * 一般任务生命周期（task 工作流）：首条消息自动开始、整句完成词自动收口。
 * 用户不按提示说「完成」时只算进行中；长篇句子（如「第一部分完成了」）不自动收口，
 * 交给模型按 task-r3 判断。
 */
import { getDefinition } from "sm-shared"
import type { Store } from "./db"
import { applyTransition } from "./workflow-ops"

/** 只有整句就是完成词才自动收口，避免「第一部分完成了」误结束。 */
const COMPLETION_RE = /^\s*(完成|完成了|做完了|搞定了|结束了)\s*[。.!！?？]?\s*$/u

export function isTaskCompletionMessage(text: string): boolean {
  return COMPLETION_RE.test(text)
}

/** task 会话首条消息自动进入 execute；已开始/已完成则跳过。 */
export function startTask(store: Store, sessionID: string): void {
  const row = store.ensure(sessionID)
  const workflow = row.workflow
  if (!workflow || workflow.type !== "task") return
  const stage = getDefinition("task").stages[0]!
  if (workflow.stages[stage]?.status !== "not_started") return
  store.mutateWorkflow(sessionID, (w) => {
    applyTransition(w, stage, "enter", Date.now(), "一般任务开始（自动）")
  })
}

/** 用户整句说「完成」时自动 approve；返回是否触发。 */
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
