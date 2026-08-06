/**
 * 本机统计聚合查询（设计文档 4.3、6）。
 * 会话级/项目级：插件库（工作流/会话内质量）+ 上游 session SDK（cost/tokens），
 * 按 sessionID 关联。纯函数实现，供 opencode-sm 复用（不依赖插件 SDK/数据库句柄）。
 */
import {
  STAGE_LABELS,
  STAGE_ORDER,
  efficiencyRatio,
  sumLinesByCategory,
  type LinesCategory,
  type StageName,
  type StageRecord,
  type WorkflowState,
} from "sm-shared"
import type { Usage } from "./report"
import type { WorkflowSessionRow } from "./db/schema"

/** 一次通过率偏低参考线：低于此值标记为返工信号（仅供统计展示，非硬阈值/非告警）。 */
export const LOW_FIRST_PASS_THRESHOLD = 70

/** 统计参考线：单文件编辑次数达到此值视为"迭代较高"（仅供统计展示，非硬上限）。 */
export const HIGH_ITERATION_THRESHOLD = 5

export interface StageStats {
  name: StageName
  label: string
  status: string
  revision: number
  durationMs: number
}

export interface SessionStats {
  sessionID: string
  title: string | null
  account: string | null
  status: string | null
  tags: string[]
  stages: StageStats[]
  durationMs: number
  firstPassRate: number | null
  iterationCount: number | null
  reworkRate: number | null
  testCoverage: number | null
  /** AI 净增行数三分类聚合（本机 linesByFile 明细经 sumLinesByCategory 逐文件 clamp 汇总）；无 AI 代码编辑为 null */
  lines: LinesCategory | null
  /** 基线预估人工工时（小时）；未录入为 null（6.3） */
  baselineHours: number | null
  /** AI 提效率 =（预估 − 实际周期）÷ 预估；无基线或无有效周期为 null，可为负（6.3） */
  efficiency: number | null
  comprehension: { total: number; confirmed: number }
  checklistPassed: number
  cost: number | null
  tokensInput: number | null
  tokensOutput: number | null
  complete: boolean
}

export interface ProjectStats {
  sessions: number
  completed: number
  completionRate: number
  avgDurationMs: number
  totalCost: number
  /** 是否有任何会话取到费用（daemon 不可达时全为 null，统计应示 N/A 而非 $0） */
  hasCostData: boolean
  avgFirstPassRate: number | null
  lowFirstPassCount: number
  highIterationCount: number
  /** AI 净增行数三分类对各会话求和（累加型指标，不做平均，6.3） */
  linesTotal: LinesCategory
  /** 是否有任何会话有行数数据（无数据时统计应示 N/A 而非 0，同 hasCostData） */
  hasLinesData: boolean
  /** 平均 AI 提效率（比率型，对有基线且有有效周期的会话求均值，6.3）；无数据为 null */
  avgEfficiency: number | null
  /** 已录入基线的会话数（提效曲线覆盖率参考） */
  baselineCount: number
  stageAvgDurationMs: Record<StageName, number>
}

/** 阶段耗时：最后一次转换时间 - 首次转换时间（6.1 时间戳即数据源）。 */
export function stageDurationMs(stage: StageRecord): number {
  if (stage.transitions.length === 0) return 0
  const first = stage.transitions[0]!.at
  const last = stage.transitions[stage.transitions.length - 1]!.at
  return Math.max(0, last - first)
}

/** 会话总耗时：全部阶段转换的最早到最晚。 */
export function workflowDurationMs(workflow: WorkflowState): number {
  const times: number[] = []
  for (const name of STAGE_ORDER) {
    for (const t of workflow.stages[name].transitions) times.push(t.at)
  }
  if (times.length === 0) return 0
  return Math.max(...times) - Math.min(...times)
}

export function isComplete(workflow: WorkflowState): boolean {
  return STAGE_ORDER.every((name) => workflow.stages[name].status === "approved")
}

