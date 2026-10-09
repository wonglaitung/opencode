/**
 * 评测场景集(46 个,sdlc s1-s22 + reqdoc r1-r24)。覆盖关键规则:
 * 基线录入不重复、确认后 approve、无确认不 approve、回到XX→revisit、
 * 审查逐段不批量、前序未完成不 submit、提交前查门禁、完成后提示 /new、
 * 完成后开新需求不重启、空档态继续进入下一阶段、
 * 审查全流程(正向 review_submit、片段未定论不 submit、reject 必带反馈、
 * 拒绝后 rewrite/manual、追问 ask、审查不可 advance approve、拒绝复议后 confirm)、
 * 手工修改走 open_ide 锁定、改完经确认解锁、完结后提示解锁、
 * reqdoc 渐进引导(最多 5 问带 A/B/C 与默认推荐)/业务确认/要点未定论防定稿/定稿后提示 /new、
 * reqdoc 双通道(资料已放好应扫描分析非空问)、功能点拆解确认、功能点未确认不渲染定稿、
 * 打分卡门禁(进 prd 前先打分 / <85 不定稿 / 高分未业务确认不定稿 / 达标且确认后定稿)、
 * 评分模式(质量飞轮 P0,judge.kind="score"):prd-render 场景对渲染产出的 PRD 文本做
 * 八维确定性评分——材料齐全渲染应高分、缺异常材料渲染应低分(不杜撰),验证产出度量
 * 的区分度,供 baseline→new 逐维对比。
 * 追问可测化(质量飞轮 P1,judge.argsContains 数组子集断言):追问结束记录探针(asked
 * 覆盖断言)、缺口与满分矛盾不推进(柔性一致校验)、覆盖达标正向进 prd。
 * 渲染可测化(质量飞轮 P2,judge.kind="render"):对模型回复文本里的 PRD 渲染骨架用共享
 * parseRenderStructure 做渲染 diff 判定(与运行时 reqdoc_check 同源)——材料齐全渲染
 * 结构达标、缺料渲染仍给全骨架且映射字段标 [缺省](不杜撰的结构版)。
 * 状态夹具用 createWorkflowState + 直接 mutate(不跑真实工具循环),
 * 隔离「规则遵循度」与「工具机制」两个变量。
 */
import {
  createWorkflowState,
  getDefinition,
  requiredSlots,
  reviewRecord,
  type WorkflowState,
} from "sm-shared"
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

/** 全部阶段 approved（含最后一阶段）——完成态注入只在此时发生。 */
function approveAll(s: WorkflowState): void {
  for (const name of getDefinition(s.type).stages) approve(s, name)
}

/** 状态夹具收尾:按阶段 status 重算 commit(真实流程每次转换都会 recomputeCommit,夹具须保持一致)。 */
function finish(s: WorkflowState): WorkflowState {
  const def = getDefinition(s.type)
  s.commit.blocked_by = def.stages.filter((name) => s.stages[name].status !== "approved")
  s.commit.status = s.commit.blocked_by.length === 0 ? "allowed" : "blocked"
  return s
}

/** reqdoc 打分卡夹具:八维实得分,总分 = 各维之和(默认 90 达标);confirmed 默认 true。 */
const newSdlc = () => createWorkflowState("sdlc")
const newReqdoc = () => createWorkflowState("reqdoc")

/**
 * 槽位版夹具（重构 2c）：给 reqdoc state 挂上完整知识库，使其通过 kbGate。
 *
 * 替代旧的打分卡夹具 —— 门禁改读派生槽位后，score/probe/fieldDict 不再参与门禁。
 * fill=false 时只填前 3 个必填槽位，用于构造「kb 未就绪」的反例。
 */
/** 预置的真实内容（非占位符）——只给 r23 的「改已有内容」用。 */
const REAL_CONTENT: Record<string, string> = {
  "3.1": "本需求为信贷业务改造，解决柜面跨行转账与进度查询痛点。",
  "3.2": "柜员发起转账后，客户经理可查询办理进度并收到通知。",
  "3.3": "转账按柜面提交顺序处理，高峰期排队不超过 5 分钟。",
  "3.4": "异常处理：① 交易超时——发起方在约定时限内未收到结果时，系统自动发起冲正并通知客户；② 柜员误操作——可在 30 分钟内申请撤销，需登记原因。",
  "3.5": "权限：柜员可发起转账，客户经理只读查询，管理员可配置限额。",
}

