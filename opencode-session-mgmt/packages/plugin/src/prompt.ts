/**
 * system prompt 注入（设计文档 session-management.md 7.1、7.4）。
 * experimental.chat.system.transform hook 的实现：
 * 从插件库读当前会话 WorkflowState，将阶段化规则（global + 当前阶段）+ 一行阶段条追加到 output.system。
 * 阶段化注入只给弱模型当前需要的规则，状态条替代冗长 JSON，降低弱模型遵循负担。
 */
import {
  crossChapterImpact,
  deriveQuestions,
  kbGate,
  matchMemory,
  requiredSlots,
  templateDrift,
  templateUnavailableNotice,
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
    if (def.type === "reqdoc") {
      // 需求迭代（加功能）是本工作流最常被误选成「/new 开新需求」的路径——选错等于让业务把整份需求重述一遍。
      parts.push(
        "在这份需求上新增功能：调用 workflow_revisit(stage=prd) 回到需求规格书阶段，" +
          "功能点只能在原清单末尾追加（见 r35 ①），已确认槽位保持不变，" +
          "只就新增部分向业务提问；**不要用 /new 重开**（会丢掉全部已确认槽位）。",
      )
    }
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

  // 模板不可用：**阶段无关**的告警。原先挂在 prd 分支里是错的——模板坏掉时
  // reqdoc_ingest 已不可用（地址判不合法），用户此时多在 goal/rules 阶段，
  // 恰恰最需要知道「不是你要补，是模板读不到」，而那正是提示被关住的地方。
  // 载体是状态条（唯一无条件进 system prompt 的路径）：插件工具回执在 TUI 默认
  // 不渲染（见上游 routes/session/index.tsx 的 generic_tool_output_visibility
  // 默认 false），不能指望用户从回执里看到。
  if (def.type === "reqdoc") {
    const unavailable = templateUnavailableNotice()
    if (unavailable) parts.push("", "# ⚠ 需求书模板不可用", "", unavailable)
  }

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
      // 换模板提示放在状态条：它是跨轮唯一持久的可见位置，回执会滚出上下文。
      // 措辞面向模型（07-业务口语 第 3 节），转述给业务时由模型翻译。
      const drift = templateDrift(kb)
      if (drift) parts.push("", `# ⚠ 模板结构已更换`, "", drift)
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
        "→ 若业务只想改已有需求书的某一章（而非整体重做）：先确认要改哪一章（用 PRD 章号或原稿节名；" +
          "章名不同须先回显 PRD 章目录+标题+内容预览请业务认领，确认才锁），再调用 reqdoc_start_scoped_edit(chapter) 锁定该章——" +
          "不要逼业务重答全部必填项。改完先 reqdoc_assemble 重组装（槽位变了不重组装 → 摘要过期、定稿会被拒）；" +
          "业务要把差异贴回自己的原稿时，在锁定期间用 reqdoc_export(mode, chapter) 导出（差异导出要求锁在），之后再 reqdoc_end_scoped_edit 释放锁。",
        "",
      )
      if (kb.editScope?.active) {
        const ch = kb.editScope.chapter
        const impact = crossChapterImpact(kb.slots, ch)
        parts.push(
          "",
          `# 定点修订进行中（锁定第 ${ch} 章）`,
          "",
          `本次只改第 ${ch} 章：引导业务补全该章事实即可，不要去问/改其它章；ingest/answer 越界会被服务端拒收。`,
          `改的内容一律 source=问答；原文档已摄入、本次未动的槽位保持 source=文档，不要重标。`,
          ...(impact.length ? [`跨章影响（仅供参考、不阻断）：${impact.join("；")}`] : []),
          `槽位有改动后先 reqdoc_assemble 重组装（否则 kb-digest 过期、定稿三重校验会拒）。`,
          `业务要把差异贴回原稿时：在锁定期间 reqdoc_export(mode:"diff"|"chapter", chapter:${ch}) 导出（差异导出要求锁在），` +
            `说明「贴回后系统不回读（单向）」，最后 reqdoc_end_scoped_edit 释放锁。`,
          "",
        )
      }
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
    // 证据走 kb.evidence 快照（工具侧写入的材料原文）——本函数同步，读不了文件；
    // 拿槽位正文会与工具回执口径不一，且重蹈 I-1 的模型可写证据。
    const hits = matchMemory(kb.evidence ?? "")
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
          // 「待你落定」不能省：免问项不在清单里，模型只看状态栏会以为已处理完；
          // 必须带地址——回执是一次性的，状态条是唯一持久提示，跨轮/压缩上下文后只剩数量会让模型反查无门；
          // 措辞保持可直接转述（不点工具名、不铺门禁因果，见 07-业务口语 第 3 节），动作指令在 ingest 的工具描述里
          `${open.l1Applied.length > 0 ? `；已采信历史记忆 ${open.l1Applied.length} 项待你落定（不必再问）：${open.l1Applied.join("、")}` : ""}`,
      )
    }
    // 连续接受默认的轮数（reqdoc-r27）：**回执是一次性的**，跨轮/压缩上下文后模型无从
    // 知道业务已经连着点了两次默认——这正是 9/34 场景仍带默认推荐的原因（r27 曾要求
    // 模型自己在对话里数）。放状态条让它成为**看得见的事实**，措辞直接可转述。
    if ((kb.defaultAcceptStreak ?? 0) > 0) {
      lines.push(
        `业务已连续 ${kb.defaultAcceptStreak} 轮接受默认推荐` +
          (kb.defaultAcceptStreak! >= 2 ? "：**本轮不要再端带默认推荐的选项**，改为开放式追问，让业务对量化目标、功能范围、权限边界说具体意见" : ""),
      )
    }
    // 已承认基线（分支二）：回执是一次性的，而「这批内容业务已经授权过了」必须在状态条里一直在——
    // 否则压缩上下文后模型只剩「覆盖率很高」却不知道为什么满的，会把旧稿内容重新问一遍，
    // 恰好破坏「旧稿已有内容不必再说」这个承诺。措辞直接可转述（不点工具名）。
    if (kb.baselineSnapshot) {
      const file = kb.baselineSnapshot.file.split("/").pop() ?? kb.baselineSnapshot.file
      lines.push(`已承认基线 ${file}：稿里已有的内容已沿用并经业务授权，不要再逐项问业务`)
    }
  } else if (getDefinition(workflow.type).type === "reqdoc") {
    // 状态条不点工具名（07-业务口语 第 3 节）：它面向模型、会被模型照讲给业务，
    // 而「reqdoc_ingest」对业务毫无意义。动作指令在 reqdoc_ingest 的工具描述里
    // （model-only、每次请求都在），状态条只报事实 + 一句可转述的提示。
    lines.push("知识库：未建（请先把需求内容提交进来，逐项请业务确认后落定）")
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
