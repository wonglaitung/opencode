import { afterEach, describe, expect, test, vi } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  REQDOC,
  REQDOC_SCORE_DIMS,
  SDLC,
  WORKFLOW_DEFINITIONS,
  createWorkflowState,
  currentInProgressStage,
  deepMerge,
  efficiencyRatio,
  getDefinition,
  getStage,
  hashApiKey,
  readIdentity,
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
    expect(validateIdentity({ apiKey: "", collector_url: "u" }).length).toBeGreaterThan(0)
    expect(validateIdentity({ apiKey: "a", collector_url: "u" })).toEqual([])
  })

  test("write 后 read 回环（缺省 workflowType 补 sdlc）", () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-id-"))
    const path = join(dir, "identity.json")
    try {
      const identity: Identity = { apiKey: "sk_test_xxx", collector_url: "http://h:8787" }
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
      const identity: Identity = { apiKey: "sk_test_xxx", collector_url: "http://h:8787", workflowType: "sdlc" }
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
    // 需求资料目录契约（7.5 重构：材料区 01~05 + AI 工作区 05/06）
    expect(REQDOC.rules.some((r) => r.text.includes("01_背景与目标"))).toBe(true)
    expect(REQDOC.rules.some((r) => r.text.includes("07_需求规格产出"))).toBe(true)
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
    // 投放/口述 决定阶段无关（质量飞轮）：reqdoc-r26 通用规则，目标阶段被跳过时仍须每轮提出二选一。
    // 措辞要点（对抗审查第十二轮）：二选一必须收敛成「本轮最多 5 问里的第一问」，**不得**写成
    // 「不得先抛其它问题」——那与 reqdoc-r2「单次提问最多 5 个、每个必须附 A/B/C + 默认推荐」
    // 直接冲突，弱模型会二选一遵守（实测照「只问这一句就停」执行，r1 判据 0/3 全塌）。
    // 故断言的是「并入本轮 5 问 + 按 r2 格式」而非「停下等待」。
    expect(REQDOC.rules.some((r) => r.id === "reqdoc-r26" && r.stage === "global" && r.text.includes("二选一") && r.text.includes("不得自行浓缩") && r.text.includes("最多 5 问") && r.text.includes("【默认推荐项】"))).toBe(true)
    // 冲突面必须显式说明：不许再出现「不得先抛其它问题」这类与追问规则打架的措辞
    expect(REQDOC.rules.some((r) => r.text.includes("不得先抛其它问题"))).toBe(false)
    expect(SDLC.rules.some((r) => r.id === "sdlc-r13" && r.text.includes("第 N/Y 步") && r.text.includes("点名阶段"))).toBe(true)
    // stagePurpose（阶段一句话目的，数据驱动、可扩展）
    expect(REQDOC.stagePurpose).toBeDefined()
    expect(REQDOC.stagePurpose?.goal).toBe("明确谁在用、解决什么痛点")
    expect(REQDOC.stagePurpose?.review).toBe("业务逐条确认 PRD 要点")
    expect(SDLC.stagePurpose?.implementation).toBe("编码实现")
    expect(SDLC.stagePurpose?.review).toBe("开发者理解确认代码")
    // 阶段 3：r20 降级为「生成事实」——字段映射已由 模板解析派生的槽位地址，
    // 规则不再复述映射表，只留内容纪律（禁杜撰/书面语/[缺省]附理由）。
    const r20 = REQDOC.rules.find((r) => r.id === "reqdoc-r20")!
    expect(r20.text).toContain("槽位内容铁律")
    expect(r20.text).toContain("禁止杜撰事实")
    expect(r20.text).not.toContain("5.k.2.8") // 映射表已移除（由地址承载）
    // 阶段 3：r33 填槽纪律 + r9/r10（主流程推演，已由槽位清单承载）删除
    expect(REQDOC.rules.some((r) => r.id === "reqdoc-r33" && r.text.includes("批量起草"))).toBe(true)
    expect(REQDOC.rules.some((r) => r.id === "reqdoc-r9" || r.id === "reqdoc-r10")).toBe(false)
    // 阶段 3：规则合并（r3+r4、r1+r5、r16+r17+r18）后，纪律不得丢失——
    // 「单次只确认一个要点」「revisit 不得自行判断阶段」是关键约束，须仍出现在某条规则里。
    const allText = REQDOC.rules.map((r) => r.text).join("\n")
    expect(allText).toContain("单次只接受一个要点")
    expect(allText).toContain("workflow_revisit")
    expect(allText).toContain("/new")
    // 重构 2c：r14/r23/r24/r31 已改写为组装路径，不再点名已删工具
    expect(REQDOC.rules.some((r) => r.id === "reqdoc-r14" && r.text.includes("reqdoc_assemble") && r.text.includes("严禁用 write 手写"))).toBe(true)
    // 重构 2c：打分卡门禁已删，edge 阶段改为槽位覆盖度门禁（kbGate）
    expect(REQDOC.rules.some((r) => r.id === "reqdoc-r22" && r.stage === "edge" && r.text.includes("kbGate") && r.text.includes("force_reason"))).toBe(true)
    expect(REQDOC.rules.some((r) => r.id === "reqdoc-r21")).toBe(false)
    // 阶段 3：r10 删除后，其「数据字典与库表设计 / 纯文本步骤展示主流程」要求迁入 r12（不可随规则删除而丢失）
    expect(REQDOC.rules.some((r) => r.id === "reqdoc-r12" && r.text.includes("数据字典") && r.text.includes("库表设计") && r.text.includes("纯文本步骤"))).toBe(true)
    // 追问 3 轮上限须逐条列出未澄清探针并说明业务可选项（质量飞轮 P1：缺口可见 + 可行动）
    expect(REQDOC.rules.some((r) => r.id === "reqdoc-r11" && r.text.includes("3 轮") && r.text.includes("可选项") && r.text.includes("开新会话") && r.text.includes("reqdoc_ingest") && r.text.includes("reqdoc_answer"))).toBe(true)
    expect(REQDOC.rules.some((r) => r.id === "reqdoc-r12" && r.text.includes("RBAC 权限控制矩阵") && r.text.includes("审批流控制逻辑"))).toBe(true)
    // 模板外成果（数据字典/库表设计、RBAC 权限矩阵、UAT 用例）的落盘要求归 r20（槽位内容铁律）
    expect(REQDOC.rules.some((r) => r.id === "reqdoc-r20" && r.text.includes("数据字典与库表设计") && r.text.includes("RBAC 权限"))).toBe(true)
    expect(REQDOC.rules.some((r) => r.id === "reqdoc-r14" && r.text.includes("reqdoc_export") && r.text.includes("Word"))).toBe(true)
    expect(REQDOC.rules.some((r) => r.id === "reqdoc-r20" && r.text.includes("07_需求规格产出"))).toBe(true)
    // 关键确认防浅背书（质量飞轮 #5）：reqdoc-r27 通用规则，连续 2 次默认须逼自主意见
    expect(REQDOC.rules.some((r) => r.id === "reqdoc-r27" && r.stage === "global" && r.text.includes("连续 2 轮") && r.text.includes("量化目标") && r.text.includes("reqdoc-r22"))).toBe(true)
    // 先补料再追问（质量飞轮 #6）：reqdoc-r28 edge 规则，进 edge 前促投放≥2 目录
    expect(REQDOC.rules.some((r) => r.id === "reqdoc-r28" && r.stage === "edge" && r.text.includes("先补料再追问") && r.text.includes("至少 2 个目录") && r.text.includes("workflow_baseline"))).toBe(true)
    // 来源真实性门禁（P0.2）：reqdoc-r30 通用规则，[文档] 占比≥30% 或 ≥2 功能点有素材
    expect(REQDOC.rules.some((r) => r.id === "reqdoc-r30" && r.stage === "global" && r.text.includes("[文档]") && r.text.includes("[问答]"))).toBe(true)
  })

  // 重构 2c：打分卡不再是 reqdoc 门禁。八维评分器仅供 eval 独立通道使用（设计 4.4 第 3 层），
  // REQDOC_SCORE_PASS 已无运行时消费者。此处只锁「eval 评分维度未被改动」。
  test("eval 独立评分通道：八维权重满分 100（达标线 85 已退役）", () => {
    expect(REQDOC_SCORE_DIMS.map((d) => d.key)).toEqual([
      "businessValue",
      "flowClosure",
      "edgeControl",
      "compliance",
      "authority",
      "material",
      "nfr",
      "acceptability",
    ])
    expect(REQDOC_SCORE_DIMS.reduce((sum, d) => sum + d.max, 0)).toBe(100)
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

describe("hashApiKey（身份哈希，3.1 / 12 安全）", () => {
  test("是 SHA-256 hex（已知答案校验）", async () => {
    // SHA-256("test") 的标准十六进制值
    expect(await hashApiKey("test")).toBe(
      "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    )
  })

  test("确定性：同输入同输出", async () => {
    expect(await hashApiKey("sk_x")).toBe(await hashApiKey("sk_x"))
  })

  test("输出为 64 位小写 hex", async () => {
    expect(await hashApiKey("anything")).toMatch(/^[0-9a-f]{64}$/)
  })

  test("不同输入产生不同哈希", async () => {
    expect(await hashApiKey("a")).not.toBe(await hashApiKey("b"))
  })
})

/**
 * 面向弱模型的提示词要求·条 6「禁用要显式写」的护栏。
 *
 * 弱模型不会自己推断「不该用哪个工具」——**语义相邻的替代工具就是它的默认诱因**。
 * 本仓已实测两起：`reqdoc_ingest` 该用时，模型连发 25 次 `comprehension_add`
 * （把需求内容堆成理解条目，内容既不进槽位也不进产物）；`comprehension_ask` 该用时，
 * 模型改用 `read_file` 自己看代码。
 *
 * 规则：凡 steer 某个工具的规则文本，若该工具存在下表列出的**替代路径**，规则必须
 * **点名禁用**那条替代路径——否则等于没写。表是显式的、可审计的：每对都对应一次实测。
 */
describe("reqdoc-r27 防浅背书：关键措辞不得在压缩中丢失", () => {
  // 这条规则正被上下文预算挤压（global+prd 长期贴着 4000 上限），每次改写别的规则都可能
  // 顺手把它压短。压缩本身没错，但压掉了「必须转开放式」与「标注是推测」就等于规则失效
  // ——而它护的正是「业务判断不了却被默认项带着点头」。故把三处要点钉住。
  const r27 = getDefinition("reqdoc").rules.find((r) => r.id === "reqdoc-r27")
  test("三处要点俱在", () => {
    expect(r27?.text).toMatch(/连续 2 轮/)
    expect(r27?.text).toMatch(/必须改为开放式追问/)
    expect(r27?.text).toMatch(/这是我的推测/)
  })
  test("「不做硬拦」已改为「必须」——原措辞等于承认不保证", () => {
    expect(r27?.text).not.toContain("不做硬拦截")
  })
})

describe("规则须显式禁用语义相邻的替代工具（条 6）", () => {
  const TYPES = ["sdlc", "reqdoc"] as const
  /** [正路工具, 替代路径] —— 每对都对应一次实测的绕道 */
  const BYPASS_PAIRS: [string, string][] = [
    ["reqdoc_ingest", "comprehension_add"],
    ["comprehension_ask", "read_file"],
  ]

  for (const [correct, bypass] of BYPASS_PAIRS) {
    test(`${correct} 必须被点名禁用 ${bypass}`, () => {
      const steering = TYPES.flatMap((t) => getDefinition(t).rules).filter((r) => r.text.includes(correct))
      expect(steering.length).toBeGreaterThan(0)
      const naming = steering.filter((r) => r.text.includes(bypass))
      expect(naming.map((r) => r.id)).not.toEqual([])
    })
  }

  test("禁用措辞必须带阶段限定——comprehension_add 在 review 阶段是正当动作", () => {
    const r14 = getDefinition("reqdoc").rules.find((r) => r.id === "reqdoc-r14")
    expect(r14?.text).toContain("comprehension_add")
    // 无条件禁用会把 review 阶段的正当用法也禁掉
    expect(r14?.text).toMatch(/本阶段|阶段无关|除 review|review 阶段/)
    // 且 review 阶段的正当规则仍在
    expect(getDefinition("reqdoc").rules.some((r) => r.id === "reqdoc-r16" && r.text.includes("comprehension_add"))).toBe(true)
    expect(getDefinition("sdlc").rules.some((r) => r.id === "sdlc-r8" && r.text.includes("comprehension_add"))).toBe(true)
  })
})
