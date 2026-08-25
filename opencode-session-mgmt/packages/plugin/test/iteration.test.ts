/**
 * 迭代计数与重复模式检测测试（设计文档 session-management.md 3.2）。
 * 验证 iterationCount 取「同一文件」的最大编辑次数（统计用），
 * 以及 stuck 检测（连续相同参数 streak ≥ 3 或频率 ≥ 6）。
 */
import { beforeEach, describe, expect, test } from "bun:test"
import { Store } from "../src/db"
import { createIterationCounter, getStuckFiles, resetStuckState } from "../src/tools/quality"

type CounterInput = { tool: string; sessionID: string; args?: unknown }

beforeEach(() => {
  resetStuckState()
})

describe("迭代计数（统计用，按文件）", () => {
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

describe("重复模式检测（stuck 检测，内存级）", () => {
  test("同一文件 + 相同参数连续 3 次 → stuck", async () => {
    const store = Store.memory()
    const counter = createIterationCounter(store)
    const args = { filePath: "a.ts", oldString: "foo", newString: "bar" }
    await counter({ tool: "edit", sessionID: "s1", args })
    await counter({ tool: "edit", sessionID: "s1", args })
    await counter({ tool: "edit", sessionID: "s1", args })
    const stuck = getStuckFiles("s1")
    expect(stuck).toEqual({ "a.ts": 3 })
  })

  test("同一文件 + 不同参数连续 3 次 → 不触发 stuck", async () => {
    const store = Store.memory()
    const counter = createIterationCounter(store)
    await counter({ tool: "edit", sessionID: "s1", args: { filePath: "a.ts", oldString: "foo", newString: "bar1" } })
    await counter({ tool: "edit", sessionID: "s1", args: { filePath: "a.ts", oldString: "baz", newString: "bar2" } })
    await counter({ tool: "edit", sessionID: "s1", args: { filePath: "a.ts", oldString: "qux", newString: "bar3" } })
    const stuck = getStuckFiles("s1")
    expect(stuck).toEqual({})
  })

  test("同一文件编辑 6 次（不同参数）→ 触发频率检测", async () => {
    const store = Store.memory()
    const counter = createIterationCounter(store)
    for (let i = 0; i < 6; i++) {
      await counter({ tool: "edit", sessionID: "s1", args: { filePath: "a.ts", oldString: `old${i}`, newString: `new${i}` } })
    }
    const stuck = getStuckFiles("s1")
    expect(stuck["a.ts"]).toBe(6)
  })

  test("穿插编辑 a-b-a（相同 hash）→ a 的 per-file streak=2，不触发", async () => {
    const store = Store.memory()
    const counter = createIterationCounter(store)
    const argsA = { filePath: "a.ts", oldString: "foo", newString: "bar" }
    const argsB = { filePath: "b.ts", oldString: "x", newString: "y" }
    await counter({ tool: "edit", sessionID: "s1", args: argsA })
    await counter({ tool: "edit", sessionID: "s1", args: argsB })
    await counter({ tool: "edit", sessionID: "s1", args: argsA })
    const stuck = getStuckFiles("s1")
    // a 的 per-file 子序列是 [hash, hash]，streak=2，不触发（需 >=3）
    expect(stuck).toEqual({})
  })

  test("不同 session 的内存状态互不影响", async () => {
    const store = Store.memory()
    const counter = createIterationCounter(store)
    const args = { filePath: "a.ts", oldString: "foo", newString: "bar" }
    // session A：2 次（不触发）
    await counter({ tool: "edit", sessionID: "sA", args })
    await counter({ tool: "edit", sessionID: "sA", args })
    // session B：3 次（触发）
    await counter({ tool: "edit", sessionID: "sB", args })
    await counter({ tool: "edit", sessionID: "sB", args })
    await counter({ tool: "edit", sessionID: "sB", args })
    expect(getStuckFiles("sA")).toEqual({})
    expect(getStuckFiles("sB")).toEqual({ "a.ts": 3 })
  })

  test("短记忆上限 20：超过后旧记录被淘汰", async () => {
    const store = Store.memory()
    const counter = createIterationCounter(store)
    // 先做 20 次不同文件的编辑（填满短记忆）
    for (let i = 0; i < 20; i++) {
      await counter({ tool: "edit", sessionID: "s1", args: { filePath: `file${i}.ts`, oldString: `o${i}`, newString: `n${i}` } })
    }
    // 再做 3 次相同操作（a.ts 相同 hash）
    const args = { filePath: "a.ts", oldString: "foo", newString: "bar" }
    await counter({ tool: "edit", sessionID: "s1", args })
    await counter({ tool: "edit", sessionID: "s1", args })
    await counter({ tool: "edit", sessionID: "s1", args })
    const stuck = getStuckFiles("s1")
    expect(stuck["a.ts"]).toBe(3)
  })

  test("write 工具：相同 content → stuck", async () => {
    const store = Store.memory()
    const counter = createIterationCounter(store)
    const args = { filePath: "a.ts", content: "hello world" }
    await counter({ tool: "write", sessionID: "s1", args })
    await counter({ tool: "write", sessionID: "s1", args })
    await counter({ tool: "write", sessionID: "s1", args })
    expect(getStuckFiles("s1")).toEqual({ "a.ts": 3 })
  })

  test("write 工具：不同 content → 不触发", async () => {
    const store = Store.memory()
    const counter = createIterationCounter(store)
    await counter({ tool: "write", sessionID: "s1", args: { filePath: "a.ts", content: "version1" } })
    await counter({ tool: "write", sessionID: "s1", args: { filePath: "a.ts", content: "version2" } })
    await counter({ tool: "write", sessionID: "s1", args: { filePath: "a.ts", content: "version3" } })
    expect(getStuckFiles("s1")).toEqual({})
  })
})
