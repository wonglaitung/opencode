/**
 * reqdoc 记忆内核测试（设计文档 3 章第 1 层 golden）。
 *
 * 覆盖三条纪律的机器化：静默接受不入库（3.5）、代码语境不入 L1（3.3.1）、
 * 只有 L1 能消缺口（3.6）；以及聚合最弱档（6.2.2）、停问收敛（6.3）、
 * 冲突两侧都不装（6.4）、遗忘引用检查（A6）。
 */
import { describe, expect, test } from "bun:test"
import {
  adjudicateConflict,
  aggregateSourceTag,
  applyStopAsking,
  decideL1Write,
  decideL4Write,
  detectSlotConflict,
  detectTermConflict,
  forgettingImpact,
  matchL1ByMaterial,
  mergeL1Terms,
  slugForTerm,
  type L1Term,
} from "../src/reqdoc-kb"
import type { ReqdocSlot } from "../src/reqdoc-slots"

function term(over: Partial<L1Term> = {}): L1Term {
  return {
    term: "CRD",
    definition: "信贷审批部",
    kind: "内部简称",
    scope: "org",
    origin: "restated",
    originContext: "business",
    fromProject: "信贷系统改造",
    confirmedAt: 1000,
    ...over,
  }
}

describe("记忆 · 写入决策（3.5 静默接受不入库）", () => {
  test("业务点了默认 → 不写", () => {
    const d = decideL1Write({ kind: "内部简称", origin: "accepted_default", originContext: "business" })
    expect(d.action).toBe("skip")
    expect(d.reason).toContain("静默接受")
  })

  test("业务复述/明说 → 写", () => {
    expect(decideL1Write({ kind: "内部简称", origin: "restated", originContext: "business" }).action).toBe("write")
    expect(decideL1Write({ kind: "内部简称", origin: "explicit", originContext: "business" }).action).toBe("write")
  })

  test("★ 纯代码标识符语境 → 不入 L1（3.3.1 k8s CRD 污染防线）", () => {
    const d = decideL1Write({ kind: "系统口径", origin: "restated", originContext: "code" })
    expect(d.action).toBe("skip")
    expect(d.reason).toContain("代码标识符")
  })

  test("inferred 不足以支撑 L1（需复述或明说）", () => {
    expect(decideL1Write({ kind: "内部简称", origin: "inferred", originContext: "business" }).action).toBe("skip")
  })

  test("负向偏好显式陈述即写", () => {
    expect(decideL4Write({ origin: "explicit" }).action).toBe("write")
    expect(decideL4Write({ origin: "accepted_default" }).action).toBe("skip")
  })
})

describe("记忆 · 同名不同义（3.3.1 不静默覆盖）", () => {
  test("术语相同释义不同 → 冲突", () => {
    const r = detectTermConflict([term()], { term: "CRD", definition: "授信管理部", kind: "内部简称" })
    expect(r.conflict).toBe("same-term-different-definition")
  })

  test("术语相同释义一致 → 无冲突（幂等）", () => {
    const r = detectTermConflict([term()], { term: "CRD", definition: "信贷审批部", kind: "内部简称" })
    expect(r.conflict).toBe("none")
  })

  test("已 retired 的同名术语不算冲突（遗忘后重新学习）", () => {
    const r = detectTermConflict([term({ retired: true })], { term: "CRD", definition: "授信管理部", kind: "内部简称" })
    expect(r.conflict).toBe("none")
  })

  test("★ 合并：冲突不覆盖，两条并存待裁决", () => {
    const { terms, pendingAdjudication } = mergeL1Terms(
      [term()],
      [term({ definition: "授信管理部", origin: "restated" })],
    )
    expect(terms.length).toBe(2) // 并存
    expect(pendingAdjudication.length).toBe(1)
    // 新条目被标 inferred 表明未经确认
    expect(terms[1]!.origin).toBe("inferred")
  })

  test("合并：无冲突时幂等，不产生重复", () => {
    const { terms, pendingAdjudication } = mergeL1Terms([term()], [term()])
    expect(terms.length).toBe(1)
    expect(pendingAdjudication.length).toBe(0)
  })
})

