import { afterEach, describe, expect, test, vi } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  REQDOC,
  REQDOC_SCORE_DIMS,
  REQDOC_SCORE_PASS,
  SDLC,
  WORKFLOW_DEFINITIONS,
  createWorkflowState,
  currentInProgressStage,
  deepMerge,
  efficiencyRatio,
  getDefinition,
  getStage,
  readIdentity,
  reqdocScoreRubric,
  resolveWorkflowType,
  reviewRecord,
  rulesForStage,
  summarizeWorkflow,
  validateIdentity,
  writeIdentity,
  type Identity,
  type WorkflowState,
} from "../src/index"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("deepMerge", () => {
  test("只覆盖出现的键，保留其余", () => {
    const base: WorkflowState = createWorkflowState("sdlc")
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

  test("write 后 read 回环（缺省 workflowType 补 sdlc）", () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-id-"))
    const path = join(dir, "identity.json")
    try {
      const identity: Identity = { account: "a@x.com", group: "前端组", org: "Eng", collector_url: "http://h:8787" }
      writeIdentity(identity, path)
      expect(readIdentity(path)).toEqual({ ...identity, workflowType: "sdlc" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("write 显式 workflowType 后回环", () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-id-"))
    const path = join(dir, "identity.json")
    try {
      const identity: Identity = { account: "a@x.com", group: "前端组", org: "Eng", collector_url: "http://h:8787", workflowType: "sdlc" }
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
    const state = createWorkflowState("sdlc")
    reviewRecord(state).comprehension.push({
      id: "a.ts:1-2",
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
    expect((summary.stages.review as { comprehension: { total: number; confirmed: number } }).comprehension).toEqual({
      total: 1,
      confirmed: 1,
    })
    // 摘要不含 explanation 正文
    expect(JSON.stringify(summary)).not.toContain("秘密解释正文")
    // 质量投影保留 iterationCount，但剔除 iterationByFile（文件路径不外传，12）
    expect(summary.quality.iterationCount).toBe(3)
    expect(JSON.stringify(summary.quality)).not.toContain("iterationByFile")
    expect(JSON.stringify(summary)).not.toContain("secret/path/a.ts")
  })

  test("行数只上行三分类聚合，linesByFile 文件路径不外传（3.2、12）", () => {
    const state = createWorkflowState("sdlc")
    state.quality.linesByFile = { "secret/path/a.ts": 10, "secret/path/a.test.ts": -3, "c.json": 2 }
    const summary = summarizeWorkflow(state)
    // 负值逐文件 clamp ≥0：测试类 -3 → 0
    expect(summary.quality.lines).toEqual({ business: 10, test: 0, config: 2 })
    expect(JSON.stringify(summary)).not.toContain("secret/path")
    expect(JSON.stringify(summary.quality)).not.toContain("linesByFile")
  })

  test("无 AI 代码编辑时行数为 null", () => {
    const summary = summarizeWorkflow(createWorkflowState("sdlc"))
    expect(summary.quality.lines).toBeNull()
  })

  test("基线已录入时随摘要上行（6.3）", () => {
    const state = createWorkflowState("sdlc")
    state.baseline = { estimatedHours: 8, setAt: 1750000000000 }
    const summary = summarizeWorkflow(state)
    expect(summary.baseline).toEqual({ estimatedHours: 8, setAt: 1750000000000 })
  })

  test("未录入基线时为 null（向后兼容）", () => {
    const summary = summarizeWorkflow(createWorkflowState("sdlc"))
    expect(summary.baseline).toBeNull()
  })
})

describe("WorkflowDefinition 注册表（3.2）", () => {
  test("SDLC 定义与旧硬编码常量一致（阶段键/清单键/标签）", () => {
    expect(SDLC.type).toBe("sdlc")
    expect(SDLC.stages).toEqual(["requirements", "design", "implementation", "testing", "review"])
    expect(SDLC.reviewStage).toBe("review")
    expect(SDLC.hasCommitGate).toBe(true)
    expect(SDLC.labels).toEqual({
      requirements: "需求分析",
      design: "设计",
      implementation: "编码",
      testing: "测试",
      review: "审查",
    })
    expect(SDLC.checklist.map((c) => c.key)).toEqual([
      "businessIntent",
      "logicExplainable",
      "behaviorVerifiable",
      "designRationale",
    ])
    // 结构化规则（7.4）：stage 归属齐全、关键语义保留、插件内部机制不进注入文本
    expect(SDLC.rules.length).toBeGreaterThan(0)
    expect(SDLC.rules.some((r) => r.stage === "global")).toBe(true)
    expect(SDLC.rules.some((r) => r.stage === "requirements" && r.text.includes("workflow_baseline"))).toBe(true)
    expect(SDLC.rules.some((r) => r.stage === "review" && r.text.includes("comprehension_confirm"))).toBe(true)
    expect(SDLC.rules.some((r) => r.text.includes("同一文件连续 3 次"))).toBe(false)
  })

  test("createWorkflowState(type) 含 type 与泛化阶段，缺省 checklist 全 false", () => {
    const s = createWorkflowState("sdlc")
    expect(s.type).toBe("sdlc")
    expect(Object.keys(s.stages)).toEqual(SDLC.stages)
    expect(s.commit.blocked_by).toEqual(SDLC.stages)
    const review = reviewRecord(s)
    expect(review.checklist).toEqual({
      businessIntent: false,
      logicExplainable: false,
      behaviorVerifiable: false,
      designRationale: false,
    })
  })

  test("getStage/reviewRecord：缺键抛错、无审查阶段抛错", () => {
    const s = createWorkflowState("sdlc")
    expect(getStage(s, "requirements").status).toBe("not_started")
    expect(() => getStage(s, "nonexistent")).toThrow()
    expect(reviewRecord(s).comprehension).toEqual([])
  })

  test("resolveWorkflowType：合法值原样返回，未知值回退 sdlc 并打 warning", () => {
    expect(resolveWorkflowType("sdlc")).toBe("sdlc")
    expect(resolveWorkflowType("reqdoc")).toBe("reqdoc")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(resolveWorkflowType(undefined)).toBe("sdlc")
    expect(resolveWorkflowType(42)).toBe("sdlc")
    expect(resolveWorkflowType("legacy")).toBe("sdlc")
    expect(warn).toHaveBeenCalled()
  })

  test("WORKFLOW_DEFINITIONS 注册表与 getDefinition", () => {
    expect(Object.keys(WORKFLOW_DEFINITIONS)).toEqual(["sdlc", "reqdoc"])
    expect(getDefinition("sdlc")).toBe(SDLC)
    expect(getDefinition("reqdoc")).toBe(REQDOC)
  })

  test("rulesForStage / currentInProgressStage：阶段化注入取 global + 当前阶段", () => {
    // 无进行中阶段 → 只给 global
    expect(rulesForStage(SDLC, null).every((r) => r.stage === "global")).toBe(true)
    expect(rulesForStage(SDLC, null)).toHaveLength(SDLC.rules.filter((r) => r.stage === "global").length)
    // 指定阶段 → global + 该阶段
    const designRules = rulesForStage(SDLC, "design")
    expect(designRules.every((r) => r.stage === "global" || r.stage === "design")).toBe(true)
    expect(designRules.some((r) => r.stage === "requirements")).toBe(false)
    // currentInProgressStage：按顺序取第一个 in_progress；无则 null
    const s = createWorkflowState("sdlc")
    expect(currentInProgressStage(s)).toBeNull()
    s.stages.design.status = "in_progress"
    s.stages.implementation.status = "in_progress"
    expect(currentInProgressStage(s)).toBe("design")
  })

  test("REQDOC 定义：四段渐进引导 + 业务确认闭环，无提交门禁", () => {
    expect(REQDOC.type).toBe("reqdoc")
    expect(REQDOC.stages).toEqual(["goal", "rules", "edge", "prd", "review"])
    expect(REQDOC.reviewStage).toBe("review")
    expect(REQDOC.hasCommitGate).toBe(false)
    expect(REQDOC.labels).toEqual({
      goal: "目标与场景",
      rules: "流程与规则",
      edge: "边界与异常",
      prd: "需求规格书",
      review: "业务确认",
    })
    expect(REQDOC.checklist.map((c) => c.key)).toEqual([
      "completeness",
      "clarity",
      "edgeCoverage",
      "resolution",
    ])
    expect(REQDOC.rules.some((r) => r.stage === "goal" && r.text.includes("workflow_baseline"))).toBe(true)
    expect(REQDOC.rules.some((r) => r.stage === "review" && r.text.includes("comprehension_confirm"))).toBe(true)
    // 需求资料目录契约（7.5 重构：材料区 01~04 + AI 工作区 05/06）
    expect(REQDOC.rules.some((r) => r.text.includes("01_背景与目标"))).toBe(true)
    expect(REQDOC.rules.some((r) => r.text.includes("06_需求规格产出"))).toBe(true)
    // 投放引导（partial 友好）：r8 须展示绝对路径、接受部分投放、并显式二选一逼出选择
    expect(REQDOC.rules.some((r) => r.id === "reqdoc-r8" && r.text.includes("绝对路径") && r.text.includes("有多少投多少") && r.text.includes("直接口述"))).toBe(true)
    // 双通道：文档扫描工具 + 功能点拆解确认工具（重构核心）
    expect(REQDOC.rules.some((r) => r.text.includes("reqdoc_scan"))).toBe(true)
    expect(REQDOC.rules.some((r) => r.text.includes("reqdoc_confirm_features"))).toBe(true)
    // 打分卡（实施方案第三节）：追问约束（r2 最多 5 问带 A/B/C 与默认推荐、最长 3 轮）、
    // 打分时机与门禁（r21，edge）、渲染铁律 + 字段映射（r20，prd）
    expect(REQDOC.rules.some((r) => r.id === "reqdoc-r2" && r.text.includes("最多 5 个问题") && r.text.includes("默认推荐"))).toBe(true)
    // 追问原则：严禁纯技术词汇（业务语言转述，实施方案「追问原则」）
    expect(REQDOC.rules.some((r) => r.id === "reqdoc-r2" && r.text.includes("严禁") && r.text.includes("纯技术词汇") && r.text.includes("幂等"))).toBe(true)
    expect(REQDOC.rules.some((r) => r.id === "reqdoc-r6" && r.text.includes("默认推荐"))).toBe(true)
    // 阶段可见性（质量飞轮）：reqdoc-r25 通用规则，驱动模型每轮开头展示阶段 + 点名确认
    expect(REQDOC.rules.some((r) => r.id === "reqdoc-r25" && r.text.includes("第 N/Y 步") && r.text.includes("点名阶段"))).toBe(true)
    // 投放/口述 决定阶段无关（质量飞轮）：reqdoc-r26 通用规则，目标阶段被跳过时仍须每轮提出二选一并停下，不得直接追问
    expect(REQDOC.rules.some((r) => r.id === "reqdoc-r26" && r.stage === "global" && r.text.includes("二选一") && r.text.includes("停下等待") && r.text.includes("不得自行浓缩"))).toBe(true)
    expect(SDLC.rules.some((r) => r.id === "sdlc-r13" && r.text.includes("第 N/Y 步") && r.text.includes("点名阶段"))).toBe(true)
    // stagePurpose（阶段一句话目的，数据驱动、可扩展）
    expect(REQDOC.stagePurpose).toBeDefined()
    expect(REQDOC.stagePurpose?.goal).toBe("明确谁在用、解决什么痛点")
    expect(REQDOC.stagePurpose?.review).toBe("业务逐条确认 PRD 要点")
    expect(SDLC.stagePurpose?.implementation).toBe("编码实现")
    expect(SDLC.stagePurpose?.review).toBe("开发者理解确认代码")
    expect(REQDOC.rules.some((r) => r.id === "reqdoc-r20" && r.text.includes("渲染铁律") && r.text.includes("字段映射"))).toBe(true)
    expect(REQDOC.rules.some((r) => r.id === "reqdoc-r21" && r.stage === "edge" && r.text.includes("reqdoc_score"))).toBe(true)
    // 实施方案 01~06 产出：03→数据字典与库表设计（r10），04→RBAC 矩阵与审批流（r12），落盘进 r14/r20
    expect(REQDOC.rules.some((r) => r.id === "reqdoc-r10" && r.text.includes("数据字典") && r.text.includes("库表设计") && r.text.includes("纯文本步骤") && r.text.includes("flowchart TD"))).toBe(true)
    // 追问 3 轮上限须逐条列出未澄清探针并说明业务可选项（质量飞轮 P1：缺口可见 + 可行动）
    expect(REQDOC.rules.some((r) => r.id === "reqdoc-r11" && r.text.includes("3 轮上限") && r.text.includes("未澄清探针") && r.text.includes("将扣分数") && r.text.includes("可选项") && r.text.includes("开新会话"))).toBe(true)
    expect(REQDOC.rules.some((r) => r.id === "reqdoc-r12" && r.text.includes("RBAC 权限控制矩阵") && r.text.includes("审批流控制逻辑"))).toBe(true)
    expect(REQDOC.rules.some((r) => r.id === "reqdoc-r14" && r.text.includes("数据字典与库表设计") && r.text.includes("RBAC 权限控制矩阵"))).toBe(true)
    expect(REQDOC.rules.some((r) => r.id === "reqdoc-r14" && r.text.includes("reqdoc_export") && r.text.includes("Word"))).toBe(true)
    expect(REQDOC.rules.some((r) => r.id === "reqdoc-r20" && r.text.includes("数据字典与库表设计/") && r.text.includes("权限矩阵与审批流/"))).toBe(true)
    // 关键确认防浅背书（质量飞轮 #5）：reqdoc-r27 通用规则，连续 2 次默认须逼自主意见
    expect(REQDOC.rules.some((r) => r.id === "reqdoc-r27" && r.stage === "global" && r.text.includes("连续 2 轮") && r.text.includes("量化目标") && r.text.includes("打分门禁兜底"))).toBe(true)
    // 先补料再追问（质量飞轮 #6）：reqdoc-r28 edge 规则，进 edge 前促投放≥2 目录
    expect(REQDOC.rules.some((r) => r.id === "reqdoc-r28" && r.stage === "edge" && r.text.includes("先补料再追问") && r.text.includes("至少 2 个目录") && r.text.includes("workflow_baseline"))).toBe(true)
    // 来源真实性门禁（P0.2）：reqdoc-r30 通用规则，[文档] 占比≥30% 或 ≥2 功能点有素材
    expect(REQDOC.rules.some((r) => r.id === "reqdoc-r30" && r.stage === "global" && r.text.includes("≥30%") && r.text.includes("至少 2 个功能点") && r.text.includes("no_document_confirmed"))).toBe(true)
  })

  test("打分卡契约：五维权重满分 100、达标线 85", () => {
    expect(REQDOC_SCORE_DIMS.map((d) => d.key)).toEqual([
      "businessValue",
      "flowClosure",
      "edgeControl",
      "compliance",
      "authority",
    ])
    expect(REQDOC_SCORE_DIMS.reduce((sum, d) => sum + d.max, 0)).toBe(100)
    expect(REQDOC_SCORE_PASS).toBe(85)
  })

  test("打分卡评分标准：每维含判定规则与扣分标准，逐条未超满分（实施方案判定规则列）", () => {
    for (const d of REQDOC_SCORE_DIMS) {
      expect(d.rule.length).toBeGreaterThan(0)
      expect(d.deductionRules.length).toBeGreaterThan(0)
      for (const p of d.deductionRules) {
        expect(p.points).toBeGreaterThan(0)
        expect(p.points).toBeLessThanOrEqual(d.max)
      }
    }
    // 方案原表的关键扣分标准全部落位
    const rubric = reqdocScoreRubric()
    expect(rubric).toContain("扣10分：缺失使用角色")
    expect(rubric).toContain("扣15分：流程有头无尾")
    expect(rubric).toContain("扣25分：未提及任何异常")
    expect(rubric).toContain("扣10分：未定义脱敏")
    expect(rubric).toContain("扣10分：描述为「所有人均可使用」")
    // r21 规则文本已嵌入完整评分标准（edge 阶段注入提示，模型打分可见）
    const r21 = REQDOC.rules.find((r) => r.id === "reqdoc-r21")!
    expect(r21.text).toContain("网络超时")
    expect(r21.text).toContain("扣25分")
    expect(r21.text).toContain("reqdoc_score")
    // 三档分级引导（实施方案「<60 不合格 / 60-84 良好 / ≥85 达标」）
    expect(r21.text).toContain("<60 分（不合格）")
    expect(r21.text).toContain("60-84 分（良好）")
    expect(r21.text).toContain("≥85 分（达标）")
    expect(r21.text).toContain("停止追问")
    expect(r21.text).toContain("进度条")
  })

  test("createWorkflowState(reqdoc) 含 reqdoc 阶段与清单", () => {
    const s = createWorkflowState("reqdoc")
    expect(s.type).toBe("reqdoc")
    expect(Object.keys(s.stages)).toEqual(["goal", "rules", "edge", "prd", "review"])
    expect(s.commit.blocked_by).toEqual(["goal", "rules", "edge", "prd", "review"])
    const review = reviewRecord(s)
    expect(review.checklist).toEqual({
      completeness: false,
      clarity: false,
      edgeCoverage: false,
      resolution: false,
    })
  })
})

describe("summarizeWorkflow 多流程结构", () => {
  test("输出含 type 与泛化 stages，键为定义阶段", () => {
    const summary = summarizeWorkflow(createWorkflowState("sdlc"))
    expect(summary.type).toBe("sdlc")
    expect(Object.keys(summary.stages)).toEqual(SDLC.stages)
    // 审查阶段为 ReviewStageSummary，含 checklist 与 comprehension
    const review = summary.stages.review as { checklist: Record<string, boolean>; comprehension: { total: number; confirmed: number } }
    expect(review.checklist).toEqual({
      businessIntent: false,
      logicExplainable: false,
      behaviorVerifiable: false,
      designRationale: false,
    })
    expect(review.comprehension).toEqual({ total: 0, confirmed: 0 })
    // 普通阶段为 StageSummary，无 checklist
    expect(summary.stages.requirements).not.toHaveProperty("checklist")
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
