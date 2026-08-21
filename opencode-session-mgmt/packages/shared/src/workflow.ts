/**
 * WorkflowState 及子结构类型定义（设计文档 session-management.md 3.2；reqdoc 专属结构见 workflow-reqdoc.md 5/6/7 章）。
 * 插件、CLI、收集服务三方共用的契约——任何字段变更必须三包同步。
 *
 * 多流程就绪：阶段键/清单/规则/门禁均从 WorkflowDefinition 注册表驱动，而非硬编码。
 * sdlc 与 reqdoc 均已注册（设计文档 session-management.md 3.2 注册表；定义分别见 workflow-sdlc.md 2 章、workflow-reqdoc.md 2 章）。
 */
import { renderCheckRubric } from "./reqdoc-render"
import type { ReqdocRender } from "./reqdoc-render"

export type WorkflowType = "sdlc" | "reqdoc"

export type StageStatus = "not_started" | "in_progress" | "approved"

export type TransitionAction = "enter" | "revisit" | "approve"

export interface Transition {
  action: TransitionAction
  at: number
  note?: string
}

export interface StageRecord {
  status: StageStatus
  revision: number
  transitions: Transition[]
}

/** 可接手标准检查项（3.2，sdlc 专属）：键→布尔，具体项由审查阶段定义驱动。 */
export interface ReviewChecklist {
  [key: string]: boolean
}

/** 片段评审去留状态机（3.2 审查）：add→pending；confirm→accepted；reject→rejected；rewrite→pending；manual→manual。终态为 accepted / manual。 */
export type ComprehensionDecision = "pending" | "accepted" | "rejected" | "manual"

/**
 * 理解确认记录（3.2 审查，工作流无关的通用机制）。
 * 泛化语义：sdlc 为「代码片段」（id 为代码段标识，file/lines 必填）；
 * reqdoc 为「PRD 要点」（id 为要点标识，file/lines 不填）。sdlc 契约逐字节不变。
 * 工具参数名一律 `codeSegmentId`（LLM 契约），内部映射到本字段 `id`。
 */
export interface ComprehensionRecord {
  /** 唯一标识：sdlc 为代码段 id（如 a.ts:1-2），reqdoc 为 PRD 要点 id */
  id: string
  /** sdlc 专属：所属文件路径；reqdoc（PRD 要点）无文件归属 → undefined */
  file?: string
  /** sdlc 专属：行区间；reqdoc 无 → undefined */
  lines?: [number, number]
  explanation: string
  /** 片段当前去留状态（3.2）。 */
  decision: ComprehensionDecision
  /** 旧确认语义保留：accepted 时为 true（统计/展示的 confirmed 口径不变）。 */
  developerConfirmed: boolean
  confirmedAt: number | null
  /** reject 时开发者补充的意见（rewrite 的依据）。 */
  feedback: string | null
  rejectedAt: number | null
  /** 被拒绝后经 rewrite 重写的次数（一次通过率判定：accepted 且 rewrites===0 视为一次通过）。 */
  rewrites: number
  /** manual 终态时开发者自处理的结果说明。 */
  resolution: string | null
}

export interface ReviewStageRecord extends StageRecord {
  checklist: Record<string, boolean>
  comprehension: ComprehensionRecord[]
}

export interface CommitGate {
  status: "blocked" | "allowed"
  blocked_by: string[]
  /**
   * 一次性强制提交授权（3.4 逃生口）：开发者明确要求并给出原因后由
   * commit_force_unlock 写入；门禁放行一次后置 used=true 留痕（不删除，供统计审计）。
   */
  force?: { reason: string; at: number; used: boolean }
}

/**
 * 基线对比（6.3）：需求创建时由项目经理给出的预估人工工时，开发者在 TUI 内经
 * workflow_baseline 工具转述录入。用于与实际周期对比得出 AI 提效率。
 * 纯数字 + 时间戳，不含代码/路径，汇报投影直接上行（12）。
 */
export interface BaselineEstimate {
  /** 预估人工工时（小时，>0） */
  estimatedHours: number
  /** 录入/最近一次重设时间（epoch ms，幂等覆盖） */
  setAt: number
}

/** reqdoc 功能点（重构核心：prd 前置功能点拆解，业务确认后记录）。
 *  sdlc 无此概念；reqdoc 在 prd 阶段经 reqdoc_confirm_features 写入，随后按模版第三章渲染。 */
export interface ReqdocFeature {
  /** 功能点序号（模版「功能点编号」，如 1、2） */
  no: number
  /** 功能点名称（模版「功能名称」） */
  name: string
  /** 优先级：高/中/低（模版「优先级」勾选） */
  priority: "high" | "medium" | "low"
  /** 业务确认时间（epoch ms） */
  confirmedAt: number
  /** 备注（可选，业务补充说明） */
  note?: string
}

/**
 * reqdoc 打分卡五维度（实施方案第三节，满分 100 = Σ max）。
 * 单点定义：reqdoc_score 工具、prd 门禁、状态条/CLI 展示、评测脚本共用。
 * 每维含 `rule`（判定规则）与 `deductionRules`（扣分标准，方案「Agent 后台判定规则与
 * 扣分标准」列），经 reqdocScoreRubric() 生成提示文本——r21 规则文本与工具描述双通道同源，
 * 模型在 edge 打分与追问时即可见完整评分标准。
 */
