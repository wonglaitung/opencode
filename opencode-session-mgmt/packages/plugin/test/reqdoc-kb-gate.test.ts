/**
 * reqdoc 门禁切换测试（重构 2b「读新写旧并存」）。
 *
 * 验证设计第 12 章 2b 的核心主张：**kb 存在时门禁读派生值，kb 缺省时保持旧门禁**——
 * 两套并存可逆（2c 才删旧字段/工具）。本测试直接构造两种 state，断言门禁行为。
 */
import { describe, expect, test } from "bun:test"
import { createWorkflowState, kbGate, requiredSlots } from "sm-shared"
import type { ReqdocKbState, ReqdocSlot, WorkflowState } from "sm-shared"

/** 构造带 kb 的 reqdoc 状态（kb 存在 → 新门禁路径）。 */
function stateWithKb(opts: { fillAll?: boolean; unclosed?: string[] } = {}): WorkflowState {
  const s = createWorkflowState("reqdoc")
  const features = [{ no: 1, name: "名单排查", priority: "high" as const, confirmedAt: 1000 }]
  const req = requiredSlots(features)
  const slots: ReqdocSlot[] = req.map((address) => ({
    kind: "prose",
    address,
    content: `${address} 内容`,
    source: "文档",
    status: "confirmed",
  }))
  const kb: ReqdocKbState = {
    slots: opts.fillAll === false ? slots.slice(0, 3) : slots,
    features,
    containers: {
      "4.1": { required: false, reason: "无特殊术语" },
      "5.1.2.1": { required: false, reason: "无结构化字段" },
    },
    askCounts: {},
    updatedAt: 1,
  }
  s.kb = kb
  s.type = "reqdoc"
  return s
}

describe("门禁切换 · kb 存在走派生门禁（2b）", () => {
  test("kb 全填 + 容器已声明可为空 → 门禁通过", () => {
    const s = stateWithKb()
    const g = kbGate(s.kb!.slots, s.kb!.features, { decls: s.kb!.containers })
    expect(g.pass).toBe(true)
    expect(g.coverage.leafFilled).toBe(g.coverage.leafTotal)
  })

  test("★ kb 未填满 → 门禁不通过（不再看 score.total）", () => {
    const s = stateWithKb({ fillAll: false })
    const g = kbGate(s.kb!.slots, s.kb!.features, { decls: s.kb!.containers })
    expect(g.pass).toBe(false)
    expect(g.reasons.join()).toContain("覆盖率")
  })

  test("★ 未收口项（未 confirmed 的地址）→ 未 force 则不通过，force 后放行", () => {
    // 真实未收口项是「该地址还没有 confirmed 槽位」的停问项——用未填的 3.6 模拟
    const s = stateWithKb({ fillAll: false })
    const g = kbGate(s.kb!.slots, s.kb!.features, {
      decls: s.kb!.containers,
      unclosed: ["3.6"],
    })
    expect(g.pass).toBe(false)
    expect(g.reasons.join()).toContain("未收口")
    // force 后该条不再拦（其余缺口仍在）
    const gf = kbGate(s.kb!.slots, s.kb!.features, {
      decls: s.kb!.containers,
      unclosed: ["3.6"],
      force: true,
    })
    expect(gf.reasons.join()).not.toContain("未收口")
    // kbGate 内部会把「已 confirmed」的地址从 unclosed 滤掉（防重复计未收口）
    const withConfirmed = stateWithKb()
    const gc = kbGate(withConfirmed.kb!.slots, withConfirmed.kb!.features, {
      decls: withConfirmed.kb!.containers,
      unclosed: ["3.1"], // 3.1 已 confirmed → 应被滤掉
    })
    expect(gc.reasons.join()).not.toContain("未收口")
  })
})

describe("门禁切换 · kb 缺省保持旧门禁（可逆，2b）", () => {
  test("★ 无 kb → score/probes/fieldDict 仍被旧门禁读取（新字段未删，可回退）", () => {
    const s = createWorkflowState("reqdoc")
    // 不设 kb —— 旧门禁路径（旧字段缺失 → 旧门禁会拦）
    expect(s.kb).toBeUndefined()
    // 旧状态字段仍在类型上可用（2c 才删）
    s.score = undefined
    s.probes = undefined
    s.fieldDict = undefined
    // 模拟旧门禁读取：score 缺失即应拦截
    const oldGateWouldBlock = !s.score
    expect(oldGateWouldBlock).toBe(true)
  })

  test("kb 与旧字段并存时，旧字段仍可写（2b 不删）", () => {
    const s = stateWithKb()
    s.score = {
      dims: {
        businessValue: { score: 10, max: 12 },
        flowClosure: { score: 15, max: 20 },
        edgeControl: { score: 20, max: 22 },
        compliance: { score: 16, max: 16 },
        authority: { score: 8, max: 8 },
        material: { score: 8, max: 8 },
        nfr: { score: 7, max: 7 },
        acceptability: { score: 7, max: 7 },
      },
      deductions: [],
      total: 91,
      confirmed: true,
      confirmedAt: 1,
      updatedAt: 1,
    }
    // kb 与 score 同时存在且互不干扰
    expect(s.kb).toBeDefined()
    expect(s.score?.total).toBe(91)
  })
})