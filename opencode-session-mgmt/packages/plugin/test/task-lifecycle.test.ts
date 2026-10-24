import { describe, expect, test } from "bun:test"
import { Store } from "../src/db"
import { finishTask, isTaskCompletionMessage, startTask } from "../src/task-lifecycle"

function setup() {
  return Store.memory(() => "task")
}

describe("task 生命周期", () => {
  test("首条消息自动开始，重复调用幂等", () => {
    const store = setup()
    try {
      startTask(store, "t1")
      startTask(store, "t1")
      const wf = store.get("t1")!.workflow!
      expect(wf.type).toBe("task")
      expect(wf.stages.execute.status).toBe("in_progress")
      expect(wf.stages.execute.transitions.filter((t) => t.action === "enter")).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  test("整句完成词自动收口", () => {
    const store = setup()
    try {
      startTask(store, "t1")
      store.mutateWorkflow("t1", (wf) => {
        wf.baseline = { estimatedHours: 2, setAt: 1 }
      })
      expect(finishTask(store, "t1", "完成")).toBe(true)
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
      startTask(store, "t1")
      expect(finishTask(store, "t1", "完成")).toBe(false)
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
      startTask(store, "t1")
      expect(finishTask(store, "t1", "第一部分完成了，继续做第二部分")).toBe(false)
      expect(store.get("t1")!.workflow!.stages.execute.status).toBe("in_progress")
    } finally {
      store.close()
    }
  })

  test("完成词匹配允许标点，拒绝问句", () => {
    for (const text of ["完成", "完成了", "做完了", "搞定了。", "结束了！"]) {
      expect(isTaskCompletionMessage(text)).toBe(true)
    }
    for (const text of ["完成了吗", "可以了", "好了", "第一部分完成了"]) {
      expect(isTaskCompletionMessage(text)).toBe(false)
    }
  })

  test("自动开始/收口 note 保持固定原文", () => {
    const store = setup()
    try {
      startTask(store, "t1")
      store.mutateWorkflow("t1", (wf) => {
        wf.baseline = { estimatedHours: 2, setAt: 1 }
      })
      finishTask(store, "t1", "完成")
      const transitions = store.get("t1")!.workflow!.stages.execute.transitions
      expect(transitions.map((t) => t.note)).toEqual([
        "一般任务开始（自动）",
        "开发者明确说完成（自动收口）",
      ])
    } finally {
      store.close()
    }
  })

  test("非 task 会话不自动开始/收口", () => {
    const store = Store.memory(() => "sdlc")
    try {
      startTask(store, "s1")
      expect(store.get("s1")!.workflow!.stages.requirements.status).toBe("not_started")
      expect(finishTask(store, "s1", "完成")).toBe(false)
    } finally {
      store.close()
    }
  })
})