describe("记忆 · 材料驱动匹配（3.6 / 7.1 封顶保证）", () => {
  const terms = [
    term({ term: "CRD", kind: "内部简称" }),
    term({ term: "AML", kind: "行业通用", definition: "反洗钱" }),
  ]

  test("材料含 CRD → 命中且要求定义（内部简称）", () => {
    const hits = matchL1ByMaterial("本需求涉及 CRD 审批流程", terms)
    const crd = hits.find((h) => h.hit.term === "CRD")
    expect(crd?.requiresDefinition).toBe(true)
  })

  test("★ 材料含 AML → 命中但不要求定义（行业通用属正常行话）", () => {
    const hits = matchL1ByMaterial("需满足 AML 合规要求", terms)
    const aml = hits.find((h) => h.hit.term === "AML")
    expect(aml?.requiresDefinition).toBe(false)
  })

  test("材料不含 → 不命中（这是封顶保证：注入的只是材料出现过的）", () => {
    expect(matchL1ByMaterial("与本术语无关的文本", terms)).toEqual([])
  })

  test("英文缩写按词边界匹配，不嵌在更长单词里", () => {
    expect(matchL1ByMaterial("MICRODISTRIBUTION", [term({ term: "CRD" })])).toEqual([])
    expect(matchL1ByMaterial("提交 CRD 申请", [term({ term: "CRD" })])).toHaveLength(1)
  })

  test("retired 记忆不参与匹配", () => {
    expect(matchL1ByMaterial("涉及 CRD", [term({ retired: true })])).toEqual([])
  })
})

describe("记忆 · 聚合来源标签取最弱档（6.2.2）", () => {
  test("全部文档 → [文档]", () => {
    const t = aggregateSourceTag([
      { source: "文档", status: "confirmed" },
      { source: "文档", status: "confirmed" },
    ])
    expect(t.tag).toBe("[文档]")
  })

  test("★ 有任一缺省 → 整节不得标 [文档]（Option A 保证不被绕过）", () => {
    const t = aggregateSourceTag([
      { source: "文档", status: "confirmed" },
      { source: "缺省", reason: "未涉及清算", status: "confirmed" },
    ])
    expect(t.tag).toBe("[缺省：未涉及清算]")
  })

  test("问答与文档混合 → 取最弱的问答", () => {
    expect(aggregateSourceTag([{ source: "文档", status: "confirmed" }, { source: "问答", status: "confirmed" }]).tag).toBe("[问答]")
  })

  test("缺省无理由 → 裸 [缺省]（触发完整性门禁）", () => {
    expect(aggregateSourceTag([{ source: "缺省", status: "confirmed" }]).tag).toBe("[缺省]")
  })

  test("retired 子项不参与聚合", () => {
    expect(aggregateSourceTag([{ source: "缺省", status: "retired" }, { source: "文档", status: "confirmed" }]).tag).toBe("[文档]")
  })

  test("全空 → 缺省无内容", () => {
    expect(aggregateSourceTag([]).tag).toBe("[缺省：无内容]")
  })
})

describe("记忆 · 停问收敛（6.3）", () => {
  const draft: ReqdocSlot = { kind: "term", address: "4.1.CRD", content: "信贷审批部", source: "问答", status: "draft" }

  test("★ 有 draft → 强制转缺省并写明记忆来源与日期", () => {
    const s = applyStopAsking(draft, { memoryFrom: { fromProject: "信贷系统改造", confirmedAt: 1756500000000 } })
    expect(s.source).toBe("缺省")
    expect(s.reason).toContain("业务未确认")
    expect(s.reason).toContain("信贷系统改造")
    // 内容保留（组织知识不丢弃），但诚实标注未确认
    expect(s.content).toBe("信贷审批部")
  })

  test("无 draft 依据 → 理由仅标未确认", () => {
    const s = applyStopAsking(draft, {})
    expect(s.reason).toBe("业务未确认")
  })
})

