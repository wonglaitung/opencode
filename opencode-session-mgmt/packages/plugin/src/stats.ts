/**
 * 本机统计聚合查询（设计文档 §4.3、§6）。
 * 会话级/项目级：插件库（工作流/会话内质量）+ 上游 session SDK（cost/tokens），
 * 按 sessionID 关联。纯函数实现，供 opencode-sm 复用（不依赖插件 SDK/数据库句柄）。
 */
import {
  STAGE_LABELS,
  STAGE_ORDER,
  type StageName,
  type StageRecord,
  type WorkflowState,
} from "sm-shared"
import type { Usage } from "./report"
import type { WorkflowSessionRow } from "./db/schema"

export const ACCEPTANCE_WARN_THRESHOLD = 45
export const ITERATION_LIMIT = 3

export interface StageStats {
  name: StageName
  label: string
  status: string
  revision: number
  durationMs: number
}

export interface SessionStats {
  sessionID: string
  account: string | null
  status: string | null
  tags: string[]
  stages: StageStats[]
  durationMs: number
  acceptanceRate: number | null
  iterationCount: number | null
  reworkRate: number | null
  testCoverage: number | null
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
  avgAcceptanceRate: number | null
  overAcceptanceThreshold: number
  hitIterationLimit: number
  stageAvgDurationMs: Record<StageName, number>
}

/** 阶段耗时：最后一次转换时间 - 首次转换时间（§6.1 时间戳即数据源）。 */
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
  return {
    sessionID: row.session_id,
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
    durationMs: workflowDurationMs(workflow),
    acceptanceRate: workflow.quality.acceptanceRate,
    iterationCount: workflow.quality.iterationCount,
    reworkRate: workflow.quality.reworkRate,
    testCoverage: workflow.quality.testCoverage,
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
  const acceptances = stats.map((s) => s.acceptanceRate).filter((x): x is number => x !== null)
  const stageAvg = {} as Record<StageName, number>
  for (const name of STAGE_ORDER) {
    const vals = stats.map((s) => s.stages.find((x) => x.name === name)!.durationMs)
    stageAvg[name] = n > 0 ? vals.reduce((a, b) => a + b, 0) / n : 0
  }
  return {
    sessions: n,
    completed,
    completionRate: n > 0 ? completed / n : 0,
    avgDurationMs: n > 0 ? durations.reduce((a, b) => a + b, 0) / n : 0,
    totalCost: stats.reduce((sum, s) => sum + (s.cost ?? 0), 0),
    avgAcceptanceRate: acceptances.length > 0 ? acceptances.reduce((a, b) => a + b, 0) / acceptances.length : null,
    overAcceptanceThreshold: stats.filter(
      (s) => s.acceptanceRate !== null && s.acceptanceRate > ACCEPTANCE_WARN_THRESHOLD,
    ).length,
    hitIterationLimit: stats.filter((s) => s.iterationCount !== null && s.iterationCount >= ITERATION_LIMIT).length,
    stageAvgDurationMs: stageAvg,
  }
}