export const REQDOC_SCORE_DIMS = [
  {
    key: "businessValue",
    label: "业务目标与价值",
    max: 15,
    rule: "必须明确使用角色与解决的痛点",
    deductionRules: [
      { points: 10, condition: "缺失使用角色" },
      { points: 5, condition: "缺乏量化目标" },
    ],
  },
  {
    key: "flowClosure",
    label: "主流程逻辑闭环",
    max: 25,
    rule: "输入、处理、输出必须闭环",
    deductionRules: [
      { points: 15, condition: "流程有头无尾" },
      { points: 10, condition: "步骤缺少触发条件" },
    ],
  },
  {
    key: "edgeControl",
    label: "异常与边界控制",
    max: 30,
    rule: "必须覆盖网络超时、扣款/提交失败、并发重复提交、逆向撤销/驳回流程",
    deductionRules: [{ points: 25, condition: "未提及任何异常" }],
  },
  {
    key: "compliance",
    label: "合规与数据安全",
    max: 20,
    rule: "敏感字段（手机号/身份证）必须明确遮罩脱敏规则；资金或高危变更操作必须声明留痕与复核机制",
    deductionRules: [{ points: 10, condition: "未定义脱敏" }],
  },
  {
    key: "authority",
    label: "权限与机构隔离",
    max: 10,
    rule: "必须明确总/分/支行数据查看边界及岗位权限",
    deductionRules: [{ points: 10, condition: "描述为「所有人均可使用」" }],
  },
] as const

/** reqdoc 打分卡维度键（类型安全，消费方遍历 REQDOC_SCORE_DIMS 即可）。 */
export type ReqdocScoreDimKey = (typeof REQDOC_SCORE_DIMS)[number]["key"]

/** 打分卡达标门禁线（实施方案：≥85 分 + 业务确认才可定稿）。 */
export const REQDOC_SCORE_PASS = 85

/**
 * 打分卡评分标准文本（实施方案第三节「判定规则与扣分标准」），r21 规则文本与
 * reqdoc_score 工具描述共用同一来源，避免两份漂移。
 * 每维格式：`label(key)满分：判定规则。扣X分：条件；扣Y分：条件`
 */
export function reqdocScoreRubric(): string {
  return REQDOC_SCORE_DIMS.map((d) => {
    const penalties = d.deductionRules.map((p) => `扣${p.points}分：${p.condition}`).join("；")
    return `${d.label}(${d.key})${d.max}分：${d.rule}${penalties ? `。${penalties}` : ""}`
  }).join("\n")
}

/**
 * reqdoc 追问探针清单（质量飞轮 P1「追问可测化」）。
 * 把 edge 阶段该问的内容落成结构化清单，每维映射打分卡维度（扣分项即探针地图）。
 * 单点定义：reqdoc_probe 工具、reqdoc-r11 规则文本、状态条/评测共用——经
 * reqdocProbeRubric() 生成文本注入 r11 与工具描述，自持续「漏问频率前移」改 round 即可。
 * businessValue（角色/痛点/量化目标）由 goal 阶段 reqdoc-r6 负责，不入 edge 清单。
 */
export interface ReqdocProbe {
  /** 探针 id（工具/状态/评测共用） */
  id: string
  /** 业务语言中文名 */
  label: string
  /** 映射打分卡维度（缺口 → 该维扣分项） */
  dim: ReqdocScoreDimKey
  /** 建议追问轮次（1-3；自持续「前移」即改此处） */
  round: number
  /** 业务语言问题模板（模型转述为 A/B/C + 默认推荐） */
  question: string
}

export const REQDOC_PROBES: readonly ReqdocProbe[] = [
  { id: "main_flow", label: "主流程闭环", dim: "flowClosure", round: 1, question: "这项业务从发起到最后完成，要经过哪些步骤？" },
  { id: "flow_trigger", label: "流程触发条件", dim: "flowClosure", round: 1, question: "什么情况下会开始这笔业务？" },
  { id: "exception", label: "异常处理", dim: "edgeControl", round: 1, question: "同一笔交易被重复点了几次、网络中断或提交失败，怎么处理？" },
  { id: "reverse", label: "逆向撤销/驳回", dim: "edgeControl", round: 2, question: "办错了想撤销、或提交后被驳回，怎么处理？" },
  { id: "desensitize", label: "敏感字段脱敏", dim: "compliance", round: 2, question: "手机号、身份证这些敏感信息，界面上怎么展示？" },
  { id: "audit", label: "留痕与复核", dim: "compliance", round: 2, question: "资金或重要操作，要不要留痕、双人复核？" },
  { id: "authority", label: "权限与机构隔离", dim: "authority", round: 2, question: "谁能看、谁能办？数据在总行/分行/支行之间怎么隔离？" },
]

/** 追问探针清单文本（质量飞轮 P1）：reqdoc-r11 规则文本与 reqdoc_probe 工具描述共用同一来源。 */
export function reqdocProbeRubric(): string {
  return REQDOC_PROBES.map((p) => `- ${p.id}（${p.label}）→${p.dim}，建议第 ${p.round} 轮：${p.question}`).join("\n")
}

/** 打分卡扣分明细条目（含证据引用，本机留痕可审计）。 */
export interface ReqdocScoreDeduction {
  /** 维度键（REQDOC_SCORE_DIMS 之一） */
  key: ReqdocScoreDimKey
  /** 该条扣分数（≥1，服务端校验不超出该维度满分） */
  points: number
  /** 扣分原因（如「未提及任何异常流程」） */
  reason: string
  /** 证据引用（材料片段/文件路径或 [问答] 轮次；含路径仅存本机，汇报不上行） */
  evidence?: string
}

/**
 * reqdoc PRD 质量打分卡（实施方案第三节）。经 reqdoc_score 工具写入，total 由服务端 = Σ dims
 * 校验后计算（不信任模型自报总分）。可多次重打覆盖（追问补缺后更新）。sdlc 无此概念，恒缺省。
 * 达标判定 = total ≥ REQDOC_SCORE_PASS（门禁处推导，不存冗余布尔避免漂移）；
 * 追问轮数上限为规则文本约束（reqdoc-r2「最长 3 轮」），不入状态。
 */
