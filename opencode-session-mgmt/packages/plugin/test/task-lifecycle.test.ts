import { describe, expect, test } from "bun:test"
import { Store } from "../src/db"
import { finishTask, isTaskCompletionMessage } from "../src/task-lifecycle"
import { applyTransition } from "../src/workflow-ops"

function setup() {
  return Store.memory(() => "task")
}

function start(store: Store, sessionID: string) {
  store.mutateWorkflow(sessionID, (workflow) => {
    applyTransition(workflow, "execute", "enter", 1)
  })
}

describe("task 生命周期", () => {
  test("整句任务完成声明自动收口", () => {
    const store = setup()
    try {
      start(store, "t1")
      store.mutateWorkflow("t1", (wf) => {
        wf.baseline = { estimatedHours: 2, setAt: 1 }
      })
      expect(finishTask(store, "t1", "本次任务已完成")).toBe(true)
      const wf = store.get("t1")!.workflow!
      expect(wf.stages.execute.status).toBe("approved")
      expect(wf.commit.status).toBe("allowed")
    } finally {
      store.close()
    }
  })

  test("未录入预估不自动收口", () => {
    const store = setup()
    try {
      start(store, "t1")
      expect(finishTask(store, "t1", "本次任务已完成")).toBe(false)
      const wf = store.get("t1")!.workflow!
      expect(wf.stages.execute.status).toBe("in_progress")
      expect(wf.stages.execute.transitions.some((t) => t.action === "approve")).toBe(false)
    } finally {
      store.close()
    }
  })

  test("长篇句子不自动收口", () => {
    const store = setup()
    try {
      start(store, "t1")
      expect(finishTask(store, "t1", "第一部分完成了，继续做第二部分")).toBe(false)
      expect(store.get("t1")!.workflow!.stages.execute.status).toBe("in_progress")
    } finally {
      store.close()
    }
  })

  test("裸完成词不自动收口", () => {
    const store = setup()
    try {
      start(store, "t1")
      store.mutateWorkflow("t1", (wf) => {
        wf.baseline = { estimatedHours: 2, setAt: 1 }
      })
      for (const text of ["完成", "完成了", "做完了", "搞定了", "结束了"]) {
        expect(finishTask(store, "t1", text)).toBe(false)
      }
      expect(store.get("t1")!.workflow!.stages.execute.status).toBe("in_progress")
    } finally {
      store.close()
    }
  })

  test("只认点明任务的整句完成声明，拒绝问句", () => {
    for (const text of [
      "本次任务已完成",
      "本次任务已完成。",
      "任务完成了！",
      "本次任务做完了",
      "任务已经结束了",
      "当前任务搞定了",
    ]) {
      expect(isTaskCompletionMessage(text)).toBe(true)
    }
    for (const text of [
      "完成",
      "完成了",
      "做完了",
      "搞定了。",
      "结束了！",
      "完成了吗",
      "本次任务已完成？",
      "任务完成了吗",
      "第一部分完成了",
    ]) {
      expect(isTaskCompletionMessage(text)).toBe(false)
    }
  })

  test("自动收口 note 保持固定原文", () => {
    const store = setup()
    try {
      start(store, "t1")
      store.mutateWorkflow("t1", (wf) => {
        wf.baseline = { estimatedHours: 2, setAt: 1 }
      })
      finishTask(store, "t1", "本次任务已完成")
      const approve = store
        .get("t1")!
        .workflow!.stages.execute.transitions.find((t) => t.action === "approve")
      expect(approve?.note).toBe("开发者明确说完成（自动收口）")
    } finally {
      store.close()
    }
  })

  test("code_review 任务未提交报告不自动收口", () => {
    const store = setup()
    try {
      start(store, "t1")
      store.mutateWorkflow("t1", (wf) => {
        wf.baseline = { estimatedHours: 2, setAt: 1 }
        wf.task = { category: "code_review", source: "model", setAt: 1 }
      })
      expect(finishTask(store, "t1", "本次任务已完成")).toBe(false)
      store.mutateWorkflow("t1", (wf) => {
        wf.taskReview = {
          status: "submitted",
          scope: ["src/auth.ts"],
          checks: [],
          dimensions: {
            correctness: { status: "pass", notes: "ok" },
            security: { status: "pass", notes: "ok" },
            design: { status: "pass", notes: "ok" },
            tests: { status: "pass", notes: "ok" },
            impact: { status: "pass", notes: "ok" },
            readability: { status: "pass", notes: "ok" },
          },
          findings: [],
          verdict: "approved",
          submittedAt: 1,
        }
      })
      expect(finishTask(store, "t1", "本次任务已完成")).toBe(true)
    } finally {
      store.close()
    }
  })

  test("非 task 会话不自动收口", () => {
    const store = Store.memory(() => "sdlc")
    try {
      store.mutateWorkflow("s1", () => {})
      expect(finishTask(store, "s1", "本次任务已完成")).toBe(false)
    } finally {
      store.close()
    }
  })
})
