import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createWorkflowState,
  deepMerge,
  efficiencyRatio,
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
    const next = deepMerge(base, { quality: { firstPassRate: 40 } })
    expect(next.quality.firstPassRate).toBe(40)
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
      decision: "accepted",
      developerConfirmed: true,
      confirmedAt: 123,
      feedback: null,
      rejectedAt: null,
      rewrites: 0,
      resolution: null,
    })
    // 本机库记录按文件的迭代计数（键为文件路径）
    state.quality.iterationByFile = { "secret/path/a.ts": 3 }
    state.quality.iterationCount = 3
    const summary = summarizeWorkflow(state)
    expect(summary.stages.review.comprehension).toEqual({ total: 1, confirmed: 1 })
    // 摘要不含 explanation 正文
    expect(JSON.stringify(summary)).not.toContain("秘密解释正文")
    // 质量投影保留 iterationCount，但剔除 iterationByFile（文件路径不外传，12）
    expect(summary.quality.iterationCount).toBe(3)
    expect(JSON.stringify(summary.quality)).not.toContain("iterationByFile")
    expect(JSON.stringify(summary)).not.toContain("secret/path/a.ts")
  })

  test("行数只上行三分类聚合，linesByFile 文件路径不外传（3.2、12）", () => {
    const state = createWorkflowState()
    state.quality.linesByFile = { "secret/path/a.ts": 10, "secret/path/a.test.ts": -3, "c.json": 2 }
    const summary = summarizeWorkflow(state)
    // 负值逐文件 clamp ≥0：测试类 -3 → 0
    expect(summary.quality.lines).toEqual({ business: 10, test: 0, config: 2 })
    expect(JSON.stringify(summary)).not.toContain("secret/path")
    expect(JSON.stringify(summary.quality)).not.toContain("linesByFile")
  })

  test("无 AI 代码编辑时行数为 null", () => {
    const summary = summarizeWorkflow(createWorkflowState())
    expect(summary.quality.lines).toBeNull()
  })

  test("基线已录入时随摘要上行（6.3）", () => {
    const state = createWorkflowState()
    state.baseline = { estimatedHours: 8, setAt: 1750000000000 }
    const summary = summarizeWorkflow(state)
    expect(summary.baseline).toEqual({ estimatedHours: 8, setAt: 1750000000000 })
  })

  test("未录入基线时为 null（向后兼容）", () => {
    const summary = summarizeWorkflow(createWorkflowState())
    expect(summary.baseline).toBeNull()
  })
})

describe("efficiencyRatio（AI 提效率，6.3）", () => {
  test("（预估 − 实际）÷ 预估", () => {
    // 预估 8h、实际 1.7h → (8−1.7)/8 = 0.7875
    expect(efficiencyRatio(8, 1.7 * 3_600_000)).toBeCloseTo(0.7875)
    // 预估与实际相等 → 提效 0
    expect(efficiencyRatio(4, 4 * 3_600_000)).toBeCloseTo(0)
  })

  test("实际超过预估时为负（仅展示，不 clamp）", () => {
    // 预估 2h、实际 3h → (2−3)/2 = −0.5
    expect(efficiencyRatio(2, 3 * 3_600_000)).toBeCloseTo(-0.5)
  })

  test("无基线或无有效周期返回 null（展示 N/A）", () => {
    expect(efficiencyRatio(null, 3_600_000)).toBeNull()
    expect(efficiencyRatio(undefined, 3_600_000)).toBeNull()
    expect(efficiencyRatio(0, 3_600_000)).toBeNull()
    expect(efficiencyRatio(-1, 3_600_000)).toBeNull()
    expect(efficiencyRatio(8, 0)).toBeNull()
    expect(efficiencyRatio(8, -5)).toBeNull()
  })
})
