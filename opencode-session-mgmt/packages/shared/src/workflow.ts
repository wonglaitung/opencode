/**
 * WorkflowState 及子结构类型定义（设计文档 session-management.md 3.2；reqdoc 专属结构见 workflow-reqdoc.md 5/6/7 章）。
 * 插件、CLI、收集服务三方共用的契约——任何字段变更必须三包同步。
 *
 * 多流程就绪：阶段键/清单/规则/门禁均从 WorkflowDefinition 注册表驱动，而非硬编码。
 * sdlc 与 reqdoc 均已注册（设计文档 session-management.md 3.2 注册表；定义分别见 workflow-sdlc.md 2 章、workflow-reqdoc.md 2 章）。
 */

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
  /**
   * 确认来源溯源（质量飞轮 P3.10，comprehension_confirm 写入；reqdoc 定稿强制）：
   * 确认某要点时必须回填其来源证据——标签 + 引用原文/编号，证明该要点确有出处（不是凭空认可）。
   * sdlc 不强制（代码段本身即出处）；reqdoc 缺少此字段则 review_submit 定稿被拦截。
   */
  confirmSource?: { label: string; quote: string }
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
 * reqdoc 打分卡八维度（实施方案第三节，满分 100 = Σ max）。
 * 单点定义：reqdoc_score 工具、prd 门禁、状态条/CLI 展示、评测脚本共用。
 * 每维含 `rule`（判定规则）与 `deductionRules`（扣分标准，方案「Agent 后台判定规则与
 * 模型在 edge 打分与追问时即可见完整评分标准。
 */
export const REQDOC_SCORE_DIMS = [
  {
    key: "businessValue",
    label: "业务目标与价值",
    max: 12,
    rule: "必须明确使用角色与解决的痛点",
    deductionRules: [
      { points: 10, condition: "缺失使用角色" },
      { points: 5, condition: "缺乏量化目标" },
    ],
  },
  {
    key: "flowClosure",
    label: "主流程逻辑闭环",
    max: 20,
    rule: "输入、处理、输出必须闭环",
    deductionRules: [
      { points: 15, condition: "流程有头无尾" },
      { points: 10, condition: "步骤缺少触发条件" },
    ],
  },
  {
    key: "edgeControl",
    label: "异常与边界控制",
    max: 22,
    rule: "必须覆盖网络超时、扣款/提交失败、并发重复提交、逆向撤销/驳回流程",
    deductionRules: [{ points: 22, condition: "未提及任何异常" }],
  },
  {
    key: "compliance",
    label: "合规与数据安全",
    max: 16,
    rule: "敏感字段（手机号/身份证）必须明确遮罩脱敏规则；资金或高危变更操作必须声明留痕与复核机制",
    deductionRules: [{ points: 10, condition: "未定义脱敏" }],
  },
  {
    key: "authority",
    label: "权限与机构隔离",
    max: 8,
    rule: "必须明确总/分/支行数据查看边界及岗位权限",
    deductionRules: [{ points: 8, condition: "描述为「所有人均可使用」" }],
  },
  {
    key: "material",
    label: "素材真实性",
    max: 8,
    rule: "须含真实案例/字段/接口证据（非纯 AI 揣测）：业务提供过真实办理实例、字段级定义或系统接口依据",
    deductionRules: [
      { points: 8, condition: "无任何真实案例/字段/接口证据，纯问答兜底" },
      { points: 4, condition: "仅有零散实例，缺字段级或接口级证据" },
    ],
  },
  {
    key: "nfr",
    label: "非功能覆盖",
    max: 7,
    rule: "须覆盖性能/并发/可用性/灾备/数据主权/信创等非功能需求",
    deductionRules: [{ points: 7, condition: "未提及任何非功能需求" }],
  },
  {
    key: "acceptability",
    label: "可验收性",
    max: 7,
    rule: "每功能点须有量化验收指标（如 MTTR、吞吐、准确率、具体可测条件）",
    deductionRules: [{ points: 7, condition: "无量化验收指标，无法判定是否做对" }],
  },
] as const

/** reqdoc 打分卡维度键（类型安全，消费方遍历 REQDOC_SCORE_DIMS 即可）。 */
export type ReqdocScoreDimKey = (typeof REQDOC_SCORE_DIMS)[number]["key"]

/**
 * edge 阶段**追问要点**（不是"探针"）。
 *
 * 原为「质量飞轮 P1 探针清单」，与已删的 `reqdoc_probe` 工具/ `probes` 状态一一对应；
 * 2c 删除那些机制后它成了孤儿：`dim` 映射的八维打分卡已不存在，而 r11 规则一边说
 * 「不需手工维护探针表」一边把表注入进去——自相矛盾（对抗审查 P2-c）。
 *
 * 现在它只保留**仍有效的追问话术**（要真实案例、异常处置、脱敏、权限边界），
 * 作为「该问什么」的补充提示；实际该问哪些**地址由服务端 `deriveQuestions` 派生**
 * （槽位缺口 + 容器候选 + 记忆消缺口），此处不参与判定、也不决定轮次。
 */