export interface ReqdocScore {
  /** 各维度实得分：键 → { 实得分, 该维度满分 }（来自 REQDOC_SCORE_DIMS） */
  dims: Record<ReqdocScoreDimKey, { score: number; max: number }>
  /** 扣分明细（展示 + 本机留痕；重打即整体替换旧明细） */
  deductions: ReqdocScoreDeduction[]
  /** 总分 0-100（服务端 = Σ dims 校验后写入） */
  total: number
  /** 业务确认（工具强制 business_confirmed=true；可先记录低分事实再补缺重打） */
  confirmed: boolean
  confirmedAt: number | null
  /** 最近一次打分时间戳（重打覆盖更新） */
  updatedAt: number
}

/**
 * reqdoc 追问探针覆盖记录（质量飞轮 P1，reqdoc_probe 工具写入）。
 * 可选字段：首次记录前缺省；sdlc 恒缺省。随汇报上行。
 * asked 按轮追加去重（保留追问历史供自持续「漏问频率」分析）；gaps 为仍缺口探针。
 * 柔性门禁：缺口探针对应打分卡维度不得打满分（见 probeGapViolations）。
 */
export interface ReqdocProbes {
  /** 已问过的探针 id（追加去重，含历史轮次） */
  asked: string[]
  /** 仍缺口的探针 id（问过未得全或未问；进入 prd 前如仍缺口须在 reqdoc_score 中如实扣分） */
  gaps: string[]
  /** 当前追问轮次（1-3；规则上限「最长 3 轮」） */
  round: number
  /** 最近一次记录时间戳（覆盖更新） */
  updatedAt: number
}

/**
 * 缺口-扣分一致性校验（质量飞轮 P1 柔性门禁，workflow_advance 进 prd 与 review_submit 两处共用）：
 * 对每个缺口探针，若其映射打分卡维度打了满分（score == max），说明自评与缺口矛盾（报缺口却打满分），
 * 返回违规条目；无 probes / 无 score / 缺口为空 → 返回空（柔性：不强制记录探针）。
 */
export function probeGapViolations(
  probes: ReqdocProbes | undefined,
  score: ReqdocScore | undefined,
): string[] {
  if (!probes || !score || probes.gaps.length === 0) return []
  const violations: string[] = []
  for (const id of probes.gaps) {
    const probe = REQDOC_PROBES.find((p) => p.id === id)
    if (!probe) continue
    const dimScore = score.dims[probe.dim]
    if (dimScore && dimScore.score >= dimScore.max) {
      violations.push(`探针 ${id}（${probe.label}）是缺口，但维度 ${probe.dim} 打了满分（${dimScore.score}/${dimScore.max}）`)
    }
  }
  return violations
}

export interface QualityMetrics {
  /** 一次通过率（3.2）：未重写即 accepted 的片段数 ÷ 全部定论片段数(accepted+manual)。
   *  review_submit 通过时由插件自动计算写回，不依赖 Agent 上报。纯讨论会话（无片段）保持 null。
   *  sdlc 专属（代码片段语义）；reqdoc 无此概念时为 null。 */
  firstPassRate: number | null
  /** 「同一段代码/文件」的最大生成-修改循环次数（3.2），取 iterationByFile 各文件最大值 */
  iterationCount: number | null
  /** 合并后由 CI 按 sessionID 回写收集服务（设计文档 session-management.md 4.3） */
  reworkRate: number | null
  testCoverage: number | null
  /**
   * 按文件的 AI 生成-修改循环计数（3.2「同一段代码」语义）。键为文件路径；
   * 无单一文件的工具（如 apply_patch）归入 "(<工具名>)" 桶。
   * 可选字段：首次计数前缺省（不改 createWorkflowState 既有形状），随汇报上行。
   */
  iterationByFile?: Record<string, number>
  /**
   * 按文件的 AI 净增代码行数（3.2「AI 代码行数统计」，规则 26）：净增量口径、可为负，
   * 同会话去重累计（write 整文件覆盖计、edit 新行−旧行、apply_patch +行−−行）。
   * 可选字段：首次计数前缺省（不改 createWorkflowState 既有形状）。
   * 键为文件路径仅存本机插件库，汇报投影剥离、只上行三分类聚合（12）。
   */
  linesByFile?: Record<string, number>
}

/**
 * 会话工作流状态（3.2）：本会话属于哪种工作流 + 泛化阶段集。
 * type 决定取哪个 WorkflowDefinition（阶段键/清单/规则/门禁），随汇报上行。
 */
export interface WorkflowState {
  /** 本会话所属工作流类型（用户级身份继承，3.1） */
  type: WorkflowType
  /** 泛化阶段集：键为定义 stages 的元素，值含状态/迭代/时间戳 */
  stages: Record<string, StageRecord>
  commit: CommitGate
  quality: QualityMetrics
  /**
   * 基线对比（6.3）：预估人工工时，需求创建时录入。
   * 可选字段：录入前缺省（不改 createWorkflowState 既有形状），随汇报上行。
   */
  baseline?: BaselineEstimate
  /**
   * reqdoc 功能点清单（重构核心：prd 前置功能点拆解，业务确认后写入）。
   * 可选字段：确认前缺省；sdlc 恒缺省。随汇报上行。
   */
  features?: ReqdocFeature[]
  /**
   * reqdoc PRD 质量打分卡（实施方案第三节，reqdoc_score 工具写入）。
   * 可选字段：打分前缺省；sdlc 恒缺省。扣分明细含 evidence（本机留痕）。
   */
  score?: ReqdocScore
  /**
   * reqdoc 追问探针覆盖记录（质量飞轮 P1，reqdoc_probe 工具写入）。
   * 可选字段：首次记录前缺省；sdlc 恒缺省。随汇报上行。
   */
  probes?: ReqdocProbes
  /**
   * reqdoc 渲染结构校验记录（质量飞轮 P2，reqdoc_check 工具写入）。
   * 可选字段：未调用 reqdoc_check 前缺省；sdlc 恒缺省。随汇报上行。
   * review_submit 定稿时重读 source 复核（防快照被篡改）；未记录则柔性放行。
   */
  render?: ReqdocRender
}

