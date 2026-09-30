/**
 * 审查与理解确认工具（设计文档 session-management.md 4.1、3.2、7.3；审查规则见 workflow-sdlc.md 3 章、workflow-reqdoc.md 4 章）。
 * 通用机制（工作流无关）：sdlc 确认「代码片段」、reqdoc 确认「PRD 要点」，
 * 统一以 codeSegmentId 参数承载标识（sdlc 为代码段 id、reqdoc 为要点 id）。
 * comprehension_add     —— 登记一个片段/要点及其自然语言解释（decision=pending）
 * comprehension_confirm —— 单次只接受一个 codeSegmentId（防批量确认，服务端强制）→ accepted
 * comprehension_reject  —— 拒绝片段/要点，feedback 必填 → rejected
 * comprehension_rewrite —— 按意见重写，回到 pending，rewrites++
 * comprehension_manual  —— 开发者自处理，resolution 必填 → manual（终态）
 * comprehension_ask     —— 追问，问答追加到 explanation
 * review_submit         —— 提交审查清单：所有片段处于终态(accepted/manual)，通过时自动计算 firstPassRate
 */
import { readdir, unlink } from "node:fs/promises"
import { join, relative } from "node:path"
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import {
  REQDOC_SCORE_PASS,
  WORKFLOW_DEFINITIONS,
  getDefinition,
  parseRenderStructure,
  deriveQuestions,
  kbDigest,
  kbGate,
  reviewRecord,
  type ComprehensionRecord,
  type ReqdocFeature,
  type RenderStructure,
  type WorkflowState,
} from "sm-shared"
import { assembleDir } from "./reqdoc-kb-tools"
import type { Store } from "../db"
import { WorkflowOpError, applyTransition, recomputeCommit } from "../workflow-ops"
import { projectRoot, resolveWithinWorktree } from "../fs-safe"

const z = tool.schema

/**
 * review_submit 的具名布尔参数（3.2 def 驱动）：汇总所有已注册类型中非 auto 的审查清单项。
 * 本轮仅 sdlc → businessIntent/logicExplainable/behaviorVerifiable（LLM 契约逐字节不变）；
 * auto 项（如 designRationale）由插件置真，不占用具名参数。reqdoc 加入时其非 auto 清单项自动并入。
 */
const reviewChecklistArgs: Record<string, ReturnType<typeof z.boolean>> = {}
for (const def of Object.values(WORKFLOW_DEFINITIONS)) {
  for (const item of def.checklist) {
    if (item.auto) continue
    if (!(item.key in reviewChecklistArgs)) reviewChecklistArgs[item.key] = z.boolean().describe(item.label)
  }
}

