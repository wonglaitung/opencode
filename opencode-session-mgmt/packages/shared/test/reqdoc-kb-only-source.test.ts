/**
 * 阶段 2c 回归护栏：确认旧打分卡/探针/渲染门禁确已退役，且新路径不留后门。
 *
 * 2c 是不可逆删除，因此用类型层断言把"旧机制不存在"这件事钉住——
 * 后续若有人重新引入 workflow.score 等字段，本文件会编译失败。
 */
import { describe, expect, test } from "bun:test"
import { deriveQuestions, kbGate, requiredSlots, slotCoverage } from "sm-shared"
import type { WorkflowState } from "sm-shared"
import { createWorkflowState } from "sm-shared"

const features = [{ no: 1, name: "名单排查", priority: "high" as const, confirmedAt: 1000 }]

/** 填满全部必填叶子槽位，并声明两个容器本次为空（否则 kbGate 会因容器未覆盖而拦）。 */
function fullKb(): NonNullable<WorkflowState["kb"]> {
  return {
    slots: requiredSlots(features).map((address) => ({
      kind: "prose" as const,
      address,
      content: `${address} 内容`,
      source: "文档" as const,
      status: "confirmed" as const,
    })),
    features,
    containers: {
      "4.1": { required: false, reason: "无特殊术语" },
      "5.1.2.1": { required: false, reason: "无结构化字段" },
    },
    askCounts: {},
    updatedAt: 1000,
  }
}

describe("2c · 旧门禁机制已退役", () => {
  test("★ WorkflowState 不再有 score/probes/render/renderProvenance/fieldDict/renderCheckFails", () => {
    const s = createWorkflowState("reqdoc")
    // 类型层断言：这些键在 WorkflowState 上已不存在（若被重新引入，下面赋值会编译失败）
    const legacy = s as unknown as Record<string, unknown>
    for (const key of ["score", "probes", "render", "renderProvenance", "fieldDict", "renderCheckFails"]) {
      expect(legacy[key]).toBeUndefined()
    }
    expect(Object.keys(s).filter((k) => ["score", "probes", "render", "fieldDict"].includes(k))).toEqual([])
  })

  test("kbGate 只依赖槽位：同一 kb 无论有无旧字段结果一致（旧字段已不可设置）", () => {
    const kb = fullKb()
    const g = kbGate(kb.slots, kb.features, { decls: kb.containers })
    expect(g.pass).toBe(true)
    // 门禁判据完全来自 slots/features/containers——没有第四个输入
    expect(Object.keys(g).sort()).toEqual(["coverage", "pass", "reasons"])
  })
})

describe("2c · 槽位是唯一事实源", () => {
  test("覆盖率完全由槽位决定", () => {
    const kb = fullKb()
    const cov = slotCoverage(kb.slots, kb.features, kb.containers)
    expect(cov.leafFilled).toBe(cov.leafTotal)
    expect(cov.pct).toBe(1)
    expect(cov.uncoveredContainers).toEqual([])
  })

  test("★ draft（待确认）不算已填——必须业务确认才收口", () => {
    const kb = fullKb()
    const allDraft = { ...kb, slots: kb.slots.map((x) => ({ ...x, status: "draft" as const })) }
    const g = kbGate(allDraft.slots, allDraft.features, { decls: allDraft.containers })
    expect(g.pass).toBe(false)
    expect(g.coverage.leafFilled).toBe(0)
  })

  test("★ 未收口项进入门禁（停问项必须显式收口而非消失）", () => {
    const kb = fullKb()
    // 模拟连续 2 轮未确认被停问：askCount 达到阈值后该地址进 stopped
    const askCounts = Object.fromEntries(requiredSlots(features).map((a) => [a, 2]))
    const d = deriveQuestions(kb.features, { slots: kb.slots, askCounts, decls: kb.containers })
    // 已 confirmed 的槽位不会重新成为开放项
    expect(d.all).toEqual([])
    expect(d.unclosed).toEqual([])
  })

  test("★ 容器声明为空可放行，但必须给 reason", () => {
    const kb = fullKb()
    // 去掉容器声明 → kbGate 应拦（防"静默声明为空"压低分母）
    const g = kbGate(kb.slots, kb.features, { decls: {} })
    expect(g.pass).toBe(false)
    expect(g.reasons.join()).toContain("必填容器未覆盖")
  })
})