/** 工作流阶段键（Record 泛化，3.2）。 */
export type WorkflowStageKey = string

/** 审查清单项（3.2 注册表）：key 为清单键，label 为渲染/注入用中文名，auto 表示 review_submit 自动置真。 */
export interface ChecklistItem {
  key: string
  label: string
  /** 由插件自动满足、无需 Agent 逐项确认的项（如覆盖率由 CI 回写）。 */
  auto?: boolean
}

/**
 * 规则项（7.4 阶段化注入）：stage 为生效阶段键，"global" 为所有阶段通用。
 * text 只承载模型可行动作（调用哪个工具、何时、确认语义）——
 * 插件内部机制（行数统计、stuck 检测）由代码强制，不进注入文本。
 */
export interface RuleItem {
  /** 稳定标识（如 sdlc-r1），供测试/评测/文档交叉引用 */
  id: string
  stage: string | "global"
  text: string
}

/**
 * 工作流定义（3.2 注册表）：把「流程的定义」与通用机制解耦。
 * 消费方一律 getDefinition(workflow.type) 取定义，不硬编码阶段/清单/规则。
 */
export interface WorkflowDefinition {
  type: WorkflowType
  /** 阶段键，顺序即推进顺序 */
  stages: string[]
  /** 阶段中文名（渲染/注入用） */
  labels: Record<string, string>
  /** 每阶段一句话目的（阶段可见性Indicator 用，prompt.ts buildStateBar 渲染、规则驱动模型复述给用户）。
   *  可选：未填则不展示目的行；新增工作流只需填此映射，通用阶段可见性规则无需改写。 */
  stagePurpose?: Record<string, string>
  /** 哪个阶段是审查阶段（可无）；审查清单/理解确认仅在该阶段存在时使用 */
  reviewStage: string | null
  /** 审查清单项（仅 reviewStage 存在时用） */
  checklist: ChecklistItem[]
  /** sdlc=true；reqdoc 定稿无 git 门禁 → false */
  hasCommitGate: boolean
  /** 该类型注入的规则项（7.4），注入时经 rulesForStage 取 global + 当前阶段 */
  rules: RuleItem[]
}

/** SDLC 五阶段审查清单项（sdlc 专属，3.2）；review_submit 从具名参数生成，字节不变。
 *  designRationale 为 auto：全部片段定论即通过，无需 Agent 逐项上报（LLM 契约仅 3 具名参数）。 */
const SDLC_CHECKLIST: ChecklistItem[] = [
  { key: "businessIntent", label: "业务意图清晰" },
  { key: "logicExplainable", label: "逻辑可解释" },
  { key: "behaviorVerifiable", label: "行为可验证" },
  { key: "designRationale", label: "设计取舍合理", auto: true },
]

/** SDLC 工作流定义：五阶段 + 四清单 + git 门禁 + 结构化规则（global + 阶段归属，7.4）。 */
export const SDLC: WorkflowDefinition = {
  type: "sdlc",
  stages: ["requirements", "design", "implementation", "testing", "review"],
  labels: {
    requirements: "需求分析",
    design: "设计",
    implementation: "编码",
    testing: "测试",
    review: "审查",
  },
  stagePurpose: {
    requirements: "厘清需求与边界",
    design: "方案设计",
    implementation: "编码实现",
    testing: "测试验证",
    review: "开发者理解确认代码",
  },
  reviewStage: "review",
  checklist: SDLC_CHECKLIST,
  hasCommitGate: true,
  rules: [
    // ---- global：所有阶段通用 ----
    { id: "sdlc-r1", stage: "global", text: "会话开始时，调用 workflow_advance(stage=requirements, action=enter) 初始化工作流。" },
    { id: "sdlc-r2", stage: "global", text: "阶段可能完成时，先输出摘要并询问确认；仅开发者明确表示「确认/通过/可以」才算确认——「你看着办」「差不多」等模糊表态不算，不得自行 approve。确认后调用 workflow_advance(action=approve, developer_confirmed=true)。询问确认时须显式点明所确认的阶段名（如「【编码 阶段】以上编码是否确认？」），不得用笼统的「以上流程与规则是否确认」。" },
    { id: "sdlc-r13", stage: "global", text: stageVisibilityRule("开发者") },
    { id: "sdlc-r3", stage: "global", text: "开发者说「回到XX」时，立即调用 workflow_revisit(stage=XX)。绝不自行判断阶段已完成。" },
    { id: "sdlc-r4", stage: "global", text: "要求提交时，先调用 commit_gate_check；全部五阶段（含审查）approved 后才可 git commit。" },
    { id: "sdlc-r5", stage: "global", text: "提交门禁放行且 git commit 成功后，提醒开发者执行 /new 开始下一个需求，保持统计隔离。" },
    { id: "sdlc-r12", stage: "global", text: "开发者表示要手工修改某段/某文件代码时，先调用 open_ide 并**必须携带 file 参数指明该文件**（不指定 file 不会锁定），以锁定该文件防 AI 覆盖。若开发者未明确文件，先询问要改哪个文件。锁定期间可继续其它任务（改其它文件/答疑），但不得修改被锁定的文件（write/edit/apply_patch 会被服务端拒绝）。开发者确认改完后，须经其明确确认（如说「改完了/可以继续」）再调用 unlock_file 解锁该文件，并重新读取最新文件内容后继续；多个锁定文件须逐个确认解锁。" },
    // ---- requirements ----
    { id: "sdlc-r6", stage: "requirements", text: "进入需求阶段时，主动询问预估人工工时（小时）；开发者明确给出后调用 workflow_baseline(developer_confirmed=true)。未提供不阻塞；已录入后不必重复询问。" },
    // ---- review（理解保障，核心）----
    { id: "sdlc-r7", stage: "review", text: "review 是唯一不可由 AI 自行推进的阶段（必须经 review_submit），目标是确保开发者真正理解代码。" },
    { id: "sdlc-r8", stage: "review", text: "进入审查后，将每个 AI 生成的代码变更拆分为可理解片段，comprehension_add 逐段登记并输出解释（做了什么、为什么这样写、被放弃的替代方案、潜在风险）。" },
    { id: "sdlc-r9", stage: "review", text: "开发者确认某片段时，立即调用 comprehension_confirm(codeSegmentId=该片段 id)；单次只接受一个 codeSegmentId，逐段确认、禁止一次确认多个。" },
    { id: "sdlc-r10", stage: "review", text: "开发者追问时详细解释，comprehension_ask 将问答追加到该片段的 explanation。" },
    { id: "sdlc-r11", stage: "review", text: "每个片段须达成终态（confirm 接受 / manual 开发者自处理），不允许 pending/rejected 悬空；拒绝的片段先 comprehension_rewrite 重写或 manual 定论，全部定论且前序阶段（requirements/design/implementation/testing）全部 approved 后才可 review_submit；清单四项须全为 true，否则回到编码/测试。返工多应结合拒绝意见 rewrite 改进，而非简单重试。" },
  ],
}

