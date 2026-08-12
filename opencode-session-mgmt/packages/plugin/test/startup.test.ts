/**
 * 启动后台任务测试（3.1 孤儿清理、5.2 标题回填）。
 * 验证：共用一次会话列表完成 清理+回填；子代理不入白名单；占位标题视为未同步可刷新。
 * 延后触发（STARTUP_DELAY_MS）与合并在 index.ts 调度层，此处测纯函数语义。
 */
import { describe, expect, test } from "bun:test"
import { Store } from "../src/db"
import { backfillSessionTitles, cleanupOrphans, STARTUP_DELAY_MS } from "../src/startup"

describe("cleanupOrphans：仅主会话保留", () => {
  test("子代理与孤儿一并清理", () => {
    const store = Store.memory()
    store.mutateWorkflow("main", () => {})
    store.mutateWorkflow("sub", () => {})
    store.mutateWorkflow("ghost", () => {})
    const removed = cleanupOrphans(store, [
      { id: "main", parentID: null },
      { id: "sub", parentID: "main" },
    ])
    expect(removed).toBe(2) // sub（子代理，不入白名单）+ ghost 被清理
    expect(store.get("main")).not.toBeNull()
    expect(store.get("sub")).toBeNull() // 子代理不入白名单
    expect(store.get("ghost")).toBeNull()
    store.close()
  })

  test("空列表时不动现有记录", () => {
    const store = Store.memory()
    store.mutateWorkflow("a", () => {})
    expect(cleanupOrphans(store, [])).toBe(0)
    expect(store.get("a")).not.toBeNull()
    store.close()
  })
})

describe("backfillSessionTitles：仅补空/占位", () => {
  test("真实标题不覆盖，空标题回填", () => {
    const store = Store.memory()
    store.mutateWorkflow("s1", () => {})
    store.mutateWorkflow("s2", () => {})
    store.setTitle("s1", "真实标题")
    backfillSessionTitles(store, [
      { id: "s1", title: "应被忽略的新标题" },
      { id: "s2", title: "回填的标题" },
    ])
    expect(store.get("s1")!.title).toBe("真实标题")
    expect(store.get("s2")!.title).toBe("回填的标题")
    store.close()
  })

  test("占位标题（New session - …）视为未同步，可刷新", () => {
    const store = Store.memory()
    store.mutateWorkflow("s1", () => {})
    store.setTitle("s1", "New session - 2026-08-12T09:00:00.000Z")
    backfillSessionTitles(store, [{ id: "s1", title: "真实标题" }])
    expect(store.get("s1")!.title).toBe("真实标题")
    store.close()
  })

  test("延后毫秒数为正值（错开首屏竞态）", () => {
    expect(STARTUP_DELAY_MS).toBeGreaterThan(0)
  })
})