describe("记忆 · 冲突裁决（6.4 两侧都不装）", () => {
  const slot: ReqdocSlot = { kind: "term", address: "4.1.CRD", content: "", source: "问答", status: "draft" }

  test("★ 检出冲突 → status=conflict 且 content 为空（两侧都不装）", () => {
    const s = detectSlotConflict({ slot, memoryContent: "信贷审批部", materialContent: "授信管理部" })
    expect(s.status).toBe("conflict")
    expect(s.content).toBe("")
    expect(s.conflict?.memory).toBe("信贷审批部")
    expect(s.conflict?.material).toBe("授信管理部")
  })

  test("两侧一致 → 不算冲突", () => {
    const s = detectSlotConflict({ slot, memoryContent: "信贷审批部", materialContent: "信贷审批部" })
    expect(s.status).toBe("draft")
  })

  test("采纳材料 → confirmed/文档 + 记忆待重写", () => {
    const c = detectSlotConflict({ slot, memoryContent: "信贷审批部", materialContent: "授信管理部" })
    const r = adjudicateConflict(c, "take-material")
    expect(r.slot.status).toBe("confirmed")
    expect(r.slot.source).toBe("文档")
    expect(r.slot.content).toBe("授信管理部")
    expect(r.memoryUpdate).toBe("rewrite-with-material")
  })

  test("采纳记忆 → confirmed/问答 + 记忆保留", () => {
    const c = detectSlotConflict({ slot, memoryContent: "信贷审批部", materialContent: "授信管理部" })
    const r = adjudicateConflict(c, "take-memory")
    expect(r.slot.source).toBe("问答")
    expect(r.slot.content).toBe("信贷审批部")
    expect(r.memoryUpdate).toBe("keep")
  })

  test("★ defer（force 放行）→ 内容仍空（force 不能解决 conflict，6.5）", () => {
    const c = detectSlotConflict({ slot, memoryContent: "信贷审批部", materialContent: "授信管理部" })
    const r = adjudicateConflict(c, "defer")
    expect(r.slot.content).toBe("")
    expect(r.slot.status).toBe("conflict")
  })
})

describe("记忆 · 遗忘引用检查（A6）", () => {
  const slots: ReqdocSlot[] = [
    { kind: "term", address: "4.1.CRD", content: "信贷审批部", source: "问答", status: "confirmed", ref: "CRD" },
  ]

  test("未完成项目引用该记忆 → 需用户决策", () => {
    const r = forgettingImpact(term(), slots, { projectFinalized: false })
    expect(r.affectedSlots).toEqual(["4.1.CRD"])
    expect(r.needsDecision).toBe(true)
  })

  test("项目已定稿 → 无需决策", () => {
    expect(forgettingImpact(term(), slots, { projectFinalized: true }).needsDecision).toBe(false)
  })

  test("无引用 → 无需决策", () => {
    expect(forgettingImpact(term(), [], { projectFinalized: false }).needsDecision).toBe(false)
  })
})

describe("记忆 · 文件名规范化（B8）", () => {
  test("中文与括号保留，非法字符替换", () => {
    expect(slugForTerm("信贷审批部（CRD）")).toBe("信贷审批部（CRD）")
    expect(slugForTerm("A/B")).toBe("A_B")
  })

  test("Windows 设备名加后缀（避免无法创建文件）", () => {
    expect(slugForTerm("CON")).toBe("CON_")
    expect(slugForTerm("nul")).toBe("nul_")
  })

  test("空串与超长兜底", () => {
    expect(slugForTerm("")).toBe("_")
    expect(slugForTerm("   ")).toBe("_")
    expect(slugForTerm("x".repeat(200)).length).toBe(60)
  })
})
