/**
 * system prompt 注入（设计文档 session-management.md 7.1、7.4）。
 * experimental.chat.system.transform hook 的实现：
 * 从插件库读当前会话 WorkflowState，将阶段化规则（global + 当前阶段）+ 一行阶段条追加到 output.system。
 * 阶段化注入只给弱模型当前需要的规则，状态条替代冗长 JSON，降低弱模型遵循负担。
 */
import {
  REQDOC_PROBES,
  REQDOC_SCORE_PASS,
  currentInProgressStage,
  getDefinition,
  renderStructureViolations,
  reviewRecord,
  rulesForStage,
  type WorkflowState,
} from "sm-shared"
import type { Store } from "./db"
import { isComplete } from "./stats"
import { getStuckFiles } from "./tools/quality"
import { loadReqdocTemplate } from "./template"

/** 将当前工作流压缩为注入片段：阶段化规则 + 状态条 + stuck 警告（完成态见下方专用分支）。 */
export function buildSystemFragment(
  workflow: WorkflowState,
  stuck: Record<string, number> = {},
  lockedFiles: string[] = [],
  templateText: string | null = null,
): string {
  const def = getDefinition(workflow.type)
  const stage = currentInProgressStage(workflow)
  const parts: string[] = []

  // 完成态（全部阶段 approved，stage===null）：不注入常规规则——全局规则里的 r1「初始化工作流」
  // 等在完成态会与「已全部完成」自相矛盾，误导弱模型重启流程；改为给全完成态的三条可行动作：
  // 提交（如尚未）→ /new 开新需求 → revisit 改本需求。
  if (isComplete(workflow)) {
    parts.push("# Workflow 已完成", "")
    if (def.hasCommitGate) {
      parts.push("如需提交代码：先调用 commit_gate_check 确认门禁，放行后 git commit。")
      // 完成态解锁提示（合并决策）：仅 sdlc（hasCommitGate）注入——reqdoc 无代码编辑不提示。
      if (lockedFiles.length > 0) {
        parts.push(
          `⚠ 仍有 ${lockedFiles.length} 个文件被人工锁定（${lockedFiles.join("、")}）。` +
            `请询问开发者是否已完成手工修改；明确确认后逐个调用 unlock_file 解锁（未提及的文件保持锁定）。`,
        )
      }
    }
    parts.push(
      "⚑ 开始下一个需求：提醒开发者执行 /new 保持统计隔离（勿在本会话复用，否则统计混入已完成需求）。",
      "修改本需求：调用 workflow_revisit 回退到对应阶段。",
    )
    parts.push("", buildStateBar(workflow, stage))
    return parts.join("\n")
  }

  // 进行中 / 未开始：阶段化注入（global + 当前阶段）
  const rules = rulesForStage(def, stage)
  const header = stage
    ? `# Workflow 规则（通用 + 当前阶段 ${def.labels[stage] ?? stage}）`
    : "# Workflow 规则（通用）"
  parts.push(header, "", rules.map((r, i) => `${i + 1}. ${r.text}`).join("\n"))
  if (stage === null) {
    // stage===null 三态：全 not_started（起步）/ 部分 approved 无进行中（空档）/ 全部 approved（完成态，已在开头返回）。
    // 空档态若仍提示「尚未开始」会让模型尝试 enter 已 approved 阶段（报错）或误判流程未启动。
    const notStarted = def.stages.filter((name) => workflow.stages[name].status === "not_started")
    if (notStarted.length === def.stages.length) {
      parts.push(
        "",
        `起步：工作流尚未开始，请从「${def.labels[def.stages[0]] ?? def.stages[0]}」(${def.stages[0]}) 开始推进。`,
      )
    } else {
      const done = def.stages.filter((name) => workflow.stages[name].status === "approved")
      // 空档态必然存在未启动阶段（无 in_progress 且非全部 approved），find 兜底仅为类型安全
      const next = def.stages.find((name) => workflow.stages[name].status === "not_started") ?? def.stages[0]
      parts.push(
        "",
        `当前无进行中阶段（已 approved：${done.map((n) => def.labels[n] ?? n).join("、")}）。` +
          `继续推进：进入「${def.labels[next] ?? next}」(${next})；回退：调用 workflow_revisit。`,
      )
    }
  }
  parts.push("", buildStateBar(workflow, stage))

  // 模板送达（渲染铁律的部署保障，见 template.ts）：reqdoc 且当前阶段为 prd 时注入模板全文，
  // 客户端模型无需自行按「docs/...」读文件（运行目录未必有），逐字遵循才真正可执行；
  // templateText 为 null（插件找不到模板文件）时退化为 reqdoc-r14 的内联骨架，不注入。
  if (def.type === "reqdoc" && stage === "prd" && templateText) {
    parts.push(
      "",
      "# 《业务需求说明书》模板全文（插件自动送达；渲染须严格逐字遵循，见 reqdoc-r20）",
      "",
      templateText,
    )
  }

  const stuckEntries = Object.entries(stuck)
  if (stuckEntries.length > 0) {
    const details = stuckEntries.map(([f, n]) => `${f}（${n} 次）`).join("、")
    parts.push("", `⚠ 检测到重复编辑模式：${details}，建议审查是否陷入无效循环，考虑人工介入修改。`)
  }
  return parts.join("\n")
}

