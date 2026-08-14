/**
 * 审查与理解确认工具（设计文档 4.1、3.2、7.3、7.4 规则 9-14）。
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
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { WORKFLOW_DEFINITIONS, getDefinition, reviewRecord, type ComprehensionRecord } from "sm-shared"
import type { Store } from "../db"
import { WorkflowOpError, applyTransition, recomputeCommit } from "../workflow-ops"

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
    },
    async execute(args, context) {
      let confirmedNow = false
      store.mutateWorkflow(context.sessionID, (workflow) => {
        const record = reviewRecord(workflow).comprehension.find(
          (c) => c.id === args.codeSegmentId,
        )
        if (!record) {
          throw new WorkflowOpError(`片段/要点 ${args.codeSegmentId} 不存在，请先 comprehension_add`)
        }
        if (record.decision === "manual") {
          throw new WorkflowOpError(`片段/要点 ${args.codeSegmentId} 已 manual 终态，不可再 confirm`)
        }
        if (record.decision !== "accepted") {
          record.decision = "accepted"
          record.developerConfirmed = true
          record.confirmedAt = Date.now()
          confirmedNow = true
        }
      })
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
      "拒绝单个片段/要点：开发者有异议或需改动，feedback 必填（作为 rewrite 的依据）。" +
      "进入 rejected 状态，须经 rewrite 重写或由开发者 manual 自处理，不允许悬空。",
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
          throw new WorkflowOpError(`片段/要点 ${args.codeSegmentId} 当前为 ${record.decision}，仅 pending 可拒绝（已 accepted/manual 不可回退）`)
        }
        record.decision = "rejected"
        record.feedback = args.feedback
        record.rejectedAt = Date.now()
      })
      return `⚠ 已拒绝 ${args.codeSegmentId}。请按意见 comprehension_rewrite 重写，或由开发者 comprehension_manual 自处理。`
    },
  })

  const comprehension_rewrite = tool({
    description:
      "按拒绝意见重写：AI 依据 feedback 修改后调用，回到 pending 重新审查，rewrites++。" +
      "仅 rejected 可重写。",
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
          throw new WorkflowOpError(`片段/要点 ${args.codeSegmentId} 当前为 ${record.decision}，仅 rejected 可重写`)
        }
        record.decision = "pending"
        record.rewrites += 1
        rewritesNow = record.rewrites
        record.developerConfirmed = false
        record.confirmedAt = null
      })
      return `🔧 ${args.codeSegmentId} 已回到 pending 重新审查（第 ${rewritesNow} 次重写）。`
    },
  })

  const comprehension_manual = tool({
    description:
      "开发者自行处理被拒绝的片段/要点（大改、废弃或人工接手）：声明 resolution 结果说明，进入 manual 终态。" +
      "manual 不进入一次通过率分子，但计入定论分母。",
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
          throw new WorkflowOpError(`片段/要点 ${args.codeSegmentId} 当前为 ${record.decision}，仅 rejected 可由开发者 manual 处理`)
        }
        record.decision = "manual"
        record.resolution = args.resolution
      })
      return `🖐 ${args.codeSegmentId} 已 manual 终态（${args.resolution}）。`
    },
  })

  const review_submit = tool({
    description:
      "提交审查清单。仅当清单各项均为 true，且所有已登记片段" +
      "处于终态（accepted/manual，不允许 pending/rejected 悬空）时，审查阶段才会 approve；" +
      "通过时自动计算一次通过率 firstPassRate 写入质量指标。具名参数由当前工作流类型的审查清单生成。",
    args: reviewChecklistArgs,
    async execute(args, context) {
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
              `审查前须先完成 ${def.labels[name]}（当前 ${def.labels[name]} 尚未 approved），请先推进该阶段`,
            )
          }
        }
        const total = review.comprehension.length
        const hadCodeEdits = (workflow.quality.iterationCount ?? 0) > 0
        // 有 AI 代码编辑就必须登记理解确认片段；纯讨论会话（无代码）可无片段通过
        if (hadCodeEdits && total === 0) {
          throw new WorkflowOpError("本会话存在 AI 代码编辑，但未登记任何理解确认片段，请先 comprehension_add")
        }
        // 评审闭环：所有片段必须定论（accepted/manual），不允许 pending/rejected 悬空
        const hanging = review.comprehension.filter(
          (c) => c.decision !== "accepted" && c.decision !== "manual",
        )
        if (hanging.length > 0) {
          const ids = hanging.map((c) => c.id).join("、")
          throw new WorkflowOpError(
            `仍有 ${hanging.length} 个片段/要点未定论（${ids}）。请 comprehension_confirm 接受、` +
              `comprehension_reject 拒绝后 rewrite/manual，使其进入终态（accepted/manual）`,
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
      const review = reviewRecord(saved)
      const total = review.comprehension.length
      const rate = saved.quality.firstPassRate
      const def = getDefinition(saved.type)
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
          ? `\n⚑ 工作流已完成，请提醒开发者执行 /new 开始下一个需求（保持统计隔离）。${lockedNote}`
          : "")
      )
    },
  })

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
