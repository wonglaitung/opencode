/**
 * reqdoc PRD 组装测试（设计文档 6.2.1.2 空内容渲染规则 + 第 2 层 golden：组装幂等）。
 *
 * 核心验证两条：
 * 1. **幂等**：同样的槽位 → 同样的文档与摘要（文档是纯投影）
 * 2. **空内容渲染**：留空标题+空正文，不写占位文字；映射字段空也须带来源标签；
 *    全空且 `required:false` 的容器整节省略
 */
import { describe, expect, test } from "bun:test"
import { assembleDoc, kbDigest, verifyAssemble } from "../src/reqdoc-assemble"
import { loadReqdocTemplate } from "../../plugin/src/template"
import { requiredSlots, type ContainerDecl, type ReqdocSlot } from "../src/reqdoc-slots"
import type { ReqdocFeature } from "../src/workflow"

const feature: ReqdocFeature[] = [{ no: 1, name: "名单排查", priority: "high", confirmedAt: 1000 }]
const template = loadReqdocTemplate()

function fill(addr: string, content: string, over: Partial<ReqdocSlot> = {}): ReqdocSlot {
  return { kind: "prose", address: addr, content, source: "文档", status: "confirmed", ...over }
}

/** 把全部必填叶子填满（confirmed/文档）。 */
function allLeavesFilled(extra: ReqdocSlot[] = []): ReqdocSlot[] {
  return [...requiredSlots(feature).map((a) => fill(a, `${a} 的内容`)), ...extra]
}

/** 容器声明：默认把两个容器都声明为"可为空"（基线无术语/字段）。 */
const EMPTY_CONTAINERS: Record<string, ContainerDecl> = {
  "4.1": { required: false, reason: "本需求无特殊术语" },
  "5.1.2.1": { required: false, reason: "无结构化字段" },
}

describe("组装 · 基本投影", () => {
  test("槽位填满 → 组装出完整文档，章节骨架来自模板", () => {
    const r = assembleDoc(allLeavesFilled(), feature, template, { containers: EMPTY_CONTAINERS })
    expect(r).not.toBeNull()
    // 第三章标题在
    expect(r!.md).toContain("第三章")
    // 功能点块渲染出名称与编号
    expect(r!.md).toContain("名单排查")
    // 填入的内容出现在正文里
    expect(r!.md).toContain("3.1 的内容")
  })

  test("模板缺失 → 返回 null（退 write 内联骨架，工具层兜底）", () => {
    expect(assembleDoc(allLeavesFilled(), feature, null)).toBeNull()
  })

  test("功能点为空 → buildPrdSkeleton 要求至少一个功能点，返回 null", () => {
    expect(assembleDoc([], [], template)).toBeNull()
  })
})

describe("组装 · 幂等与摘要（6.2.1.2 / 9.3）", () => {
  test("★ 同样槽位 → 同样摘要与结构指纹", () => {
    const a = assembleDoc(allLeavesFilled(), feature, template, { containers: EMPTY_CONTAINERS })!
    const b = assembleDoc(allLeavesFilled(), feature, template, { containers: EMPTY_CONTAINERS })!
    expect(a.digest).toBe(b.digest)
    expect(a.fingerprint).toEqual(b.fingerprint)
  })

  test("★ 槽位内容改动 → 摘要变化（可检出文档过期）", () => {
    const before = kbDigest(allLeavesFilled())
    const after = kbDigest(allLeavesFilled([fill("3.1", "改了内容")]).map((s) =>
      s.address === "3.1" ? fill("3.1", "改了内容") : s,
    ))
    expect(after).not.toBe(before)
  })

  test("retired 槽位不参与摘要", () => {
    const a = kbDigest([fill("3.1", "x")])
    const b = kbDigest([fill("3.1", "x"), fill("3.2", "y", { status: "retired" })])
    expect(a).toBe(b)
  })

  test("verifyAssemble 三分支：一致 / 过期 / 手改", () => {
    const slots = allLeavesFilled()
    const d0 = kbDigest(slots)
    // 一致
    expect(verifyAssemble(slots, d0, d0)).toBe("consistent")
    // 槽位变了 → 产物过期（stale）
    const changed = [...slots, fill("3.1", "改了")]
    expect(verifyAssemble(changed, d0, d0)).toBe("stale")
    // 槽位没变但摘要对不上（文档被手改/记录损坏）→ tampered
    expect(verifyAssemble(slots, "deadbeefdeadbeef", d0)).toBe("tampered")
  })
})