/** 阶段状态中文（buildStateBar 表头用） */
function statusZh(status: string): string {
  return status === "in_progress" ? "进行中" : status === "approved" ? "已通过" : "未开始"
}

/** 将工作流状态压缩为一行阶段条 + 关键状态（替代原冗长 JSON，弱模型更易读，7.1/7.3）。 */
export function buildStateBar(workflow: WorkflowState, stage: string | null): string {
  const def = getDefinition(workflow.type)
  const total = def.stages.length
  const idx = stage ? def.stages.indexOf(stage) : -1
  let header: string
  if (stage) {
    const st = workflow.stages[stage]
    const purpose = def.stagePurpose?.[stage]
    header =
      `当前阶段：${def.labels[stage] ?? stage}（第 ${idx + 1}/${total} 步），状态 ${statusZh(st.status)}` +
      (purpose ? ` ｜ 目的：${purpose}` : "")
  } else {
    // stage===null：全未开始（起步）或空档（部分 approved 无进行中）
    const notStarted = def.stages.filter((n) => workflow.stages[n].status === "not_started")
    if (notStarted.length === total) {
      const first = def.stages[0]
      header = `当前阶段：未开始（第 1/${total} 步），请从「${def.labels[first] ?? first}」开始`
    } else {
      const done = def.stages
        .filter((n) => workflow.stages[n].status === "approved")
        .map((n) => def.labels[n] ?? n)
      const next = def.stages.find((n) => workflow.stages[n].status === "not_started") ?? def.stages[0]
      header = `当前阶段：空档（已 approved：${done.join("、")}），下一步：「${def.labels[next] ?? next}」`
    }
  }
  const bar = def.stages
    .map((name) => `${def.labels[name] ?? name}(${name})[${workflow.stages[name].status}]`)
    .join(" → ")
  const lines = ["## 当前工作流", header, bar]

  // 审查进行中才输出审查进度（含清单各项 + 待确认项 id，让模型知道要 confirm 什么）
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
    const pending = review.comprehension.filter((c) => c.decision !== "accepted" && c.decision !== "manual")
    if (pending.length > 0) {
      lines.push(`待确认：${pending.map((c) => `${c.id}(${c.decision})`).join("、")}`)
    }
  }
  if (workflow.baseline) lines.push(`基线：已录入 ${workflow.baseline.estimatedHours} 小时`)
  if (workflow.score) {
    const passed = workflow.score.total >= REQDOC_SCORE_PASS
    lines.push(
      `PRD 评分：${workflow.score.total}/100（${passed ? "达标 ✓" : `未达标，需 ≥${REQDOC_SCORE_PASS} 才可进入渲染/定稿`}）；业务确认：${workflow.score.confirmed ? "已" : "未"}`,
    )
  }
  // 追问探针覆盖（质量飞轮 P1）：reqdoc 记录过探针才展示（柔性：未记录不打扰）
  if (workflow.probes) {
    const total = REQDOC_PROBES.length
    const gapNames = workflow.probes.gaps
      .map((id) => REQDOC_PROBES.find((p) => p.id === id)?.label ?? id)
      .join("、")
    lines.push(
      `追问覆盖：已问 ${workflow.probes.asked.length}/${total} 探针；缺口：${gapNames || "无"}；轮次 ${workflow.probes.round}`,
    )
  }
  // 渲染结构校验（质量飞轮 P2）：reqdoc_check 记录过才展示明细；reqdoc 未记录则提示未执行（柔性，不打扰 sdlc）
  if (workflow.render) {
    const rv = renderStructureViolations(workflow.render)
    lines.push(
      rv.length === 0
        ? `渲染校验：✓ 结构合规（${workflow.render.featureCount} 功能点）`
        : `渲染校验：✗ ${rv[0]}${rv.length > 1 ? ` 等 ${rv.length} 项` : ""}；功能点 ${workflow.render.featureCount}/${workflow.render.expectedFeatures}`,
    )
    // 来源覆盖（X 软提示）：展示 [文档]/[问答] 标注占比，提醒全 [问答] 缺书面依据
    const doc = workflow.render.docBlocks
    const total = workflow.render.featureCount || 1
    const docPct = Math.round((doc / total) * 100)
    lines.push(
      `来源覆盖：文档支撑 ${doc}/${workflow.render.featureCount} 功能点（${docPct}%）` +
        `、标注 [文档] ${workflow.render.docCount} 处 / [问答] ${workflow.render.qaCount} 处` +
        (doc === 0 ? `；⚠ 全 [问答] 无 [文档] 支撑，定稿需先补材料或业务确认无书面材料` : ""),
    )
  } else if (getDefinition(workflow.type).type === "reqdoc") {
    lines.push(`渲染校验：未执行 reqdoc_check（定稿不复核，需评分卡 ≥${REQDOC_SCORE_PASS} 兜底）`)
  }
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
    output.system.push(
      buildSystemFragment(
        workflow,
        getStuckFiles(input.sessionID),
        store.listLocks(input.sessionID),
        loadReqdocTemplate(),
      ),
    )
  }
}
