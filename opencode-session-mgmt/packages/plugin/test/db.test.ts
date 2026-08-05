import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Store } from "../src/db"

describe("Store", () => {
  test("ensure 初始化全新工作流", () => {
    const store = Store.memory()
    const row = store.ensure("s1")
    expect(row.workflow).not.toBeNull()
    expect(row.workflow!.stages.requirements.status).toBe("not_started")
    store.close()
  })

  test("mutateWorkflow 读-改-写持久化", () => {
    const store = Store.memory()
    store.mutateWorkflow("s1", (wf) => {
      wf.stages.requirements.status = "approved"
    })
    expect(store.get("s1")!.workflow!.stages.requirements.status).toBe("approved")
    store.close()
  })

  test("stampAccount 幂等，仅首次写入", () => {
    const store = Store.memory()
    expect(store.stampAccount("s1", "a@x.com")).toBe(true)
    expect(store.stampAccount("s1", "b@x.com")).toBe(false)
    expect(store.get("s1")!.account_id).toBe("a@x.com")
    store.close()
  })

  test("tags 去重", () => {
    const store = Store.memory()
    store.setTags("s1", ["a", "b", "a"])
    expect(store.getTags("s1")).toEqual(["a", "b"])
    store.close()
  })

  test("outbox 入队/列出/标记送达", () => {
    const store = Store.memory()
    store.enqueueReport({
      sessionID: "s1",
      account: "a",
      group: "g",
      org: "o",
      workflow: {} as never,
      cost: null,
      tokensInput: null,
      tokensOutput: null,
      reportedAt: 1,
    })
    expect(store.pendingReports()).toHaveLength(1)
    store.markSent(store.pendingReports()[0]!.id)
    expect(store.pendingReports()).toHaveLength(0)
    store.close()
  })
})

describe("openIfExists 只读跨项目打开（4.3）", () => {
  test("库不存在返回 null，且不留下 .opencode", () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-openif-"))
    try {
      expect(Store.openIfExists(dir)).toBeNull()
      expect(existsSync(join(dir, ".opencode"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("已有库只读打开可读会话数据", () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-openif-"))
    try {
      const store = Store.open(dir)
      store.mutateWorkflow("s1", (wf) => {
        wf.quality.linesByFile = { "a.ts": 5 }
      })
      store.close()
      const readonly = Store.openIfExists(dir)!
      expect(readonly.get("s1")!.workflow!.quality.linesByFile).toEqual({ "a.ts": 5 })
      readonly.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