/** reqdoc 审查清单项（reqdoc 专属，3.2）：业务确认 PRD 要点（区别于 sdlc 的代码理解确认）。 */
const REQDOC_CHECKLIST: ChecklistItem[] = [
  { key: "completeness", label: "信息完整（背景/口径/字段齐全）" },
  { key: "clarity", label: "表达明确（无歧义、可落地）" },
  { key: "edgeCoverage", label: "边界覆盖（异常/权限/合规场景俱到）" },
  { key: "resolution", label: "职责清晰（技术初步可行性已确认）" },
]

/**
 * reqdoc 工作流定义：需求书（需求分析师角色，3.2、7.4）。
 * 源于《业务需求难点与解决方案》的四段式渐进引导（目标与场景 → 主流程与规则 →
 * 边界与异常探针 → 自动化排版），外加业务确认闭环。审查阶段（review）语义为
 * 业务确认 PRD 要点，复用通用 comprehension/checklist/review_submit 机制。
 * 定稿无 git 门禁（hasCommitGate=false）。结构化规则（global + 阶段归属），
 * 需求资料目录契约（7.5）落在 goal 阶段规则与各阶段扫描映射。
 */

/**
 * 阶段可见性规则文本（质量飞轮：阶段可见性）。reqdoc/sdlc 共用同一段、仅受众措辞不同，
 * 阶段名与一句话目的均取自各工作流定义的 labels / stagePurpose（数据驱动，不在此硬编码枚举），
 * 故未来新增工作流只需挂本规则 + 填自己的 stagePurpose，无需改写本文本。
 * 作用：驱动模型在每条回复开头向用户复述当前阶段与全部阶段进展，并令确认/approve 点名阶段。
 */
function stageVisibilityRule(who: string): string {
  return (
    `阶段可见性（通用）：你每条回复的开头，必须用一行向${who}展示当前所处阶段与全部阶段进展，格式——` +
    `📍 阶段：<当前阶段中文名>（第 N/Y 步）｜ 目的：<本阶段一句话目的> ｜ 已完成：<已 approved 阶段名>✓ ｜ 下一步：<下一阶段名>。` +
    `处于「未开始/空档」态时，说明「尚未开始，请从<首阶段>开始」或「空档，下一步：<阶段名>」。` +
    `向${who}询问确认/approve 时，必须显式点明所确认的**阶段名**（如「【边界与异常 阶段】以上边界与异常是否确认？」），` +
    `不得用笼统的「以上流程与规则是否确认」之类不点名阶段的问法。`
  )
}