export function createReviewTools(store: Store): Record<string, ToolDefinition> {
  const comprehension_add = tool({
    description:
      "审查阶段：登记一个 AI 生成的代码片段（sdlc）或 PRD 要点（reqdoc）及其自然语言解释。" +
      "sdlc 需填 file/lineStart/lineEnd；reqdoc（要点）不填代码位置。登记后 decision=pending，待开发者 confirm/reject 定夺。",
    args: {
      codeSegmentId: z.string().describe("标识：sdlc 为代码段 id（如 auth/service.ts:12-45），reqdoc 为要点 id"),
      explanation: z.string().describe("自然语言解释，含设计推导、替代方案与风险"),
      file: z.string().optional().describe("sdlc 专属：文件路径；reqdoc 不填"),
      lineStart: z.number().int().optional().describe("sdlc 专属：起始行；reqdoc 不填"),
      lineEnd: z.number().int().optional().describe("sdlc 专属：结束行；reqdoc 不填"),
    },
    async execute(args, context) {
      store.mutateWorkflow(context.sessionID, (workflow) => {
        const list = reviewRecord(workflow).comprehension
        if (list.some((c) => c.id === args.codeSegmentId)) {
          throw new WorkflowOpError(`片段/要点 ${args.codeSegmentId} 已登记`)
        }
        const record: ComprehensionRecord = {
          id: args.codeSegmentId,
          file: args.file,
          lines: args.lineStart !== undefined && args.lineEnd !== undefined ? [args.lineStart, args.lineEnd] : undefined,
          explanation: args.explanation,
          decision: "pending",
          developerConfirmed: false,
          confirmedAt: null,
          feedback: null,
          rejectedAt: null,
          rewrites: 0,
          resolution: null,
        }
        list.push(record)
      })
      return `📖 已登记 ${args.codeSegmentId}，待开发者定夺。`
    },
  })

  const comprehension_confirm = tool({
    description:
      "确认单个片段/要点一次通过（accepted）。单次调用只接受一个 codeSegmentId——" +
      "批量确认在服务端被拒绝（防 LLM 在开发者说『看起来不错』时一次性置真全部）。" +
      "pending 与 rejected（开发者复议后接受）均可确认；已 manual 终态的不可再 confirm。",
    args: {
      codeSegmentId: z.string().describe("要确认的单个片段/要点标识"),
      sourceLabel: z
        .string()
        .optional()
        .describe("确认来源标签（溯源，P3.10）：如「文档 3.2 章」「对话第 4 轮业务原话」「要点 2.3」；reqdoc 要点确认时建议填写以便定稿溯源"),
      sourceQuote: z
        .string()
        .optional()
        .describe("确认来源引用原文/编号（溯源，P3.10）：粘贴被确认要点的出处片段或编号；reqdoc 要点确认时建议填写"),
    },
    async execute(args, context) {
      let confirmedNow = false
      store.mutateWorkflow(context.sessionID, (workflow) => {
        const record = reviewRecord(workflow).comprehension.find(
          (c) => c.id === args.codeSegmentId,
        )
        if (!record) {
          throw new WorkflowOpError(`片段/要点 ${args.codeSegmentId} 不存在，请先登记要点`)
        }
        if (record.decision === "manual") {
          throw new WorkflowOpError(`片段/要点 ${args.codeSegmentId} 已处理终态，不可再确认`)
        }
        if (record.decision !== "accepted") {
          record.decision = "accepted"
          record.developerConfirmed = true
          record.confirmedAt = Date.now()
          confirmedNow = true
        }
        if (args.sourceLabel || args.sourceQuote) {
          record.confirmSource = { label: args.sourceLabel ?? "", quote: args.sourceQuote ?? "" }
        }
      })
      // P3.10 溯源回填：reqdoc 要点确认并给出来源证据时，将引用写回 PRD 交付件（确认溯源章节），
      // 使交付物本身可追溯（不止停留在 record）。best-effort：写盘失败不阻断确认。
      if (args.sourceLabel || args.sourceQuote) {
        const wf = store.ensure(context.sessionID).workflow
        const src = { label: args.sourceLabel ?? "", quote: args.sourceQuote ?? "" }
        if (wf?.kb) {
          try {
            const root = projectRoot(context)
            await appendConfirmSourceToPrd(root, prdRelPath(root, wf.kb.features), args.codeSegmentId, src)
          } catch {
            // best-effort：溯源回填失败不阻断要点确认
          }
        }
      }
      const review = reviewRecord(store.ensure(context.sessionID).workflow!)
      const done = review.comprehension.filter((c) => c.decision === "accepted").length
      return (
        (confirmedNow ? `✅ 已确认 ${args.codeSegmentId}（一次通过）。` : `片段/要点 ${args.codeSegmentId} 此前已确认。`) +
        `\n理解确认进度：accepted ${done}/${review.comprehension.length}`
      )
    },
  })

  const comprehension_ask = tool({
    description: "对某片段/要点追问：将开发者的问题与 AI 的解答追加到其 explanation（形成可检索知识库）。",
    args: {
      codeSegmentId: z.string().describe("被追问的片段/要点标识"),
      question: z.string().describe("开发者的问题"),
      answer: z.string().describe("AI 的解答"),
    },
    async execute(args, context) {
      store.mutateWorkflow(context.sessionID, (workflow) => {
        const record = reviewRecord(workflow).comprehension.find(
          (c) => c.id === args.codeSegmentId,
        )
        if (!record) {
          throw new WorkflowOpError(`片段/要点 ${args.codeSegmentId} 不存在`)
        }
        record.explanation += `\n\n追问：${args.question}\n解答：${args.answer}`
      })
      return `💬 问答已追加到 ${args.codeSegmentId} 的解释。`
    },
  })

  const comprehension_reject = tool({
    description:
      "拒绝单个片段/要点：开发者有异议或需改动，feedback 必填（作为修改的依据）。" +
      "进入拒绝状态，须经重写或由开发者自行处理，不允许悬空。",
    args: {
      codeSegmentId: z.string().describe("被拒绝的片段/要点标识"),
      feedback: z.string().describe("拒绝意见：期望的改动、被误导的地方或风险点"),
    },
    async execute(args, context) {
      store.mutateWorkflow(context.sessionID, (workflow) => {
        const record = reviewRecord(workflow).comprehension.find(
          (c) => c.id === args.codeSegmentId,
        )
        if (!record) {
          throw new WorkflowOpError(`片段/要点 ${args.codeSegmentId} 不存在`)
        }
        if (record.decision !== "pending") {
          throw new WorkflowOpError(`片段/要点 ${args.codeSegmentId} 当前为 ${record.decision}，仅待定状态可拒绝（已接受/已处理不可回退）`)
        }
        record.decision = "rejected"
        record.feedback = args.feedback
        record.rejectedAt = Date.now()
      })
      return `⚠ 已拒绝 ${args.codeSegmentId}。请按意见重写，或由开发者自行处理。`
    },
  })

  const comprehension_rewrite = tool({
    description:
      "按拒绝意见重写：AI 依据 feedback 修改后调用，回到待定状态重新审查。" +
      "仅拒绝状态可重写。",
    args: {
      codeSegmentId: z.string().describe("被拒绝待重写的片段/要点标识"),
    },
    async execute(args, context) {
      let rewritesNow = 0
      store.mutateWorkflow(context.sessionID, (workflow) => {
        const record = reviewRecord(workflow).comprehension.find(
          (c) => c.id === args.codeSegmentId,
        )
        if (!record) {
          throw new WorkflowOpError(`片段/要点 ${args.codeSegmentId} 不存在`)
        }
        if (record.decision !== "rejected") {
          throw new WorkflowOpError(`片段/要点 ${args.codeSegmentId} 当前为 ${record.decision}，仅拒绝状态可重写`)
        }
        record.decision = "pending"
        record.rewrites += 1
        rewritesNow = record.rewrites
        record.developerConfirmed = false
        record.confirmedAt = null
      })
      return `🔧 ${args.codeSegmentId} 已回到待定状态重新审查（第 ${rewritesNow} 次重写）。`
    },
  })

  const comprehension_manual = tool({
    description:
      "开发者自行处理被拒绝的片段/要点（大改、废弃或人工接手）：声明处理结果说明，进入已处理终态。" +
      "已处理不进入一次通过率分子，但计入定论分母。",
    args: {
      codeSegmentId: z.string().describe("被拒绝、由开发者自行处理的片段/要点标识"),
      resolution: z.string().describe("处理结果说明，如『已废弃』『已人工重写』『保留但记入风险』"),
    },
    async execute(args, context) {
      store.mutateWorkflow(context.sessionID, (workflow) => {
        const record = reviewRecord(workflow).comprehension.find(
          (c) => c.id === args.codeSegmentId,
        )
        if (!record) {
          throw new WorkflowOpError(`片段/要点 ${args.codeSegmentId} 不存在`)
        }
        if (record.decision !== "rejected") {
          throw new WorkflowOpError(`片段/要点 ${args.codeSegmentId} 当前为 ${record.decision}，仅拒绝状态可由开发者处理`)
        }
        record.decision = "manual"
        record.resolution = args.resolution
      })
      return `🖐 ${args.codeSegmentId} 已处理终态（${args.resolution}）。`
    },
  })

  const review_submit = tool({
    description:
      "提交审查清单。仅当清单各项均为 true，且所有已登记片段" +
      "处于终态（accepted/manual，不允许 pending/rejected 悬空）时，审查阶段才会 approve；" +
      "通过时自动计算一次通过率 firstPassRate 写入质量指标。具名参数由当前工作流类型的审查清单生成。",
    args: {
      ...reviewChecklistArgs,
      no_document_confirmed: z
        .boolean()
        .optional()
        .describe(
          "仅当 PRD 全部字段来自 [问答]、无任何 [文档] 支撑时使用：须业务在对话中明确确认「无书面材料可引用」后才可为 true，否则定稿会被来源支撑门禁拦截",
        ),
      skip_field_dict: z
        .boolean()
        .optional()
        .describe(
          "仅当需求确无结构化输入字段（无需字段定义）时使用：默认 false；为 true 时跳过「进 prd 前须生成数据字典(reqdoc_field_dict)」门禁。一般需求应在 prd 渲染前完成字段定义。",
        ),
      force_kb: z
        .boolean()
        .optional()
        .describe(
          "重构 2b：仅知识库定稿门禁（kbGate）未通过时使用——业务明确「不想再补」时放行。必须同时给 force_reason（业务给的理由）。默认 false。",
        ),
      force_reason: z
        .string()
        .optional()
        .describe("force_kb=true 时必填：业务给的不再补齐的理由（模型不得代填）"),
    },
    async execute(args, context) {
      if (args.force_kb && !args.force_reason) {
        throw new WorkflowOpError("force_kb=true 必须同时给 force_reason（理由须由业务给出，模型不得代填）")
      }
      // 组装产物读取（2c）：槽位是唯一事实源，产物只是投影——定稿只需重读产物比对内嵌摘要。
      // 来源记账/篡改检测等 Option A 机制随 reqdoc_patch 一并退役。
      let liveRender: RenderStructure | undefined
      const wf0 = store.ensure(context.sessionID).workflow
      if (wf0?.kb) {
        try {
          const root = projectRoot(context)
          liveRender = parseRenderStructure(
            await Bun.file(resolveWithinWorktree(root, prdRelPath(root, wf0.kb.features))).text(),
          )
        } catch {
          // 产物不存在/不可读时不阻断：kbGate 已校验槽位覆盖，产物缺失由 reqdoc_assemble 补
        }
      }
      // 是否首次定稿（幂等：重复 review_submit 不再重复写变更记录行）
      const preWf = store.ensure(context.sessionID).workflow
      const preApproved = preWf ? preWf.stages[getDefinition(preWf.type).reviewStage!]?.status === "approved" : false
      const saved = store.mutateWorkflow(context.sessionID, (workflow) => {
        const def = getDefinition(workflow.type)
        const review = reviewRecord(workflow)
        // 审查是最后一关：前序阶段须全部 approved，防越序（弱模型跳过编码/测试直接假通过审查）。
        // 定义驱动：sdlc（req→des→imp→tst→review）与 reqdoc（goal→rules→edge→prd→review）自动适用。
        const reviewIdx = def.stages.indexOf(def.reviewStage!)
        for (let i = 0; i < reviewIdx; i++) {
          const name = def.stages[i]
          if (workflow.stages[name].status !== "approved") {
            throw new WorkflowOpError(
              `审查前须先完成 ${def.labels[name]}（当前 ${def.labels[name]} 尚未完成），请先推进该阶段`,
            )
          }
        }
        // 知识库定稿门禁（2c）：旧打分卡/探针/渲染门禁已删除，kbGate 是唯一依据。
        if (def.type === "reqdoc") {
          const kb = workflow.kb
          if (!kb) {
            throw new WorkflowOpError(
              "需求知识库未建：请先 reqdoc_ingest 提交需求内容槽位并逐项确认，再定稿。",
            )
          }
          const unclosed = deriveQuestions(kb.features, {
            slots: kb.slots,
            askCounts: kb.askCounts,
            decls: kb.containers,
          }).unclosed
          const gate = kbGate(kb.slots, kb.features, {
            decls: kb.containers,
            unclosed,
            force: args.force_kb,
            threshold: 1,
          })
          if (!gate.pass) {
            throw new WorkflowOpError(
              `需求知识库未就绪：${gate.reasons.join("；")}。` +
                `覆盖率 ${gate.coverage.leafFilled}/${gate.coverage.leafTotal} 必填槽位。` +
                `请用 reqdoc_answer 补齐；确实无法补齐的，可 review_submit(force_kb=true, force_reason=<业务给的理由>) 放行。`,
            )
          }
          // 组装幂等校验（9.3 三分支）：产物与槽位不一致时区分「过期」与「被手改」
          const current = kbDigest(kb.slots)
          if (liveRender?.kbDigest && liveRender.kbDigest !== current) {
            throw new WorkflowOpError(
              `PRD 产物与知识库不一致（槽位摘要 ${current} ≠ 产物内嵌 ${liveRender.kbDigest}）：` +
                `若槽位已变更请用 reqdoc_assemble 重新组装（过期产物）；若未变更则产物被手工改动，请还原后重组装。`,
            )
          }
        }
        // 确认溯源门禁（P3.10）：reqdoc 已接受要点须回填来源证据，否则定稿视为凭空认可
        if (def.type === "reqdoc") {
          const noSource = review.comprehension.filter(
            (c) => c.decision === "accepted" && !c.confirmSource,
          )
          if (noSource.length > 0) {
            throw new WorkflowOpError(
              `确认溯源缺失：${noSource.map((c) => c.id).join("、")} 已确认但未回填来源证据。` +
                `请对每处确认补充来源标签与引用原文后再定稿。`,
            )
          }
        }
        const total = review.comprehension.length
        const hadCodeEdits = (workflow.quality.iterationCount ?? 0) > 0
        // 有 AI 代码编辑就必须登记理解确认片段；纯讨论会话（无代码）可无片段通过
        if (hadCodeEdits && total === 0) {
          throw new WorkflowOpError("本会话存在 AI 代码编辑，但未登记任何理解确认片段，请先登记要点")
        }
        // 评审闭环：所有片段必须定论（accepted/manual），不允许 pending/rejected 悬空
        const hanging = review.comprehension.filter(
          (c) => c.decision !== "accepted" && c.decision !== "manual",
        )
        if (hanging.length > 0) {
          const ids = hanging.map((c) => c.id).join("、")
          throw new WorkflowOpError(
            `仍有 ${hanging.length} 个片段/要点未定论（${ids}）。请确认接受或拒绝后处理，使其进入终态`,
          )
        }
        // 清单逐项写入：非 auto 取具名参数，auto 项（如 designRationale）置真（3.2 def 驱动）
        const failed: string[] = []
        for (const item of def.checklist) {
          const value = item.auto ? true : (args as Record<string, boolean>)[item.key]
          review.checklist[item.key] = value === true
          if (value !== true) failed.push(item.key)
        }
        if (failed.length > 0) {
          throw new WorkflowOpError(`审查清单未全部通过（缺：${failed.join("、")}），请回到编码/测试阶段补齐`)
        }
        // 自动计算一次通过率（3.2，sdlc 代码片段语义）：未重写即 accepted ÷ 全部定论片段(accepted+manual)
        if (total > 0) {
          const decided = review.comprehension.length
          const firstPass = review.comprehension.filter(
            (c) => c.decision === "accepted" && c.rewrites === 0,
          ).length
          workflow.quality.firstPassRate = Math.round((firstPass / decided) * 100)
        }
        // 幂等：已 approved 时不重复转换（重复 review_submit 不再报错）
        if (review.status !== "approved") {
          if (review.status === "not_started") {
            applyTransition(workflow, def.reviewStage!, "enter", Date.now(), "进入审查")
          }
          applyTransition(workflow, def.reviewStage!, "approve", Date.now(), `审查清单全部通过且所有片段已定论`)
        }
        recomputeCommit(workflow)
      })
      // PRD 交付件后处理（best-effort）：变更记录回填 + 迭代副本。
      // 路径由知识库功能点推导（2c）；无 worktree / 写盘失败都不应阻断定稿结果。
      if (saved.type === "reqdoc" && saved.kb) {
        try {
          const root = projectRoot(context)
          const rel = prdRelPath(root, saved.kb.features)
          // revision 0 = 初始定稿（1.0）；revisit 重做后定稿 = 修订行（1.<revision>）
          if (!preApproved) {
            await appendChangeRecordToPrd(root, rel, saved.stages[getDefinition(saved.type).reviewStage!].revision ?? 0)
          }
          await copyPrdToIterDir(root, saved)
        } catch {
          // best-effort：交付件后处理失败不影响定稿
        }
      }
      const review = reviewRecord(saved)
      const total = review.comprehension.length
      const rate = saved.quality.firstPassRate
      const def = getDefinition(saved.type)
      // 缺省收口软提示（2c）：知识库里 [缺省] 来源的槽位偏多时，提醒补材料/实例
      const defaultCount = (saved.kb?.slots ?? []).filter((sl) => sl.source === "缺省").length
      const lazyNote =
        defaultCount >= 3
          ? `\n⚠ 本次有 ${defaultCount} 个槽位以 [缺省] 收口（需求细节未落实）：建议补充 01~05 书面材料或真实实例后再评审。`
          : ""
      // 审查是最后阶段：通过即全部阶段 approved → 完成。此时在工具返回直接带出 /new 提醒
      // （弱模型未必等到下一轮注入片段才行动，完成瞬间的工具结果是最稳的触发点）。
      const locked = store.listLocks(context.sessionID)
      const lockedNote =
        def.hasCommitGate && locked.length > 0
          ? `\n⚠ 仍有 ${locked.length} 个文件被人工锁定（${locked.join("、")}）。` +
            `请询问开发者是否已完成手工修改，明确确认后逐个调用 unlock_file 解锁。`
          : ""
      return (
        `✅ 审查阶段通过（清单 ${def.checklist.length}/${def.checklist.length}，片段定论 ${total}/${total}）` +
        (rate !== null ? `，一次通过率 ${rate}%` : "") +
        `。\n提交门禁：${saved.commit.status}` +
        (saved.commit.blocked_by.length ? `（未完成：${saved.commit.blocked_by.join("、")}）` : "") +
        (saved.commit.status === "allowed"
          ? `\n⚑ 工作流已完成，请提醒开发者执行 /new 开始下一个需求（保持统计隔离）。`
          : "") +
        lockedNote + lazyNote
      )
    },
  })

  /**
   * 组装产物相对路径（2c）：由知识库功能点推导，供溯源回填/变更记录/迭代复制共用。
   * root 缺失（无 worktree 的调用方）时抛错——调用点均为 best-effort，不阻断定稿。
   */
  const prdRelPath = (root: string, features: readonly ReqdocFeature[]): string => {
    if (!root) throw new Error("无工作区根目录，无法定位组装产物")
    return join(relative(root, assembleDir(root, features)), "PRD.md")
  }

  /** P3.10 溯源回填：把要点的来源证据追加写入 PRD 交付件末尾的「确认溯源」章节（best-effort）。 */

  async function appendConfirmSourceToPrd(
    root: string,
    rel: string,
    id: string,
    src: { label: string; quote: string },
  ): Promise<void> {
    try {
      const abs = resolveWithinWorktree(root, rel)
      const md = await Bun.file(abs).text()
      const header = "## 确认溯源"
      const line = `- 要点「${id}」来源：${src.label || "—"} —— ${src.quote.replace(/\r?\n/g, " ").slice(0, 200)}`
      if (md.includes(line)) return // 去重：同一条引用已写入
      const out = md.includes(header)
        ? `${md.trimEnd()}\n${line}\n`
        : `${md.trimEnd()}\n\n${header}\n${line}\n`
      await Bun.write(abs, out)
    } catch {
      // 写盘失败不影响确认本身（溯源仍存在于 record）
    }
  }

  /** 变更记录自动填充（best-effort）：把本次定稿写入 PRD「第二章 文档变更过程」表。
   * 已有表则在分隔行后插一行；缺表则于章节内建表（表头 + 分隔 + 首行）。 */
  async function appendChangeRecordToPrd(root: string, rel: string, revision: number): Promise<void> {
    try {
      const abs = resolveWithinWorktree(root, rel)
      const md = await Bun.file(abs).text()
      const header = "## 第二章 文档变更过程"
      const sectionIdx = md.indexOf(header)
      if (sectionIdx === -1) return
      const version = `1.${revision}`
      const date = new Date().toISOString().slice(0, 10)
      const content = revision === 0 ? "初始定稿" : "重做后修订定稿"
      const row = `| ${version} | ${content} | ${date} | 业务+AI 代笔 | |`
      const lines = md.split(/\r?\n/)
      // 已有变更记录表：在分隔行后插一行
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("版本号")) {
          const sepIdx = i + 1
          if (sepIdx < lines.length && /^\|[\s\-:|]+\|$/.test(lines[sepIdx])) {
            lines.splice(sepIdx + 1, 0, row)
            await Bun.write(abs, lines.join("\n"))
            return
          }
        }
      }
      // 缺表：于本章节内（下一章之前）建表
      const nextSectionIdx = md.indexOf("\n## ", sectionIdx)
      const insertAt = nextSectionIdx === -1 ? md.length : nextSectionIdx
      const table = `\n| 版本号 | 变更说明 | 日期 | 编制 | 复核 |\n| --- | --- | --- | --- | --- |\n${row}\n`
      await Bun.write(abs, md.slice(0, insertAt) + table + md.slice(insertAt))
    } catch {
      // 写盘失败不影响定稿本身（变更记录仍存于 WorkflowState）
    }
  }

  /** PRD 迭代支持：定稿后自动复制 PRD 到 00_初稿需求书，供下轮迭代。 */
  async function copyPrdToIterDir(root: string, workflow: WorkflowState): Promise<void> {
    if (!workflow.kb) return
    try {
      const srcRel = prdRelPath(root, workflow.kb.features)
      const srcAbs = resolveWithinWorktree(root, srcRel)
      const md = await Bun.file(srcAbs).text()

      // 版本号：revision 0 = V1，revision 1 = V2...
      const revision = workflow.stages.review?.revision ?? 0
      const version = `V${revision + 1}`

      const dstName = `PRD_${version}.md`
      const dstAbs = join(root, "00_初稿需求书", dstName)

      // 删除旧版本（00_初稿需求书/ 下的 PRD_V*.md）
      const dir = join(root, "00_初稿需求书")
      for (const f of await readdir(dir)) {
        if (f.startsWith("PRD_V") && f.endsWith(".md") && f !== dstName) {
          await unlink(join(dir, f))
        }
      }

      // 写入新版本
      await Bun.write(dstAbs, md)
    } catch {
      // 写盘失败不影响定稿本身
    }
  }

  return {
    comprehension_add,
    comprehension_confirm,
    comprehension_reject,
    comprehension_rewrite,
    comprehension_manual,
    comprehension_ask,
    review_submit,
  }
}
