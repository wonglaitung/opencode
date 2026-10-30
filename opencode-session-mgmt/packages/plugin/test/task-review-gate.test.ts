/**
 * code_review 子任务只读门禁：拦截 bash、代码编辑与 git commit；只允许读取。
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

  test("拦截所有 bash（包括测试与 git 只读命令）", async () => {
    const { store, gate } = setup("code_review")
    try {
      for (const command of ["bun test auth", "git diff", "bun run build", "npm run lint"]) {
        await expect(gate(input("bash"), output({ command }))).rejects.toThrow(/只读/)
      }
    } finally {
      store.close()
    }
  })

  test("允许 read 与专用只读工具", async () => {
    const { store, gate } = setup("code_review")
    try {
      await expect(gate(input("read"), output({ filePath: "src/auth.ts" }))).resolves.toBeUndefined()
      await expect(gate(input("grep"), output({ pattern: "TODO" }))).resolves.toBeUndefined()
      await expect(gate(input("task_check"), output({ action: "diff" }))).resolves.toBeUndefined()
      await expect(gate(input("task_scan"), output({ scope: "diff" }))).resolves.toBeUndefined()
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
