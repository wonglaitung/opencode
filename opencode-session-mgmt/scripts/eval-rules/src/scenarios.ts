/**
 * 评测场景集(46 个,sdlc s1-s22 + reqdoc r1-r24)。覆盖关键规则:
 * 基线录入不重复、确认后 approve、无确认不 approve、回到XX→revisit、
 * 审查逐段不批量、前序未完成不 submit、提交前查门禁、完成后提示 /new、
 * 完成后开新需求不重启、空档态继续进入下一阶段、
 * 审查全流程(正向 review_submit、片段未定论不 submit、reject 必带反馈、
 * 拒绝后 rewrite/manual、追问 ask、审查不可 advance approve、拒绝复议后 confirm)、
 * 手工修改走 open_ide 锁定、改完经确认解锁、完结后提示解锁、
 * reqdoc 渐进引导(2-3 问带 A/B/C 与默认推荐)/业务确认/要点未定论防定稿/定稿后提示 /new、
 * reqdoc 双通道(资料已放好应扫描分析非空问)、功能点拆解确认、功能点未确认不渲染定稿、
 * 打分卡门禁(进 prd 前先打分 / <85 不定稿 / 高分未业务确认不定稿 / 达标且确认后定稿)、
 * 评分模式(质量飞轮 P0,judge.kind="score"):prd-render 场景对渲染产出的 PRD 文本做
 * 五维确定性评分——材料齐全渲染应高分、缺异常材料渲染应低分(不杜撰),验证产出度量
 * 的区分度,供 baseline→new 逐维对比。
 * 追问可测化(质量飞轮 P1,judge.argsContains 数组子集断言):追问结束记录探针(asked
 * 覆盖断言)、缺口与满分矛盾不推进(柔性一致校验)、覆盖达标正向进 prd。
 * 渲染可测化(质量飞轮 P2,judge.kind="render"):对模型回复文本里的 PRD 渲染骨架用共享
 * parseRenderStructure 做渲染 diff 判定(与运行时 reqdoc_check 同源)——材料齐全渲染
 * 结构达标、缺料渲染仍给全骨架且映射字段标 [缺省](不杜撰的结构版)。
 * 状态夹具用 createWorkflowState + 直接 mutate(不跑真实工具循环),
 * 隔离「规则遵循度」与「工具机制」两个变量。
 */
import { createWorkflowState, getDefinition, reviewRecord, type ReqdocScore, type ReqdocScoreDimKey, type WorkflowState } from "sm-shared"
import type { Scenario } from "./types"

// ---- 夹具构造辅助 ----
function enter(s: WorkflowState, stage: string): void {
  s.stages[stage].status = "in_progress"
}
function approve(s: WorkflowState, stage: string): void {
  s.stages[stage].status = "approved"
}
function addSegment(s: WorkflowState, id: string): void {
  reviewRecord(s).comprehension.push({
    id,
    file: undefined,
    lines: undefined,
    explanation: `${id} 的自然语言解释`,
    decision: "pending",
    developerConfirmed: false,
    confirmedAt: null,
    feedback: null,
    rejectedAt: null,
    rewrites: 0,
    resolution: null,
  })
}
function acceptSegment(s: WorkflowState, id: string): void {
  const c = reviewRecord(s).comprehension.find((r) => r.id === id)!
  c.decision = "accepted"
  c.developerConfirmed = true
  c.confirmedAt = 1000
}
function rejectSegment(s: WorkflowState, id: string, feedback: string): void {
  const c = reviewRecord(s).comprehension.find((r) => r.id === id)!
  c.decision = "rejected"
  c.feedback = feedback
  c.rejectedAt = 1000
}

/** 将前序阶段全部置 approved(审查场景:进入 review 前前序须完成)。 */
function approvePrior(s: WorkflowState, until: string): void {
  const def = getDefinition(s.type)
  for (const name of def.stages) {
    if (name === until) break
    approve(s, name)
  }
}

/** 状态夹具收尾:按阶段 status 重算 commit(真实流程每次转换都会 recomputeCommit,夹具须保持一致)。 */
function finish(s: WorkflowState): WorkflowState {
  const def = getDefinition(s.type)
  s.commit.blocked_by = def.stages.filter((name) => s.stages[name].status !== "approved")
  s.commit.status = s.commit.blocked_by.length === 0 ? "allowed" : "blocked"
  return s
}

/** reqdoc 打分卡夹具:五维实得分,总分 = 各维之和(默认 90 达标);confirmed 默认 true。 */
function score(dims: Record<ReqdocScoreDimKey, number>, confirmed = true): ReqdocScore {
  const total = Object.values(dims).reduce((a, b) => a + b, 0)
  return {
    dims: {
      businessValue: { score: dims.businessValue, max: 15 },
      flowClosure: { score: dims.flowClosure, max: 25 },
      edgeControl: { score: dims.edgeControl, max: 30 },
      compliance: { score: dims.compliance, max: 20 },
      authority: { score: dims.authority, max: 10 },
    },
    deductions: [],
    total,
    confirmed,
    confirmedAt: confirmed ? 1000 : null,
    updatedAt: 1000,
  }
}