export interface ReqdocClarifyHint {
  /** 要点 id */
  id: string
  /** 业务语言中文名 */
  label: string
  /** 业务语言问题模板（模型转述为 A/B/C + 默认推荐） */
  question: string
}

export const REQDOC_CLARIFY_HINTS: readonly ReqdocClarifyHint[] = [
  { id: "main_flow", label: "主流程闭环", question: "请举一个最近发生的真实办理案例，描述它从发起到完成的具体步骤（不要泛泛讲流程，先给实例）；给不出实例请先向 01~05 投放材料或确认口述补全。" },
  { id: "flow_trigger", label: "流程触发条件", question: "什么情况下会开始这笔业务？请结合上面的真实案例说明触发场景。" },
  { id: "exception", label: "异常处理", question: "请举一个真实发生的异常案例（如某笔交易被重复提交、网络中断或提交失败），说明当时怎么处置的；无真实案例则先投放材料或确认口述补全，不要凭空假设。" },
  { id: "reverse", label: "逆向撤销/驳回", question: "办错了想撤销、或提交后被驳回，怎么处理？" },
  { id: "desensitize", label: "敏感字段脱敏", question: "手机号、身份证这些敏感信息，界面上怎么展示？" },
  { id: "audit", label: "留痕与复核", question: "资金或重要操作，要不要留痕、双人复核？" },
  { id: "authority", label: "权限与机构隔离", question: "谁能看、谁能办？数据在总行/分行/支行之间怎么隔离？" },
]

/** 追问要点文本（注入 reqdoc-r11）：作为「该问什么」的补充话术，与派生清单互补。 */
export function reqdocClarifyHints(): string {
  return REQDOC_CLARIFY_HINTS.map((p) => `- ${p.label}：${p.question}`).join("\n")
}



/**
 * reqdoc 追问探针覆盖记录（质量飞轮 P1，reqdoc_probe 工具写入）。
 * 可选字段：首次记录前缺省；sdlc 恒缺省。随汇报上行。
 * asked 按轮追加去重（保留追问历史供自持续「漏问频率」分析）；gaps 为仍缺口探针。

 */


export interface QualityMetrics {
  /** 一次通过率（3.2）：未重写即 accepted 的片段数 ÷ 全部定论片段数(accepted+manual)。
   *  review_submit 通过时由插件自动计算写回，不依赖 Agent 上报。纯讨论会话（无片段）保持 null。
   *  sdlc 专属（代码片段语义）；reqdoc 无此概念时为 null。 */
  firstPassRate: number | null
  /** 「同一段代码/文件」的最大生成-修改循环次数（3.2），取 iterationByFile 各文件最大值 */
  iterationCount: number | null
  /** 最近一次 AI 代码编辑时间戳（write/edit/apply_patch，与 iterationByFile 同观测点）。
   *  sdlc 审查提交时用于前向失效：confirmedAt < lastEditAt 的已接受片段打回 pending
   *  （对抗审核 P2——确认绑定当时的代码，编辑后旧确认不再成立；与 revisit 级联重置同纪律）。 */
  lastEditAt?: number | null
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
   * 基线预估由开发者在对话中明确给出的证据（6.3 防 AI 杜撰）：chat.message hook
   * 捕获开发者消息里的工时表述后写入；`workflow_baseline` 在 `developer_confirmed=true`
   * 时须与之匹配，否则拒收——防止模型自造基线毒化 6.3 AI 提效对比分母。
   * 可选字段：hook 未捕获时缺省。
   */
  baselineProposedByDev?: { hours: number; messageID: string; at: number }
  /**
   * reqdoc 功能点清单（重构核心：prd 前置功能点拆解，业务确认后写入）。
   * 可选字段：确认前缺省；sdlc 恒缺省。随汇报上行。
   */
  features?: ReqdocFeature[]
  /**
   * reqdoc 需求知识库（Slot-filling KB，权威状态；重构 2c 起为唯一渲染/门禁依据）。
   * 槽位是唯一事实源：追问项、覆盖率、门禁、PRD 组装全部由服务端派生。
   * 可选字段：首次 ingest 前缺省；sdlc 恒缺省。
   */
  kb?: ReqdocKbState
}

/**
 * reqdoc 知识库状态（槽位 + 功能点 + 追问轮次）。
 * slots 是唯一事实源——PRD 文档是它的投影（`assembleDoc`），二者不一致即视为构建产物过期。
 */
