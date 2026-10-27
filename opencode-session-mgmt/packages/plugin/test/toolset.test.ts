import { describe, expect, test } from "bun:test"
import type { WorkflowType } from "sm-shared"
import { Store } from "../src/db"
import { createLockRegistry } from "../src/open-ide/lock"
import { createToolset } from "../src/tools/toolset"

function setup(workflowType: WorkflowType) {
  const store = Store.memory(() => workflowType)
  const lockRegistry = createLockRegistry(process.cwd(), store)
  const tools = createToolset({ store, workflowType, ideEntries: [], lockRegistry })
  return { store, tools }
}

const SHARED = [
  "workflow_advance",
  "workflow_revisit",
  "workflow_baseline",
  "workflow_start",
  "comprehension_add",
  "comprehension_confirm",
  "comprehension_reject",
  "comprehension_rewrite",
  "comprehension_manual",
  "comprehension_ask",
  "review_submit",
  "open_ide",
  "lock_file",
  "unlock_file",
  "list_locked_files",
]

describe("createToolset", () => {
  test("sdlc 不注册 reqdoc 工具，保留提交门禁", () => {
    const { store, tools } = setup("sdlc")
    try {
      expect(Object.keys(tools)).toHaveLength(17)
      for (const name of SHARED) expect(tools[name]).toBeDefined()
      expect(tools.commit_gate_check).toBeDefined()
      expect(tools.commit_force_unlock).toBeDefined()
      expect(tools.task_classify).toBeUndefined()
      expect(Object.keys(tools).filter((name) => name.startsWith("reqdoc_"))).toEqual([])
    } finally {
      store.close()
    }
  })

  test("task 只注册一般任务工具，不注册 review/提交门禁", () => {
    const { store, tools } = setup("task")
    try {
      expect(Object.keys(tools)).toHaveLength(9)
      for (const name of [
        "workflow_advance",
        "workflow_revisit",
        "workflow_baseline",
        "workflow_start",
        "task_classify",
        "open_ide",
        "lock_file",
        "unlock_file",
        "list_locked_files",
      ]) {
        expect(tools[name]).toBeDefined()
      }
      expect(tools.review_submit).toBeUndefined()
      expect(tools.comprehension_add).toBeUndefined()
      expect(tools.commit_gate_check).toBeUndefined()
      expect(tools.commit_force_unlock).toBeUndefined()
      expect(Object.keys(tools).filter((name) => name.startsWith("reqdoc_"))).toEqual([])
    } finally {
      store.close()
    }
  })

  test("workflow_start 描述包含三个入口短语", () => {
    const { store, tools } = setup("sdlc")
    try {
      const description = tools.workflow_start!.description
      expect(description).toContain("启动 SDLC 工作流")
      expect(description).toContain("启动 REQDOC 工作流")
      expect(description).toContain("启动一般任务")
      expect(description).toContain("仅启动当前会话已定的工作流类型")
      expect(description).not.toContain("自动开始")
    } finally {
      store.close()
    }
  })

  test("task 由 workflow_start 启动 execute，重复调用幂等", async () => {
    const { store, tools } = setup("task")
    try {
      await tools.workflow_start!.execute({} as never, { sessionID: "t1" } as never)
      expect(store.get("t1")!.workflow!.stages.execute.status).toBe("in_progress")
      await tools.workflow_start!.execute({} as never, { sessionID: "t1" } as never)
      const transitions = store.get("t1")!.workflow!.stages.execute.transitions
      expect(transitions.filter((t) => t.action === "enter")).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  test("跨类型启动统一拒绝，且不改变会话状态", async () => {
    const { store, tools } = setup("sdlc")
    try {
      await expect(
        tools.workflow_start!.execute({ type: "task" } as never, { sessionID: "s1" } as never),
      ).rejects.toThrow(/请在启动器切换工作流后开新会话/)
      const wf = store.get("s1")!.workflow!
      expect(wf.type).toBe("sdlc")
      expect(wf.stages.requirements.status).toBe("not_started")
    } finally {
      store.close()
    }
    const second = setup("task")
    try {
      await expect(
        second.tools.workflow_start!.execute({ type: "sdlc" } as never, { sessionID: "s2" } as never),
      ).rejects.toThrow(/请在启动器切换工作流后开新会话/)
    } finally {
      second.store.close()
    }
  })

  test("reqdoc 注册 reqdoc 工具，不注册 sdlc 提交门禁", () => {
    const { store, tools } = setup("reqdoc")
    try {
      expect(Object.keys(tools)).toHaveLength(28)
      for (const name of SHARED) expect(tools[name]).toBeDefined()
      expect(tools.reqdoc_scan).toBeDefined()
      expect(tools.reqdoc_ingest).toBeDefined()
      expect(tools.reqdoc_assemble).toBeDefined()
      expect(tools.task_classify).toBeUndefined()
      expect(tools.commit_gate_check).toBeUndefined()
      expect(tools.commit_force_unlock).toBeUndefined()
    } finally {
      store.close()
    }
  })
})
