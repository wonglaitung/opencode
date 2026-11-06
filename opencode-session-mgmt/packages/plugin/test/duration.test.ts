/**
 * 会话周期（durationMs）语义测试（6.1）。
 * 活跃用时：busy 区间完整累计；非 busy 空档最多累计 5 分钟；已完成冻结。
 * 旧状态无 timing 时回退为转换跨度；提效率仅对完成会话计算。
 */
import { describe, expect, test } from "bun:test"
import { createWorkflowState } from "sm-shared"
import { Store } from "../src/db"
import { IDLE_GAP_MS, markBusy, markIdle, recordActivity, sessionStats, workflowDurationMs } from "../src/stats"

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

describe("活跃计时：排除长时间离开", () => {
  test("超过空档上限只累计上限，不把过夜时间算进去", () => {
    const wf = createWorkflowState("task")
    wf.stages.execute.transitions.push({ action: "enter", at: NOW })
    wf.stages.execute.status = "in_progress"
    recordActivity(wf, NOW)
    const overnight = 12 * 3_600_000
    recordActivity(wf, NOW + overnight)
    expect(wf.timing?.activeMs).toBe(IDLE_GAP_MS)
    expect(workflowDurationMs(wf, NOW + overnight)).toBe(IDLE_GAP_MS)
  })

  test("连续活动按实际间隔累计", () => {
    const wf = createWorkflowState("task")
    wf.stages.execute.transitions.push({ action: "enter", at: NOW })
    wf.stages.execute.status = "in_progress"
    recordActivity(wf, NOW)
    recordActivity(wf, NOW + 60_000)
    recordActivity(wf, NOW + 180_000)
    expect(wf.timing?.activeMs).toBe(180_000)
    expect(workflowDurationMs(wf, NOW + 180_000)).toBe(180_000)
  })

  test("完成后冻结活跃时长，不再追加离开期间", () => {
    const wf = createWorkflowState("task")
    wf.stages.execute.transitions.push({ action: "enter", at: NOW })
    wf.stages.execute.status = "in_progress"
    recordActivity(wf, NOW)
    recordActivity(wf, NOW + 60_000)
    wf.stages.execute.status = "approved"
    wf.stages.execute.transitions.push({ action: "approve", at: NOW + 60_000 })
    expect(workflowDurationMs(wf, NOW + 24 * 3_600_000)).toBe(60_000)
  })
})