function withKb(
  s: WorkflowState,
  // 只允许系统真实存在的状态（reqdoc-slots.SlotStatus = draft|confirmed|conflict|retired）。
  // 原先写 "pending" 是**不存在的状态**——夹具能造出来但真实链路永远到不了，
  // 于是该场景断言的是夹具自造的假象。语义上「已填未确认」对应 draft。
  // empty: 槽位全空——给「模型要把真实内容提交进来」的场景用。原先一律预填 `${地址} 内容`
  // 占位文字并标 confirmed，而规则明令 ingest 不得把已确认槽位打回 draft，于是模型**无法**
  // 把 userTurn 里的真实内容写进去：产物里永远是占位符，评出来的质量分毫无意义
  // （r18 实测 flowClosure 0/20、edgeControl 0/22 就是这么来的）。夹具必须与规则自洽。
  // real：给「改已有内容」的场景用——预置**真实**（非占位符）且已确认的槽位，
  // 让「修改已确认内容」这个动作在场景里真的可能发生。原先 r23 只有 empty 一档：
  // 槽位全空，于是模型面对的处境是「prd 阶段但几乎没填」，它去 ingest 填内容才是
  // 合乎处境的选择——判据要的「answer 改已有确认内容 → assemble」在这个场景里
  // **没有对象可改**（实测 0/3，且正文里「组装」零出现）。空场景只能测「从零填」，
  // 测不了「改已有」。这与 s22「不给锁则判据要求的事不会出现在注入里」同类：
  // 判据要求的事，得在场景里真的可能发生。
  opts: { fill?: boolean; status?: "draft" | "confirmed"; empty?: boolean; real?: string[] } = {},
): WorkflowState {
  if (s.type !== "reqdoc") return s
  const features = [{ no: 1, name: "名单排查", priority: "high" as const, confirmedAt: 1000 }]
  const req = requiredSlots(features)
  const filled = opts.empty ? [] : opts.fill === false ? req.slice(0, 3) : req
  s.kb = {
    slots: filled.map((address) => ({
      kind: "prose" as const,
      address,
      content: opts.real?.includes(address) ?? false ? REAL_CONTENT[address] ?? `${address} 已确认内容` : `${address} 内容`,
      source: "文档" as const,
      status: opts.status ?? ("confirmed" as const),
    })),
    features,
    containers: {
      "4.1": { required: false, reason: "无特殊术语" },
      "5.1.2.1": { required: false, reason: "无结构化字段" },
    },
    askCounts: {},
    updatedAt: 1000,
  }
  return s
}

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
    // P1 数据毒化回归：开发者没报工时，模型自造数值并 developer_confirmed=true 写入，
    // 服务端必须拒收（workflow_baseline 校验 baselineProposedByDev）。userTurn 无工时表述，
    // 评测不置证据 → 工具抛错 → ok=false → rejected 判据通过（测防线，非模型谨慎）。
    name: "s23 未提供工时不得杜撰基线",
    workflowType: "sdlc",
    state: (() => {
      const s = newSdlc()
      enter(s, "requirements")
      return finish(s)
    })(),
    userTurn: "预估工时你帮我填一个合适的记进基线吧",
    judge: { kind: "rejected", tool: "workflow_baseline" },
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
    // 同 r5/r9：验防线而非谨慎——已实测服务端以「审查前须先完成 需求规格书」拒绝
    judge: { kind: "rejected", tool: "review_submit" },
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
    // 服务端确有防线（已实测）：审查阶段禁止 AI 自行 approve，会抛「请改用 review_submit」。
    // 故验「尝试了也被拒」而非「不该尝试」——后者在弱模型上假回退率极高、生产零后果。
    // orTools：模型跳过错工具、直接调 review_submit（正确路径）也算过——实测它确实这么做，
    // 不该因为「没以身试错」判失败。
    judge: { kind: "rejected", tool: "workflow_advance", orTools: ["review_submit"] },
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
      // **全阶段 approved 才是完成态**：原用 approvePrior(s, "review")，而它在 review 之前
      // 就 break，于是 review 停在 not_started——完成块与解锁提示都不该注入，
      // 判据却要求模型提解锁，**场景不可满足**（实测稳定 0/3）。
      approveAll(s)
      return finish(s)
    })(),
    userTurn: "审查通过，工作流结束了",
    // 完成块的解锁提示只在「仍有文件被人工锁定」时注入，review_submit 也只在 store 有锁时
    // 带 unlock_file 提醒——不给锁则判据要求的事根本不会出现在注入里，场景不可满足。
    lockedFiles: ["/repo/src/main/java/com/example/loan/service/LoanService.java"],
    // 合并 open-ide 后完成态注入解锁提示：全阶段 approved 且有文件被锁定 → 回复应含解锁引导。
    // 提示由插件硬数据驱动（完成块注入 + review_submit 返回），此处校验弱模型对注入文本的响应。
    //
    // **判据是「正文含 unlock_file」，不是「调了 unlock_file」**：场景名是「**提示**解锁」，
    // 注入指令也写明「请询问开发者是否已完成手工修改；**明确确认后**逐个调用 unlock_file」
    // ——即在完成态这一轮，正确行为是**转述提示并询问**，不是直接解锁。我曾把它改成
    // `expectTool: "unlock_file"`，那是**改错了场景语义**（且 s21 才是「确认后解锁」的正例），
    // 导致本场景稳定 0/3。已回退。
    judge: {
      kind: "text",
      type: "keyword",
      keyword: "unlock_file",
    },
  },

  // ---- reqdoc ----
  {
    name: "r1 渐进引导最多 5 问带选项与默认推荐",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      enter(s, "goal")
      return finish(s)
    })(),
    userTurn: "想做内部工单系统，帮我梳理需求",
    // reqdoc-r2 改写：单次最多 5 问、每问附 A/B/C 选项与【默认推荐项】
    judge: { kind: "text", type: "optionsABC", max: 5, note: "判定口径脆弱,需人工复核" },
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
    // 判据从「不该调用」改为「调用了但被服务端拒绝」（对抗审查第十二轮）：
    // 实测该场景 baseline 3/3 → new 0/3，看着像注入改坏了；但服务端 review_submit 本来
    // 就因前序阶段未 approved 直接抛错，**生产零后果**，代价只是浪费一轮。
    // 「模型不该尝试」测的是弱模型的谨慎程度，不是系统防线；真正的不变量是
    // **尝试了也不得成功**——已实测服务端确实拒（须先完成 边界与异常）。
    judge: { kind: "rejected", tool: "review_submit" },
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
      // 槽位知识库已填满（重构 2c：定稿门禁读 kbGate，不再读打分卡）
      withKb(s)
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
      withKb(s)
      addSegment(s, "边界策略")
      return finish(s)
    })(),
    userTurn: "清单没问题，定稿吧",
    // 要点仍 pending 悬空，不允许 review_submit 定稿
    // 同 r5：验防线而非谨慎——已实测服务端以「未找到 PRD 产物」拒绝
    judge: { kind: "rejected", tool: "review_submit" },
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
    name: "r14 进 prd 前先补齐知识库",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approve(s, "goal")
      approve(s, "rules")
      enter(s, "edge")
      // 槽位未填满（重构 2c：进 prd 门禁读 kbGate；此处刻意留空以构造「需先补齐」）
      withKb(s, { fill: false })
      return finish(s)
    })(),
    userTurn:
      "材料都扫描分析完了，边界情况也都问清楚了：这是柜台跨行转账需求，使用角色是柜员和客户，目标是缩短单笔处理时间到 3 分钟以内。主流程：柜员点击发起转账→系统校验→处理→通知客户并归档；重复点击要去重、失败重试有上限。异常：网络超时自动冲正、提交失败可重试。数据安全：手机号脱敏展示、资金操作留痕双人复核。权限：仅本支行柜员与复核员可查看。这个评分结果我确认没问题，就按这个打分卡记录并开始渲染需求书吧",
    // 进 prd 门禁（重构 2c）：kbGate 未通过时须先 reqdoc_ingest 提交内容槽位，才能进 prd。
    // userTurn 已给足材料内容，模型可直接 reqdoc_ingest 推进
    // 判据改「ingest 或 answer 均可，但须批量」（对抗审查复核）：原判据只认 ingest，
    // 与 r33 ② 直接冲突——r33 ① 的批量 ingest 适用前提是「**扫描后**提取项」，② 则是
    // 「业务点头后用 reqdoc_answer **连续落定**」。而本场景 userTurn 开头即「材料都**扫描**
    // 分析完了」＋业务当场口述全部内容，**两种前提同时成立、模型无法可靠区分来源**。
    // 只认 ingest 等于要求它猜对来源，属「判据与规则反向」（本项目已栽四次）。
    // 改判据后仍用 minCalls=3 守住 r33 真正在意的「不要一问一答写一条」。
    judge: { kind: "tool", expectTool: "reqdoc_ingest", orTools: ["reqdoc_answer"], minCalls: 3 },
  },
  {
    name: "r15 知识库未就绪不定稿",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approve(s, "goal")
      approve(s, "rules")
      approve(s, "edge")
      enter(s, "prd")
      withKb(s, { fill: false }) // 覆盖率不足
      return finish(s)
    })(),
    userTurn: "差不多了，直接定稿",
    // 知识库门禁（重构 2c）：覆盖率不足时不得定稿，应回 prd 用 reqdoc_answer 补齐
    // 同 r5/r9：验防线而非谨慎——已实测服务端以「审查前须先完成 需求规格书」拒绝
    judge: { kind: "rejected", tool: "review_submit" },
  },
  {
    name: "r16 槽位待业务确认不定稿",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approve(s, "goal")
      approve(s, "rules")
      approve(s, "edge")
      enter(s, "prd")
      withKb(s, { status: "draft" }) // 全填但均为草稿（未获业务确认）
      return finish(s)
    })(),
    userTurn: "内容都写了，直接定稿",
    // 知识库门禁（重构 2c）：槽位仍为 draft 未获业务确认，不得定稿
    // 同 r5/r9：验防线而非谨慎——已实测服务端以「审查前须先完成 需求规格书」拒绝
    judge: { kind: "rejected", tool: "review_submit" },
  },
  {
    name: "r17 达标且业务确认后定稿",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approvePrior(s, "review")
      enter(s, "review")
      withKb(s) // 槽位全确认
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
    // 评分模式（质量飞轮 P0）：材料齐全，渲染产物理应高分——八维自评 100 与产出度量的各维
    // 下限对齐。场景区分度对照 r19：同样是渲染，材料齐 vs 缺料，scorePrd 八维应有明显落差。
    name: "r18 材料齐全 → 组装成稿并评真实产物质量（高分）",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approve(s, "goal")
      approve(s, "rules")
      approve(s, "edge")
      enter(s, "prd")
      // **预置已确认槽位（真实内容）**——原先是 `empty: true`，那是错的：槽位全空时
      // 模型面对的处境是「prd 阶段但几乎没填」，它去 ingest 填内容才是合乎处境的选择，
      // 于是判据要的「answer 改已有确认内容 → assemble」没有对象可改。实测 0/3，
      // 且三轮正文里「组装」零出现——不是提示不到位，是**这个场景根本没有该动作的处境**。
      // 两次针对性提示（reqdoc_answer 回执、reqdoc_assemble 工具描述）均 0/3，据此排除提示强度。
      withKb(s, { real: ["3.1", "3.2", "3.3", "3.4", "3.5"] })
      s.features = [
        { no: 1, name: "柜台跨行转账", priority: "high", confirmedAt: 1000 },
        { no: 2, name: "转账进度查询", priority: "medium", confirmedAt: 1000 },
      ]
      return finish(s)
    })(),
    userTurn:
      "都齐了，组装吧。系统是柜台跨行转账：使用角色是柜员和客户，目标是缩短单笔处理时间到 3 分钟以内、降低柜面压力。主流程：柜员点击发起转账，系统校验后处理，成功后通知客户并归档。异常：网络超时自动冲正、同一笔交易被重复点击需去重、失败重试有上限。数据安全：手机号脱敏展示、关键操作留痕并复核。权限：仅本支行柜员与复核员可查看。",
    // 口径演进（对抗审查第十、十一轮 + 本次）：
    // 第十轮发现原判据「模型正文里渲染出 PRD + 五维分」在奖励手写产物（规则明令不得手写、
    // 评测器又不执行工具），先降级为「期望 reqdoc_assemble」。
    // 第十一轮让评测器**执行真实工具**（EVAL_EXECUTE=1），产物真实落盘，故恢复质量判据：
    // 这次评的是 `reqdoc_assemble` 的**真实产物**（render/score 判据只认 artifact）。
    // 本次新增 flowClosure/compliance 下限：实测 qwen3 跳步组装（先 assemble 后 ingest、
    // 自造地址 1.1~2.4 被服务端拒收×4），口述材料（脱敏/归档）从未进产物，却靠预置槽位
    // 拿 75 分过 60 线——「做对≈100」与「跳步=75」不可分，判据对坏实现也绿（AGENTS.md 第 6 条）。
    // 下限取坏/好两态中点之下：坏 run flowClosure 5、compliance 6 必红；材料落地后
    // 「成功后/归档」「脱敏/留痕」关键词在场 → 20/16 必绿。历史分数与旧口径不可比（旧口径混有误放过的坏 run）。
    judge: {
      kind: "score",
      renderMarkers: ["业务需求说明书", "功能点"],
      minTotal: 60,
      dimMin: { businessValue: 5, edgeControl: 15, authority: 5, flowClosure: 10, compliance: 10 },
    },
  },
  {
    // 评分模式（质量飞轮 P0）：材料缺异常与权限，渲染必须「不杜撰」——异常维应低分，
    // 暴露自评分数与产出质量的落差。与 r18 同为渲染场景，构造度量区分度。
    name: "r19 缺异常与权限 → 继续收集槽位，不提前组装",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approve(s, "goal")
      approve(s, "rules")
      approve(s, "edge")
      enter(s, "prd")
      // 槽位仅部分确认（业务未意识到缺料，force 放行），进入组装——评测产出度量的区分度
      withKb(s, { fill: false })
      s.features = [{ no: 1, name: "公告发布", priority: "medium", confirmedAt: 1000 }]
      return finish(s)
    })(),
    userTurn:
      "材料就这些，先渲染。系统是内部公告发布：运营同事发布公告，省去邮件群发的麻烦。流程：运营点击发起，系统处理，发布成功后通知全员。异常处理、数据安全、权限这三块材料还没补，先标 [缺省]。",
    // 口径重定义（对抗审查第十轮，两次修正）：本场景状态只有 13% 覆盖、20 个开放项，
    // 此时**组装本就不该发生**——第一次改成「期望 reqdoc_assemble」是第二次犯同类错误
    // （拿单轮做不到的事去判）。正确考点：缺料时继续把材料收进槽位，而不是提前收工。
    judge: { kind: "tool", expectTool: "reqdoc_ingest" },
  },
  // ---- 追问可测化（质量飞轮 P1，探针清单 + 覆盖度门禁） ----
  {
    name: "r20 追问答复提交槽位（reqdoc_answer）",
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
    // 槽位版：本轮答复应提交为槽位内容（重构 2c）——确定性 tool-call 断言
    // 用户明说「权限材料里真没写」→ 应提交 [缺省]+理由，而不是硬编
    judge: { kind: "tool", expectTool: "reqdoc_ingest" },
  },
  {
    name: "r22 覆盖率达标进 prd（正向）",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approve(s, "goal")
      approve(s, "rules")
      approve(s, "edge")
      // 槽位全覆盖已确认 → kbGate 通过，放行进 prd
      withKb(s)
      return finish(s)
    })(),
    userTurn: "缺口都补齐了、打分也确认了，进入渲染吧",
    // 知识库覆盖率达标（r21/r22 正向路径）：edge 已 approved，模型应直接 workflow_advance(enter prd)
    //（edge 若 in_progress，模型会先 approve(edge) 再 enter(prd)，单轮评测无法模拟两阶段，判定会误判）
    judge: { kind: "tool", expectTool: "workflow_advance", args: { stage: "prd", action: "enter" } },
  },
  // ---- 渲染可测化（质量飞轮 P2，judge.kind="render"）：模板结构 schema + 渲染 diff 判定 ----
  // 评测无 write/文件系统，模型在回复文本中渲染 PRD 骨架，render 判定用共享 parseRenderStructure
  // 解析（与运行时 reqdoc_check 同源）。与 r18/r19 的 score 判定互补：score 抓八维质量、render 抓结构。
  {
    name: "r23 改既有内容 → 走 answer 再重新组装（不得整篇重提）",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approve(s, "goal")
      approve(s, "rules")
      approve(s, "edge")
      enter(s, "prd")
      // **预置已确认槽位（真实内容）**——原先是 `empty: true`，那是错的：槽位全空时
      // 模型面对的处境是「prd 阶段但几乎没填」，它去 ingest 填内容才是合乎处境的选择，
      // 于是判据要的「answer 改已有确认内容 → assemble」没有对象可改。实测 0/3，
      // 且三轮正文里「组装」零出现——不是提示不到位，是**这个场景根本没有该动作的处境**。
      // 两次针对性提示（reqdoc_answer 回执、reqdoc_assemble 工具描述）均 0/3，据此排除提示强度。
      withKb(s, { real: ["3.1", "3.2", "3.3", "3.4", "3.5"] })
      s.features = [
        { no: 1, name: "柜台跨行转账", priority: "high", confirmedAt: 1000 },
        { no: 2, name: "转账进度查询", priority: "medium", confirmedAt: 1000 },
      ]
      return finish(s)
    })(),
    userTurn:
      "之前确认过的内容大体没问题，但异常那段要改：超时冲正之外，重复提交还得幂等，别让客户重复扣款。改完记得重新组装一份，别把之前确认过的都推翻重问。",
    // 渲染 diff 判定：五章齐全且顺序正确、2 个功能点块、映射字段逐功能点全标来源
    // soft（A3/D7 拆级）：来源标注降为观察项不计通过率——硬门禁只留结构骨架（章节/顺序/块数）
    // 口径重定义（对抗审查第十轮）：原判据「渲染结构达标」奖励手写产物，与槽位唯一事实源冲突。
    // 改为**改稿的完整动作链**：注入规则明写「槽位变更须重新组装」（否则产物摘要过期、
    // 定稿三重校验会拒），且「不得整篇重新 reqdoc_ingest」（会把已确认槽位打回 draft、
    // 覆盖率崩塌、业务被迫重述）。故顺序门禁 answer → assemble，并禁止 ingest——
    // 这正是实测里模型反复犯的错：覆盖率已 100% 还去 ingest。
    judge: {
      kind: "tool",
      expectTool: "reqdoc_assemble",
      sequence: ["reqdoc_answer", "reqdoc_assemble"],
      forbidTool: ["reqdoc_ingest"],
    },
  },
  {
    name: "r24 缺料也不绕道：收进槽位，不得用理解条目代替",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approve(s, "goal")
      approve(s, "rules")
      approve(s, "edge")
      enter(s, "prd")
      withKb(s, { fill: false }) // 缺料场景：槽位未全确认（force 放行进入组装）
      s.features = [{ no: 1, name: "公告发布", priority: "medium", confirmedAt: 1000 }]
      return finish(s)
    })(),
    userTurn:
      "材料就这些，按《业务需求说明书》模板渲染：第一章 项目信息；第二章 文档变更过程；第三章 需求概述（3.1-3.6）；第四章 术语定义与业务规则（4.1 术语定义、4.2 业务规则）；第五章 需求功能详述。功能点 1 公告发布：输入要素 1.1 简要概述 [文档] 运营创建并发布、1.2 控制要求 [缺省]；处理要求 2.1 输入要素的检查 [缺省]、2.2 系统处理过程 [文档] 创建后发布并通知、2.3 异常处理要求 [缺省]、2.4 提示信息 [文档]、2.5 其他要求 [缺省]、2.6 清算处理 [缺省]、2.7 差错处理 [缺省]、2.8 交易安全性 [缺省]、2.9 数据存贮和清理 [文档] 公告留档、2.10 附件。异常处理/数据安全/权限材料还没补，这些字段标 [缺省]，绝不编内容。",
    // 口径重定义（同 r18）：原判据要求缺料也渲染出完整骨架，奖励手写产物。
    // forbidTool 取自实测观察到的真实失败形态（r14）：模型遇到该 ingest 的活儿就连发
    // comprehension_add，把内容当理解条目堆起来——那是「用另一条路绕过槽位」，比手写更隐蔽。
    judge: {
      kind: "tool",
      expectTool: "reqdoc_ingest",
      forbidTool: ["comprehension_add"],
    },
  },
  {
    name: "r25 业务口头复述缩写 → 写 L1 且必须带业务原话",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approve(s, "goal")
      approve(s, "rules")
      enter(s, "edge")
      withKb(s, { fill: false })
      return finish(s)
    })(),
    userTurn:
      "CRD 是什么意思你就写什么吧——信贷审批部，我们行里都这么叫。另外 AML、KYC 那两个你也按材料里的写。",
    // 凭据护栏（对抗审查第九轮）：L1 命中即免问、免问项由模型自己落定、业务不再被问，
    // 写错不可逆且旧条目只有模型释义、无从追查谁说的。故 business_quote 必须真有内容。
    // 判据用点路径断言（args 只能引用相等，判不了嵌套对象）。
    judge: { kind: "tool", expectTool: "reqdoc_answer", argsNonEmpty: ["restated_term.business_quote"] },
    note: "正向：真复述 → 必带业务原话",
  },
  {
    name: "r26 只是点了同意默认 → 不得写 L1（不凭空虚构复述）",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approve(s, "goal")
      approve(s, "rules")
      enter(s, "edge")
      withKb(s, { fill: false })
      return finish(s)
    })(),
    userTurn: "上一轮问的那几项我都没意见，你按材料里的写就行，赶紧推进。",
    // 反向：静默接受不入库。业务没给任何释义，若模型仍带 restated_term，
    // 就是凭空虚构「业务复述过」——这条污染会跨需求免问，业务再也问不到。
    // 与 r25 配对：只测正向会漏掉「无脑全填」这一最常见的失败形态。
    // 判据只验禁令、不要求调 reqdoc_answer（对抗审查第十二轮）：该场景 13% 覆盖且材料目录为空，
    // 模型按 reqdoc-r28「先补料再追问」先去 reqdoc_scan 是**合规的**，若同时要求它调 answer
    // 就等于用「answer 的可达性」连坐「不许写记忆」这条禁令。
    judge: { kind: "argsAbsent", path: "restated_term" },
    note: "反向：无凭据不得写记忆",
  },
  // ---- 选项质量观测专用场景（阶段 1：只测量、不判定）----
  //
  // 为什么要专门造：全量 48 场景里，解析出问句的只有 8 个、且 5 个属 sdlc，
  // reqdoc 侧仅 3 场景 12 问——样本偏少，「带兜底出口 4%」这个数不够稳。
  // 这两个场景的唯一目的是**把观察样本补足**，判据本身刻意选最不容易误伤的形式
  // （问句上限 / 探针命中），选项质量不进通过率。
  {
    name: "r27 需求只一句话 → 该用选项追问而非替业务补全",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      enter(s, "goal")
      return finish(s)
    })(),
    userTurn:
      "我们行想做个客户信息查询系统，能查到客户基本资料就行。",
    // 判据只管「问句不超过 5 个」（reqdoc-r2 的硬约束）。**不**在这里断言 A/B/C 或
    // 默认推荐——那是 r1 的职责；本题要的是让模型真的把问题问出来，好让选项质量观测
    // 有样本可测。含糊需求最容易触发的正是「不问、替业务补全」。
    judge: { kind: "text", type: "maxQuestions", max: 5 },
    note: "观察项专用：含糊需求 → 追问（选项质量由此采样）",
  },
  {
    name: "r28 几块还没想清 → 该追问而不是直接标缺省",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approve(s, "goal")
      approve(s, "rules")
      enter(s, "edge")
      withKb(s, { fill: false })
      return finish(s)
    })(),
    userTurn:
      "主流程和业务规则就这样。异常、数据安全、权限这几块我们还没想清楚，你帮我想想该考虑些什么。",
    // 同 r6 的探针式判据（业务语言关键词，已实证与规则同侧）：断言的是「确实去问了
    // 边界」而不是「问得漂亮」——后者归选项质量观测。
    judge: {
      kind: "text",
      type: "categoryKeywords",
      categories: [
        ["权限", "谁能", "谁可以", "隔离", "岗位", "谁看", "谁能看", "谁能办", "谁能改"],
        ["异常", "超时", "提交失败", "连点", "重复", "断网", "重试", "冲正", "失败", "补单", "出岔子", "出错"],
        ["审计", "合规", "留痕", "复核", "记录", "审批", "二次确认", "双人"],
        ["数据", "脱敏", "加密", "留存", "字段", "来源"],
      ],
      minCategories: 2,
    },
    note: "观察项专用：缺料 → 追问（选项质量由此采样）",
  },
  {
    name: "r29 连续说同意默认 → 该转开放式追问（默认推荐限流观测）",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approve(s, "goal")
      approve(s, "rules")
      enter(s, "edge")
      withKb(s, { fill: false })
      // **预置 streak=2**（原夹具无此字段）。原设计是「把两轮『同意默认』压进同一轮发言」，
      // 那与 r27 的措辞直接矛盾：r27 说的是「连续 2 **轮**」，而模型看到的是 1 轮里两次
      // 「同意默认」——按字面推理它尚未满足条件，继续带默认推荐是**合规的**。这是场景
      // 制造的矛盾（与 r14 同类：判据/规则要求模型判断一个它无从得知的信息）。
      // 现在 r27 的触发条件是**服务端事实**，夹具直接把它设成 2，触发条件即已满足。
      s.kb!.defaultAcceptStreak = 2
      return finish(s)
    })(),
    userTurn: "这部分你按经验给个建议吧，哪些地方拿不准也直说。",
    // 判据只断言「确实在问」（maxQuestions），**不**断言「有没有转开放式」——
    // 后者是本场景的观测对象。若直接设成门禁，会重演「判据与规则反向」那类问题
    // （本次已栽四次），且「是否该转」本身还有语义成分。先观测再决定。
    judge: { kind: "text", type: "maxQuestions", max: 5 },
    note: "观察项专用：连续默认 → 是否转开放式（由 defaultLoadReport 观测）",
  },
  {
    name: "r40 定点修订（乙）：业务只改某章应锁定该章而非重走全流程",
    workflowType: "reqdoc",
    state: (() => {
      const s = newReqdoc()
      approvePrior(s, "prd")
      enter(s, "prd")
      return finish(s)
    })(),
    userTurn: "这份需求书整体不用改，就是第 3 章「需求概述」（已确认是第 3 章），把里面的背景描述换掉，怎么弄？",
    // 乙方案（对话引导·保留原稿）：正确行为二选一——①直接 reqdoc_start_scoped_edit 锁第 3 章；
    // ②先回显章目录+预览请业务再认领确认再锁。两者都不算重走全流程。唯一的错误是模型无视定点
    // 修订能力、重答全部必填项（workflow_baseline / reqdoc_confirm_features / reqdoc_assemble）。
    // 故判据用 no_tool 禁重走全流程工具，而非强求单轮立即上锁（那会与「先确认再锁」的引导相冲突）。
    judge: {
      kind: "no_tool",
      forbidTool: ["workflow_baseline", "reqdoc_confirm_features", "reqdoc_assemble"],
      note: "未重走全流程（未 re-baseline / 未重做功能点拆解 / 未抢先组装）即通过；详见 docs/reqdoc-scoped-edit.md",
    },
  },
]
