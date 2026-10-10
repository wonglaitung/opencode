/**
 * 定点修订（乙）章作用域纯函数测试：chapterOf / slotsByChapter / resolveChapterLabel /
 * crossChapterImpact / chapterRetireRatio / chapterDiff / deriveQuestions({chapter})。
 * 对照实现见 docs/reqdoc-scoped-edit.md。
 */
import { describe, expect, test } from "bun:test"
import {
  chapterClearRatio,
  chapterDiff,
  chapterOf,
  chapterRetireRatio,
  crossChapterImpact,
  deriveQuestions,
  resolveChapterLabel,
  slotsByChapter,
  type ReqdocSlot,
} from "../src/reqdoc-slots"
import { templateSchemaOrEmpty } from "../src/reqdoc-template-schema"
import type { ReqdocFeature } from "../src/workflow"

const schema = templateSchemaOrEmpty()
const oneFeature: ReqdocFeature[] = [{ no: 1, name: "名单排查", priority: "high", confirmedAt: 1 }]

function slot(addr: string, over: Partial<ReqdocSlot> = {}): ReqdocSlot {
  return { kind: "prose", address: addr, content: "x", source: "文档", status: "confirmed", ...over }
}

describe("定点修订 · 章作用域纯函数", () => {
  test("chapterOf 取首段数字", () => {
    expect(chapterOf("4.1.CRD")).toBe(4)
    expect(chapterOf("5.1.2.1.客户号")).toBe(5)
    expect(chapterOf("3.1")).toBe(3)
    expect(chapterOf("9.9")).toBe(9)
  })

  test("slotsByChapter 按章过滤", () => {
    const slots = [slot("3.1"), slot("3.2"), slot("4.1.CRD", { kind: "term" }), slot("5.1.2.1.客户号", { kind: "field" })]
    expect(slotsByChapter(slots, 3).map((s) => s.address)).toEqual(["3.1", "3.2"])
    expect(slotsByChapter(slots, 4).map((s) => s.address)).toEqual(["4.1.CRD"])
  })

  test("resolveChapterLabel 数字/标题/未知", () => {
    expect(resolveChapterLabel("第2章", schema)).toBe(2)
    expect(resolveChapterLabel("术语定义与业务规则", schema)).toBe(4)
    expect(resolveChapterLabel("需求概述", schema)).toBe(3)
    expect(resolveChapterLabel("第9章", schema)).toBeNull()
    expect(resolveChapterLabel("不存在的章zzz", schema)).toBeNull()
  })

  test("crossChapterImpact 列出被他章引用的术语", () => {
    const slots = [
      slot("4.1.CRD", { kind: "term", content: "客户尽调标识" }),
      slot("3.1", { content: "本流程使用 CRD 做客户尽调" }),
      slot("5.1.2.1.客户号", { kind: "field", content: "客户号" }),
    ]
    const impact = crossChapterImpact(slots, 4, schema)
    expect(impact.some((x) => x.includes("CRD") && x.includes("3.1"))).toBe(true)
    // 编辑术语章时，功能点章内的字段不应误报
    expect(impact.some((x) => x.includes("客户号"))).toBe(false)
  })

  test("chapterRetireRatio 含拟 retire", () => {
    const slots = [slot("3.1"), slot("3.2"), slot("3.3", { status: "retired" })]
    expect(chapterRetireRatio(slots, 3)).toBeCloseTo(1 / 3)
    expect(chapterRetireRatio(slots, 3, ["3.2"])).toBeCloseTo(2 / 3)
  })

  test("chapterClearRatio 含拟写空（对抗 F：空内容与退役同权）", () => {
    const slots = [slot("3.1"), slot("3.2"), slot("3.3", { content: "  " })]
    expect(chapterClearRatio(slots, 3)).toBeCloseTo(1 / 3)
    expect(chapterClearRatio(slots, 3, ["3.2"])).toBeCloseTo(2 / 3)
    // 已空的地址重复提议不双计；他章地址不计入
    expect(chapterClearRatio(slots, 3, ["3.3", "4.1"])).toBeCloseTo(1 / 3)
    // 已退役槽位不进分母（退役占比归 confirmRetire 管，不重复计）
    const withRetired = [...slots, slot("3.4", { status: "retired", content: "" })]
    expect(chapterClearRatio(withRetired, 3)).toBeCloseTo(1 / 3)
  })

  test("chapterDiff 地址级增改删", () => {
    const before = [slot("3.1"), slot("3.2")]
    const after = [
      slot("3.1", { content: "改了" }),
      slot("3.2", { status: "retired" }),
      slot("3.3"),
    ]
    const d = chapterDiff(before, after, 3)
    expect(d.added).toEqual(["3.3"])
    expect(d.changed).toEqual(["3.1"])
    expect(d.removed).toEqual(["3.2"])
  })

  test("deriveQuestions({chapter}) 只出该章开放项", () => {
    const all = deriveQuestions(oneFeature, { slots: [], schema })
    expect(all.all.some((q) => chapterOf(q.address) !== 3)).toBe(true)
    const scoped = deriveQuestions(oneFeature, { slots: [], schema, chapter: 3 })
    for (const q of scoped.all) expect(chapterOf(q.address)).toBe(3)
    expect(scoped.all.length).toBeGreaterThan(0)
  })
})
