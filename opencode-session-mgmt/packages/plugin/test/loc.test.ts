/**
 * AI 代码行数累计与统计测试（设计文档 session-management.md 3.2「AI 代码行数统计」）。
 * 净增量口径：write 整文件替换、edit 新行−旧行（oldString="" 为新建语义）、
 * apply_patch 按文件 +行−−行；同会话去重累计；
 * sessionStats/aggregateProject 三分类汇总（逐文件 clamp ≥0，累加型求和）。
 */
import { describe, expect, test } from "bun:test"
import { Store } from "../src/db"
import { aggregateProject, sessionStats } from "../src/stats"
import { createIterationCounter } from "../src/tools/quality"

const noUsage = { cost: null, tokensInput: null, tokensOutput: null }

describe("行数累计（净增量口径）", () => {
  test("write 计整文件行数", async () => {
    const store = Store.memory()
    const counter = createIterationCounter(store)
    await counter({ tool: "write", sessionID: "s1", args: { filePath: "src/a.ts", content: "a\nb\nc\n" } })
    expect(store.get("s1")!.workflow!.quality.linesByFile).toEqual({ "src/a.ts": 3 })
  })

  test("write 后 edit 去重累计：3 + 2 = 5", async () => {
    const store = Store.memory()
    const counter = createIterationCounter(store)
    await counter({ tool: "write", sessionID: "s1", args: { filePath: "src/a.ts", content: "a\nb\nc" } })
    await counter({
      tool: "edit",
      sessionID: "s1",
      args: { filePath: "src/a.ts", oldString: "b", newString: "b1\nb2\nb3" },
    })
    expect(store.get("s1")!.workflow!.quality.linesByFile).toEqual({ "src/a.ts": 5 })
  })

  test("edit oldString 为空按新建文件语义计 newString 整体", async () => {
    const store = Store.memory()
    const counter = createIterationCounter(store)
    await counter({ tool: "edit", sessionID: "s1", args: { filePath: "src/new.ts", oldString: "", newString: "x\ny" } })
    expect(store.get("s1")!.workflow!.quality.linesByFile).toEqual({ "src/new.ts": 2 })
  })

  test("edit 净删除保留负值（clamp 只在汇总时发生）", async () => {
    const store = Store.memory()
    const counter = createIterationCounter(store)
    await counter({
      tool: "edit",
      sessionID: "s1",
      args: { filePath: "src/a.ts", oldString: "a\nb\nc\nd", newString: "a" },
    })
    expect(store.get("s1")!.workflow!.quality.linesByFile).toEqual({ "src/a.ts": -3 })
  })

  test("write 替换先前计数（AI 重写不重复累加）", async () => {
    const store = Store.memory()
    const counter = createIterationCounter(store)
    await counter({ tool: "write", sessionID: "s1", args: { filePath: "src/a.ts", content: "l1\nl2\nl3\nl4\nl5" } })
    await counter({ tool: "edit", sessionID: "s1", args: { filePath: "src/a.ts", oldString: "l1", newString: "l1\nl1b" } })
    expect(store.get("s1")!.workflow!.quality.linesByFile).toEqual({ "src/a.ts": 6 })
    await counter({ tool: "write", sessionID: "s1", args: { filePath: "src/a.ts", content: "new\nfile\n" } })
    expect(store.get("s1")!.workflow!.quality.linesByFile).toEqual({ "src/a.ts": 2 })
  })

  test("apply_patch 逐文件累计行数", async () => {
    const store = Store.memory()
    const counter = createIterationCounter(store)
    const patchText = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+n1",
      "+n2",
      "*** Update File: src/a.ts",
      "@@ -1,2 +1,3 @@",
      " ctx",
      "-old",
      "+new1",
      "+new2",
      "*** End Patch",
    ].join("\n")
    await counter({ tool: "apply_patch", sessionID: "s1", args: { patchText } })
    // 与迭代计数不同：行数解析出真实文件路径，不归入 (apply_patch) 桶
    expect(store.get("s1")!.workflow!.quality.linesByFile).toEqual({ "src/new.ts": 2, "src/a.ts": 1 })
    expect(store.get("s1")!.workflow!.quality.iterationByFile).toEqual({ "(apply_patch)": 1 })
  })

  test("缺 content/patchText 不计行数但照常计迭代", async () => {
    const store = Store.memory()
    const counter = createIterationCounter(store)
    await counter({ tool: "write", sessionID: "s1", args: { filePath: "src/a.ts" } })
    const wf = store.get("s1")!.workflow!
    expect(wf.quality.iterationCount).toBe(1)
    expect(wf.quality.linesByFile).toBeUndefined()
  })

  test("无入参的代码编辑：工具级桶计迭代、不计行数", async () => {
    const store = Store.memory()
    const counter = createIterationCounter(store)
    await counter({ tool: "write", sessionID: "s1" })
    const wf = store.get("s1")!.workflow!
    expect(wf.quality.iterationByFile).toEqual({ "(write)": 1 })
    expect(wf.quality.linesByFile).toBeUndefined()
  })
})

describe("行数三分类统计", () => {
  test("sessionStats.lines 为三分类聚合（逐文件 clamp ≥0）", () => {
    const store = Store.memory()
    store.mutateWorkflow("s1", (wf) => {
      wf.quality.linesByFile = { "src/a.ts": 10, "src/a.test.ts": -3, "c.json": 2 }
    })
    const stats = sessionStats(store.get("s1")!, noUsage)!
    expect(stats.lines).toEqual({ business: 10, test: 0, config: 2 })
  })

  test("无 linesByFile 时 sessionStats.lines 为 null", () => {
    const store = Store.memory()
    store.ensure("s1")
    expect(sessionStats(store.get("s1")!, noUsage)!.lines).toBeNull()
  })

  test("aggregateProject.linesTotal 对会话求和；hasLinesData 标识有无数据", () => {
    const store = Store.memory()
    store.mutateWorkflow("s1", (wf) => {
      wf.quality.linesByFile = { "src/a.ts": 10, "src/a.test.ts": 5 }
    })
    store.mutateWorkflow("s2", (wf) => {
      wf.quality.linesByFile = { "c.yaml": 3 }
    })
    store.ensure("s3") // 纯讨论会话：无行数数据，不影响求和
    const project = aggregateProject(store.listAll(), () => noUsage)
    expect(project.linesTotal).toEqual({ business: 10, test: 5, config: 3 })
    expect(project.hasLinesData).toBe(true)
  })

  test("无任何会话行数时 hasLinesData 为 false", () => {
    const store = Store.memory()
    store.ensure("s1")
    const project = aggregateProject(store.listAll(), () => noUsage)
    expect(project.linesTotal).toEqual({ business: 0, test: 0, config: 0 })
    expect(project.hasLinesData).toBe(false)
  })
})
