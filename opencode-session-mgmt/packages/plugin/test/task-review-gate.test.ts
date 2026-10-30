/**
 * code_review 子任务只读门禁：只拦截代码编辑与 git commit，不拦截读/测试。
 */
import { describe, expect, test } from "bun:test"
import { Store } from "../src/db"
import { applyTransition } from "../src/workflow-ops"
import { createTaskReviewGate } from "../src/task-review-gate"

const input = (tool: string) => ({ tool, sessionID: "s1" })
const output = (args: unknown = {}) => ({ args })

function setup(category: "code_review" | "coding") {
  const store = Store.memory(() => "task")
  store.mutateWorkflow("s1", (workflow) => {
    applyTransition(workflow, "execute", "enter", 1)
    workflow.task = { category, source: "model", setAt: 1 }
  })
  return { store, gate: createTaskReviewGate(store) }
}

describe("code_review 只读门禁", () => {
  test("拦截 write/edit/apply_patch/git commit", async () => {
    const { store, gate } = setup("code_review")
    try {
      for (const tool of ["write", "edit", "apply_patch"]) {
        await expect(gate(input(tool), output({ filePath: "src/auth.ts" }))).rejects.toThrow(/只读/)
      }
      await expect(gate(input("bash"), output({ command: "git commit -m x" }))).rejects.toThrow(/只读/)
    } finally {
      store.close()
    }
  })

  test("允许读取与测试命令", async () => {
    const { store, gate } = setup("code_review")
    try {
      await expect(gate(input("read"), output({ filePath: "src/auth.ts" }))).resolves.toBeUndefined()
      await expect(gate(input("bash"), output({ command: "bun test auth" }))).resolves.toBeUndefined()
      await expect(gate(input("bash"), output({ command: "git diff" }))).resolves.toBeUndefined()
    } finally {
      store.close()
    }
  })

  test("非 code_review 的普通任务不拦截代码编辑", async () => {
    const { store, gate } = setup("coding")
    try {
      await expect(gate(input("edit"), output({ filePath: "src/auth.ts" }))).resolves.toBeUndefined()
    } finally {
      store.close()
    }
  })
})
