/**
 * 迭代计数语义测试（设计文档 §3.2 / §7.4 规则 17）。
 * 验证 iterationCount 取「同一段代码/文件」的最大循环次数，而非全会话编辑总数。
 */
import { describe, expect, test } from "bun:test"
import { Store } from "../src/db"
import { createIterationCounter } from "../src/tools/quality"

type CounterInput = { tool: string; sessionID: string; args?: unknown }

describe("迭代计数（按文件，§3.2）", () => {
  test("同一文件编辑 3 次 → iterationCount=3", async () => {
    const store = Store.memory()
    const counter = createIterationCounter(store)
    const call = (tool: string, filePath: string): CounterInput => ({ tool, sessionID: "s1", args: { filePath } })
    await counter(call("write", "a.ts"))
    await counter(call("edit", "a.ts"))
    await counter(call("edit", "a.ts"))
    const wf = store.get("s1")!.workflow!
    expect(wf.quality.iterationCount).toBe(3)
    expect(wf.quality.iterationByFile).toEqual({ "a.ts": 3 })
  })

  test("交替编辑两个文件 → 取最大值而非总数", async () => {
    const store = Store.memory()
    const counter = createIterationCounter(store)
    const call = (filePath: string): CounterInput => ({ tool: "edit", sessionID: "s2", args: { filePath } })
    await counter(call("a.ts"))
    await counter(call("b.ts"))
    await counter(call("a.ts"))
    const wf = store.get("s2")!.workflow!
    // a.ts×2、b.ts×1 → 最热 2，而非全会话总数 3
    expect(wf.quality.iterationCount).toBe(2)
    expect(wf.quality.iterationByFile).toEqual({ "a.ts": 2, "b.ts": 1 })
  })

  test("无 filePath 的工具（apply_patch）归入工具级桶", async () => {
    const store = Store.memory()
    const counter = createIterationCounter(store)
    await counter({ tool: "apply_patch", sessionID: "s3", args: { patchText: "*** Update ..." } })
    const wf = store.get("s3")!.workflow!
    expect(wf.quality.iterationCount).toBe(1)
    expect(wf.quality.iterationByFile).toEqual({ "(apply_patch)": 1 })
  })

  test("只读工具不计入", async () => {
    const store = Store.memory()
    const counter = createIterationCounter(store)
    await counter({ tool: "read", sessionID: "s4", args: { filePath: "a.ts" } })
    // 未触发任何写入，会话行不应被创建
    expect(store.get("s4")).toBeNull()
  })
})
