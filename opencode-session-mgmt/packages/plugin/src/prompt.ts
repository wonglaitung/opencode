/**
 * system prompt 注入（设计文档 7.1、7.4）。
 * experimental.chat.system.transform hook 的实现：
 * 从插件库读当前会话 WorkflowState，将规则全文 + 状态压缩 JSON 追加到 output.system。
 */
import { STAGE_LABELS, STAGE_ORDER, type StageName, type WorkflowState } from "sm-shared"
import type { Store } from "./db"
import { getStuckFiles } from "./tools/quality"

const RULES = `# Workflow Agent 规则

## 阶段推进
1. 会话开始时初始化 workflow（所有阶段 not_started）。
2. 阶段可能完成时，先输出摘要并询问确认；开发者明确确认后才可调用 workflow_advance 标记 approved。
3. 开发者说"回到XX"时，立即调用 workflow_revisit。
4. 绝不自行判断阶段已完成——阶段转换的唯一来源是开发者的明确操作。
5. 要求提交时先调用 commit_gate_check，检查全部五个阶段（含审查）。

## 审查阶段（理解保障，核心）
6. 审查是唯一不可由 AI 自行推进的阶段，目标是确保开发者真正理解代码。
7. 进入审查后，将每个 AI 生成的代码变更拆分为可理解片段，逐段输出自然语言解释
   （做了什么、为什么这样写、被放弃的替代方案、潜在风险）。
8. 开发者必须逐段确认：comprehension_confirm 单次只接受一个 codeSegmentId。
9. 开发者追问时详细解释，并将问答追加到该片段的 explanation（comprehension_ask）。
10. 每个片段须达成终态（comprehension_confirm 接受 / comprehension_manual 开发者自处理），
    不允许 pending/rejected 悬空；拒绝的片段先 comprehension_rewrite 重写或 manual 定论，全部定论后才可 review_submit；
    清单四项须全为 true，否则回到编码/测试。

## 一次通过率与迭代上限
11. 一次通过率由 review_submit 自动计算（未重写即 accepted 的片段占比），无需 Agent 上报；
    一次通过率低说明返工多，应结合拒绝意见 comprehension_rewrite 改进，而非简单重试。
12. 检测连续重复编辑模式（同一文件连续 3 次以上相同参数的 AI 编辑，或同一文件被编辑 6 次以上），提醒开发者审查是否陷入无效循环，但不拒绝生成。

## 基线对比（预估工时）
13. 进入需求阶段（workflow_advance stage=requirements action=enter）时，主动询问开发者：
    项目经理对本需求的预估人工工时是多少（小时）？开发者明确给出后调用 workflow_baseline 记录
    （developer_confirmed=true）。用于会话结束后与实际周期对比、计算 AI 提效率；未提供不阻塞，
    已录入后可从状态中读到，不必重复询问。

## SDLC 完结与下一需求
14. 提交门禁放行（commit.status=allowed）且 git commit 成功后，主动提醒开发者：
    "本需求 SDLC 已完成。建议执行 /new 开始下一个需求，以保持统计隔离。"`

/** 将当前工作流压缩为注入片段：规则 + 阶段进度 + 质量指标 + stuck 警告。 */
export function buildSystemFragment(workflow: WorkflowState, stuck: Record<string, number> = {}): string {
  const lines: string[] = []
  for (const name of STAGE_ORDER) {
    const stage = workflow.stages[name as StageName]
    lines.push(`- ${STAGE_LABELS[name as StageName]}(${name}): ${stage.status}，revision=${stage.revision}`)
  }
  const review = workflow.stages.review
  const confirmed = review.comprehension.filter((c) => c.developerConfirmed).length
  const iteration = workflow.quality.iterationCount ?? 0
  // 最热文件（迭代轮次来源，3.2 按文件计数）
  const byFile = Object.entries(workflow.quality.iterationByFile ?? {})
  const hottest = byFile.sort((a, b) => b[1] - a[1])[0]
  const parts = [
    RULES,
    "",
    "## 当前 WorkflowState",
    "```json",
    JSON.stringify(
      {
        stages: Object.fromEntries(
          STAGE_ORDER.map((name) => [name, workflow.stages[name as StageName].status]),
        ),
        commit: workflow.commit,
        quality: workflow.quality,
        // 基线（预估工时）：让 Agent 知道是否已录入，避免重复询问（13）
        baseline: workflow.baseline ?? null,
        review: {
          checklist: review.checklist,
          comprehension: `${confirmed}/${review.comprehension.length} 已确认`,
        },
      },
      null,
      2,
    ),
    "```",
    "",
    `迭代轮次：${iteration}${hottest ? `（最热文件 ${hottest[0]} ×${hottest[1]}）` : ""}`,
    `提交门禁：${workflow.commit.status}${
      workflow.commit.blocked_by.length > 0 ? `（未完成：${workflow.commit.blocked_by.join("、")}）` : ""
    }`,
  ]
  const stuckEntries = Object.entries(stuck)
  if (stuckEntries.length > 0) {
    const details = stuckEntries.map(([f, n]) => `${f}（${n} 次）`).join("、")
    parts.push("", `⚠ 检测到重复编辑模式：${details}，建议审查是否陷入无效循环，考虑人工介入修改。`)
  }
  if (workflow.commit.status === "allowed") {
    parts.push("", "⚑ SDLC 已完成，请提醒开发者执行 /new 开始下一个需求（保持统计隔离）。")
  }
  return parts.join("\n")
}

/** 生成 experimental.chat.system.transform 处理器（闭包持有 store）。 */
export function createSystemTransform(store: Store) {
  return async (
    input: { sessionID?: string },
    output: { system: string[] },
  ): Promise<void> => {
    if (!input.sessionID) return
    const row = store.ensure(input.sessionID)
    const workflow = row.workflow
    if (!workflow) return
    output.system.push(buildSystemFragment(workflow, getStuckFiles(input.sessionID)))
  }
}
