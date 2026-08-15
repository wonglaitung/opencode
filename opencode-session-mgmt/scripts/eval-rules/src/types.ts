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
    }
  | {
      kind: "no_tool"
      /** 不应调用的工具名（可多个，任一命中即违规） */
      forbidTool: string | string[]
      /** 若设置,仅当调用同时满足这些参数时才判违规(如 action=approve) */
      args?: Record<string, unknown>
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
      /** 必查章节标题（缺省=REQDOC_TEMPLATE_CHAPTERS 全部）；断言这些标题都出现 */
      requiredChapters?: string[]
      /** 章节顺序须正确（outOfOrder 为空），缺省 true */
      ordered?: boolean
      /** 功能点块数下限（第三章每功能点一段） */
      minFeatures?: number
      /** 所有映射字段在所有功能点块都带来源标注（covered[key] ≥ featureCount） */
      sourceAll?: boolean
      /** 至少一个映射字段标 [缺省]（缺料不杜撰的结构信号） */
      anyDefault?: boolean
    }

export interface Scenario {
  name: string
  workflowType: WorkflowType
  /** 会话状态夹具(baseline 与 new 渲染共用同一夹具,保证可对等比较) */
  state: WorkflowState
  /** 模拟开发者/业务的当前发言 */
  userTurn: string
  judge: Judge
}

export interface ToolCall {
  name: string
  args: Record<string, unknown>
}

export interface ModelOutput {
  text: string
  toolCalls: ToolCall[]
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
}

export interface GroupSummary {
  /** 通过的运行次数（非场景数）；rate = pass/total 为按运行次数的通过率 */
  pass: number
  total: number
  rate: number
}

/** 评分场景聚合：跨评分场景按「每场景多运行平均」求五维平均分（质量飞轮 P0 产出度量）。 */
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
  results: ScenarioResult[]
  summary: { overall: GroupSummary; sdlc: GroupSummary; reqdoc: GroupSummary; score?: ScoreSummary }
}