export function sessionStats(row: WorkflowSessionRow, usage: Usage): SessionStats | null {
  const workflow = row.workflow
  if (!workflow) return null
  const review = workflow.stages.review
  const confirmed = review.comprehension.filter((c) => c.developerConfirmed).length
  const checklist = review.checklist
  const checklistPassed = [
    checklist.businessIntent,
    checklist.logicExplainable,
    checklist.behaviorVerifiable,
    checklist.designRationale,
  ].filter(Boolean).length
  // 会话总耗时既用于展示，也作为提效率的「实际周期」（6.3）
  const durationMs = workflowDurationMs(workflow)
  return {
    sessionID: row.session_id,
    title: row.title,
    account: row.account_id,
    status: row.status,
    tags: row.tags,
    stages: STAGE_ORDER.map((name) => ({
      name,
      label: STAGE_LABELS[name],
      status: workflow.stages[name].status,
      revision: workflow.stages[name].revision,
      durationMs: stageDurationMs(workflow.stages[name]),
    })),
    durationMs,
    firstPassRate: workflow.quality.firstPassRate,
    iterationCount: workflow.quality.iterationCount,
    reworkRate: workflow.quality.reworkRate,
    testCoverage: workflow.quality.testCoverage,
    lines: workflow.quality.linesByFile ? sumLinesByCategory(workflow.quality.linesByFile) : null,
    baselineHours: workflow.baseline?.estimatedHours ?? null,
    efficiency: efficiencyRatio(workflow.baseline?.estimatedHours, durationMs),
    comprehension: { total: review.comprehension.length, confirmed },
    checklistPassed,
    cost: usage.cost,
    tokensInput: usage.tokensInput,
    tokensOutput: usage.tokensOutput,
    complete: isComplete(workflow),
  }
}

/** 项目级聚合：对一组会话统计求汇总（period 过滤由调用方在 rows 上完成）。 */
export function aggregateProject(rows: WorkflowSessionRow[], usageOf: (id: string) => Usage): ProjectStats {
  const stats = rows.map((r) => sessionStats(r, usageOf(r.session_id))).filter((s): s is SessionStats => s !== null)
  const n = stats.length
  const completed = stats.filter((s) => s.complete).length
  const durations = stats.map((s) => s.durationMs)
  const firstPasses = stats.map((s) => s.firstPassRate).filter((x): x is number => x !== null)
  const stageAvg = {} as Record<StageName, number>
  for (const name of STAGE_ORDER) {
    const vals = stats.map((s) => s.stages.find((x) => x.name === name)!.durationMs)
    stageAvg[name] = n > 0 ? vals.reduce((a, b) => a + b, 0) / n : 0
  }
  // 行数为累加型指标：对各会话三分类求和（不做平均，6.3）
  const linesTotal: LinesCategory = { business: 0, test: 0, config: 0 }
  for (const s of stats) {
    if (!s.lines) continue
    linesTotal.business += s.lines.business
    linesTotal.test += s.lines.test
    linesTotal.config += s.lines.config
  }
  // 提效率为比率型指标：对「有基线且有有效周期」的会话求均值（null 不参与，6.3）
  const efficiencies = stats.map((s) => s.efficiency).filter((x): x is number => x !== null)
  return {
    sessions: n,
    completed,
    completionRate: n > 0 ? completed / n : 0,
    avgDurationMs: n > 0 ? durations.reduce((a, b) => a + b, 0) / n : 0,
    totalCost: stats.reduce((sum, s) => sum + (s.cost ?? 0), 0),
    hasCostData: stats.some((s) => s.cost !== null),
    avgFirstPassRate: firstPasses.length > 0 ? firstPasses.reduce((a, b) => a + b, 0) / firstPasses.length : null,
    lowFirstPassCount: stats.filter(
      (s) => s.firstPassRate !== null && s.firstPassRate < LOW_FIRST_PASS_THRESHOLD,
    ).length,
    highIterationCount: stats.filter((s) => s.iterationCount !== null && s.iterationCount >= HIGH_ITERATION_THRESHOLD).length,
    linesTotal,
    hasLinesData: stats.some((s) => s.lines !== null),
    avgEfficiency: efficiencies.length > 0 ? efficiencies.reduce((a, b) => a + b, 0) / efficiencies.length : null,
    baselineCount: stats.filter((s) => s.baselineHours !== null).length,
    stageAvgDurationMs: stageAvg,
  }
}
