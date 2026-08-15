/**
 * 规则遵循度评测共享类型(scripts/eval-rules,设计文档 12.1)。
 * 场景 → 注入片段(baseline/new)→ 弱模型 tool_use/文本 → rule-based 判定。
 */
import type { WorkflowType as SharedWorkflowType, WorkflowState } from "sm-shared"

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
}

export interface GroupSummary {
  /** 通过的运行次数（非场景数）；rate = pass/total 为按运行次数的通过率 */
  pass: number
  total: number
  rate: number
}

export interface EvalReport {
  variant: "baseline" | "new"
  model: string
  dry: boolean
  runAt: string
  results: ScenarioResult[]
  summary: { overall: GroupSummary; sdlc: GroupSummary; reqdoc: GroupSummary }
}
