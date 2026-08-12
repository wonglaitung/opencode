/**
 * 会话周期（durationMs）语义测试（6.1）。
 * 进行中（未全部 approved）会话取「自工作流启动至今」；已完成取转换跨度；
 * 提效率仅对完成会话计算（避免进行中误报高提效）。
 */
import { describe, expect, test } from "bun:test"
import { createWorkflowState } from "sm-shared"
import { Store } from "../src/db"
import { sessionStats, workflowDurationMs } from "../src/stats"

const noUsage = { cost: null, tokensInput: null, tokensOutput: null }
const NOW = 1_800_000_000_000

/** 五阶段全 approved（完成态）。 */
function completeWorkflow(durationMs: number, start: number): ReturnType<typeof createWorkflowState> {
  const wf = createWorkflowState("sdlc")
  const order = ["requirements", "design", "implementation", "testing", "review"]
  order.forEach((name, i) => {
    const at = start + Math.round((durationMs * i) / (order.length - 1))
    wf.stages[name].transitions.push({ action: "enter", at })
    wf.stages[name].transitions.push({ action: "approve", at })
    wf.stages[name].status = "approved"
  })
  return wf
}

describe("workflowDurationMs：进行中取至今、完成取跨度", () => {
  test("无任何转换 → 0", () => {
    const wf = createWorkflowState("sdlc")
    expect(workflowDurationMs(wf, NOW)).toBe(0)
  })

  test("进行中（仅一条 enter）→ now − 启动时间", () => {
    const wf = createWorkflowState("sdlc")
    wf.stages.requirements.transitions.push({ action: "enter", at: NOW - 3_600_000 })
    expect(workflowDurationMs(wf, NOW)).toBe(3_600_000)
  })

  test("已完成 → 转换跨度（max−min）", () => {
    const start = NOW - 3_600_000
    const wf = completeWorkflow(2_000_000, start)
    expect(workflowDurationMs(wf, NOW)).toBe(2_000_000)
  })

  test("部分阶段完成、仍有进行中 → 取至今", () => {
    const wf = createWorkflowState("sdlc")
    const start = NOW - 7_200_000
    wf.stages.requirements.transitions.push({ action: "enter", at: start })
    wf.stages.requirements.transitions.push({ action: "approve", at: start + 1_000_000 })
    wf.stages.requirements.status = "approved"
    wf.stages.design.transitions.push({ action: "enter", at: start + 1_000_000 })
    // design 进行中，未完成
    expect(workflowDurationMs(wf, NOW)).toBe(7_200_000)
  })
})

describe("sessionStats：提效率仅对完成会话", () => {
  test("进行中 + 有基线 → 周期 > 0、提效率 null", () => {
    const store = Store.memory()
    store.mutateWorkflow("s1", (wf) => {
      wf.stages.requirements.transitions.push({ action: "enter", at: Date.now() - 60_000 })
      wf.baseline = { estimatedHours: 8, setAt: Date.now() - 60_000 }
    })
    const stats = sessionStats(store.get("s1")!, noUsage)!
    expect(stats.complete).toBe(false)
    expect(stats.durationMs).toBeGreaterThan(0) // 进行中显示至今耗时
    expect(stats.efficiency).toBeNull() // 未完成不误报提效
    store.close()
  })

  test("已完成 + 有基线 → 提效率按跨度计算", () => {
    const store = Store.memory()
    const start = Date.now() - 2 * 3_600_000
    store.mutateWorkflow("s1", (wf) => {
      const w = completeWorkflow(1.7 * 3_600_000, start)
      wf.stages = w.stages
      wf.baseline = { estimatedHours: 8, setAt: start }
    })
    const stats = sessionStats(store.get("s1")!, noUsage)!
    expect(stats.complete).toBe(true)
    expect(stats.durationMs).toBeCloseTo(1.7 * 3_600_000, -3)
    expect(stats.efficiency).toBeCloseTo((8 - 1.7) / 8)
    store.close()
  })
})

describe("sessionStats.currentStage：进行中会话标注当前阶段", () => {
  test("有进行中阶段 → 返回其标签", () => {
    const store = Store.memory()
    store.mutateWorkflow("s1", (wf) => {
      wf.stages.requirements.status = "approved"
      wf.stages.design.status = "in_progress"
      wf.stages.design.transitions.push({ action: "enter", at: 100 })
    })
    expect(sessionStats(store.get("s1")!, noUsage)!.currentStage).toBe("设计")
    store.close()
  })

  test("已完成 → null", () => {
    const store = Store.memory()
    const start = 1_750_000_000_000
    store.mutateWorkflow("s1", (wf) => {
      const w = completeWorkflow(60_000, start)
      wf.stages = w.stages
    })
    expect(sessionStats(store.get("s1")!, noUsage)!.currentStage).toBeNull()
    store.close()
  })

  test("多个进行中阶段 → 最近进入者胜出", () => {
    const store = Store.memory()
    store.mutateWorkflow("s1", (wf) => {
      wf.stages.requirements.status = "in_progress"
      wf.stages.requirements.transitions.push({ action: "enter", at: 100 })
      wf.stages.design.status = "in_progress"
      wf.stages.design.transitions.push({ action: "enter", at: 200 })
    })
    expect(sessionStats(store.get("s1")!, noUsage)!.currentStage).toBe("设计")
    store.close()
  })

  test("全部 not_started → null", () => {
    const store = Store.memory()
    store.ensure("s1")
    expect(sessionStats(store.get("s1")!, noUsage)!.currentStage).toBeNull()
    store.close()
  })
})