export const REQDOC: WorkflowDefinition = {
  type: "reqdoc",
  stages: ["goal", "rules", "edge", "prd", "review"],
  labels: {
    goal: "目标与场景",
    rules: "流程与规则",
    edge: "边界与异常",
    prd: "需求规格书",
    review: "业务确认",
  },
  stagePurpose: {
    goal: "明确谁在用、解决什么痛点",
    rules: "理清主流程、字段与数据字典",
    edge: "补全异常、逆向与权限合规",
    prd: "按模板渲染需求规格书",
    review: "业务逐条确认 PRD 要点",
  },
  reviewStage: "review",
  checklist: REQDOC_CHECKLIST,
  hasCommitGate: false,
  rules: [
    // ---- global：所有阶段通用 ----
    { id: "reqdoc-r1", stage: "global", text: "会话开始时，调用 workflow_advance(stage=goal, action=enter) 初始化工作流。" },
    { id: "reqdoc-r2", stage: "global", text: "采用渐进式分段引导，不要一次性抛出所有问题；单次提问 2-3 个问题，每个问题必须附 A/B/C 选项并标注【默认推荐项】（业务回复「同意默认」即按推荐确认）；同一需求追问最长 3 轮，3 轮后仍未澄清项标 [缺省] 进入下一环节，避免业务有被「质问」的挫败感。提问一律用业务语言，严禁出现「高并发、幂等性、API」等纯技术词汇——同一含义必须转述为业务说法（如并发重复提交→「同一笔交易被重复点了几次怎么处理」）。" },
    { id: "reqdoc-r3", stage: "global", text: "阶段可能完成时，先输出摘要并询问确认；仅业务明确表示「确认/可以」才算确认——模糊表态不算，不得自行 approve。确认后调用 workflow_advance(action=approve, developer_confirmed=true)。询问确认时须显式点明所确认的阶段名（如「【边界与异常 阶段】以上边界与异常是否确认？」），不得用笼统的「以上流程与规则是否确认」。" },
    { id: "reqdoc-r25", stage: "global", text: stageVisibilityRule("业务") },
    { id: "reqdoc-r26", stage: "global", text: "投放/口述 决定未完成前不得推进：需求资料目录（01~04）已建、但业务尚未明确选择「投放材料」还是「直接口述」时，每轮开场都须显式向业务提出二选一（或问清已投放了哪些目录），并停下等待业务明确选择；未获得明确选择不得进入追问、不得先抛其它问题。调用 reqdoc_init 后，必须把工具返回的目录绝对路径**逐行粘贴到你的回复正文里**（不要只写「见工具返回/见上方」——业务可能看不到工具记录），再附「① 投放材料 / ② 直接口述」二选一，不得自行浓缩成「方便您后续放材料」之类不触发动作的话术后直接追问。业务选直接口述时先回知情确认（见 reqdoc-r8），部分投放则仅扫描已投目录。" },
    { id: "reqdoc-r4", stage: "global", text: "业务说「回到XX」时，立即调用 workflow_revisit(stage=XX)。绝不自行判断阶段已完成。" },
    { id: "reqdoc-r5", stage: "global", text: "业务确认完成（review_submit 通过）后，建议执行 /new 开始下一个需求，保持统计隔离。" },
    // ---- goal 目标与场景 ----
    { id: "reqdoc-r6", stage: "goal", text: "用一两句话引导业务说明：上线后谁在用、解决什么痛点；提炼【核心用户】【业务场景】【业务价值】，表达模糊时给出 A/B/C 选项并标注【默认推荐项】让业务勾选确认。" },
    { id: "reqdoc-r7", stage: "goal", text: "进入 goal 阶段时，主动询问预估人工书写工时（小时）；业务明确给出后调用 workflow_baseline(developer_confirmed=true)。未提供不阻塞；已录入后不必重复询问。" },
    { id: "reqdoc-r8", stage: "goal", text: "目录就绪检查：项目根约定 01~06 需求资料目录（01_背景与目标、02_制度与合规、03_流程与数据、04_角色与权限，此四目录业务投放材料；05_功能点、06_需求规格产出为 AI 工作区）。尚无时主动调用 reqdoc_init 搭建骨架（幂等，绝不重建或覆盖业务已放材料），并向业务展示各材料目录的绝对路径、明确说明「把资料放进 01~04 对应目录，有多少投多少，未投放的目录我们口述补全，无需一次备齐」；业务说资料已放好、或会话中途补充了材料，则调用 reqdoc_scan(directory=01_背景与目标) 扫描提取作引导输入（可重复扫描，不必等下一轮）。init 之后、进入追问前，必须显式向业务提出「投放材料 / 直接口述」的二选一（或问清已投了哪些目录），未得到明确选择不擅自推进追问；业务选直接口述时，先回一句知情确认「那全程来源会是 [问答]，定稿时你需确认『无书面材料』」再继续，部分投放则仅对投放目录扫描、状态条自然显示 [文档]/[问答] 混合、无需该确认。" },
    // ---- rules 流程与规则 ----
    { id: "reqdoc-r9", stage: "rules", text: "引导补全主流程：用户输入哪些信息、系统处理后给什么结果；将自然语言转化为字段定义（数据项 / 是否必填 / 校验规则）。" },
    { id: "reqdoc-r10", stage: "rules", text: "自动推演主流程后，在对话里用**可读的纯文本步骤（编号列表 ①→②→③ 或箭头串）**向业务展示确认——CLI/终端不渲染 Mermaid，对话内不得只给 Mermaid 图、也不要裸写 flowchart TD；如需保留可视化图，把 Mermaid（须用 ```mermaid 围栏包裹）写入 06_需求规格产出/附_流程图/ 供在支持渲染的查看器中打开。业务说资料已放好则调用 reqdoc_scan(directory=03_流程与数据) 扫描提取字段与流程作输入；综合扫描材料与问答生成数据字典与库表设计（数据实体/字段/主外键关系/校验规则），向业务展示确认。" },
    // ---- edge 边界与异常（最关键）----
    { id: "reqdoc-r11", stage: "edge", text: `按探针清单推进追问（清单与 reqdoc_probe 工具描述同源，每维映射打分卡扣分项）：\n${reqdocProbeRubric()}\n逐轮追问 2-3 问（见 r2，带 A/B/C 与【默认推荐项】），每轮结束调用 reqdoc_probe(asked=本轮新问探针, gaps=仍缺口探针, round=轮次) 记录覆盖；追问最多 3 轮，3 轮后仍未澄清项标 [缺省] 停止追问；到 3 轮上限时，先把未澄清探针逐条列出（附对应打分卡维度与将扣分数），再进下一环节。` },
    { id: "reqdoc-r12", stage: "edge", text: "按已投放材料反问缺口（如已有制度但缺权限，追问「不同岗位的权限如何隔离」）；业务说资料已放好则调用 reqdoc_scan(directory=02_制度与合规) 与 reqdoc_scan(directory=04_角色与权限) 扫描提取作输入；综合岗位角色矩阵、机构隔离、审批授权与双人复核材料生成 RBAC 权限控制矩阵与审批流控制逻辑，向业务展示确认。" },
    { id: "reqdoc-r22", stage: "edge", text: "探针覆盖度（柔性门禁）：进入 prd 前，若已调用 reqdoc_probe 记录过探针，服务端校验缺口与打分一致——缺口探针对应打分卡维度不得打满分（缺口+满分=自评不诚实，workflow_advance 进 prd 与 review_submit 会被拒绝）；建议每轮追问结束调用 reqdoc_probe 记录（覆盖度在状态条可见，帮助自评一致）；材料已全覆盖无追问时可记录一次（asked/gaps 可为空），不记录不强求。" },
    { id: "reqdoc-r21", stage: "edge", text: `打分时机与门禁（实施方案打分卡）：边界与异常收集完成、准备进入 prd 前，基于已扫描材料 + 问答对照打分卡逐维打分（满分 100）：\n${reqdocScoreRubric()}\n调用 reqdoc_score 输出各维得分与扣分明细（附证据引用），向业务展示并请其确认；business_confirmed=true 且 total≥85 后才可 workflow_advance(stage=prd, action=enter)。未达标按三档引导重打：<60 分（不合格）优先继续提问主流程与异常边界，补齐流程闭环与异常覆盖；60-84 分（良好）引导补充脱敏规则、权限与机构隔离、逆向撤销/驳回流程；≥85 分（达标）输出扣分明细、业务确认通过后即停止追问、不再重复盘问。展示得分时必须附质量得分进度条（如 [▓▓▓▓▓░░░░░ 50%]，进度直观反映达标进度）。严禁未展示扣分明细即自报达标。` },
    // ---- prd 需求规格书 ----
    { id: "reqdoc-r13", stage: "prd", text: "功能点拆解（核心）：综合前面 goal/rules/edge 收集的信息（材料提取 + 问答），把需求拆成功能点清单（编号/名称/优先级），先向业务展示清单确认；业务确认后调用 reqdoc_confirm_features(features=[{name,priority}]...) 记录，并为每个功能点在 05_功能点 下建子目录写入来源摘录（标注 [文档]/[问答] 来源）。业务说资料已放好则先调用 reqdoc_scan(directory=06_需求规格产出) 检查已有产出。" },
    { id: "reqdoc-r14", stage: "prd", text: "按《业务需求说明书》模板渲染最终 PRD（模板：docs/reqdoc-prd-template.md；模板全文由插件在 prd 阶段自动注入系统提示，见「模板全文」段；以注入的模板全文为唯一依据，渲染须严格逐字遵循，见 reqdoc-r20；仅当插件找不到模板文件时才按内联骨架渲染）：封面（项目信息表、文档变更过程表）→ 第一章 需求概述（需求类型：新增/更改、流程优化/跨部门/总行开发、希望完成时间、提出原因及功能概述）→ 第二章 术语定义与业务规则（术语定义、业务规则）→ 第三章 需求功能详述（按已确认功能点：编号/名称/优先级，输入要素：简要概述/控制要求，处理要求：输入要素检查/系统处理过程/异常处理/提示信息/其他要求/清算处理/差错处理/交易安全性/数据存贮和清理/附件）。每功能点内容从 05_功能点/N_名称/ 子目录的来源摘录 + 问答补全，逐字段标来源：文档提取标 [文档]、问答补全标 [问答]、尚未获得的信息留白并标 [缺省]，绝不杜撰事实；[问答] 来源的口语须提炼整理为规范的需求书面语（去除闲聊、口头禅与不完整表述、保留业务原意），不得原话照搬对话文字，但不得为填满字段而虚构业务未确认的内容；未涉及项在 ○/● 中选「不涉及/不适用」并留白正文；项目信息表与文档变更过程属项目元数据，不主动问业务，渲染时留空占位。产出归档：需求澄清记录、自动提取的 Mermaid 流程图、数据字典与库表设计、RBAC 权限控制矩阵与审批流控制逻辑、最终 PRD 一律写入 06_需求规格产出 目录；PRD 定稿后调用 reqdoc_export(source=PRD 路径) 生成 Word 版（.docx）交付件，与 md 同目录归档。" },
    { id: "reqdoc-r20", stage: "prd", text: "渲染铁律 + 字段映射（模板权威约束）：模板全文已由插件注入对话（见系统提示「模板全文」段，无需自行读文件），以注入的模板全文为唯一依据，渲染严格逐字遵循、不调整章节顺序/标题/字段名；如发现模板结构问题如实上报、不擅自修正（归行方模板主管部门）。打分卡扣分项按以下映射落位到模板既有字段：脱敏规则（手机号/身份证遮罩）→功能点 2.8 交易安全性/2.9 数据存贮和清理；资金或高危变更留痕与双人复核→1.2 控制要求/2.8 交易安全性；总/分/支行数据边界与岗位权限→1.2 控制要求/2.1 输入要素的检查；异常边界（网络超时/操作失败/并发重复提交/逆向撤销驳回）→2.3 异常处理要求/2.6 清算处理/2.7 差错处理；模板确无对应字段的补充内容→2.2 系统处理过程或功能点描述，来源标注注明「补」。模板外成果（Mermaid 流程图、UAT 验收测试用例、低保真界面说明、数据字典与库表设计、RBAC 权限控制矩阵与审批流控制逻辑）不插入模板正文，用 write 写入 06_需求规格产出 下子目录（附_流程图/、测试用例/、界面草图/、数据字典与库表设计/、权限矩阵与审批流/），并在对应功能点「2.10 附件」列出清单与相对路径。" },
    { id: "reqdoc-r23", stage: "prd", text: `渲染结构校验：渲染完成并写入 06_需求规格产出 后，调用 reqdoc_check(source=PRD md 相对项目根路径) 对照模板结构 schema 做渲染 diff 校验（章节齐全/顺序/功能点块数/必填字段来源标注）：\n${renderCheckRubric()}\n校验有违规（缺章节/乱序/功能点块数不符/映射字段漏标来源）须修正后重调 reqdoc_check 复查；结构合规后再 review_submit 定稿。` },
    { id: "reqdoc-r24", stage: "prd", text: "渲染门禁（柔性 + 定稿复核）：reqdoc_check 不强制调用（未记录则 review_submit 放行，靠打分卡 ≥85 与产出度量兜底）；一旦调用即记录，review_submit 定稿时会重读源 md 复核——结构违规（缺章节/乱序/功能点块数不符/映射字段漏标来源）与 [缺省] 字段对应打分卡维度打满分都会被拒绝。此外，全部字段来自 [问答]、无任何 [文档] 支撑（docBlocks=0）时定稿也会被来源支撑门禁拦截，除非业务在对话中明确确认「无书面材料可引用」后 review_submit(no_document_confirmed=true)。建议渲染后都调用 reqdoc_check 自查（来源覆盖与校验结果在状态条可见），缺料字段如实标 [缺省] 并在 reqdoc_score 中对应维度扣分。" },
    // ---- review 业务确认（核心）----
    { id: "reqdoc-r15", stage: "review", text: "review 是唯一不可由 AI 自行推进的阶段（必须经 review_submit），确保业务真正理解并确认 PRD 要点。" },
    { id: "reqdoc-r16", stage: "review", text: "将 PRD 拆分为可确认要点（业务目标 / 核心字段 / 异常规则 / 合规要求），comprehension_add 逐段复述输出。" },
    { id: "reqdoc-r17", stage: "review", text: "业务确认某要点时，立即调用 comprehension_confirm(codeSegmentId=该要点 id)；单次只接受一个要点，逐段确认、禁止一次确认多个。" },
    { id: "reqdoc-r18", stage: "review", text: "业务追问时详细解释，comprehension_ask 将问答追加到该要点的 explanation。" },
    { id: "reqdoc-r19", stage: "review", text: "每个要点须达成终态（confirm 接受 / manual 自处理），不允许 pending/rejected 悬空；拒绝的要点先 rewrite 重写或 manual 定论，全部定论且前序阶段（goal/rules/edge/prd）全部 approved 后才可 review_submit；清单四项须全为 true，否则回到 edge/prd。通过率低说明要点含糊，应结合拒绝意见重写，而非简单重试。" },
  ],
}

