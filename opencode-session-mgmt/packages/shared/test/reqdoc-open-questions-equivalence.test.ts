/**
 * 验收标准 6：开放项集合与冻结清单**逐地址相等**（设计文档 13 章）。
 *
 * 这是"追问变少且没丢事实"的**确定性判据**，也是第 3 层端到端验收的机器可验部分
 * （模型层验证见 `bun run acceptance`）。
 *
 * 为什么是"不多不少"：
 * - **多一个** = 该问的没问（漏问回归——问少了但没少在该少的地方）
 * - **少一个** = 不该问的问了，或问了个不存在的地址
 * - 两者在总数上可能同增同减，只有逐地址比对能发现
 *
 * 与 `reqdoc-open-questions.test.ts` 的分工：那份守护 **golden 与 schema 不漂移**
 * （清单是否仍自洽），本文件守护 **golden 与真实派生链路不漂移**（实现是否仍产出清单）。
 */
import { describe, expect, test } from "bun:test"
import {
  deriveQuestions,
  requiredSlots,
  slotCoverage,
  kbGate,
  writeL1Term,
  matchMemory,
  materialOf,
} from "sm-shared"
import type { MemoryTerm, ReqdocFeature } from "sm-shared"
import {
  BASELINE_OPEN_QUESTIONS,
  CONFLICT_EXPECTATION,
  MEMORY_L1_EXPECTATION,
  MEMORY_L2_EXPECTATION,
  GOLDEN_CASES,
} from "./reqdoc-open-questions.golden"

const features: ReqdocFeature[] = [{ no: 1, name: "名单排查", priority: "high", confirmedAt: 1000 }]

/** 基线场景：纯口述起步，无槽位、无记忆、无候选。 */
const CONTAINERS = {
  "4.1": { required: false, reason: "基线：本次无术语" },
  "5.1.2.1": { required: false, reason: "基线：本次无结构化字段" },
}

const CRD_MEMORY: MemoryTerm = {
  term: "CRD",
  definition: "信贷审批部",
  kind: "内部简称",
  scope: "org",
  origin: "restated",
  confirmedAt: 1000,
  fromProject: "信贷系统改造",
}

