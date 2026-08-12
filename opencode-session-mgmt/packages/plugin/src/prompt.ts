/**
 * system prompt 注入（设计文档 7.1、7.4）。
 * experimental.chat.system.transform hook 的实现：
 * 从插件库读当前会话 WorkflowState，将阶段化规则（global + 当前阶段）+ 一行阶段条追加到 output.system。
 * 阶段化注入只给弱模型当前需要的规则，状态条替代冗长 JSON，降低弱模型遵循负担。
 */
import { currentInProgressStage, getDefinition, reviewRecord, rulesForStage, type WorkflowState } from "sm-shared"
import type { Store } from "./db"
import { getStuckFiles } from "./tools/quality"

/** 将当前工作流压缩为注入片段：阶段化规则 + 状态条 + stuck 警告。 */
export function buildSystemFragment(workflow: WorkflowState, stuck: Record<string, number> = {}): string {
  const def = getDefinition(workflow.type)
  const stage = currentInProgressStage(workflow)
  const rules = rulesForStage(def, stage)
  const parts: string[] = []

  const header = stage
    ? `# Workflow 规则（通用 + 当前阶段 ${def.labels[stage] ?? stage}）`
    : "# Workflow 规则（通用）"
  parts.push(header, "", rules.map((r, i) => `${i + 1}. ${r.text}`).join("\n"))
  if (stage === null) {
    parts.push(
      "",
      `起步：工作流尚未开始，请从「${def.labels[def.stages[0]] ?? def.stages[0]}」(${def.stages[0]}) 开始推进。`,
    )
  }
  parts.push("", buildStateBar(workflow, stage))

  const stuckEntries = Object.entries(stuck)
  if (stuckEntries.length > 0) {
    const details = stuckEntries.map(([f, n]) => `${f}（${n} 次）`).join("、")
    parts.push("", `⚠ 检测到重复编辑模式：${details}，建议审查是否陷入无效循环，考虑人工介入修改。`)
  }
  if (workflow.commit.status === "allowed") {
    parts.push(
      "",
      def.hasCommitGate
        ? "⚑ SDLC 已完成，请提醒开发者执行 /new 开始下一个需求（保持统计隔离）。"
        : "⚑ 业务确认完成，请提醒执行 /new 开始下一个需求（保持统计隔离）。",
    )
  }
  return parts.join("\n")
}

/** 将工作流状态压缩为一行阶段条 + 关键状态（替代原冗长 JSON，弱模型更易读，7.1/7.3）。 */
export function buildStateBar(workflow: WorkflowState, stage: string | null): string {
  const def = getDefinition(workflow.type)
  const bar = def.stages
    .map((name) => `${def.labels[name] ?? name}(${name})[${workflow.stages[name].status}]`)
    .join(" → ")
  const lines = ["## 当前工作流", bar]

  // 审查进行中才输出审查进度（含清单各项）
  if (stage === def.reviewStage) {
    const review = reviewRecord(workflow)
    const decided = review.comprehension.filter((c) => c.decision === "accepted" || c.decision === "manual").length
    const checklist = Object.entries(review.checklist)
      .map(([k, v]) => `${k} ${v ? "✓" : "✗"}`)
      .join(" / ")
    lines.push(
      `审查进度：片段定论 ${decided}/${review.comprehension.length}${
        review.comprehension.length ? `；清单 ${checklist}` : ""
      }`,
    )
  }
  if (workflow.baseline) lines.push(`基线：已录入 ${workflow.baseline.estimatedHours} 小时`)
  const iteration = workflow.quality.iterationCount ?? 0
  if (iteration > 0) {
    const byFile = Object.entries(workflow.quality.iterationByFile ?? {})
    const hottest = byFile.sort((a, b) => b[1] - a[1])[0]
    lines.push(`迭代轮次：${iteration}${hottest ? `（最热文件 ${hottest[0]} ×${hottest[1]}）` : ""}`)
  }
  lines.push(
    `提交门禁：${workflow.commit.status}${
      workflow.commit.blocked_by.length > 0 ? `（未完成：${workflow.commit.blocked_by.join("、")}）` : ""
    }`,
  )
  return lines.join("\n")
}

/** 生成 experimental.chat.system.transform 处理器（闭包持有 store）。isSubagent 为子代理识别器，缺省不识别。 */
export function createSystemTransform(store: Store, isSubagent: (sessionID: string) => Promise<boolean> = async () => false) {
  return async (
    input: { sessionID?: string },
    output: { system: string[] },
  ): Promise<void> => {
    if (!input.sessionID) return
    // 子代理会话不注入工作流规则、不建记录（2.4 统计纯净度）
    if (await isSubagent(input.sessionID)) return
    const row = store.ensure(input.sessionID)
    const workflow = row.workflow
    if (!workflow) return
    output.system.push(buildSystemFragment(workflow, getStuckFiles(input.sessionID)))
  }
}