/** 已注册的工作流定义注册表（3.2）。 */
export const WORKFLOW_DEFINITIONS: Record<WorkflowType, WorkflowDefinition> = {
  sdlc: SDLC,
  reqdoc: REQDOC,
}

/** 按类型取定义；未知类型抛错（类型安全，消费方应已经 resolveWorkflowType 归一）。 */
export function getDefinition(type: WorkflowType): WorkflowDefinition {
  return WORKFLOW_DEFINITIONS[type]
}

/** 将未知值归一为合法 WorkflowType；未知值回退 "sdlc" 并打 warning（兼容旧身份/旧库）。 */
export function resolveWorkflowType(v: unknown): WorkflowType {
  if (v === "sdlc") return "sdlc"
  if (v === "reqdoc") return "reqdoc"
  console.warn(`未知工作流类型 ${JSON.stringify(v)}，回退为 "sdlc"`)
  return "sdlc"
}

function createStageRecord(): StageRecord {
  return { status: "not_started", revision: 0, transitions: [] }
}

function createReviewStageRecord(def: WorkflowDefinition): ReviewStageRecord {
  const checklist: Record<string, boolean> = {}
  for (const item of def.checklist) checklist[item.key] = false
  return {
    ...createStageRecord(),
    checklist,
    comprehension: [],
  }
}

