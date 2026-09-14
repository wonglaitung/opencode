import { describe, expect, test } from "bun:test"
import { createWorkflowState } from "sm-shared"
import { Store } from "../src/db"
import { createCommitGate, isCommitCommand } from "../src/gate"
import { recomputeCommit } from "../src/workflow-ops"

describe("isCommitCommand", () => {
  test("识别 bash 中的 git commit", () => {
    expect(isCommitCommand("bash", { command: "git commit -m 'x'" })).toBe(true)
    expect(isCommitCommand("bash", { command: "git add . && git commit" })).toBe(true)
    expect(isCommitCommand("bash", { command: "ls -la" })).toBe(false)
    expect(isCommitCommand("edit", { command: "git commit" })).toBe(false)
    expect(isCommitCommand("bash", {})).toBe(false)
  })

  test("排除 commit-tree/commit-graph，兼容 git 选项与复合命令", () => {
    expect(isCommitCommand("bash", { command: "git commit-tree abc" })).toBe(false)
    expect(isCommitCommand("bash", { command: "git commit-graph write" })).toBe(false)
    expect(isCommitCommand("bash", { command: "git log" })).toBe(false)
    expect(isCommitCommand("bash", { command: "git -c user.name=x commit -m y" })).toBe(true)
    expect(isCommitCommand("bash", { command: "cd repo && git commit --amend" })).toBe(true)
    expect(isCommitCommand("bash", { command: "GIT_DIR=/x git commit" })).toBe(true)
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

  test("全部 approved 且已录基线时放行", async () => {
    const store = Store.memory()
    store.mutateWorkflow("s1", (wf) => {
      for (const name of ["requirements", "design", "implementation", "testing", "review"] as const) {
        wf.stages[name].status = "approved"
      }
      wf.baseline = { estimatedHours: 8, setAt: 1 }
    })
    const gate = createCommitGate(store)
    await expect(
      gate({ tool: "bash", sessionID: "s1" }, { args: { command: "git commit" } }),
    ).resolves.toBeUndefined()
    store.close()
  })

  test("全部 approved 但未录基线 → 提交仍被拦截（基线门禁）", async () => {
    const store = Store.memory()
    store.mutateWorkflow("s1", (wf) => {
      for (const name of ["requirements", "design", "implementation", "testing", "review"] as const) {
        wf.stages[name].status = "approved"
      }
    })
    const gate = createCommitGate(store)
    await expect(
      gate({ tool: "bash", sessionID: "s1" }, { args: { command: "git commit" } }),
    ).rejects.toThrow(/基线预估工时/)
    store.close()
  })

  test("recomputeCommit：sdlc 无基线时 blocked_by 含「基线预估工时」", () => {
    const s = createWorkflowState("sdlc")
    expect(recomputeCommit(s).commit.blocked_by).toContain("基线预估工时")
  })

  test("recomputeCommit：sdlc 录入基线后不再阻塞", () => {
    const s = createWorkflowState("sdlc")
    s.baseline = { estimatedHours: 8, setAt: 1 }
    expect(recomputeCommit(s).commit.blocked_by).not.toContain("基线预估工时")
  })

  test("一次性强制提交授权：放行一次后失效（3.4）", async () => {
    const store = Store.memory()
    store.mutateWorkflow("s1", (wf) => {
      wf.commit.force = { reason: "紧急 hotfix", at: 1, used: false }
    })
    const gate = createCommitGate(store)
    // 第一次：放行并标记已用
    await expect(
      gate({ tool: "bash", sessionID: "s1" }, { args: { command: "git commit" } }),
    ).resolves.toBeUndefined()
    expect(store.get("s1")!.workflow!.commit.force!.used).toBe(true)
    // 第二次：授权已用，恢复阻断
    await expect(
      gate({ tool: "bash", sessionID: "s1" }, { args: { command: "git commit" } }),
    ).rejects.toThrow(/提交门禁/)
    store.close()
  })
})
