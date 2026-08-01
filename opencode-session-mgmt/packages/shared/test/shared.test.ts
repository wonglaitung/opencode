import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createWorkflowState,
  deepMerge,
  readIdentity,
  summarizeWorkflow,
  validateIdentity,
  writeIdentity,
  type Identity,
  type WorkflowState,
} from "../src/index"

describe("deepMerge", () => {
  test("只覆盖出现的键，保留其余", () => {
    const base: WorkflowState = createWorkflowState()
    const next = deepMerge(base, { quality: { acceptanceRate: 40 } })
    expect(next.quality.acceptanceRate).toBe(40)
    expect(next.quality.iterationCount).toBeNull()
    expect(next.stages.requirements.status).toBe("not_started")
  })

  test("数组整体替换", () => {
    const base = { list: [1, 2, 3] }
    const next = deepMerge(base, { list: [9] })
    expect(next.list).toEqual([9])
  })

  test("undefined 值不覆盖", () => {
    const base = { a: 1, b: 2 }
    const next = deepMerge(base, { a: undefined, b: 3 })
    expect(next.a).toBe(1)
    expect(next.b).toBe(3)
  })
})

describe("identity", () => {
  test("validateIdentity 拒绝空字段", () => {
    expect(validateIdentity({ account: "", group: "g", org: "o", collector_url: "u" }).length).toBeGreaterThan(0)
    expect(validateIdentity({ account: "a", group: "g", org: "o", collector_url: "u" })).toEqual([])
  })

  test("write 后 read 回环", () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-id-"))
    const path = join(dir, "identity.json")
    try {
      const identity: Identity = { account: "a@x.com", group: "前端组", org: "Eng", collector_url: "http://h:8787" }
      writeIdentity(identity, path)
      expect(readIdentity(path)).toEqual(identity)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("文件不存在返回 null", () => {
    expect(readIdentity(join(tmpdir(), "definitely-missing-sm.json"))).toBeNull()
  })
})

describe("summarizeWorkflow", () => {
  test("剥离代码相关内容，保留计数", () => {
    const state = createWorkflowState()
    state.stages.review.comprehension.push({
      codeSegmentId: "a.ts:1-2",
      file: "a.ts",
      lines: [1, 2],
      explanation: "秘密解释正文",
      developerConfirmed: true,
      confirmedAt: 123,
    })
    const summary = summarizeWorkflow(state)
    expect(summary.stages.review.comprehension).toEqual({ total: 1, confirmed: 1 })
    // 摘要不含 explanation 正文
    expect(JSON.stringify(summary)).not.toContain("秘密解释正文")
  })
})
