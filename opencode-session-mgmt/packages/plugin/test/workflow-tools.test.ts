/**
 * 工作流工具测试：commit_force_unlock 强制提交授权（设计文档 §3.4 逃生口）。
 * 校验开发者确认 + 原因必填，授权写入留痕且为一次性。
 */
import { describe, expect, test } from "bun:test"
import { Store } from "../src/db"
import { createWorkflowTools } from "../src/tools/workflow"

const ctx = { sessionID: "s1" } as never

function setup() {
  const store = Store.memory()
  const tools = createWorkflowTools(store)
  return { store, tools }
}

describe("commit_force_unlock", () => {
  test("需 developer_confirmed 与非空原因", async () => {
    const { store, tools } = setup()
    const unlock = tools.commit_force_unlock!
    await expect(
      unlock.execute({ reason: "紧急", developer_confirmed: false } as never, ctx),
    ).rejects.toThrow(/developer_confirmed/)
    await expect(
      unlock.execute({ reason: "   ", developer_confirmed: true } as never, ctx),
    ).rejects.toThrow(/原因/)
    store.close()
  })

  test("写入一次性授权并留痕", async () => {
    const { store, tools } = setup()
    await tools.commit_force_unlock!.execute({ reason: "紧急 hotfix", developer_confirmed: true } as never, ctx)
    const force = store.get("s1")!.workflow!.commit.force
    expect(force?.reason).toBe("紧急 hotfix")
    expect(force?.used).toBe(false)
    expect(typeof force?.at).toBe("number")
    store.close()
  })

  test("workflow_advance 仍拒绝审查阶段自批", async () => {
    const { store, tools } = setup()
    await expect(
      tools.workflow_advance!.execute({ stage: "review", action: "approve", developer_confirmed: true } as never, ctx),
    ).rejects.toThrow(/review_submit/)
    store.close()
  })
})
