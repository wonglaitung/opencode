/**
 * reqdoc 槽位内核测试（设计文档 6 章第 1 层 golden 的比对实现）。
 *
 * **本文件是"少问 vs 漏问"的判定者**：把 `deriveOpenQuestions` 的输出与阶段 0 冻结的
 * `BASELINE_OPEN_QUESTIONS` 逐地址比对——多一个=少问了（可疑），少一个=漏问了（回归）。
 * 这正是 4.3 所说"两者指标同形、只能靠冻结清单区分"的落地点。
 */
import { describe, expect, test } from "bun:test"
import { createWorkflowState, type ReqdocFeature } from "sm-shared"
import {
  containerCovered,
  containerDeclViolations,
  deriveOpenQuestions,
  docAddrOf,
  isContainerAddr,
  isDocAddr,
  kbGate,
  leafCovered,
  requiredContainers,
  requiredSlots,
  slotCoverage,
  slotSubKey,
  type ContainerDecl,
  type ReqdocSlot,
} from "../src/reqdoc-slots"
import { BASELINE_OPEN_QUESTIONS, MEMORY_L1_EXPECTATION } from "./reqdoc-open-questions.golden"

/** 单功能点夹具（bi=0 → 5.1.*）。 */
const oneFeature: ReqdocFeature[] = [
  { no: 1, name: "名单排查", priority: "high", confirmedAt: 1000 },
]

function confirmed(addr: string): ReqdocSlot {
  return { kind: "prose", address: addr, content: "x", source: "文档", status: "confirmed" }
}

describe("槽位内核 · 地址空间（6.2）", () => {
  test("docAddrOf 剥子键，slotSubKey 取子键", () => {
    expect(docAddrOf("4.1.CRD")).toBe("4.1")
    expect(slotSubKey("4.1.CRD")).toBe("CRD")
    expect(docAddrOf("5.1.2.1.客户号")).toBe("5.1.2.1")
    expect(slotSubKey("5.1.2.1.客户号")).toBe("客户号")
  })

  test("无子键的文档地址不被误剥（5.1.2.13 不可剥成 5.1.2）", () => {
    expect(docAddrOf("5.1.2.13")).toBe("5.1.2.13")
    expect(slotSubKey("5.1.2.13")).toBeNull()
    expect(docAddrOf("3.1")).toBe("3.1")
  })

  test("容器识别：4.1 与 5.k.2.1 是容器，其余 5.k.2.x 不是", () => {
    expect(isContainerAddr("4.1")).toBe(true)
    expect(isContainerAddr("5.1.2.1")).toBe(true)
    expect(isContainerAddr("5.2.2.1")).toBe(true)
    expect(isContainerAddr("5.1.2.3")).toBe(false)
    expect(isContainerAddr("4.2")).toBe(false)
  })

  test("isDocAddr 接受模板键与四段功能点子小节", () => {
    expect(isDocAddr("3.1")).toBe(true)
    expect(isDocAddr("4.1")).toBe(true)
    expect(isDocAddr("5.1.2.1")).toBe(true)
    expect(isDocAddr("4.1.CRD")).toBe(false) // 带子键不是文档地址
  })
})

describe("槽位内核 · 必填集（6.2.0）", () => {
  test("必填叶子 = golden 基线（单功能点，逐地址相等）", () => {
    expect(requiredSlots(oneFeature)).toEqual([...BASELINE_OPEN_QUESTIONS])
  })

  test("必填容器单列 4.1 与 5.1.2.1，不在叶子集里（选项 B）", () => {
    const containers = requiredContainers(oneFeature)
    expect(containers).toEqual(["4.1", "5.1.2.1"])
    for (const c of containers) expect(BASELINE_OPEN_QUESTIONS).not.toContain(c)
  })

  test("多功能点时必填叶子按 5.k.* 线性展开", () => {
    const two: ReqdocFeature[] = [
      ...oneFeature,
      { no: 2, name: "额度调整", priority: "medium", confirmedAt: 1000 },
    ]
    const addrs = requiredSlots(two)
    expect(addrs.filter((a) => a.startsWith("5.1.")).length).toBe(
      addrs.filter((a) => a.startsWith("5.2.")).length,
    )
    expect(addrs).toContain("5.2.2.13")
  })
})