export interface ReqdocKbState {
  /** 全部槽位（含 draft/confirmed/conflict/retired） */
  slots: import("./reqdoc-slots").ReqdocSlot[]
  /** 已确认功能点（决定必填槽位集合，见 reqdoc-slots.requiredSlots） */
  features: ReqdocFeature[]
  /** 容器声明（可为空通道）：地址 → { required, reason } */
  containers?: Record<string, import("./reqdoc-slots").ContainerDecl>
  /** 地址 → 已连续出现在开放项的轮次（6.3 停问；按轮次计不按调用计） */
  askCounts?: Record<string, number>
  /**
   * 业务**连续**接受默认推荐的轮数（`reqdoc-r27` 的触发条件）。
   *
   * 为什么要有这个字段：r27 要求「连续 2 轮后当轮必须改为开放式追问」，而此前
   * **服务端不存这个数、状态条也不显示**——模型只能自己在对话历史里数「同意默认」
   * 出现了几次。跨轮计数对弱模型不可靠，实测 9/34 场景仍带默认推荐。与 r14 同病：
   * 规则要求模型判断一个服务端未提供的信息。
   *
   * 口径：`reqdoc_answer(source=缺省)` 时 +1（业务接受了这个默认）；任何其它调用归零
   * （业务给了具体意见，连续即中断）。服务端维护、状态条呈现，r27 据此改写。
   */
  defaultAcceptStreak?: number
  /**
   * 建库时的模板**必填地址空间**（`schemaAddressSpace` 的规范化串）。
   *
   * 换模板检测：拿它与当前模板的地址空间做**集合包含**比对——旧必填叶子/容器
   * 不在新模板里才算漂移（旧槽位作废）；必填集变大只是多答一节、不惊动业务；
   * 仅改措辞则完全相等。存串而非哈希，是因为要判包含关系。
   *
   * **只提示不自动清**（显式重置）：`kb.slots` 是唯一事实源、原地覆盖不留历史，
   * 自动清空等于替业务决定这轮问答不算数；跨版本搬地址要判断旧内容在新模板的
   * 哪一节算数，服务端无法校验语义。故提示业务开新会话重走，
   * 旧交付件保留在 `07_需求规格产出/` 不会被覆盖。
   */
  templateAddressSpace?: string
  /**
   * 容器下待判定的子项候选（6.2.1.1：服务端不预置，由扫描/抽取产出）。
   * 例：`{ "<术语容器地址>": ["CRD","AML"], "<字段容器地址>": ["客户号"] }`（具体地址取工具清单）。
   *
   * **这是 L1/L2 记忆的唯一生效入口**——缺了它 `deriveAll` 的候选分支整段不执行，
   * 「少问」机制形同虚设（对抗审查 P0-1）。模型不产生候选（会产生幻觉术语），
   * 由 `reqdoc_scan` 抽取或 `reqdoc_ingest(candidates=…)` 显式提交。
   */
  candidates?: Record<string, string[]>
  /**
   * 记忆匹配的证据快照（材料原文，`materialEvidence(root)` 的产物）。
   * 由 `reqdoc_ingest` / `reqdoc_answer` 写入——它们是异步的、能读盘；
   * `buildStateBar` 是同步的，只能读这里，否则状态栏与工具回执口径不一。
   */
  evidence?: string
  /** 最近一次组装产物的文件名（相对功能点子目录，默认 `PRD.md`）。
   *  定稿校验/变更记录/溯源回填都按它定位产物——否则用户传了 `source=需求规格书V2.md`
   *  就会与硬编码的 `PRD.md` 脱节，导致定稿永久报「未找到产物」（P1-d）。 */
  assembledFile?: string
  /**
   * 承认基线时冻结的槽位快照（`reqdoc_adopt_baseline(confirm=true)` 写入，只冻一次）。
   *
   * 为什么必须有：`kb.slots` 是**原地覆盖**的（`reqdoc_answer` 直接改同地址），系统不留历史，
   * 因此定稿时无法回答「这次到底改了哪些内容」。变更清单以本快照为基准。
   */
  baselineSnapshot?: {
    /** 被承认的基线文件（相对项目根），用于溯源 */
    file: string
    slots: import("./reqdoc-slots").ReqdocSlot[]
    features: ReqdocFeature[]
    at: number
  }
  /**
   * 定点修订（乙）作用域锁：进入后 ingest/answer 只接受该章地址，越界写入服务端拒收。
   * 编辑前冻结 `snapshotBefore` 作差异基准；绑 `sessionId`/写入时刻，会话结束或新 baseline 强清，
   * 杜绝跨会话残留误拒（对抗 B）。见 docs/reqdoc-scoped-edit.md。
   */
  editScope?: {
    chapter: number
    snapshotBefore: import("./reqdoc-slots").ReqdocSlot[]
    active: boolean
    sessionId?: string
    at: number
  }
  updatedAt: number
}

