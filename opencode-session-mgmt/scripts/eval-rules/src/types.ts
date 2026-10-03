/**
 * 规则遵循度评测共享类型(scripts/eval-rules,设计文档 session-management.md 13.1)。
 * 场景 → 注入片段(baseline/new)→ 弱模型 tool_use/文本 → rule-based 判定。
 */
import type { ReqdocScoreDimKey, WorkflowType as SharedWorkflowType, WorkflowState } from "sm-shared"
import type { PrdScore } from "./score"

export type WorkflowType = SharedWorkflowType

/**
 * 判定规则(rule-based,不用 LLM judge——弱模型判定既贵又不稳):
 * - tool   应调用某工具,且参数满足谓词(如 approve 时 developer_confirmed 必须 true)
 * - no_tool 不应调用某工具(未确认不 approve、前序未完成不 submit、基线已录不重复)
 * - text   无对应工具的纯文本行为(问句 ≤2、edge 探针关键词),仅用于引导类场景,判定口径脆弱需人工复核
 */
export type Judge =
  | {
      /**
       * 「尝试了但被服务端拒绝」——验的是**服务端防线**，不是模型谨慎。
       *
       * 存在的理由：`no_tool` 判据（「不该调用 X」）在弱模型上假回退率极高。本项目实测
       * r5「前序未完成不 submit」在新注入下 baseline 3/3 → new 0/3，看着像注入改坏了，
       * 查下去服务端 `review_submit` 本来就会因前序阶段未 approved 直接抛错——**生产零后果**，
       * 代价只是浪费一轮 + 一次困惑报错。用「模型不该尝试」去测，测的是弱模型的谨慎程度，
       * 不是系统的防线；正确的不变量是：**尝试了也不得成功**。
       *
       * 要求必须真的被拒绝（`ok === false`），没尝试不算通过——否则这个场景就不再走防线，
       * 白测。**仅在 `EVAL_EXECUTE=1` 下可判**（需要真实工具执行结果）。
       *
       * `orTools` 是「走正路也算过」的例外：有些场景模型不试错工具、直接用了正确的那个
       * （实测 s18：模型跳过 `workflow_advance(approve)` 改调 `review_submit`——完全正确，
       * 却因没踩防线而判失败）。列出后，命中其中任一即通过。
       */
      kind: "rejected"
      tool: string
      /** 这些工具被调用也算通过（模型选了正确路径，无需以身试错） */
      orTools?: string[]
    }
  | {
      kind: "tool"
      expectTool: string
      /** 期望参数子集(全部匹配即通过),如 { stage: "requirements", action: "approve", developer_confirmed: true } */
      args?: Record<string, unknown>
      /** 数组子集断言(质量飞轮 P1 追问可测化):期望每个元素须出现在实际数组参数中。
       *  如 { asked: ["exception","authority"] } 断言至少问过异常与权限;与 args 全等语义互不影响(零回归)。 */
      argsContains?: Record<string, unknown[]>
      /** 若设置,调用次数须恰为该值(防批量/防漏) */
      exactCount?: number
      /** 若设置,各次调用的该参数值必须互不相同(防重复确认同一 id) */
      distinctArg?: string
      /** 若设置,这些**点路径**字段必须在某次调用里是非空字符串(如
       *  "restated_term.business_quote")。用于断言嵌套字段真有内容——
       *  `args` 只能做 `actual[k] === v` 的引用相等,判不了嵌套对象。 */
      argsNonEmpty?: string[]
      /** 若设置,这些点路径字段在**任何一次**调用里都不得有值(防模型多传不该传的字段,
       *  如业务只是点了「同意默认」却仍带 restated_term)。 */
      forbidArgsPresent?: string[]
      /** 若设置,这些工具名必须按此**先后顺序**各出现一次(子序列匹配,允许中间夹别的调用)。
       *  用于「先补齐知识库再组装」这类顺序门禁——顺序错���产物就是过期快照。 */
      sequence?: string[]
      /** 若设置,这些工具**一次都不许调**(在本场景同样有效的替代路径)。
       *  如「该走槽位不许用 comprehension_add 堆理解条目」——绕过比硬写更隐蔽。 */
      forbidTool?: string[]
      /** 判据说明/复核备注（不参与判定，仅留痕）——各变体通用 */
      note?: string
    }
  | {
      /**
       * 「任何调用都不得带该字段」——只验禁令，不要求模型做别的动作。
       *
       * 存在的理由：把「要做 X」和「不许做 Y」写在同一条判据里，等于用 X 的可达性去连坐 Y。
       * r26 的考点是「业务只是点了同意默认 → 不得凭空虚构复述写 L1」，但判据要求必须调
       * `reqdoc_answer`——而该场景 13% 覆盖、材料目录为空，模型按 reqdoc-r28「先补料再追问」
       * 先去 `reqdoc_scan` 是**合规的**，却因没调 answer 而判失败。禁令型考点必须独立成判据。
       */
      kind: "argsAbsent"
      path: string
    }
  | {
      kind: "no_tool"
      /** 不应调用的工具名（可多个，任一命中即违规） */
      forbidTool: string | string[]
      /** 若设置,仅当调用同时满足这些参数时才判违规(如 action=approve) */
      args?: Record<string, unknown>
      /** 判据说明/复核备注（不参与判定，仅留痕）——各变体通用 */
      note?: string
    }
  | {
      kind: "text"
      type: "maxQuestions" | "optionsABC" | "categoryKeywords" | "keyword"
      /** maxQuestions: 回复中问号(？/?)计数上限 */
      max?: number
      /** optionsABC(追问约束 r2)：问号 ≤ max 且含「默认推荐」且 A/B/C 选项标记 ≥2(每个问题须附选项与默认推荐) */
      minOptions?: number
      /** categoryKeywords: 命中 ≥minCategories 类关键词(每类任一命中即算该类) */
      categories?: string[][]
      minCategories?: number
      /** keyword: 回复必须包含的关键词(如完成后提醒 /new 的无工具纯文本行为) */
      keyword?: string
      note?: string
    }
  | {
      kind: "score"
      /** 渲染结构校验：文本命中任一标记才算真的渲染出 PRD(防空谈不渲染) */
      renderMarkers: string[]
      /** 通过条件：scorePrd(text).total ≥ minTotal */
      minTotal: number
      /** 附加维度上限(缺料场景验证「不杜撰」)：该维实得分 ≤ 上限 */
      dimMax?: Partial<Record<ReqdocScoreDimKey, number>>
      /** 附加维度下限(材料齐全场景)：该维实得分 ≥ 下限 */
      dimMin?: Partial<Record<ReqdocScoreDimKey, number>>
    }
  | {
      kind: "render"
      /** 渲染 diff 判定（质量飞轮 P2）：用共享 parseRenderStructure 解析模型回复文本，
       *  断言章节骨架/顺序/功能点块数/来源标注（与运行时 reqdoc_check 同源，无真实文件，
       *  judge 解析 out.text——评测模型在回复文本里渲染 PRD 骨架）。 */
      /** 必查章节标题（缺省=模板全部章节）；断言这些标题都出现 */
      requiredChapters?: string[]
      /** 章节顺序须正确（outOfOrder 为空），缺省 true */
      ordered?: boolean
      /** 功能点块数下限（第三章每功能点一段） */
      minFeatures?: number
      /** 所有映射字段在所有功能点块都带来源标注（covered[key] ≥ featureCount） */
      sourceAll?: boolean
      /** 至少一个映射字段标 [缺省]（缺料不杜撰的结构信号） */
      anyDefault?: boolean
      /** 模糊匹配章节标题（includes 而非精确相等），弱模型可能用不同标题格式 */
      fuzzy?: boolean
      /** 拆级降权（质量飞轮 A3/D7）：true 时 sourceAll/anyDefault 降为**观察项**——
       *  仍解析、仍记录进 detail，但不计通过率。硬门禁只保留结构骨架（章节齐全/顺序/功能点块数），
       *  来源标注是当前模型能力外的软指标，作数据反哺（哪字段漏标最多 → 规则示例/模板），
       *  不阻塞整体通过率（r23/r24 已定「接受现状」）。 */
      soft?: boolean
    }