describe("AI busy：运行很久也按完整时长计入", () => {
  test("busy 期间无工具调用，30 分钟后仍计 30 分钟", () => {
    const wf = createWorkflowState("task")
    wf.stages.execute.transitions.push({ action: "enter", at: NOW })
    wf.stages.execute.status = "in_progress"
    recordActivity(wf, NOW)
    markBusy(wf, NOW)
    expect(workflowDurationMs(wf, NOW + 30 * 60_000)).toBe(30 * 60_000)
  })

  test("idle 后只保留 5 分钟空档，不再无限计时", () => {
    const wf = createWorkflowState("task")
    wf.stages.execute.transitions.push({ action: "enter", at: NOW })
    wf.stages.execute.status = "in_progress"
    recordActivity(wf, NOW)
    markBusy(wf, NOW)
    markIdle(wf, NOW + 30 * 60_000)
    expect(workflowDurationMs(wf, NOW + 3_600_000)).toBe(35 * 60_000)
    expect(workflowDurationMs(wf, NOW + 24 * 3_600_000)).toBe(35 * 60_000)
  })


  test("重复 idle 事件不重复累计空档", () => {
    const wf = createWorkflowState("task")
    wf.stages.execute.transitions.push({ action: "enter", at: NOW })
    wf.stages.execute.status = "in_progress"
    recordActivity(wf, NOW)
    markBusy(wf, NOW)
    markIdle(wf, NOW + 30 * 60_000)
    markIdle(wf, NOW + 60 * 60_000)
    markIdle(wf, NOW + 2 * 60 * 60_000)
    expect(workflowDurationMs(wf, NOW + 3 * 60 * 60_000)).toBe(35 * 60_000)
  })

  test("完成发生在 busy 中：完成后的 idle 延迟不再计入", () => {
    const wf = createWorkflowState("task")
    wf.stages.execute.transitions.push({ action: "enter", at: NOW })
    wf.stages.execute.status = "in_progress"
    recordActivity(wf, NOW)
    markBusy(wf, NOW)
    wf.stages.execute.status = "approved"
    wf.stages.execute.transitions.push({ action: "approve", at: NOW + 30 * 60_000 })
    expect(workflowDurationMs(wf, NOW + 30 * 60_000)).toBe(30 * 60_000)
    markIdle(wf, NOW + 2 * 3_600_000)
    expect(workflowDurationMs(wf, NOW + 24 * 3_600_000)).toBe(30 * 60_000)
  })


  test("完成后仍有工具活动：活跃时长仍冻结在完成点", () => {
    const wf = createWorkflowState("task")
    wf.stages.execute.transitions.push({ action: "enter", at: NOW })
    wf.stages.execute.status = "in_progress"
    recordActivity(wf, NOW)
    markBusy(wf, NOW)
    wf.stages.execute.status = "approved"
    wf.stages.execute.transitions.push({ action: "approve", at: NOW + 30 * 60_000 })
    recordActivity(wf, NOW + 2 * 3_600_000)
    expect(workflowDurationMs(wf, NOW + 24 * 3_600_000)).toBe(30 * 60_000)
  })

  test("完成后的活动或 busy 事件不会继续累加工时", () => {
    const wf = createWorkflowState("task")
    wf.stages.execute.transitions.push({ action: "enter", at: NOW })
    wf.stages.execute.status = "approved"
    wf.stages.execute.transitions.push({ action: "approve", at: NOW + 30 * 60_000 })
    recordActivity(wf, NOW + 2 * 3_600_000)
    markBusy(wf, NOW + 2 * 3_600_000)
    markIdle(wf, NOW + 3 * 3_600_000)
    expect(workflowDurationMs(wf, NOW + 24 * 3_600_000)).toBe(30 * 60_000)
  })

  test("busy 早于 workflow_start：启动后补记此前 AI 运行时间", () => {
    const wf = createWorkflowState("task")
    markBusy(wf, NOW)
    wf.stages.execute.transitions.push({ action: "enter", at: NOW + 10 * 60_000 })
    wf.stages.execute.status = "in_progress"
    recordActivity(wf, NOW + 10 * 60_000)
    expect(workflowDurationMs(wf, NOW + 10 * 60_000)).toBe(10 * 60_000)
  })

  test("busy 中工具活动不会重复计数，idle 后结算并冻结", () => {
    const wf = createWorkflowState("task")
    wf.stages.execute.transitions.push({ action: "enter", at: NOW })
    wf.stages.execute.status = "in_progress"
    recordActivity(wf, NOW)
    markBusy(wf, NOW)
    recordActivity(wf, NOW + 10 * 60_000)
    markIdle(wf, NOW + 30 * 60_000)
    expect(wf.timing?.activeMs).toBe(30 * 60_000)
    expect(workflowDurationMs(wf, NOW + 30 * 60_000)).toBe(30 * 60_000)
    wf.stages.execute.status = "approved"
    wf.stages.execute.transitions.push({ action: "approve", at: NOW + 30 * 60_000 })
    expect(workflowDurationMs(wf, NOW + 24 * 3_600_000)).toBe(30 * 60_000)
  })
})


describe("重启清理遗留 busy", () => {
  test("resetBusyTiming 清掉 busySince，保留已结算工时", () => {
    const store = Store.memory()
    store.mutateWorkflow("s1", (wf) => {
      wf.timing = { activeMs: 1_000, lastAt: 1_000, busySince: 500 }
    })
    store.resetBusyTiming()
    expect(store.get("s1")!.workflow?.timing).toEqual({ activeMs: 1_000, lastAt: 1_000 })
    store.close()
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

describe("task 一般任务统计", () => {
  test("无 review 阶段不抛错，审查指标归零", () => {
    const store = Store.memory(() => "task")
    try {
      store.mutateWorkflow("t1", (wf) => {
        const start = Date.now() - 3_600_000
        wf.stages.execute.transitions.push({ action: "enter", at: start })
        wf.stages.execute.transitions.push({ action: "approve", at: start + 1_800_000 })
        wf.stages.execute.status = "approved"
        wf.baseline = { estimatedHours: 2, setAt: start }
      })
      const stats = sessionStats(store.get("t1")!, noUsage)!
      expect(stats.type).toBe("task")
      expect(stats.complete).toBe(true)
      expect(stats.checklistPassed).toBe(0)
      expect(stats.comprehension).toEqual({ total: 0, confirmed: 0 })
      expect(stats.efficiency).toBeCloseTo((2 - 0.5) / 2)
    } finally {
      store.close()
    }
  })
})
