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
      expect(Object.keys(tools).filter((name) => name.startsWith("reqdoc_"))).toEqual([])
    } finally {
      store.close()
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
      expect(tools.commit_gate_check).toBeUndefined()
      expect(tools.commit_force_unlock).toBeUndefined()
    } finally {
      store.close()
    }
  })
})
