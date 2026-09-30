/**
 * golden 规格的**自洽性校验**：确保冻结清单不会与模板 schema 漂移（设计 4.4 陷阱警告）。
 *
 * `reqdoc-open-questions.golden.ts` 是从设计意图手工推导的冻结清单，绝不能变成
 * "跑一遍现实现录下来"——否则会把当前 bug 固化成基线。本测试守护两件事：
 * 1. **清单里每个地址都能在 schema 找到依据**（不是凭空写的地址）
 * 2. **schema 里的必填项没有漏进清单**（新增必填字段时会被本测试抓住，强制同步 golden）
 *
 * 双向校验是"自证清单合理性"的可执行形态：能双向通过 = 清单确实从设计意图推导而来。
 */
import { describe, expect, test } from "bun:test"
import { MAPPED_FIELD_KEYS, REQDOC_TEMPLATE_CHAPTERS } from "sm-shared"
import { BASELINE_OPEN_QUESTIONS } from "./reqdoc-open-questions.golden"

/** 章节级必填：非 meta 章的 sections[] 全必填。 */
const chapterSections: string[] = []
for (const c of REQDOC_TEMPLATE_CHAPTERS) {
  if (c.meta) continue
  for (const s of c.sections ?? []) chapterSections.push(s.key)
}

/** 功能点必填：简要概述 + 控制要求 + 10 个映射字段（逐功能点展开，此处取首块 5.1.*）。 */
const featureBlockSlots = ["5.1.1.1", "5.1.1.2", ...MAPPED_FIELD_KEYS.map((k) => `5.1.2.${k.split(".")[1]}`)]

/** 应有必填集（章节 + 单功能点块）。 */
const requiredSet = new Set([...chapterSections, ...featureBlockSlots])

describe("开放项 golden 规格自洽性", () => {
  test("清单里每个地址都能在模板 schema 找到依据（无凭空地址）", () => {
    const unjustified = BASELINE_OPEN_QUESTIONS.filter((a) => !requiredSet.has(a))
    expect(unjustified).toEqual([])
  })

  test("schema 的每个必填项都在清单里（无遗漏；新增必填字段会抓住）", () => {
    const missing = [...requiredSet].filter((a) => !BASELINE_OPEN_QUESTIONS.includes(a))
    expect(missing).toEqual([])
  })

  test("清单无重复（重复地址会让等价性比对的计数失真）", () => {
    const seen = new Set(BASELINE_OPEN_QUESTIONS)
    expect(seen.size).toBe(BASELINE_OPEN_QUESTIONS.length)
  })

  test("章节必填集与 schema 同步（防 meta 章/章节增删未同步）", () => {
    // 固定期望，防止 REQDOC_TEMPLATE_CHAPTERS 改动后 golden 静默失准
    expect(chapterSections).toEqual(["3.1","3.2","3.3","3.4","3.5","3.6","4.1","4.2","6.1","6.2","6.3","6.4","7.1","7.2"])
  })

  test("映射字段必填集为 10 个（防 MAPPED_FIELD_KEYS 增减未同步 golden）", () => {
    expect(MAPPED_FIELD_KEYS.length).toBe(10)
  })
})