/** 会话开始时初始化的全新工作流状态（所有阶段 not_started，初始化规则见 workflow-sdlc.md 3 章 sdlc-r1 / workflow-reqdoc.md 4 章 reqdoc-r1）。 */
export function createWorkflowState(type: WorkflowType): WorkflowState {
  const def = getDefinition(type)
  const stages: Record<string, StageRecord> = {}
  for (const key of def.stages) {
    const isReview = def.reviewStage !== null && def.reviewStage === key
    stages[key] = isReview ? createReviewStageRecord(def) : createStageRecord()
  }
  return {
    type,
    stages,
    commit: { status: "blocked", blocked_by: [...def.stages] },
    quality: {
      firstPassRate: null,
      iterationCount: null,
      reworkRate: null,
      testCoverage: null,
    },
  }
}

/** 取指定阶段记录；缺键抛错（消费方不应访问不存在的阶段）。 */
export function getStage(s: WorkflowState, key: string): StageRecord {
  const stage = s.stages[key]
  if (!stage) throw new Error(`阶段 ${key} 不存在（工作流类型 ${s.type}）`)
  return stage
}

/** 取审查阶段记录（经定义 reviewStage 定位）；无审查阶段时抛错。 */
export function reviewRecord(s: WorkflowState): ReviewStageRecord {
  const def = getDefinition(s.type)
  if (def.reviewStage === null) throw new Error(`工作流类型 ${s.type} 无审查阶段`)
  return getStage(s, def.reviewStage) as ReviewStageRecord
}

/** 取指定阶段应注入的规则：global + 该阶段规则；stage 为 null 时只给 global（7.4 阶段化注入）。 */
export function rulesForStage(def: WorkflowDefinition, stage: string | null): RuleItem[] {
  if (stage === null) return def.rules.filter((r) => r.stage === "global")
  return def.rules.filter((r) => r.stage === "global" || r.stage === stage)
}

/** 当前进行中阶段：按 def.stages 顺序取第一个 in_progress；无则 null（阶段化注入选规则用）。 */
export function currentInProgressStage(workflow: WorkflowState): string | null {
  const def = getDefinition(workflow.type)
  return def.stages.find((name) => workflow.stages[name].status === "in_progress") ?? null
}

/** 一小时对应的毫秒数（基线提效计算口径）。 */
const MS_PER_HOUR = 3_600_000

/**
 * AI 提效率（6.3）：（预估人工工时 − 实际周期）÷ 预估人工工时。
 * 比率型指标，可为负（实际周期超过预估时），仅展示不设阈值。
 * 无基线（estimatedHours 缺失或非正）或无有效周期（durationMs≤0）时返回 null（展示 N/A）。
 */
export function efficiencyRatio(estimatedHours: number | null | undefined, durationMs: number): number | null {
  if (estimatedHours === null || estimatedHours === undefined || estimatedHours <= 0) return null
  if (durationMs <= 0) return null
  return (estimatedHours * MS_PER_HOUR - durationMs) / (estimatedHours * MS_PER_HOUR)
}