export interface Scenario {
  name: string
  workflowType: WorkflowType
  /** 会话状态夹具(baseline 与 new 渲染共用同一夹具,保证可对等比较) */
  state: WorkflowState
  /** 模拟开发者/业务的当前发言 */
  userTurn: string
  judge: Judge
  /** 判据意图一句话（不参与判定，仅留痕；配对场景靠它说明「正向/反向」） */
  note?: string
}

export interface ToolCall {
  name: string
  args: Record<string, unknown>
  /** OpenAI 兼容协议的工具调用 id——多轮回灌 tool 结果时必需（model 侧按 id 配对） */
  id?: string
}

export interface ModelOutput {
  text: string
  toolCalls: ToolCall[]
  /**
   * 真实产物内容（仅 `EVAL_EXECUTE=1` 时有）：执行工具后从工作区读到的组装产物。
   *
   * 存在的理由：PRD 由服务端 `reqdoc_assemble` 投影生成，**模型正文里不该有 PRD**
   * （规则明令「不要手写产物」）。所以渲染质量/五维分只能从真实产物评——
   * 没有这个字段，render/score 判据就只能去读模型正文，等于奖励手写产物。
   * 判据侧一律按 `artifact ?? text` 取，缺产物时回落正文（并让 render 判据如实判不通过）。
   */
  artifact?: string
  /** 执行工具时每个调用的结果（工具名 → 回执或错误文案），供诊断与「调用是否被拒」类判定 */
  toolResults?: { name: string; ok: boolean; result: string }[]
}