/** reqdoc 字段定义（P2.5 数据字典一项）：逐功能点输入字段的元数据。 */
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
    { id: "sdlc-r1", stage: "global", text: "会话开始时，调用 workflow_start 初始化工作流（开发者说「启动/开始 SDLC 工作流」时也调用它，不要仅用文字回复）。" },
    { id: "sdlc-r2", stage: "global", text: "阶段可能完成时，先输出摘要并询问确认；仅开发者明确表示「确认/通过/可以」才算确认——「你看着办」「差不多」等模糊表态不算，不得自行 approve。确认后调用 workflow_advance(action=approve, developer_confirmed=true)。询问确认时须显式点明所确认的阶段名（如「【编码 阶段】以上编码是否确认？」），不得用笼统的「以上流程与规则是否确认」。注意：enter 进入下一阶段会自动确认仍处于进行中的前序阶段（工具强制）——同样必须在开发者明确确认之后才可调用（developer_confirmed=true），回执会列出被自动确认的阶段；不要用连环 enter 绕过逐阶段确认。" },
    { id: "sdlc-r13", stage: "global", text: stageVisibilityRule("开发者") },
    { id: "sdlc-r3", stage: "global", text: "开发者说「回到XX」时，立即调用 workflow_revisit(stage=XX)。绝不自行判断阶段已完成。" },
    { id: "sdlc-r4", stage: "global", text: "要求提交时，先调用 commit_gate_check；全部五阶段（含审查）approved 后才可 git commit。" },
    { id: "sdlc-r5", stage: "global", text: "提交门禁放行且 git commit 成功后，提醒开发者执行 /new 开始下一个需求，保持统计隔离。" },
    { id: "sdlc-r12", stage: "global", text: "开发者表示要手工修改某段/某文件代码时，先调用 open_ide 并**必须携带 file 参数指明该文件**（不指定 file 不会锁定），以锁定该文件防 AI 覆盖。若开发者未明确文件，先询问要改哪个文件。锁定期间可继续其它任务（改其它文件/答疑），但不得修改被锁定的文件（write/edit/apply_patch 会被服务端拒绝）。开发者确认改完后，须经其明确确认（如说「改完了/可以继续」）再调用 unlock_file 解锁该文件，并重新读取最新文件内容后继续；多个锁定文件须逐个确认解锁。" },
    // ---- implementation ----
    // 原本只有 conventions/sdlc/00-编码规约.md 第 10 节要求「改完即对抗性审核」，而
    // conventions 按设计「只注入、无门禁」（conventions.ts 头注：质量飞轮不参与），
    // 评测器永远看不见它——即一条不可观测的行为要求。落成规则才能进 rulesForStage、
    // 进打分卡、进 scripts/eval-rules，模型侧自审才第一次可被度量。
    { id: "sdlc-r37", stage: "implementation", text: "每次改完代码立即自审一轮，不攒到提交前：① **波及面**——这次改动会波及哪些地方，一处不漏地列出来再动手：调用方（签名/返回值/导出改了吗）、运行与分发环境（宿主提供什么、依赖在别处会不会丢）、既有数据与产物（旧文件/已生成代码/已发出去的东西还在吗）、以及会被读到的文本（给机器的指令别混进给人看的输出，可见性去实际渲染路径核实而非凭感觉断言）。② **反例与方向**——给自己的修复构造一个能推翻它的场景（空值、并发、重复调用、顺序颠倒、上一步遗留状态），**跑出来而不是脑补**；并确认修法对齐了被比较双方的口径与方向，不只字面对上。③ **同类残留**——同类问题在别处多半也存在，grep 同模式一并处理，只修被点名的那一处等于修一半。④ **规约互查**——不与本目录其它规约（安全、日志、并发幂等）冲突。⑤ **护栏随修**——每条被证实的缺陷补一条能失败的测试钉住，与修复同一批提交；拿不准的取舍先回报再改，不静默绕过。" },
    { id: "sdlc-r38", stage: "testing", text: "进入测试阶段后先跑全量测试（项目既有测试套件），把结果摘要（通过/失败数、失败项）贴给开发者看；有失败未修复时不得请求确认通过。项目无测试套件时如实说明，并与开发者约定替代验证方式（如手工验收步骤）后再请求确认。" },
    // ---- requirements ----
    { id: "sdlc-r6", stage: "requirements", text: "进入需求阶段时，主动询问预估人工工时（小时）；开发者明确给出后调用 workflow_baseline(developer_confirmed=true)。未提供不阻塞；已录入后不必重复询问。" },
    // ---- review（理解保障，核心）----
    { id: "sdlc-r7", stage: "review", text: "review 是唯一不可由 AI 自行推进的阶段（必须经 review_submit），目标是确保开发者真正理解代码。" },
    { id: "sdlc-r8", stage: "review", text: "进入审查后，将每个 AI 生成的代码变更拆分为可理解片段，comprehension_add 逐段登记并输出解释（做了什么、为什么这样写、被放弃的替代方案、潜在风险）。" },
    { id: "sdlc-r9", stage: "review", text: "开发者确认某片段时，立即调用 comprehension_confirm(codeSegmentId=该片段 id)；单次只接受一个 codeSegmentId，逐段确认、禁止一次确认多个。" },
    { id: "sdlc-r10", stage: "review", text: "开发者追问时详细解释，comprehension_ask 将问答追加到该片段的 explanation。**追问必须登记成问答，不要用 read_file 自看代码代替**——不登记的问答不进理解证据链。" },
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
    { id: "reqdoc-r1", stage: "global", text: "会话开始时调用 workflow_start 初始化工作流（开发者说「启动/开始 reqdoc 工作流」时也调用它，不要仅用文字回复）。定稿完成（review_submit 通过）后建议 /new 开始下一个需求，保持统计隔离。" },
    { id: "reqdoc-r2", stage: "global", text: "采用渐进式分段引导，不要一次性抛出所有问题；单次提问最多 5 个问题，每个问题必须附 A/B/C 选项并标注【默认推荐项】（业务回复「同意默认」即按推荐确认）；同一需求追问最长 3 轮，3 轮后仍未澄清项标 [缺省] 进入下一环节，避免业务有被「质问」的挫败感。提问一律用业务语言，严禁出现「高并发、幂等性、API」等纯技术词汇——同一含义必须转述为业务说法（如并发重复提交→「同一笔交易被重复点了几次怎么处理」）。" },
    { id: "reqdoc-r3", stage: "global", text: "阶段推进纪律：阶段可能完成时先输出摘要并询问确认，仅业务明确「确认/可以」才算（模糊表态不算），询问时须点明所确认的阶段名。确认后进入下一阶段即自动确认上一阶段（工具强制，无需单独调 approve；enter 自动确认前序阶段时同样须 developer_confirmed=true）。业务说「回到XX」时立即 workflow_revisit(stage=XX)——**绝不自行判断阶段已完成，也不要用「进入下一阶段」绕过**。" },
    { id: "reqdoc-r25", stage: "global", text: stageVisibilityRule("业务") },
    { id: "reqdoc-r26", stage: "global", text: "投放/口述 决定未完成前不得推进：需求资料目录（01~05）已建、但业务尚未明确选择「投放材料」还是「直接口述」时，**这一问本身就是本轮「最多 5 问」里的第一问**，须与其他问一起按 r2 的格式给出（每个问题都带 A/B/C 选项与【默认推荐项】），问完照常等业务回答即可——**不要因为要问这一问就放弃 A/B/C 与默认推荐，也不要把它当成「本轮只问这一句」**。（旧措辞写成「本轮不许问别的」，与 r2 打架：弱模型会二选一遵守，实测照「只问一句就停」执行，r1 判据立刻塌——问句 2/5、无「默认推荐」、A/B/C 仅 3 个。）真正的约束是「不替业务假定投放/口述、不得跳过这一问直接进追问」，不是「本轮不许问别的」。调用 reqdoc_init 后，必须把工具返回的目录绝对路径**逐行粘贴到你的回复正文里**（不要只写「见工具返回/见上方」——业务可能看不到工具记录），再附「① 投放材料 / ② 直接口述」二选一，不得自行浓缩成「方便您后续放材料」之类不触发动作的话术后追问。业务选直接口述时先回知情确认（见 reqdoc-r8），部分投放则仅扫描已投目录。" },
    { id: "reqdoc-r27", stage: "global", text: "关键确认防浅背书：状态条报「业务已连续 N 轮接受默认推荐」、N ≥ 2（连续 2 轮默认）时，**当轮必须改为开放式追问**（不端带默认推荐的选项），让业务对量化目标、功能范围、权限边界说具体意见。**按状态条数字判，别自己在对话里数**（回执一次性）。默认项须标注「这是我的推测，你判断不了就选『以上都不是』」，且用 reqdoc_answer(source=缺省, reason=…)显式收口才计入覆盖（reqdoc-r22 门禁兜底）；**静默点默认的内容不得写入记忆**（错误定义会跨需求传播）。" },
    { id: "reqdoc-r28", stage: "edge", text: "先补料再追问：进入边界与异常（edge）追问前，若 01_背景与目标 / 03_制度与合规 / 04_角色与权限 仍全空且业务未选「直接口述」，须先促业务投放其中至少 2 个目录（或确认口述），避免全程 [问答] 兜底导致需求说服力与可追溯性弱；同时提示调用 workflow_baseline(developer_confirmed=true) 录入预估工时与 MTTR 基线，形成 AI 提效对比。已扫描材料充足时可跳过。" },
    { id: "reqdoc-r30", stage: "global", text: "来源真实性：尽量让槽位来源为 [文档]——业务向 01_背景与目标 / 02_流程与数据 / 03_制度与合规 / 04_角色与权限 补充书面材料后重扫 reqdoc_scan。**凭历史记忆直接落定的术语一律标 [问答]，不算来源降级**——材料只出现该词、并未给出定义，标 [文档] 是不实溯源，审计拿标签回材料里搜不到那句话。当前无书面材料可直接与业务说明「本次全程 [问答] 兜底，未确认项标 [缺省]」，无需额外确认动作。" },
    { id: "reqdoc-r35", stage: "global", text: "增量与已有稿的增量口径（功能点地址按「章号.序号.*」结构寻址，序号即功能点在清单里的位置；地址本身取清单，勿自造）：① **功能点只能追加到末尾**——插入/删除/改名会让既有槽位地址漂移、内容错位，门禁判成未填导致全量重问，且无报错说明原因；已有需求要加功能时，用 `reqdoc_confirm_features` 传入「原清单 + 末尾追加的新功能」。② **不得把旧稿/上一版 PRD 整篇重新 `reqdoc_ingest`**——ingest 对提交的地址一律记为 draft（并把 askCount 归零），整篇重提会把已确认槽位静默打回草稿、覆盖率崩塌、业务被迫重述；要修改已有槽位内容只能用 `reqdoc_answer`（它保持 confirmed）。" },


    // ---- goal 目标与场景 ----
    { id: "reqdoc-r6", stage: "goal", text: "用一两句话引导业务说明：上线后谁在用、解决什么痛点；提炼【核心用户】【业务场景】【业务价值】，表达模糊时给出 A/B/C 选项并标注【默认推荐项】让业务勾选确认。" },
    { id: "reqdoc-r7", stage: "goal", text: "进入 goal 阶段时，主动询问预估人工书写工时（小时）；业务明确给出后调用 workflow_baseline(developer_confirmed=true)。未提供不阻塞；已录入后不必重复询问。" },
    { id: "reqdoc-r8", stage: "goal", text: "目录就绪检查：项目根约定 00~07 需求资料目录（编号即五步编写流顺序）：00_初稿需求书 为已有初稿导入入口；01_背景与目标、02_流程与数据、03_制度与合规、04_角色与权限 为业务投放材料区；05_系统现状与能力 为可选目录（单位技术侧投放系统架构/现有能力/接口/数据模型）；06_功能点、07_需求规格产出为 AI 工作区。尚无时主动调用 reqdoc_init 搭建骨架（幂等，绝不重建或覆盖业务已放材料），并向业务展示各材料目录的绝对路径、明确说明「把资料放进 01~05 对应目录，有多少投多少，未投放的目录我们口述补全，无需一次备齐」；业务已有初稿则放进 00_初稿需求书/ 后调 reqdoc_import(path) 导入。**00_初稿需求书/ 里有文件时，先判定走哪个分支再选路径**（并入下面「投放材料 / 直接口述」那一次提问，不要为此单独多问一轮）：**分支二（改已有需求）**——业务自己写的初稿、或本流程上一版定稿（`PRD_V*.md`）→ 调用序按本条后续顺序不跳步：`reqdoc_import` 导入为 [文档] → `reqdoc_ingest` 提交槽位（**每项 ref 填该稿路径**，槽位一律 draft）→ `reqdoc_adopt_baseline` **先不带 confirm 预演**，把按章分组的清单给业务逐条看过 → 带 `confirm=true` + `authorized_by` + `confirm_note` 执行（**两项须来自业务，模型不得代填**，照 force_kb/force_reason 先例）+ `unmapped` 逐条申报「稿里有、模板装不下的内容」（不申报这类内容会静默消失）→ 沿用基线后**只问「旧稿未覆盖的必填项 + 新增功能点」**（新增功能点用 `reqdoc_confirm_features` 末尾追加）；**别被状态条的「必填容器未覆盖」带偏**——术语容器与字段容器（本轮清单里 kind=term / kind=field 的那两个）是**聚合判定**：旧稿里有对应内容就把它提交成容器叶子（`reqdoc_ingest`，地址形如 `<容器地址>.<术语名>` / `<容器地址>.<字段名>`，具体地址取清单，勿自造），容器即算覆盖；旧稿里确实没有才声明 `required:false` + reason，**不要因为容器报未就绪就把旧稿里已写着的术语与字段重问一遍**；业务点名要改某段已确认内容时（见 r35 ②），先问清新内容再用 `reqdoc_answer` 落定 → 定稿回执给出「本次变更」清单。**顺序反了会出事**：先沿用基线、后问业务要改什么，中间没有可对照的基线，业务要的改动会被并进旧内容里分不清；**分支一（全新流程）**——该目录为空 → 按常规五阶段从头走，不为此额外发问。业务说资料已放好、或会话中途补充了材料，则调用 reqdoc_scan(directory=01_背景与目标) 扫描提取作引导输入（可重复扫描，不必等下一轮）。init 之后、进入追问前，必须显式向业务提出「投放材料 / 直接口述」的二选一（或问清已投了哪些目录），未得到明确选择不擅自推进追问；业务选直接口述时，先回一句知情确认「那全程来源会是 [问答]，定稿时你需确认『无书面材料』」再继续，部分投放则仅对投放目录扫描、状态条自然显示 [文档]/[问答] 混合、无需该确认。" },
    { id: "reqdoc-r32", stage: "global", text: "已有初稿需求书时，引导业务把初稿放进 00_初稿需求书/ 目录后调用 reqdoc_import(path) 导入（path 可为文件或目录）：产出「按机构规约的初评」（逐份规约列 满足/缺失/矛盾），并停在起点等业务看初评后再逐阶段走（不自动 approve、不替业务快进）。初评后按三类路径补全：① AI 可直接改的结构/术语类（如术语未引原文、章节错序）；② 依赖外部依据（制度原文、系统接口、敏感字段清单）须投放 03_制度与合规 / 04_角色与权限 / 05_系统现状与能力 后 reqdoc_scan 提取；③ 仅业务知晓（真实异常实例、量化指标、权限边界）走 edge 探针追问（A/B/C + 默认推荐，≤3 轮）。初稿定位为「待完善的原始稿」，导入即诊断、不改写初稿本身。" },
    // ---- rules 流程与规则 ----


    // ---- edge 边界与异常（最关键）----
    // 追问按服务端派生的开放项推进（openItems），不再有独立探针清单：
    // 口径与要求由 deriveQuestions 从槽位缺口派生，模型只负责「问 + 提交 + 确认」。
    { id: "reqdoc-r11", stage: "edge", text: `按工具返回的「本轮该填」清单追问——**清单是唯一依据**（由服务端从槽位缺口 + 术语候选 + 记忆实时派生，随答复收敛）：${reqdocClarifyHints()}
（以上是 edge 阶段易漏的追问要点，供参考；**清单里没有的项不要问**，清单有的项不要漏。）
每轮最多 5 问（见 r2，带 A/B/C 与【默认推荐项】）；主流程/异常类须「先要真实案例再答题」——业务给不出实例则明示缺真实素材、卡住提示投放 01~05，不往下走。**清单里没有的项不要问**；标「默认：…」的说明有记忆可参考，转述成确认式提问（业务点头即可）。

每轮问答后必须回写槽位（唯一事实源，不写则门禁不放行）：提取到的内容批量 reqdoc_ingest（一次最多 8 项）；业务明确答复的立即 reqdoc_answer 落定。同一项连续 ${"2"} 轮未确认会被停问、移出清单——此时不得反复追问，应显式收口（source=缺省 + reason 写明原因）。最多 3 轮；到上限仍未澄清的逐条列出并说明业务可选项：补充材料/口述补全、确认接受 [缺省]、或开新会话继续。` },
    { id: "reqdoc-r12", stage: "edge", text: "按已投放材料反问缺口（如已有制度但缺权限，追问「不同岗位的权限如何隔离」）；业务说资料已放好则调用 reqdoc_scan(directory=03_制度与合规) 与 reqdoc_scan(directory=04_角色与权限) 扫描提取作输入；综合岗位角色矩阵、机构隔离、审批授权与双人复核材料生成 RBAC 权限控制矩阵与审批流控制逻辑，向业务展示确认。\n主流程须先用**可读的纯文本步骤**（编号列表 ①→②→③ 或箭头串）向业务展示确认——对话内不得只给 Mermaid 图。综合扫描材料与问答产出**数据字典与库表设计**（数据实体/字段/主外键/校验规则）并请业务确认，落盘 07_需求规格产出/数据字典与库表设计/。" },
    // 填槽纪律（设计 10 章新增 r33）：批量起草 + 一次性确认 + 术语优先取记忆
    { id: "reqdoc-r33", stage: "edge", text: "填槽纪律：① 扫描后**批量起草**——一次 reqdoc_ingest 提交本轮全部提取项（工具封顶 8 项/次），不要一问一答写一条；② **一次性确认**——把本轮清单合成一条消息请业务逐项过目，业务点头后用 reqdoc_answer 连续落定，不要每项单独问一轮；③ 术语分三类，别混：**(a) 回执「已采信历史记忆」列出的项**——它们**不在本轮清单里**（服务端已剔除），**绝不要再问业务**，但**须由你直接 reqdoc_answer 落定，source 一律标「问答」**（定义出自业务过往口述，材料只出现该词、并未给出定义；标「文档」等于在交付件上做不实溯源）；不落定则术语容器覆盖不过、进 prd 被拦；**(b) 清单里带「默认：…」标记的**——共享知识命中（即 L2 组织知识），转述成确认式提问请业务点头（仍要问，只是带默认值）；**(c) 两者都没有的缩写**——正常问，取不到定义时可给猜测但必须带默认值请业务点头。" },
    { id: "reqdoc-r22", stage: "edge", text: "覆盖度门禁（进 prd 硬前置）：服务端按 kbGate 校验必填槽位覆盖率与未收口项——**必填槽位未 confirmed、或有停问/conflict 项未收口，workflow_advance(stage=prd, action=enter) 会被拒绝**。工具返回的覆盖率与剩余项实时反映状态，别凭记忆判断。业务明确「本期确实不涉及」的项用 reqdoc_answer(source=缺省, reason=...) 显式收口即计入覆盖。确实无法补齐且业务坚持不做，可 force_kb=true + 业务给的 force_reason 放行（理由模型不得代填）。" },

    // ---- prd 需求规格书 ----
    { id: "reqdoc-r13", stage: "prd", text: "功能点拆解（核心）：综合前面 goal/rules/edge 收集的信息（材料提取 + 问答），把需求拆成功能点清单（编号/名称/优先级），先向业务展示清单确认；业务确认后调用 reqdoc_confirm_features(features=[{name,priority}]...) 记录，并为每个功能点在 06_功能点 下建子目录写入来源摘录（标注 [文档]/[问答] 来源）。业务说资料已放好则先调用 reqdoc_scan(directory=07_需求规格产出) 检查已有产出。" },
    { id: "reqdoc-r14", stage: "prd", text: "PRD 产出（**由服务端从槽位投影生成，不要手写**）：流程只有两步——① reqdoc_ingest 批量提交内容槽位（地址取工具返回的清单）→ reqdoc_answer 逐项请业务确认落定；② reqdoc_assemble 由服务端按《业务需求说明书》模板投影出整篇 md，归档到 07_需求规格产出。**严禁用 write 手写或手工编辑 PRD 正文**（手写产物缺内嵌槽位摘要，定稿会被拦）。槽位变更后重跑 reqdoc_assemble。定稿后调用 reqdoc_export 生成 Word 交付件。**prd 阶段禁止用 comprehension_add**（review 阶段工具）堆理解条目——用它代替 reqdoc_ingest，内容既不进槽位也不进产物。" },
    // 槽位内容铁律：地址映射已由服务端派生（清单精确到每个小节），规则不再复述映射表、也不复述任何编号——
    // 模板结构已改为从 md 解析，编号会随机构模板变，写死在规则里必然过时。
    { id: "reqdoc-r20", stage: "prd", text: "槽位内容铁律：工具返回的「本轮该填」地址已精确到小节，**照地址填即可，不要自己判断该写进哪一节，也不要自造地址**（换机构模板后编号会变，清单永远是唯一依据）。内容要求：业务语言书面语，**禁止杜撰事实**——[问答] 来源的口语须提炼为规范书面语，不得原话照搬；[缺省] 必须附 reason，禁止裸 [缺省]。模板外成果（UAT 用例、低保真界面、数据字典与库表设计、RBAC 权限矩阵）不插入 PRD 正文，用 write 写入 07_需求规格产出 下子目录，并在对应功能点的「附件」小节列出清单与相对路径（该小节标题与地址以工具清单为准）。" },

    { id: "reqdoc-r24", stage: "prd", text: "组装幂等门禁：reqdoc_assemble 会把槽位摘要内嵌进产物，review_submit 定稿时重读比对——**不一致即拒绝**（槽位变更须重新组装；产物被手改须还原）。手写或编辑过的 PRD（无内嵌摘要）同样被拦。缺料字段如实标 [缺省] 并附 reason，不要为凑覆盖率编造内容。" },
    { id: "reqdoc-r31", stage: "prd", text: "字段定义（进入本轮清单里 kind=field 的容器下的槽位，逐字段与业务确认）：每个功能点的输入字段逐一定义——字段名、类型、长度/精度、是否必填、取值域/约束、来源系统/接口——用 reqdoc_ingest(kind=\"field\") 提交、reqdoc_answer 落定。**确无结构化输入字段的，用 containers 把该容器声明为 {required: false, reason: <理由>}**（容器地址取工具返回的清单；术语容器同理，即 kind=term 的那个），否则 kbGate 会因必填容器未覆盖而拦截。" },
    { id: "reqdoc-r34", stage: "prd", text: "流程图生成（prd 阶段）：渲染每个功能点时，若满足以下任一条件，须在模板的「流程图」小节内嵌 Mermaid 流程图（flowchart TD 或 sequence diagram）：(1) 功能点涉及 3 步以上的主流程（含分支/循环）；(2) 功能点涉及多角色交互（如客户→系统→审批人）；(3) 业务在 rules/edge 阶段已提供或确认过流程图（02_流程与数据 扫描提取）。不满足时任选「● 不涉及」。该小节的地址取本轮清单，勿自造。流程图以 Mermaid 语法内嵌 PRD 正文该小节（用 ```mermaid 围栏包裹），不单独落盘附_流程图/（除非流程图超长超一屏才拆分独立文件，并在同一小节引用路径）。" },
    // ---- review 业务确认（核心）----
    { id: "reqdoc-r15", stage: "review", text: "review 是唯一不可由 AI 自行推进的阶段（必须经 review_submit），确保业务真正理解并确认 PRD 要点。" },
    { id: "reqdoc-r16", stage: "review", text: "要点拆解与确认：把 PRD 拆为可确认要点（业务目标/核心字段/异常规则/合规要求），comprehension_add 逐段复述输出。业务确认某要点立即 comprehension_confirm(codeSegmentId=该要点 id)——**单次只接受一个要点，禁止一次确认多个**。业务追问时用 comprehension_ask 把问答追加到该要点。" },


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