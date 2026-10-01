/**
 * system prompt 注入（设计文档 session-management.md 7.1、7.4）。
 * experimental.chat.system.transform hook 的实现：
 * 从插件库读当前会话 WorkflowState，将阶段化规则（global + 当前阶段）+ 一行阶段条追加到 output.system。
 * 阶段化注入只给弱模型当前需要的规则，状态条替代冗长 JSON，降低弱模型遵循负担。
 */
import {
  deriveQuestions,
  kbGate,
  matchMemory,
  materialOf,
  requiredSlots,
  currentInProgressStage,
  getDefinition,
  reviewRecord,
  rulesForStage,
  type WorkflowState,
} from "sm-shared"
import type { Store } from "./db"
import { isComplete } from "./stats"
import { loadWorkflowConventions } from "./conventions"
import { getStuckFiles } from "./tools/quality"

/** 将当前工作流压缩为注入片段：阶段化规则 + 状态条 + stuck 警告（完成态见下方专用分支）。 */
export function buildSystemFragment(
  workflow: WorkflowState,
  stuck: Record<string, number> = {},
  lockedFiles: string[] = [],
  projectRoot: string = process.cwd(),
): string {
  const def = getDefinition(workflow.type)
  const stage = currentInProgressStage(workflow)
  const parts: string[] = []
  // 绑定规约送达（阶段化：global 常驻 + 当前阶段专属，见 conventions.ts）。stage===null 时只有 global。
  const conventions = loadWorkflowConventions(def.type, stage, projectRoot)

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
    if (conventions) {
      parts.push("", `# 《${def.type} 编写规约》自遵循清单（插件按工作流阶段自动送达）`, "", conventions)
    }
    parts.push("", buildStateBar(workflow, stage))
    return parts.join("\n")
  }

  // 进行中 / 未开始：阶段化注入（global + 当前阶段）
  const rules = rulesForStage(def, stage)
  const header = stage
    ? `# Workflow 规则（通用 + 当前阶段 ${def.labels[stage] ?? stage}）`
    : "# Workflow 规则（通用）"
  parts.push(header, "", rules.map((r, i) => `${i + 1}. ${r.text}`).join("\n"))

  if (conventions) {
    parts.push("", `# 《${def.type} 编写规约》自遵循清单（插件按工作流阶段自动送达）`, "", conventions)
  }

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

  // PRD 产出指引（重构 2c）：prd 阶段注入槽位流程。
  // 模板逐字落实由服务端 reqdoc_assemble 投影保证，模型只负责把槽位内容写对，不读模板、不手写产物。
  if (def.type === "reqdoc" && stage === "prd") {
    const kb = workflow.kb
    if (!kb) {
      // kb 缺省只有 workflow_revisit 回退到 prd 一条路径（enter prd 已被 kbGate 拦住）：
      // 此时必须先建库，不能沿用旧的「手写渲染」指引。
      parts.push(
        "",
        "# 需求知识库未建（重构 2c）",
        "",
        "PRD 由槽位投影生成，当前知识库为空——请先：",
        "1) reqdoc_ingest —— 提交功能点清单与内容槽位（地址取工具返回的「本轮该填」清单）。",
        "2) reqdoc_answer —— 逐项请业务确认后落定。",
        "3) reqdoc_assemble —— 由槽位投影生成整篇 PRD。",
        "",
      )
    } else {
      const req = requiredSlots(kb.features)
      const filled = req.filter((a) => kb.slots.some((x) => x.address === a && x.status === "confirmed")).length
      parts.push(
        "",
        "# 需求知识库流程（重构 2c：PRD 由服务端从槽位投影生成，不要手写产物）",
        "",
        `覆盖率：${filled}/${req.length} 必填槽位。`,
        "1) reqdoc_ingest —— 从材料批量提取内容提交为槽位（不是写文档）；status 由服务端记为待确认。",
        "2) reqdoc_answer —— 逐项请业务确认后落定；连续 2 轮未确认的项会被停问，应显式收口（[缺省]+理由）。",
        "3) reqdoc_assemble —— 由槽位投影生成整篇 PRD（结构与来源标签由服务端保证，**不要手工编辑产物**）。",
        "4) reqdoc_memory_recall（定稿后）—— 把本次收集到的组织知识候选逐条给业务**勾选**，勾选的写入 L2 记忆供后续复用。",
        "→ 进入下一阶段与定稿的门禁读知识库派生门禁（kbGate）：必填槽位未 confirmed 或有未收口项即拦截。",
        "",
      )
    }
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
    .map((name) => `${def.labels[name] ?? name}[${workflow.stages[name].status}]`)
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
  // 知识库覆盖（重构 2c）：槽位覆盖率 + 开放项全部由服务端派生，不再展示打分卡/探针/渲染校验
  if (workflow.kb) {
    const kb = workflow.kb
    const gate = kbGate(kb.slots, kb.features, {
      decls: kb.containers,
      unclosed: deriveQuestions(kb.features, { slots: kb.slots, askCounts: kb.askCounts, decls: kb.containers }).unclosed,
      threshold: 1,
    })
    const c = gate.coverage
    lines.push(
      `知识库：必填槽位 ${c.leafFilled}/${c.leafTotal}（${Math.round(c.pct * 100)}%）` +
        `；${gate.pass ? "门禁可通过 ✓" : `未就绪：${gate.reasons.join("；")}`}`,
    )
    const hits = matchMemory(
      materialOf(kb.slots.map((sl) => sl.content)),
    )
    const open = deriveQuestions(kb.features, {
      slots: kb.slots,
      askCounts: kb.askCounts,
      decls: kb.containers,
      candidates: kb.candidates,
      l1: hits.l1,
      l2: hits.l2,
    })
    if (open.all.length > 0) {
      lines.push(
        `待确认槽位 ${open.all.length} 项${open.batch.length > 0 ? `（本轮问 ${open.batch.length}）` : ""}` +
          `${open.stopped.length > 0 ? `；已停问 ${open.stopped.length} 项` : ""}` +
          `${open.l1Applied.length > 0 ? `；L1 记忆已消缺口 ${open.l1Applied.length} 项` : ""}`,
      )
    }
  } else if (getDefinition(workflow.type).type === "reqdoc") {
    lines.push("知识库：未建（请先 reqdoc_ingest 提交需求内容槽位）")
  }
  const iteration = workflow.quality.iterationCount ?? 0
  if (iteration > 0) {
    const byFile = Object.entries(workflow.quality.iterationByFile ?? {})
    const hottest = byFile.sort((a, b) => b[1] - a[1])[0]
    lines.push(`迭代轮次：${iteration}${hottest ? `（最热文件 ${hottest[0]} ×${hottest[1]}）` : ""}`)
  }
  lines.push(
    `提交状态：${workflow.commit.status}${
      workflow.commit.blocked_by.length > 0 ? `（未完成：${workflow.commit.blocked_by.join("、")}）` : ""
    }`,
  )
  return lines.join("\n")
}

/** 生成 experimental.chat.system.transform 处理器（闭包持有 store）。isSubagent 为子代理识别器，缺省不识别。 */
export function createSystemTransform(
  store: Store,
  isSubagent: (sessionID: string) => Promise<boolean> = async () => false,
  directory: string = process.cwd(),
) {
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
        directory,
      ),
    )
  }
}
