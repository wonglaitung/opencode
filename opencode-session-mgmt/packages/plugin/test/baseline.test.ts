/**
 * 基线对比统计测试（设计文档 6.3）。
 * sessionStats.efficiency =（预估 − 实际周期）÷ 预估（可为负，无基线/无周期为 null）；
 * aggregateProject.avgEfficiency 对「有基线且有有效周期」的会话求均值，
 * baselineCount 统计已录入基线的会话数。
 */
import { describe, expect, test } from "bun:test"
import { Store } from "../src/db"
import { aggregateProject, sessionStats } from "../src/stats"

const noUsage = { cost: null, tokensInput: null, tokensOutput: null }
const HOUR = 3_600_000

/** 构造一个「已完成」会话：五阶段全 approved、首末转换时间戳跨 durationMs，可选基线。
 *  完成态保证会话周期取转换跨度（durationMs），便于断言提效率。 */
function seed(store: Store, id: string, durationMs: number, estimatedHours: number | null): void {
  store.mutateWorkflow(id, (wf) => {
    const start = 1_750_000_000_000
    const order = ["requirements", "design", "implementation", "testing", "review"]
    order.forEach((name, i) => {
      const at = start + Math.round((durationMs * i) / (order.length - 1))
      wf.stages[name].transitions.push({ action: "enter", at })
      wf.stages[name].transitions.push({ action: "approve", at })
      wf.stages[name].status = "approved"
    })
    if (estimatedHours !== null) wf.baseline = { estimatedHours, setAt: start }
  })
}

describe("sessionStats.efficiency（AI 提效率）", () => {
  test("有基线有周期：（预估 − 实际）÷ 预估", () => {
    const store = Store.memory()
    seed(store, "s1", 1.7 * HOUR, 8)
    const stats = sessionStats(store.get("s1")!, noUsage)!
    expect(stats.baselineHours).toBe(8)
    expect(stats.efficiency).toBeCloseTo((8 - 1.7) / 8)
    store.close()
  })

  test("实际超过预估时为负（仅展示）", () => {
    const store = Store.memory()
    seed(store, "s1", 3 * HOUR, 2)
    expect(sessionStats(store.get("s1")!, noUsage)!.efficiency).toBeCloseTo(-0.5)
    store.close()
  })

  test("无基线 → null（展示 N/A）", () => {
    const store = Store.memory()
    seed(store, "s1", 2 * HOUR, null)
    const stats = sessionStats(store.get("s1")!, noUsage)!
    expect(stats.baselineHours).toBeNull()
    expect(stats.efficiency).toBeNull()
    store.close()
  })

  test("无转换时间戳（无有效周期）→ null", () => {
    const store = Store.memory()
    store.mutateWorkflow("s1", (wf) => {
      wf.baseline = { estimatedHours: 8, setAt: 1 }
    })
    expect(sessionStats(store.get("s1")!, noUsage)!.efficiency).toBeNull()
    store.close()
  })
})

describe("aggregateProject.avgEfficiency / baselineCount", () => {
  test("对有基线且有有效周期的会话求均值；baselineCount 计基线会话数", () => {
    const store = Store.memory()
    seed(store, "s1", 1 * HOUR, 4) // 提效 0.75
    seed(store, "s2", 1 * HOUR, 2) // 提效 0.5
    seed(store, "s3", 2 * HOUR, null) // 无基线，不参与均值
    const project = aggregateProject(store.listAll(), () => noUsage)
    expect(project.avgEfficiency).toBeCloseTo((0.75 + 0.5) / 2)
    expect(project.baselineCount).toBe(2)
    store.close()
  })

  test("无任何基线会话时 avgEfficiency 为 null、baselineCount 为 0", () => {
    const store = Store.memory()
    seed(store, "s1", 2 * HOUR, null)
    const project = aggregateProject(store.listAll(), () => noUsage)
    expect(project.avgEfficiency).toBeNull()
    expect(project.baselineCount).toBe(0)
    store.close()
  })
})