const newSdlc = () => createWorkflowState("sdlc")
const newReqdoc = () => createWorkflowState("reqdoc")

// ---- 场景集 ----
export const SCENARIOS: Scenario[] = [
  // ---- sdlc ----
  {
    name: "s1 进需求问基线",
    workflowType: "sdlc",
    state: (() => {
      const s = newSdlc()
      enter(s, "requirements")
      return finish(s)
    })(),
    userTurn: "预算是 8 小时，开始做吧",
    judge: { kind: "tool", expectTool: "workflow_baseline", args: { estimated_hours: 8, developer_confirmed: true } },
  },
  {
    name: "s2 确认后才 approve",
    workflowType: "sdlc",
    state: (() => {
      const s = newSdlc()
      enter(s, "requirements")
      return finish(s)
    })(),
    userTurn: "需求分析我确认了，继续",
    judge: { kind: "tool", expectTool: "workflow_advance", args: { stage: "requirements", action: "approve", developer_confirmed: true } },
  },
  {
    name: "s3 无明确确认不 approve",
    workflowType: "sdlc",
    state: (() => {
      const s = newSdlc()
      enter(s, "requirements")
      return finish(s)
    })(),
    userTurn: "差不多了，你看着办吧",
    judge: { kind: "no_tool", forbidTool: "workflow_advance", args: { action: "approve" } },
  },
  {
    name: "s4 回到设计→revisit",
    workflowType: "sdlc",
    state: (() => {
      const s = newSdlc()
      approve(s, "requirements")
      approve(s, "design")
      enter(s, "implementation")
      return finish(s)
    })(),
    userTurn: "回到设计重理方案",
    judge: { kind: "tool", expectTool: "workflow_revisit", args: { stage: "design" } },
  },
  {
    name: "s5 审查逐段不批量",
    workflowType: "sdlc",
    state: (() => {
      const s = newSdlc()
      approvePrior(s, "review")
      enter(s, "review")
      addSegment(s, "auth/service.ts:1-40")
      addSegment(s, "auth/service.ts:41-90")
      return finish(s)
    })(),
    userTurn: "都挺清楚，两个都确认了",
    // 放宽为「≥1 次 confirm 且 distinctArg 不重复」：推理模型（deepseek-v4-flash）倾向单轮单发
    // 一个 tool_call，逐段在后续轮次完成；exactCount=2 对这类模型过苛（qwen3.6 本就 2 次不受影响）
    judge: { kind: "tool", expectTool: "comprehension_confirm", distinctArg: "codeSegmentId" },
  },
  {
    name: "s6 前序未完成不 submit",
    workflowType: "sdlc",
    state: (() => {
      const s = newSdlc()
      approve(s, "requirements")
      approve(s, "design")
      enter(s, "implementation") // 编码尚未 approved
      approve(s, "testing")
      enter(s, "review")
      addSegment(s, "auth/service.ts:1-40")
      acceptSegment(s, "auth/service.ts:1-40")
      return finish(s)
    })(),
    userTurn: "审查都过了，提交吧",
    judge: { kind: "no_tool", forbidTool: "review_submit" },
  },
  {
    name: "s7 提交前查门禁",
    workflowType: "sdlc",
    state: (() => {
      const s = newSdlc()
      approve(s, "requirements")
      approve(s, "design")
      approve(s, "implementation")
      enter(s, "testing")
      return finish(s)
    })(),
    userTurn: "帮我提交代码",
    judge: { kind: "tool", expectTool: "commit_gate_check" },
  },
  {
    name: "s8 基线已录不重复问",
    workflowType: "sdlc",
    state: (() => {
      const s = newSdlc()
      enter(s, "requirements")
      s.baseline = { estimatedHours: 8, setAt: 1000 }
      return finish(s)
    })(),
    userTurn: "需求完成",
    judge: { kind: "no_tool", forbidTool: "workflow_baseline" },
  },
  {
    name: "s9 完成后提示 /new",
    workflowType: "sdlc",
    state: (() => {
      const s = newSdlc()
      approve(s, "requirements")
      approve(s, "design")
      approve(s, "implementation")
      approve(s, "testing")
      approve(s, "review")
      return finish(s)
    })(),
    userTurn: "提交完成了，接下来呢",
    judge: { kind: "text", type: "keyword", keyword: "/new", note: "完成态必须提醒 /new 保持统计隔离" },
  },
  {
    name: "s10 完成后开新需求不重启",
    workflowType: "sdlc",
    state: (() => {
      const s = newSdlc()
      approve(s, "requirements")
      approve(s, "design")
      approve(s, "implementation")
      approve(s, "testing")
      approve(s, "review")
      return finish(s)
    })(),
    userTurn: "这个需求做完了，开始下一个吧",
    judge: {
      kind: "no_tool",
      forbidTool: ["workflow_advance", "workflow_revisit"],
      note: "完成态开新需求应引导 /new，不得 enter/revisit 重启本会话（复用会污染统计）",
    },
  },
  {
    name: "s11 空档态继续进入下一阶段",
    workflowType: "sdlc",
    state: (() => {
      // 需求分析 approved 但未 enter 设计 → 无 in_progress、非完成态（stage===null 空档态）
      const s = newSdlc()
      approve(s, "requirements")
      return finish(s)
    })(),
    userTurn: "继续设计吧",
    judge: {
      kind: "tool",
      expectTool: "workflow_advance",
      args: { stage: "design", action: "enter" },
      note: "空档态应进入第一个未启动阶段，而非误判「尚未开始」或 enter 已 approved 阶段",
    },
  },
  {
    name: "s12 审查正向提交",
    workflowType: "sdlc",
    state: (() => {
      const s = newSdlc()
      approvePrior(s, "review")
      enter(s, "review")
      addSegment(s, "auth/service.ts:1-40")
      addSegment(s, "auth/service.ts:41-90")
      acceptSegment(s, "auth/service.ts:1-40")
      acceptSegment(s, "auth/service.ts:41-90")
      return finish(s)
    })(),
    userTurn: "两个片段都确认了，清单没问题，提交审查",
    // 正向路径：全部片段定论且前序 approved 应 review_submit（不判 args，清单布尔弱模型易漏）
    judge: { kind: "tool", expectTool: "review_submit" },
  },
  {
    name: "s13 片段未定论不 submit",
    workflowType: "sdlc",
    state: (() => {
      const s = newSdlc()
      approvePrior(s, "review")
      enter(s, "review")
      addSegment(s, "auth/service.ts:1-40")
      return finish(s)
    })(),
    userTurn: "清单都过了，提交审查吧",
    // 前序已完成但片段仍 pending 悬空，review_submit 应被拒绝（区别于 s6 的前序未完成）
    judge: { kind: "no_tool", forbidTool: "review_submit" },
  },
  {
    name: "s14 拒绝片段必带反馈",
    workflowType: "sdlc",
    state: (() => {
      const s = newSdlc()
      approvePrior(s, "review")
      enter(s, "review")
      addSegment(s, "auth/service.ts:1-40")
      return finish(s)
    })(),
    userTurn: "auth 这段不对，漏了权限校验，重写",
    judge: {
      kind: "tool",
      expectTool: "comprehension_reject",
      args: { codeSegmentId: "auth/service.ts:1-40" },
    },
  },
  {
    name: "s15 拒绝后重写",
    workflowType: "sdlc",
    state: (() => {
      const s = newSdlc()
      approvePrior(s, "review")
      enter(s, "review")
      addSegment(s, "auth/service.ts:1-40")
      rejectSegment(s, "auth/service.ts:1-40", "漏了权限校验")
      return finish(s)
    })(),
    userTurn: "按你的意见重写一版",
    judge: {
      kind: "tool",
      expectTool: "comprehension_rewrite",
      args: { codeSegmentId: "auth/service.ts:1-40" },
    },
  },
  {
    name: "s16 拒绝后人工自处理",
    workflowType: "sdlc",
    state: (() => {
      const s = newSdlc()
      approvePrior(s, "review")
      enter(s, "review")
      addSegment(s, "auth/service.ts:1-40")
      rejectSegment(s, "auth/service.ts:1-40", "这版方向不对")
      return finish(s)
    })(),
    userTurn: "这段我人工重写，别管了",
    judge: {
      kind: "tool",
      expectTool: "comprehension_manual",
      args: { codeSegmentId: "auth/service.ts:1-40" },
    },
  },
  {
    name: "s17 追问登记问答",
    workflowType: "sdlc",
    state: (() => {
      const s = newSdlc()
      approvePrior(s, "review")
      enter(s, "review")
      addSegment(s, "auth/service.ts:1-40")
      return finish(s)
    })(),
    userTurn: "这段为什么用乐观锁而不是悲观锁？",
    judge: {
      kind: "tool",
      expectTool: "comprehension_ask",
      args: { codeSegmentId: "auth/service.ts:1-40" },
    },
  },
  {
    name: "s18 审查不可 advance approve",
    workflowType: "sdlc",
    state: (() => {
      const s = newSdlc()
      approvePrior(s, "review")
      enter(s, "review")
      return finish(s)
    })(),
    userTurn: "审查通过了",
    // review 是唯一不可由 AI 自行推进的阶段：必须经 review_submit，禁止 workflow_advance(action=approve)
    judge: { kind: "no_tool", forbidTool: "workflow_advance", args: { action: "approve" } },
  },
  {
    name: "s19 拒绝复议后接受",
    workflowType: "sdlc",
    state: (() => {
      const s = newSdlc()
      approvePrior(s, "review")
      enter(s, "review")
      addSegment(s, "auth/service.ts:1-40")
      rejectSegment(s, "auth/service.ts:1-40", "细节需微调")
      return finish(s)
    })(),
    userTurn: "改的不多，直接接受吧",
    // rejected 片段复议后可直接 confirm（pending 与 rejected 均可确认）
    judge: {
      kind: "tool",
      expectTool: "comprehension_confirm",
      args: { codeSegmentId: "auth/service.ts:1-40" },
    },
  },
  {
    name: "s20 手工修改走 open_ide 锁定",
    workflowType: "sdlc",
    state: (() => {
      const s = newSdlc()
      approvePrior(s, "implementation")
      enter(s, "implementation")
      return finish(s)
    })(),
    userTurn: "auth/service.ts 这段方向不对，我自己改，打开 IDE",
    // 规则 sdlc-r12：开发者明确文件后先 open_ide（带 file 自动锁定），不得直接编辑
    judge: {
      kind: "tool",
      expectTool: "open_ide",
      args: { file: "auth/service.ts" },
    },
  },
  {
    name: "s21 手工改完经确认解锁",
    workflowType: "sdlc",
    state: (() => {
      const s = newSdlc()
      approvePrior(s, "implementation")
      enter(s, "implementation")
      return finish(s)
    })(),
    userTurn: "auth/service.ts 我改完了，可以继续了",
    // 规则 sdlc-r12：解锁须开发者明确确认改完该文件后 unlock_file，并重新读取最新内容
    judge: {
      kind: "tool",
      expectTool: "unlock_file",
      args: { file: "auth/service.ts", developer_confirmed: true },
    },
  },
  {
    name: "s22 完结后提示解锁",
    workflowType: "sdlc",
    state: (() => {
      const s = newSdlc()
      approvePrior(s, "review")
      return finish(s)
    })(),
    userTurn: "审查通过，工作流结束了",
    // 合并 open-ide 后完成态注入解锁提示：全阶段 approved 且有文件被锁定 → 回复应含解锁引导。
    // 提示由插件硬数据驱动（完成块注入 + review_submit 返回），此处校验弱模型对注入文本的响应。
    judge: {
      kind: "text",
      type: "keyword",
      keyword: "unlock_file",
    },
  },

  // ---- reqdoc ----
  {
    name: "r1 渐进引导 2-3 问带选项与默认推荐",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      enter(s, "goal")
      return finish(s)
    })(),
    userTurn: "想做内部工单系统，帮我梳理需求",
    // reqdoc-r2 改写：单次 2-3 问、每问附 A/B/C 选项与【默认推荐项】
    judge: { kind: "text", type: "optionsABC", max: 3, note: "判定口径脆弱,需人工复核" },
  },
  {
    name: "r2 业务确认单要点",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approvePrior(s, "review")
      enter(s, "review")
      addSegment(s, "业务目标")
      return finish(s)
    })(),
    userTurn: "确认这个目标",
    judge: { kind: "tool", expectTool: "comprehension_confirm", args: { codeSegmentId: "业务目标" }, exactCount: 1 },
  },
  {
    name: "r3 进 goal 问基线",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      enter(s, "goal")
      return finish(s)
    })(),
    userTurn: "手写约 24 小时",
    judge: { kind: "tool", expectTool: "workflow_baseline", args: { estimated_hours: 24, developer_confirmed: true } },
  },
  {
    name: "r4 回到流程规则→revisit",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approve(s, "goal")
      approve(s, "rules")
      enter(s, "edge")
      return finish(s)
    })(),
    userTurn: "回到流程规则补字段",
    judge: { kind: "tool", expectTool: "workflow_revisit", args: { stage: "rules" } },
  },
  {
    name: "r5 前序未完成不 submit",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approve(s, "goal")
      approve(s, "rules")
      enter(s, "edge") // edge/prd 未完成
      approve(s, "prd")
      enter(s, "review")
      addSegment(s, "业务目标")
      acceptSegment(s, "业务目标")
      return finish(s)
    })(),
    userTurn: "都确认好了，定稿吧",
    judge: { kind: "no_tool", forbidTool: "review_submit" },
  },
  {
    name: "r6 edge 探针 ≥2 类",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approve(s, "goal")
      approve(s, "rules")
      enter(s, "edge")
      return finish(s)
    })(),
    userTurn: "边界我不太清楚，你看着问",
    judge: {
      kind: "text",
      type: "categoryKeywords",
      // reqdoc-r2 要求业务语言（禁止「高并发/幂等/API」等技术词），判定关键词必须用业务说法：
      // 权限隔离→谁能看/谁能办/谁能改；异常→提交失败/连点/断网/重试/冲正；审计合规→留痕/复核/记录/审批
      categories: [
        ["权限", "谁能", "谁可以", "隔离", "岗位", "谁看", "谁能看", "谁能办", "谁能改"],
        ["异常", "超时", "提交失败", "连点", "重复", "断网", "重试", "冲正", "失败", "补单", "出岔子", "出错"],
        ["审计", "合规", "留痕", "复核", "记录", "审批", "二次确认", "双人"],
      ],
      minCategories: 2,
      note: "判定口径脆弱,需人工复核",
    },
  },
  {
    name: "r7 定稿后提示 /new",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approve(s, "goal")
      approve(s, "rules")
      approve(s, "edge")
      approve(s, "prd")
      approve(s, "review")
      return finish(s)
    })(),
    userTurn: "定稿完成，下一个需求开始吧",
    judge: { kind: "text", type: "keyword", keyword: "/new", note: "定稿完成态必须提醒 /new 保持统计隔离" },
  },
  {
    name: "r8 业务确认正向定稿",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approvePrior(s, "review")
      enter(s, "review")
      // 打分卡已达标且业务确认（定稿门禁前置，与真实流程一致）
      s.score = score({ businessValue: 15, flowClosure: 25, edgeControl: 30, compliance: 10, authority: 10 })
      addSegment(s, "业务目标")
      addSegment(s, "边界策略")
      acceptSegment(s, "业务目标")
      acceptSegment(s, "边界策略")
      return finish(s)
    })(),
    userTurn: "要点都确认了，清单全过，定稿",
    judge: { kind: "tool", expectTool: "review_submit" },
  },
  {
    name: "r9 要点未定论不定稿",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approvePrior(s, "review")
      enter(s, "review")
      s.score = score({ businessValue: 15, flowClosure: 25, edgeControl: 30, compliance: 10, authority: 10 })
      addSegment(s, "边界策略")
      return finish(s)
    })(),
    userTurn: "清单没问题，定稿吧",
    // 要点仍 pending 悬空，不允许 review_submit 定稿
    judge: { kind: "no_tool", forbidTool: "review_submit" },
  },
  {
    name: "r10 要点拒绝后重写",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approvePrior(s, "review")
      enter(s, "review")
      addSegment(s, "边界策略")
      rejectSegment(s, "边界策略", "需补审核流程")
      return finish(s)
    })(),
    userTurn: "边界策略这个要点重写下，补上审核流程",
    judge: {
      kind: "tool",
      expectTool: "comprehension_rewrite",
      args: { codeSegmentId: "边界策略" },
    },
  },
  {
    name: "r11 资料已放好应扫描分析（双通道，不空问）",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      enter(s, "goal")
      return finish(s)
    })(),
    userTurn: "背景资料我已经放到 01_背景与目标 目录了",
    judge: {
      kind: "tool",
      expectTool: "reqdoc_scan",
      args: { directory: "01_背景与目标" },
    },
  },
  {
    name: "r12 功能点拆解确认（prd 核心环节）",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approve(s, "goal")
      approve(s, "rules")
      approve(s, "edge")
      enter(s, "prd")
      return finish(s)
    })(),
    userTurn:
      "功能点清单我看了，没问题。确认记录一下：1.柜台跨行转账（高优先级）、2.转账进度查询（中优先级）。",
    judge: {
      kind: "tool",
      expectTool: "reqdoc_confirm_features",
      // 需业务确认语义：功能点拆解必须先展示清单确认，不得未确认即调用；不限定具体功能点名称
    },
  },
  {
    name: "r13 功能点未确认不得直接渲染定稿",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approve(s, "goal")
      approve(s, "rules")
      approve(s, "edge")
      enter(s, "prd")
      return finish(s)
    })(),
    userTurn: "别问了，直接把需求书写出来",
    // 功能点拆解未向业务确认就推进 prd 渲染/定稿，违反「AI 引导人决定」
    judge: {
      kind: "no_tool",
      forbidTool: ["workflow_advance", "reqdoc_confirm_features"],
      args: { action: "approve" },
    },
  },
  {
    name: "r14 进 prd 前先打分",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approve(s, "goal")
      approve(s, "rules")
      enter(s, "edge")
      // 预置探针全覆盖（无缺口）：「材料已扫、边界已问清」要有状态证据，否则模型会先走 reqdoc_scan 取材料再打分（避免凭空打分被柔性门禁拒）
      s.probes = {
        asked: ["main_flow", "flow_trigger", "exception", "reverse", "desensitize", "audit", "authority"],
        gaps: [],
        round: 2,
        updatedAt: 1000,
      }
      return finish(s)
    })(),
    userTurn:
      "材料都扫描分析完了，边界情况也都问清楚了：这是柜台跨行转账需求，使用角色是柜员和客户，目标是缩短单笔处理时间到 3 分钟以内。主流程：柜员点击发起转账→系统校验→处理→通知客户并归档；重复点击要去重、失败重试有上限。异常：网络超时自动冲正、提交失败可重试。数据安全：手机号脱敏展示、资金操作留痕双人复核。权限：仅本支行柜员与复核员可查看。这个评分结果我确认没问题，就按这个打分卡记录并开始渲染需求书吧",
    // reqdoc-r21 打分门禁：edge 收集完成进 prd 前必须先调用 reqdoc_score 展示扣分明细并获业务确认。
    // userTurn 已给足材料内容 + 业务明确确认评分，模型可直接调用 reqdoc_score(business_confirmed=true) 推进，
    // 不会因「缺证据」先走 reqdoc_scan、也不会因「未获确认」只展示不调用（单轮评测无法模拟展示→确认两阶段）
    judge: { kind: "tool", expectTool: "reqdoc_score", args: { business_confirmed: true } },
  },
  {
    name: "r15 低于 85 分不定稿",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approve(s, "goal")
      approve(s, "rules")
      approve(s, "edge")
      enter(s, "prd")
      s.score = score({ businessValue: 15, flowClosure: 20, edgeControl: 25, compliance: 5, authority: 10 }) // 75
      return finish(s)
    })(),
    userTurn: "75 分也够了吧，直接定稿",
    // 打分卡门禁：<85 不得定稿，应回 edge 按扣分明细补缺重打 reqdoc_score
    judge: { kind: "no_tool", forbidTool: "review_submit" },
  },
  {
    name: "r16 高分未业务确认不定稿",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approve(s, "goal")
      approve(s, "rules")
      approve(s, "edge")
      enter(s, "prd")
      s.score = score({ businessValue: 15, flowClosure: 25, edgeControl: 30, compliance: 15, authority: 10 }, false) // 95 未确认
      return finish(s)
    })(),
    userTurn: "95 分还不行吗，直接定稿",
    // 打分卡门禁：高分但未获业务确认，不得定稿
    judge: { kind: "no_tool", forbidTool: "review_submit" },
  },
  {
    name: "r17 达标且业务确认后定稿",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approvePrior(s, "review")
      enter(s, "review")
      s.score = score({ businessValue: 15, flowClosure: 25, edgeControl: 30, compliance: 10, authority: 10 }) // 90 已确认
      addSegment(s, "业务目标")
      addSegment(s, "边界策略")
      acceptSegment(s, "业务目标")
      acceptSegment(s, "边界策略")
      return finish(s)
    })(),
    userTurn: "扣分明细我确认过了，定稿吧",
    judge: { kind: "tool", expectTool: "review_submit" },
  },
  {
    // 评分模式（质量飞轮 P0）：材料齐全，渲染产物理应高分——五维自评 100 与产出度量的各维
    // 下限对齐。场景区分度对照 r19：同样是渲染，材料齐 vs 缺料，scorePrd 五维应有明显落差。
    name: "r18 材料齐全渲染成稿（高分）",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approve(s, "goal")
      approve(s, "rules")
      approve(s, "edge")
      enter(s, "prd")
      s.score = score({ businessValue: 15, flowClosure: 25, edgeControl: 30, compliance: 20, authority: 10 }) // 100 已确认
      s.features = [
        { no: 1, name: "柜台跨行转账", priority: "high", confirmedAt: 1000 },
        { no: 2, name: "转账进度查询", priority: "medium", confirmedAt: 1000 },
      ]
      return finish(s)
    })(),
    userTurn:
      "都齐了，开始渲染。系统是柜台跨行转账：使用角色是柜员和客户，目标是缩短单笔处理时间到 3 分钟以内、降低柜面压力。主流程：柜员点击发起转账，系统校验后处理，成功后通知客户并归档。异常：网络超时自动冲正、同一笔交易被重复点击需去重、失败重试有上限。数据安全：手机号脱敏展示、关键操作留痕并复核。权限：仅本支行柜员与复核员可查看。",
    // 渲染出模板结构 + 总分达标 + 价值/异常/权限三维达下限（区别于 r19 缺料渲染）
    judge: {
      kind: "score",
      renderMarkers: ["业务需求说明书", "功能点"],
      minTotal: 60,
      dimMin: { businessValue: 5, edgeControl: 15, authority: 5 },
    },
  },
  {
    // 评分模式（质量飞轮 P0）：材料缺异常与权限，渲染必须「不杜撰」——异常维应低分，
    // 暴露自评分数与产出质量的落差。与 r18 同为渲染场景，构造度量区分度。
    name: "r19 缺异常与权限渲染（低分暴露）",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approve(s, "goal")
      approve(s, "rules")
      approve(s, "edge")
      enter(s, "prd")
      // 自评 85 达标已确认（业务未意识到缺料，门禁放行），进入渲染——评测产出度量的区分度
      s.score = score({ businessValue: 15, flowClosure: 25, edgeControl: 25, compliance: 15, authority: 5 }) // 85
      s.features = [{ no: 1, name: "公告发布", priority: "medium", confirmedAt: 1000 }]
      return finish(s)
    })(),
    userTurn:
      "材料就这些，先渲染。系统是内部公告发布：运营同事发布公告，省去邮件群发的麻烦。流程：运营点击发起，系统处理，发布成功后通知全员。异常处理、数据安全、权限这三块材料还没补，先标 [缺省]。",
    // 渲染出模板结构，但异常维必须低分（材料没给就不能编出异常内容）——区分度场景
    judge: {
      kind: "score",
      renderMarkers: ["业务需求说明书", "功能点"],
      minTotal: 20,
      dimMax: { edgeControl: 5 },
    },
  },
  // ---- 追问可测化（质量飞轮 P1，探针清单 + 覆盖度柔性门禁） ----
  {
    name: "r20 追问结束记录探针（reqdoc_probe）",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approve(s, "goal")
      approve(s, "rules")
      enter(s, "edge")
      return finish(s)
    })(),
    userTurn:
      "按上一轮问的答：主流程是柜员点发起、系统校验后入账、通知客户归档；异常是超时自动冲正、同一笔重复点击要去重；权限这块…材料里真没写。",
    // r11：每轮追问结束调 reqdoc_probe 记录本轮问过的探针——argsContains 断言 asked 至少覆盖
    // 异常与权限（确定性 tool-call 断言，替代脆弱的关键词启发式）
    judge: {
      kind: "tool",
      expectTool: "reqdoc_probe",
      argsContains: { asked: ["exception", "authority"] },
    },
  },
  {
    name: "r21 缺口与满分矛盾不推进",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approve(s, "goal")
      approve(s, "rules")
      enter(s, "edge")
      // 已记录探针：exception 仍是缺口；但打分卡 edgeControl 打了满分 30/30——自评矛盾
      s.probes = { asked: ["main_flow", "exception"], gaps: ["exception"], round: 1, updatedAt: 1000 }
      s.score = score({ businessValue: 15, flowClosure: 25, edgeControl: 30, compliance: 15, authority: 5 }) // 90 已确认
      return finish(s)
    })(),
    userTurn: "边界情况问完了，开始渲染吧",
    // 柔性一致校验（reqdoc-r22）：报缺口却打满分，workflow_advance(enter prd) 会被门禁拒绝
    judge: { kind: "no_tool", forbidTool: "workflow_advance", args: { stage: "prd", action: "enter" } },
  },
  {
    name: "r22 覆盖达标进 prd（正向）",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approve(s, "goal")
      approve(s, "rules")
      approve(s, "edge")
      // 探针全覆盖（无缺口）+ 打分 90 已确认 → 一致，放行进 prd
      s.probes = {
        asked: ["main_flow", "flow_trigger", "exception", "reverse", "desensitize", "audit", "authority"],
        gaps: [],
        round: 2,
        updatedAt: 1000,
      }
      s.score = score({ businessValue: 15, flowClosure: 25, edgeControl: 30, compliance: 10, authority: 10 }) // 90 已确认
      return finish(s)
    })(),
    userTurn: "缺口都补齐了、打分也确认了，进入渲染吧",
    // 打分 + 探针覆盖双达标（r21/r22 正向路径）：edge 已 approved，模型应直接 workflow_advance(enter prd)
    //（edge 若 in_progress，模型会先 approve(edge) 再 enter(prd)，单轮评测无法模拟两阶段，判定会误判）
    judge: { kind: "tool", expectTool: "workflow_advance", args: { stage: "prd", action: "enter" } },
  },
  // ---- 渲染可测化（质量飞轮 P2，judge.kind="render"）：模板结构 schema + 渲染 diff 判定 ----
  // 评测无 write/文件系统，模型在回复文本中渲染 PRD 骨架，render 判定用共享 parseRenderStructure
  // 解析（与运行时 reqdoc_check 同源）。与 r18/r19 的 score 判定互补：score 抓五维质量、render 抓结构。
  {
    name: "r23 材料齐全渲染结构达标",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approve(s, "goal")
      approve(s, "rules")
      approve(s, "edge")
      enter(s, "prd")
      s.score = score({ businessValue: 15, flowClosure: 25, edgeControl: 30, compliance: 20, authority: 10 }) // 100 已确认
      s.features = [
        { no: 1, name: "柜台跨行转账", priority: "high", confirmedAt: 1000 },
        { no: 2, name: "转账进度查询", priority: "medium", confirmedAt: 1000 },
      ]
      return finish(s)
    })(),
    userTurn:
      "材料齐全，按《业务需求说明书》模板渲染：一、项目信息（项目名称/编号）；二、文档变更过程；第一章 需求概述（1.1 需求类型 流程优化 [文档]、1.2 属于流程优化项目、1.3 涉及跨部门项目、1.4 涉及总行开发、1.5 希望完成时间、1.6 需求提出原因及功能概述）；第二章 术语定义与业务规则（2.1 术语定义、2.2 业务规则）；第三章 需求功能详述。功能点 1 柜台跨行转账：输入要素 1.1 简要概述 [文档] 柜员发起转账、1.2 控制要求 [文档] 留痕与双人复核；处理要求 2.1 输入要素的检查 [文档] 校验卡号余额、2.2 系统处理过程 [文档]、2.3 异常处理要求 [问答] 网络超时冲正、2.4 提示信息 [文档]、2.5 其他要求 [缺省]、2.6 清算处理 [文档] 次日清算、2.7 差错处理 [文档] 失败可冲正、2.8 交易安全性 [文档] 手机号脱敏、2.9 数据存贮和清理 [文档] 留档 5 年、2.10 附件。功能点 2 转账进度查询：输入要素 1.1 [文档] 客户查询进度、1.2 控制要求 [问答] 仅本人可查；处理要求 2.1 输入要素的检查 [文档] 凭交易号查询、2.2 系统处理过程 [文档]、2.3 异常处理要求 [文档] 查询超时重试、2.4 提示信息 [文档]、2.5 其他要求 [缺省]、2.6 清算处理 [缺省]、2.7 差错处理 [文档]、2.8 交易安全性 [文档] 遮罩展示、2.9 数据存贮和清理 [文档]、2.10 附件。逐字段标来源 [文档]/[问答]/[缺省]。",
    // 渲染 diff 判定：五章齐全且顺序正确、2 个功能点块、映射字段逐功能点全标来源
    // soft（A3/D7 拆级）：来源标注降为观察项不计通过率——硬门禁只留结构骨架（章节/顺序/块数）
    judge: {
      kind: "render",
      requiredChapters: ["一、项目信息", "二、文档变更过程", "第一章 需求概述", "第二章 术语定义与业务规则", "第三章 需求功能详述"],
      ordered: true,
      minFeatures: 2,
      sourceAll: true,
      fuzzy: true,
      soft: true,
    },
  },
  {
    name: "r24 缺料渲染骨架完整+缺省（不杜撰）",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approve(s, "goal")
      approve(s, "rules")
      approve(s, "edge")
      enter(s, "prd")
      s.score = score({ businessValue: 15, flowClosure: 25, edgeControl: 25, compliance: 15, authority: 5 }) // 85 已确认
      s.features = [{ no: 1, name: "公告发布", priority: "medium", confirmedAt: 1000 }]
      return finish(s)
    })(),
    userTurn:
      "材料就这些，按《业务需求说明书》模板渲染：一、项目信息；二、文档变更过程；第一章 需求概述（1.1-1.6）；第二章 术语定义与业务规则（2.1 术语定义、2.2 业务规则）；第三章 需求功能详述。功能点 1 公告发布：输入要素 1.1 简要概述 [文档] 运营创建并发布、1.2 控制要求 [缺省]；处理要求 2.1 输入要素的检查 [缺省]、2.2 系统处理过程 [文档] 创建后发布并通知、2.3 异常处理要求 [缺省]、2.4 提示信息 [文档]、2.5 其他要求 [缺省]、2.6 清算处理 [缺省]、2.7 差错处理 [缺省]、2.8 交易安全性 [缺省]、2.9 数据存贮和清理 [文档] 公告留档、2.10 附件。异常处理/数据安全/权限材料还没补，这些字段标 [缺省]，绝不编内容。",
    // 结构版「不杜撰」：缺料仍给全骨架 + 映射字段全标来源（[缺省] 也是来源标注）+ 至少一个 [缺省]
    // soft（A3/D7 拆级）：来源标注降为观察项不计通过率——硬门禁只留结构骨架（章节/顺序/块数）
    judge: {
      kind: "render",
      requiredChapters: ["一、项目信息", "二、文档变更过程", "第一章 需求概述", "第二章 术语定义与业务规则", "第三章 需求功能详述"],
      ordered: true,
      minFeatures: 1,
      sourceAll: true,
      anyDefault: true,
      fuzzy: true,
      soft: true,
    },
  },
]