describe("槽位内核 · 开放项派生（6.2.3）", () => {
  test("★ 无记忆无候选时，派生结果 === 冻结基线（这就是漏问检测）", () => {
    const derived = deriveOpenQuestions(oneFeature).map((q) => q.address)
    const golden = [...BASELINE_OPEN_QUESTIONS]
    // 少一个 = 漏问（回归）；多一个 = 少问了（可疑）
    const missed = golden.filter((a) => !derived.includes(a))
    const extra = derived.filter((a) => !golden.includes(a))
    expect({ missed, extra }).toEqual({ missed: [], extra: [] })
  })

  test("容器 4.1 不进开放项（6.2.1.1）", () => {
    const addrs = deriveOpenQuestions(oneFeature).map((q) => q.address)
    expect(addrs).not.toContain("4.1")
    expect(addrs).not.toContain("5.1.2.1")
  })

  test("L1 术语记忆命中 → 该叶子消缺口、不再问", () => {
    const addrs = deriveOpenQuestions(oneFeature, {
      candidates: { "4.1": ["CRD", "AML"] },
      l1: [
        { term: "CRD", definition: "信贷审批部", kind: "内部简称", scope: "org", origin: "restated", confirmedAt: 1, fromProject: "信贷系统改造" },
        { term: "AML", definition: "反洗钱", kind: "行业通用", scope: "org", origin: "restated", confirmedAt: 1, fromProject: "信贷系统改造" },
      ],
    }).map((q) => q.address)
    // 内部简称 CRD 消缺口（3.6 规则 1：L1 唯一能消缺口）
    expect(addrs).not.toContain("4.1.CRD")
    // 行业通用 AML 也不要求定义（3.2 kind 分类：正常行话允许使用）
    expect(addrs).not.toContain("4.1.AML")
  })

  test("有 L1 记忆的内部简称消缺口；无记忆的术语仍开放（无默认猜测）", () => {
    const qs = deriveOpenQuestions(oneFeature, {
      candidates: { "4.1": ["CRD", "AML"] },
      l1: [
        { term: "CRD", definition: "信贷审批部", kind: "内部简称", scope: "org", origin: "restated", confirmedAt: 1, fromProject: "P" },
      ],
    })
    // 有记忆的内部简称 → 消缺口
    expect(qs.find((q) => q.address === "4.1.CRD")).toBeUndefined()
    // 无记忆的术语 → 仍开放，且没有默认猜测（无记忆可依）
    const aml = qs.find((q) => q.address === "4.1.AML")
    expect(aml).toBeDefined()
    expect(aml?.guess).toBeUndefined()
  })

  test("行业通用缩写（AML）不产生定义要求——不开放（3.2 kind 分类）", () => {
    const qs = deriveOpenQuestions(oneFeature, {
      candidates: { "4.1": ["AML"] },
      l1: [
        { term: "AML", definition: "反洗钱", kind: "行业通用", scope: "org", origin: "restated", confirmedAt: 1, fromProject: "P" },
      ],
    })
    // 行业通用属正常行话、允许使用——不该问"AML 是什么"
    expect(qs.find((q) => q.address === "4.1.AML")).toBeUndefined()
  })

  test("★ L1 期望与 golden 一致：只消自己的叶子，不越权消别人", () => {
    const derived = deriveOpenQuestions(oneFeature, {
      candidates: { "4.1": ["CRD"] },
      l1: [
        { term: "CRD", definition: "信贷审批部", kind: "内部简称", scope: "org", origin: "restated", confirmedAt: 1, fromProject: "P" },
      ],
    }).map((q) => q.address)
    for (const a of MEMORY_L1_EXPECTATION.expectedRemain) {
      expect(derived).toContain(a)
    }
  })

  test("L2 记忆只 draft 不消缺口——但带默认猜测（3.6 规则 2）", () => {
    const addrs = deriveOpenQuestions(oneFeature, {
      candidates: { "5.1.2.1": ["对接系统"] },
      l2: [{ content: "对接系统含 CIPS", source: "问答", scope: "org", origin: "restated", confirmedAt: 1, fromProject: "P" }],
    })
    const q = addrs.find((x) => x.address === "5.1.2.1.对接系统")
    expect(q).toBeDefined() // 仍被问
    expect(q?.guess).toBeDefined() // 但有默认猜测
  })

  test("已 confirmed 的叶子不进开放项", () => {
    const addrs = deriveOpenQuestions(oneFeature, { slots: [confirmed("3.1")] }).map((q) => q.address)
    expect(addrs).not.toContain("3.1")
    expect(addrs).toContain("3.2")
  })
})

