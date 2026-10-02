/**
 * golden 规格的**自洽性校验**：确保冻结清单不会与模板结构漂移（设计 4.4 陷阱警告）。
 *
 * `reqdoc-open-questions.golden.ts` 是从设计意图手工推导的冻结清单，绝不能变成
 * "跑一遍现实现录下来"——否则会把当前 bug 固化成基线。本测试守护两件事：
 * 1. **清单里每个地址都能在模板找到依据**（不是凭空写的地址）
 * 2. **模板里的必填项没有漏进清单**（新增必填字段时会被本测试抓住，强制同步 golden）
 *
 * 双向校验是"自证清单合理性"的可执行形态：能双向通过 = 清单确实从设计意图推导而来。
 *
 * 模板结构改由 `reqdoc-template-schema` 解析后，本测试的「schema 侧」从常量换成了
 * `requiredSlots(features)`——但**硬编码期望（章小节清单、必填数量）全部保留**。
 * 这很关键：若两侧都改成「问实现要答案」，本测试就退化成 `a === a` 的同义反复，
 * 什么也守不住。硬编码那两处正是防漂移的锚。
 */
import { describe, expect, test } from "bun:test"
import { requiredSlots, templateSchema } from "sm-shared"
import { BASELINE_OPEN_QUESTIONS } from "./reqdoc-open-questions.golden"

const schema = templateSchema()
if (!schema) throw new Error("模板不可读：本测试的前提是 docs/reqdoc-prd-template.md 存在")

/** 单功能点场景的应有开放项（由生产派生，与冻结清单逐地址比对）。 */
const derived = requiredSlots([{ no: 1, name: "甲", priority: "high", confirmedAt: 0 }])

/** 容器地址（按 6.2.1.1：容器永不进开放项清单，其叶子由候选清单派生）。 */
const containerAddrs = [...schema.chapterContainers, ...schema.featureContainerRels.map((r) => `5.1.${r}`)]

describe("开放项 golden 规格自洽性", () => {
  test("清单里每个地址都能在派生必填集里找到依据（无凭空地址）", () => {
    expect(BASELINE_OPEN_QUESTIONS.filter((a) => !derived.includes(a))).toEqual([])
  })

  test("派生必填集的每个地址都在清单里（无遗漏；模板增删必填项会抓住）", () => {
    expect(derived.filter((a) => !BASELINE_OPEN_QUESTIONS.includes(a))).toEqual([])
  })

  test("清单无重复（重复地址会让等价性比对的计数失真）", () => {
    expect(new Set(BASELINE_OPEN_QUESTIONS).size).toBe(BASELINE_OPEN_QUESTIONS.length)
  })

  // 以下三条是**硬编码锚点**，防模板或政策改动后 golden 静默失准。
  test("章内必填小节与冻结期望一致（防章节增删未同步）", () => {
    expect([...schema.docSectionAddrs]).toEqual([
      "3.1", "3.2", "3.3", "3.4", "3.5", "3.6",
      "4.2",
      "6.1", "6.2", "6.3", "6.4",
      "7.1", "7.2",
    ])
  })

  test("功能点必填叶子为 10 个（防政策增删未同步 golden）", () => {
    expect(schema.requiredSubRels).toHaveLength(10)
  })

  test("必填来源标注的子节为 10 个（比必填集多一个字段容器）", () => {
    expect(schema.taggedSubRels).toHaveLength(10)
  })

  test("模板解析零告警（章号唯一、功能点块同构、小节编号与章号相符）", () => {
    expect(schema.warnings).toEqual([])
  })

  test("容器地址不在基线开放项里（6.2.1.1）", () => {
    // 容器永不进开放项清单——这条规则曾与 golden 冲突（4.1 曾被误列入基线），
    // 故显式固化断言，防回归。
    for (const c of containerAddrs) {
      expect(BASELINE_OPEN_QUESTIONS).not.toContain(c)
    }
    // 反向确认：容器确实存在于模板结构中（否则上面这条就是空断言）。
    expect(containerAddrs).toEqual(["4.1", "5.1.2.1"])
  })
})