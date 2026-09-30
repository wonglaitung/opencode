/**
 * reqdoc 知识库门禁测试（重构 2c：旧门禁字段已删除，kbGate 是唯一门禁依据）。
 *
 * 覆盖：覆盖率达标放行 / 覆盖率不足拦截 / 未收口项拦截与 force 放行 / 已确认项不重复计未收口。
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