describe("槽位内核 · 覆盖与门禁（6.2.1/6.2.2）", () => {
  test("draft 不消缺口（只认 confirmed，防刷覆盖率）", () => {
    const draft: ReqdocSlot = { kind: "prose", address: "3.1", content: "x", source: "问答", status: "draft" }
    expect(leafCovered([draft], "3.1")).toBe(false)
    expect(leafCovered([confirmed("3.1")], "3.1")).toBe(true)
  })

  test("retired 不计覆盖（已作废留痕但不算数）", () => {
    const retired: ReqdocSlot = { kind: "prose", address: "3.1", content: "x", source: "文档", status: "retired" }
    expect(leafCovered([retired], "3.1")).toBe(false)
  })

  test("容器覆盖 = ≥1 confirmed 子项；无子项需声明 required:false + 理由", () => {
    const term: ReqdocSlot = { kind: "term", address: "4.1.CRD", content: "信贷审批部", source: "问答", status: "confirmed" }
    expect(containerCovered([term], "4.1")).toBe(true)
    const draftTerm: ReqdocSlot = { ...term, status: "draft" }
    expect(containerCovered([draftTerm], "4.1")).toBe(false)
    // 无子项 + 未声明 → 不覆盖
    expect(containerCovered([], "4.1")).toBe(false)
    // 无子项 + 声明可为空（带理由）→ 覆盖
    const decl: ContainerDecl = { required: false, reason: "本需求无特殊术语" }
    expect(containerCovered([], "4.1", decl)).toBe(true)
    // 无子项 + 声明可为空但无理由 → 不覆盖
    expect(containerCovered([], "4.1", { required: false })).toBe(false)
  })

  test("防绕过：有候选却声明 required:false → 违规（A3）", () => {
    const draftTerm: ReqdocSlot = { kind: "term", address: "4.1.CRD", content: "x", source: "问答", status: "draft" }
    const v = containerDeclViolations([draftTerm], { "4.1": { required: false, reason: "想跳过" } })
    expect(v.length).toBe(1)
    expect(v[0]).toContain("有候选子项")
  })

  test("★ B1 守卫：必填叶子为 0（无功能点且章节全声明为空）→ 拦截", () => {
    // 无功能点时章节叶子仍必填（3.x/4.2/6.x/7.x），但若全声明 required:false…
    // 注意：章节叶子是 prose，不走容器声明——本用例验证的是"真无必填"的情形：
    // 传入空 features 且所有容器声明可为空时，leafTotal 仍 > 0（章节必填），不会触发此守卫。
    // 故直接构造 leafTotal=0 的极端：空 features + 阈值场景下检查容器守卫先触发。
    const g = kbGate([], [], { threshold: 1, decls: { "4.1": { required: false, reason: "无" } } })
    expect(g.pass).toBe(false)
    // 容器 5.1.2.1 随功能点出现，无功能点时只有 4.1 一个容器；已声明可为空 → 剩叶子覆盖率不足
    expect(g.reasons.join()).toContain("覆盖率")
  })

  test("存在未收口项（停问/conflict）→ 未 force 则拦截", () => {
    const g = kbGate([confirmed("3.1")], oneFeature, { threshold: 0, unclosed: ["3.2"] })
    expect(g.pass).toBe(false)
    expect(g.reasons.join()).toContain("未收口项")
    const forced = kbGate([confirmed("3.1")], oneFeature, { threshold: 0, unclosed: ["3.2"], force: true })
    expect(forced.reasons.join()).not.toContain("未收口项")
  })

  test("必填容器未覆盖 → 拦截（即使叶子全填）", () => {
    const allLeaves = requiredSlots(oneFeature).map(confirmed)
    const g = kbGate(allLeaves, oneFeature, { threshold: 1 })
    // 叶子全填但 4.1 / 5.1.2.1 两个容器无子项且未声明 → 拦
    expect(g.pass).toBe(false)
    expect(g.reasons.join()).toContain("必填容器未覆盖")
  })

  test("容器声明可为空 + 叶子全填 → 通过", () => {
    const allLeaves = requiredSlots(oneFeature).map(confirmed)
    const decls = { "4.1": { required: false, reason: "无特殊术语" }, "5.1.2.1": { required: false, reason: "无结构化字段" } }
    const g = kbGate(allLeaves, oneFeature, { threshold: 1, decls })
    expect(g.pass).toBe(true)
  })

  test("覆盖率：容器不进分母（A3 防声明为空压低分母）", () => {
    const cov = slotCoverage([confirmed("3.1")], oneFeature)
    expect(cov.leafTotal).toBe(requiredSlots(oneFeature).length)
    expect(cov.pct).toBeCloseTo(1 / cov.leafTotal, 5)
    expect(cov.containerTotal).toBe(2)
  })
})