export interface ScenarioResult {
  name: string
  workflowType: WorkflowType
  pass: boolean
  /** 该场景 N 次运行中通过次数（repeat>1 时聚合按运行次数统计，防单次抖动掩盖趋势） */
  passCount: number
  runCount: number
  detail: string
  /** 评分场景（judge.kind==="score"）：多次运行的平均分，供 run.ts 聚合逐维对比 */
  scoreAvg?: {
    total: number
    dims: Record<ReqdocScoreDimKey, number>
    maxDims: Record<ReqdocScoreDimKey, number>
  }
  /** 评分场景：多次运行的 PrdScore 明细（本机留痕，汇报仅带上行 summary.score） */
  scores?: PrdScore[]
  /** 渲染/评分场景（质量飞轮）：各次运行的模型输出原文（A4 归因用——只看判定 detail
   *  无法区分「纯文本渲染」「错层级标题」「tool_call 占位」，须留原文；本机留痕，汇报不上行） */
  outputs?: string[]
}

export interface GroupSummary {
  /** 通过的运行次数（非场景数）；rate = pass/total 为按运行次数的通过率 */
  pass: number
  total: number
  rate: number
}

/** 评分场景聚合：跨评分场景按「每场景多运行平均」求八维平均分（质量飞轮 P0 产出度量）。 */
export interface ScoreDimAvg {
  key: ReqdocScoreDimKey
  label: string
  max: number
  avg: number
  /** 平均分占满分比例（0-100） */
  rate: number
}

export interface ScoreSummary {
  /** 参与聚合的评分场景数 */
  scenarios: string[]
  totalAvg: number
  dims: ScoreDimAvg[]
}

export interface EvalReport {
  variant: "baseline" | "new"
  model: string
  dry: boolean
  runAt: string
  /** 仅跑了子集时的留痕：ran/total 场景数与过滤条件。与全量结果不可直接比较 */
  partial?: { ran: number; total: number; name?: string; workflow?: string }
  results: ScenarioResult[]
  summary: { overall: GroupSummary; sdlc: GroupSummary; reqdoc: GroupSummary; score?: ScoreSummary }
}