describe("验收 6 · 开放项与冻结清单逐地址相等", () => {
  test("★ 无记忆基线：deriveQuestions 产出 == BASELINE_OPEN_QUESTIONS", () => {
    const actual = deriveQuestions(features, { slots: [], decls: CONTAINERS }).all.map((q) => q.address)
    const expected = [...BASELINE_OPEN_QUESTIONS].sort()
    const got = [...actual].sort()
    // 多一个 = 漏问回归；少一个 = 多问或地址非法
    expect({ missing: expected.filter((a) => !got.includes(a)), extra: got.filter((a) => !expected.includes(a)) })
      .toEqual({ missing: [], extra: [] })
  })

  test("★ 有 L1 记忆：应消失的恰好消失，其余一个不少", () => {
    const candidates = { "4.1": ["CRD"] }
    const d = deriveQuestions(features, {
      slots: [],
      decls: CONTAINERS,
      candidates,
      l1: [CRD_MEMORY],
    })
    const got = new Set(d.all.map((q) => q.address))

    // 应消失
    for (const addr of MEMORY_L1_EXPECTATION.expectedVanished) {
      expect(got.has(addr)).toBe(false)
    }
    // 必须仍在（抽样验证 L1 未越权消缺口）
    for (const addr of MEMORY_L1_EXPECTATION.expectedRemain) {
      expect(got.has(addr)).toBe(true)
    }
    // 除基线项外，只多出被消掉的那一项
    expect(d.l1Applied).toEqual([...MEMORY_L1_EXPECTATION.expectedVanished])
  })

  test("★ 有 L2 记忆：不消缺口（golden 的 mustRemainOpen 仍开放）", () => {
    // golden：L2 命中不消缺口——即便命中，这些地址仍须在开放项里
    const candidates = { "5.1.2.1": ["CIPS"] }
    const l2 = [
      { content: "CIPS 报文经 ESB", source: "问答" as const, scope: "org" as const, origin: "restated", confirmedAt: 1, fromProject: "p" },
    ]
    const d = deriveQuestions(features, { slots: [], decls: CONTAINERS, candidates, l2 })
    for (const addr of MEMORY_L2_EXPECTATION.mustRemainOpen) {
      // 该地址是必填叶子（映射字段），L2 命中与否都仍开放
      expect(d.all.map((q) => q.address)).toContain(addr)
    }
    // L2 命中的候选仍被问，且带默认值猜测
    const cips = d.all.find((q) => q.address === "5.1.2.1.CIPS")
    if (cips) {
      expect(cips.from).toBe("memory-L2")
      expect(cips.guess).toBeTruthy()
    }
    // 关键：L2 消缺口数为 0（L1 才是唯一能消的一级）
    expect(d.l1Applied).toEqual([])
  })

  test("★ 冲突项进未收口清单（供 kbGate 拦门禁）", () => {
    // 冲突槽位取代该地址的 confirmed 槽位（不能并存——kbGate 按「有 confirmed 就不算未收口」判定）
    const slots = requiredSlots(features).map((address) =>
      address === "3.1"
        ? { kind: "prose" as const, address, content: "材料说 A，记忆说 B", source: "文档" as const, status: "conflict" as const }
        : { kind: "prose" as const, address, content: "x", source: "文档" as const, status: "confirmed" as const },
    )
    const d = deriveQuestions(features, { slots, decls: CONTAINERS })
    // 冲突项仍留在开放项（leafCovered 只认 confirmed）——业务仍需就冲突点表态，
    // 这与「材料与记忆冲突时交业务裁决」（3.6 规则 4）一致。
    expect(d.all.map((q) => q.address)).toContain("3.1")
    // ★ 同时它计入未收口 → 门禁拦截，force 才放行
    expect(d.unclosed).toContain("3.1")
    // golden：冲突计入未收口（countsAsUnclosed）
    expect(CONFLICT_EXPECTATION.countsAsUnclosed).toBe(true)
    const gate = kbGate(slots, features, { decls: CONTAINERS, unclosed: d.unclosed })
    expect(gate.pass).toBe(false)
    // force 后放行
    const forced = kbGate(slots, features, { decls: CONTAINERS, unclosed: d.unclosed, force: true })
    expect(forced.pass).toBe(true)
  })

  test("★ GOLDEN_CASES 四用例规格仍成立（CRD/AML/猜错固化/漏问检测）", () => {
    // 四用例规格（设计 4.4）须齐备且各有断言——防止 golden 被删减
    expect(GOLDEN_CASES.map((c) => c.id)).toEqual([
      "crd-l1-vanishes",
      "aml-industry-term",
      "guess-corrected",
      "no-under-ask",
    ])
    for (const c of GOLDEN_CASES) expect(c.asserts.length).toBeGreaterThan(0)

    // ① crd-l1-vanishes：L1 消叶子、容器永不进清单
    const withCrd = deriveQuestions(features, {
      slots: [],
      decls: CONTAINERS,
      candidates: { "4.1": ["CRD"] },
      l1: [CRD_MEMORY],
    })
    expect(withCrd.all.map((q) => q.address)).not.toContain("4.1.CRD")
    expect(withCrd.all.map((q) => q.address)).not.toContain("4.1") // 容器永不进清单

    // ② aml-industry-term：**行业通用**缩写记在 L1 且 kind=行业通用 → 不要求用户定义
    const amlTerm: MemoryTerm = { ...CRD_MEMORY, term: "AML", kind: "行业通用" }
    const withAml = deriveQuestions(features, {
      slots: [],
      decls: CONTAINERS,
      candidates: { "4.1": ["AML"] },
      l1: [amlTerm],
    })
    expect(withAml.all.map((q) => q.address)).not.toContain("4.1.AML")
    // 但**没有**记忆时它仍会被问（不是无条件豁免）
    const noAmlMem = deriveQuestions(features, { slots: [], decls: CONTAINERS, candidates: { "4.1": ["AML"] } })
    expect(noAmlMem.all.map((q) => q.address)).toContain("4.1.AML")

    // ④ no-under-ask：等价性判据——同为单个候选，命中记忆者恰好少 1 项（不多不少）。
    // 这是「多一个=少问了可疑 / 少一个=漏问了回归」的可执行形态。
    const singleCrd = deriveQuestions(features, { slots: [], decls: CONTAINERS, candidates: { "4.1": ["CRD"] } })
    expect(singleCrd.all.length).toBe(BASELINE_OPEN_QUESTIONS.length + 1) // 基线 + 该候选
    expect(withCrd.all.length).toBe(BASELINE_OPEN_QUESTIONS.length) // 命中后回到基线规模
    expect(withCrd.l1Applied).toEqual(["4.1.CRD"])
  })

  test("覆盖率口径同源（kbGate 与 slotCoverage 出自同一分母）", () => {
    const slots = requiredSlots(features).map((address) => ({
      kind: "prose" as const,
      address,
      content: "x",
      source: "文档" as const,
      status: "confirmed" as const,
    }))
    const cov = slotCoverage(slots, features, CONTAINERS)
    const gate = kbGate(slots, features, { decls: CONTAINERS })
    expect(gate.coverage.leafFilled).toBe(cov.leafFilled)
    expect(gate.coverage.leafTotal).toBe(cov.leafTotal)
    expect(cov.pct).toBe(1)
  })
})

describe("验收 6 · 记忆不改变门禁判定（3.3.2 红线）", () => {
  test("★ 有无 sdlc 记忆，kbGate 结果完全一致", () => {
    const slots = requiredSlots(features).map((address) => ({
      kind: "prose" as const,
      address,
      content: "x",
      source: "文档" as const,
      status: "confirmed" as const,
    }))
    const noMem = kbGate(slots, features, { decls: CONTAINERS })
    const hits = matchMemory(materialOf(["信贷审批部 CRD 相关"]))
    const withMem = kbGate(slots, features, {
      decls: CONTAINERS,
      unclosed: deriveQuestions(features, { slots, decls: CONTAINERS, l1: hits.l1, l2: hits.l2 }).unclosed,
    })
    expect(withMem.pass).toBe(noMem.pass)
    expect(withMem.coverage).toEqual(noMem.coverage)
  })

  test("★ 冲突期望结构仍被 golden 声明（防止 golden 与实现脱钩）", () => {
    expect(CONFLICT_EXPECTATION.countsAsUnclosed).toBe(true)
    expect(CONFLICT_EXPECTATION.emptyRenderAddresses.length).toBeGreaterThan(0)
  })

  test("记忆写入只接受 restated/explicit（污染源被拒）", () => {
    const bad = writeL1Term("CRD", "错误定义", {
      kind: "内部简称",
      scope: "org",
      origin: "accepted_default",
      fromProject: "p",
    })
    expect(bad.ok).toBe(false)
  })
})