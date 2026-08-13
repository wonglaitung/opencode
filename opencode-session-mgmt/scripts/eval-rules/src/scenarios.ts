/**
 * 评测场景集(18 个,sdlc s1-s11 + reqdoc r1-r7)。覆盖关键规则:
 * 基线录入不重复、确认后 approve、无确认不 approve、回到XX→revisit、
 * 审查逐段不批量、前序未完成不 submit、提交前查门禁、完成后提示 /new、
 * 完成后开新需求不重启、空档态继续进入下一阶段、reqdoc 渐进引导/业务确认/定稿后提示 /new。
 * 状态夹具用 createWorkflowState + 直接 mutate(不跑真实工具循环),
 * 隔离「规则遵循度」与「工具机制」两个变量。
 */
import { createWorkflowState, getDefinition, reviewRecord, type WorkflowState } from "sm-shared"
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
    judge: { kind: "tool", expectTool: "comprehension_confirm", exactCount: 2, distinctArg: "codeSegmentId" },
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

  // ---- reqdoc ----
  {
    name: "r1 渐进引导 ≤2 问",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      enter(s, "goal")
      return finish(s)
    })(),
    userTurn: "想做内部工单系统，帮我梳理需求",
    judge: { kind: "text", type: "maxQuestions", max: 2, note: "判定口径脆弱,需人工复核" },
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
      categories: [
        ["权限", "隔离", "岗位可见", "数据权限"],
        ["异常", "超时", "驳回", "失败", "补单"],
        ["审计", "合规", "留痕", "二次授权"],
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
]