describe("组装 · 空内容渲染规则（6.2.1.2）", () => {
  test("★ 槽位为空 → 留空标题 + 空正文，不写占位文字", () => {
    // 只填一半，3.1 空
    const slots = requiredSlots(feature).filter((a) => a !== "3.1").map((a) => fill(a, `${a} 内容`))
    const r = assembleDoc(slots, feature, template, { containers: EMPTY_CONTAINERS })!
    // 3.1 标题仍在（骨架不变）
    expect(r.md).toContain("3.1")
    // 不得出现占位文字
    expect(r.md).not.toContain("（未填写）")
    expect(r.md).not.toContain("待补充")
    expect(r.md).not.toContain("TBD")
    // 空节带缺省标签
    expect(r.fingerprint.tags["3.1"]).toContain("缺省")
  })

  test("★ 映射字段为空也须带来源标签（不能无标签）", () => {
    const slots = requiredSlots(feature)
      .filter((a) => a !== "5.1.2.13") // 流程图是映射字段，留空
      .map((a) => fill(a, `${a} 内容`))
    const r = assembleDoc(slots, feature, template, { containers: EMPTY_CONTAINERS })!
    const tag = r.fingerprint.tags["5.1.2.13"]
    expect(tag).toBeTruthy()
    expect(tag).toContain("缺省")
  })

  test("全空且 required:false 的容器 → 整节省略，不渲染标题", () => {
    const r = assembleDoc(allLeavesFilled(), feature, template, { containers: EMPTY_CONTAINERS })!
    expect(r.omittedContainers).toEqual(["4.1", "5.1.2.1"])
    // 容器子键不在结构指纹里（整节被略）
    expect(r.fingerprint.subSections).not.toContain("4.1")
    expect(r.fingerprint.subSections).not.toContain("5.1.2.1")
  })

  test("容器有子项 → 渲染聚合视图（术语表 / 字段清单）", () => {
    const terms = [
      { kind: "term" as const, address: "4.1.CRD", content: "信贷审批部", source: "问答" as const, status: "confirmed" as const },
      { kind: "term" as const, address: "4.1.AML", content: "反洗钱", source: "文档" as const, status: "confirmed" as const },
    ]
    const r = assembleDoc(allLeavesFilled(terms), feature, template, { containers: {} })!
    expect(r.md).toContain("- **CRD**：信贷审批部")
    expect(r.md).toContain("- **AML**：反洗钱")
    expect(r.omittedContainers).toEqual([])
  })

  test("★ 容器内含缺省子项 → 整节标签取最弱档（不得标 [文档]）", () => {
    const terms = [
      { kind: "term" as const, address: "4.1.CRD", content: "信贷审批部", source: "问答" as const, status: "confirmed" as const },
      { kind: "term" as const, address: "4.1.EMA", content: "新兴市场部", source: "缺省" as const, status: "confirmed" as const, reason: "本需求无该机构" },
    ]
    const r = assembleDoc(allLeavesFilled(terms), feature, template, { containers: {} })!
    expect(r.fingerprint.tags["4.1"]).toBe("[缺省：本需求无该机构]")
    expect(r.fingerprint.tags["4.1"]).not.toBe("[文档]")
  })
})

describe("组装 · 结构指纹（第 2 层 golden 比对基准）", () => {
  test("指纹含章节顺序、功能点数、子小节地址、标签", () => {
    const r = assembleDoc(allLeavesFilled(), feature, template, { containers: EMPTY_CONTAINERS })!
    expect(r.fingerprint.featureCount).toBe(1)
    expect(r.fingerprint.chapters.length).toBeGreaterThan(4)
    expect(r.fingerprint.subSections).toContain("3.1")
    expect(r.fingerprint.subSections).toContain("5.1.2.13")
    expect(Object.keys(r.fingerprint.tags).length).toBeGreaterThan(10)
  })

  test("★ 指纹不含正文文字（内容可变、结构不可变——比对只比结构）", () => {
    const a = assembleDoc(allLeavesFilled(), feature, template, { containers: EMPTY_CONTAINERS })!
    const slots2 = allLeavesFilled().map((s) => fill(s.address, "完全不同但结构相同的内容"))
    const b = assembleDoc(slots2, feature, template, { containers: EMPTY_CONTAINERS })!
    expect(a.fingerprint).toEqual(b.fingerprint)
    expect(a.md).not.toBe(b.md) // 正文确实变了
  })
})