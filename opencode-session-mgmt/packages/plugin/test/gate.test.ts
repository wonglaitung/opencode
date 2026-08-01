import { describe, expect, test } from "bun:test"
import { Store } from "../src/db"
import { createCommitGate, isCommitCommand } from "../src/gate"

describe("isCommitCommand", () => {
  test("识别 bash 中的 git commit", () => {
    expect(isCommitCommand("bash", { command: "git commit -m 'x'" })).toBe(true)
    expect(isCommitCommand("bash", { command: "git add . && git commit" })).toBe(true)
    expect(isCommitCommand("bash", { command: "ls -la" })).toBe(false)
    expect(isCommitCommand("edit", { command: "git commit" })).toBe(false)
    expect(isCommitCommand("bash", {})).toBe(false)
  })
})

describe("createCommitGate", () => {
  test("阶段未完成时阻断 git commit", async () => {
    const store = Store.memory()
    store.ensure("s1") // 全部 not_started → blocked
    const gate = createCommitGate(store)
    await expect(
      gate({ tool: "bash", sessionID: "s1" }, { args: { command: "git commit" } }),
    ).rejects.toThrow(/提交门禁/)
    store.close()
  })

  test("非提交命令与未追踪会话放行", async () => {
    const store = Store.memory()
    const gate = createCommitGate(store)
    await expect(gate({ tool: "bash", sessionID: "s1" }, { args: { command: "ls" } })).resolves.toBeUndefined()
    await expect(
      gate({ tool: "bash", sessionID: "untracked" }, { args: { command: "git commit" } }),
    ).resolves.toBeUndefined()
    store.close()
  })

  test("全部 approved 时放行", async () => {
    const store = Store.memory()
    store.mutateWorkflow("s1", (wf) => {
      for (const name of ["requirements", "design", "implementation", "testing", "review"] as const) {
        wf.stages[name].status = "approved"
      }
    })
    const gate = createCommitGate(store)
    await expect(
      gate({ tool: "bash", sessionID: "s1" }, { args: { command: "git commit" } }),
    ).resolves.toBeUndefined()
    store.close()
  })
})
