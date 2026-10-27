import { describe, expect, test } from "bun:test"
import { Store } from "../src/db"
import { createTaskClassifyTool } from "../src/tools/task-classify"
import { applyTransition } from "../src/workflow-ops"

function taskSetup() {
  const store = Store.memory(() => "task")
  store.mutateWorkflow("t1", (workflow) => {
    applyTransition(workflow, "execute", "enter", 1)
  })
  return { store, tool: createTaskClassifyTool(store).task_classify! }
}

describe("task_classify", () => {
  test("未启动拒绝，且不创建会话行", async () => {
    const store = Store.memory(() => "task")
    const tool = createTaskClassifyTool(store).task_classify!
    try {
      await expect(
        tool.execute({ category: "documentation" } as never, { sessionID: "t1" } as never),
      ).rejects.toThrow(/尚未启动/)
      expect(store.get("t1")).toBeNull()
    } finally {
      store.close()
    }
  })

  test("已建行但未启动同样拒绝", async () => {
    const store = Store.memory(() => "task")
    store.mutateWorkflow("t1", () => {})
    const tool = createTaskClassifyTool(store).task_classify!
    try {
      await expect(
        tool.execute({ category: "documentation" } as never, { sessionID: "t1" } as never),
      ).rejects.toThrow(/尚未启动/)
      expect(store.get("t1")!.workflow!.task).toBeUndefined()
    } finally {
      store.close()
    }
  })
  test("写入一般任务分类与来源", async () => {
    const { store, tool } = taskSetup()
    try {
      await tool.execute({ category: "documentation" } as never, { sessionID: "t1" } as never)
      const task = store.get("t1")!.workflow!.task!
      expect(task.category).toBe("documentation")
      expect(task.source).toBe("model")
      expect(task.setAt).toBeGreaterThan(0)
    } finally {
      store.close()
    }
  })

  test("再次调用覆盖分类", async () => {
    const { store, tool } = taskSetup()
    try {
      await tool.execute({ category: "documentation" } as never, { sessionID: "t1" } as never)
      await tool.execute({ category: "debugging" } as never, { sessionID: "t1" } as never)
      expect(store.get("t1")!.workflow!.task!.category).toBe("debugging")
    } finally {
      store.close()
    }
  })

  test("同分类重复调用幂等，不刷新 setAt", async () => {
    const { store, tool } = taskSetup()
    try {
      store.mutateWorkflow("t1", (workflow) => {
        workflow.task = { category: "testing", source: "model", setAt: 1 }
      })
      await tool.execute({ category: "testing" } as never, { sessionID: "t1" } as never)
      expect(store.get("t1")!.workflow!.task!.setAt).toBe(1)
    } finally {
      store.close()
    }
  })

  test("非 task 会话拒绝", async () => {
    const store = Store.memory(() => "sdlc")
    store.ensure("s1")
    const tool = createTaskClassifyTool(store).task_classify!
    try {
      await expect(
        tool.execute({ category: "documentation" } as never, { sessionID: "s1" } as never),
      ).rejects.toThrow(/仅适用于一般任务/)
    } finally {
      store.close()
    }
  })
})
