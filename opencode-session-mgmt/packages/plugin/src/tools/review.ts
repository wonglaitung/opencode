/**
 * 审查与理解确认工具（设计文档 4.1、3.2、7.3、7.4 规则 9-14）。
 * comprehension_add     —— 登记一个代码片段及其自然语言解释（developerConfirmed=false）
 * comprehension_confirm —— 单次只接受一个 codeSegmentId（防批量确认，服务端强制）
 * comprehension_ask     —— 追问片段，问答追加到 explanation
 * review_submit         —— 提交审查清单，四项全 true 且片段全部确认才可成功
 */
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { ComprehensionRecord } from "sm-shared"
import type { Store } from "../db"
import { WorkflowOpError, applyTransition, recomputeCommit } from "../workflow-ops"

const z = tool.schema

export function createReviewTools(store: Store): Record<string, ToolDefinition> {
  const comprehension_add = tool({
    description:
      "审查阶段：登记一个 AI 生成的代码片段及其自然语言解释（做了什么、为什么这样写、被放弃的替代方案、潜在风险）。" +
      "登记后 developerConfirmed=false，待开发者逐段确认后由 comprehension_confirm 置真。",
    args: {
      codeSegmentId: z.string().describe("片段唯一标识，如 auth/service.ts:12-45"),
      file: z.string().describe("文件路径"),
      lineStart: z.number().int().describe("起始行"),
      lineEnd: z.number().int().describe("结束行"),
      explanation: z.string().describe("自然语言解释，含设计推导、替代方案与风险"),
    },
    async execute(args, context) {
      store.mutateWorkflow(context.sessionID, (workflow) => {
        const list = workflow.stages.review.comprehension
        if (list.some((c) => c.codeSegmentId === args.codeSegmentId)) {
          throw new WorkflowOpError(`片段 ${args.codeSegmentId} 已登记`)
        }
        const record: ComprehensionRecord = {
          codeSegmentId: args.codeSegmentId,
          file: args.file,
          lines: [args.lineStart, args.lineEnd],
          explanation: args.explanation,
          developerConfirmed: false,
          confirmedAt: null,
        }
        list.push(record)
      })
      return `📖 已登记片段 ${args.codeSegmentId}，待开发者确认。`
    },
  })

  const comprehension_confirm = tool({
    description:
      "确认单个代码片段已被开发者理解。单次调用只接受一个 codeSegmentId——" +
      "批量确认在服务端被拒绝（防 LLM 在开发者说『看起来不错』时一次性置真全部片段）。",
    args: {
      codeSegmentId: z.string().describe("要确认的单个片段标识"),
    },
    async execute(args, context) {
      let confirmedNow = false
      store.mutateWorkflow(context.sessionID, (workflow) => {
        const record = workflow.stages.review.comprehension.find(
          (c) => c.codeSegmentId === args.codeSegmentId,
        )
        if (!record) {
          throw new WorkflowOpError(`片段 ${args.codeSegmentId} 不存在，请先 comprehension_add`)
        }
        if (!record.developerConfirmed) {
          record.developerConfirmed = true
          record.confirmedAt = Date.now()
          confirmedNow = true
        }
      })
      const review = store.ensure(context.sessionID).workflow!.stages.review
      const done = review.comprehension.filter((c) => c.developerConfirmed).length
      return (
        (confirmedNow ? `✅ 已确认片段 ${args.codeSegmentId}。` : `片段 ${args.codeSegmentId} 此前已确认。`) +
        `\n理解确认进度：${done}/${review.comprehension.length}`
      )
    },
  })

  const comprehension_ask = tool({
    description: "对某片段追问：将开发者的问题与 AI 的解答追加到该片段的 explanation（形成可检索知识库）。",
    args: {
      codeSegmentId: z.string().describe("被追问的片段标识"),
      question: z.string().describe("开发者的问题"),
      answer: z.string().describe("AI 的解答"),
    },
    async execute(args, context) {
      store.mutateWorkflow(context.sessionID, (workflow) => {
        const record = workflow.stages.review.comprehension.find(
          (c) => c.codeSegmentId === args.codeSegmentId,
        )
        if (!record) {
          throw new WorkflowOpError(`片段 ${args.codeSegmentId} 不存在`)
        }
        record.explanation += `\n\n追问：${args.question}\n解答：${args.answer}`
      })
      return `💬 问答已追加到片段 ${args.codeSegmentId} 的解释。`
    },
  })

  const review_submit = tool({
    description:
      "提交审查清单。仅当 businessIntent/logicExplainable/behaviorVerifiable 均为 true，" +
      "且所有已登记片段 developerConfirmed=true 时，审查阶段才会 approve；否则拒绝并说明原因。",
    args: {
      businessIntent: z.boolean().describe("公共方法有业务意图注释"),
      logicExplainable: z.boolean().describe("圈复杂度>10 的方法有行内注释"),
      behaviorVerifiable: z.boolean().describe("每个 Service 方法有至少一个集成测试"),
    },
    async execute(args, context) {
      const saved = store.mutateWorkflow(context.sessionID, (workflow) => {
        const review = workflow.stages.review
        const total = review.comprehension.length
        const confirmed = review.comprehension.filter((c) => c.developerConfirmed).length
        const hadCodeEdits = (workflow.quality.iterationCount ?? 0) > 0
        // 有 AI 代码编辑就必须登记理解确认片段；纯讨论会话（无代码）可无片段通过
        if (hadCodeEdits && total === 0) {
          throw new WorkflowOpError("本会话存在 AI 代码编辑，但未登记任何理解确认片段，请先 comprehension_add")
        }
        if (confirmed < total) {
          throw new WorkflowOpError(`仍有 ${total - confirmed} 个片段未确认理解，不可提交审查`)
        }
        review.checklist.businessIntent = args.businessIntent
        review.checklist.logicExplainable = args.logicExplainable
        review.checklist.behaviorVerifiable = args.behaviorVerifiable
        review.checklist.designRationale = confirmed === total
        const allPassed =
          args.businessIntent && args.logicExplainable && args.behaviorVerifiable && review.checklist.designRationale
        if (!allPassed) {
          const failed = [
            !args.businessIntent && "businessIntent",
            !args.logicExplainable && "logicExplainable",
            !args.behaviorVerifiable && "behaviorVerifiable",
          ]
            .filter((x): x is string => Boolean(x))
            .join("、")
          throw new WorkflowOpError(`审查清单未全部通过（缺：${failed}），请回到编码/测试阶段补齐`)
        }
        // 幂等：已 approved 时不重复转换（重复 review_submit 不再报错）
        if (review.status !== "approved") {
          if (review.status === "not_started") {
            applyTransition(workflow, "review", "enter", Date.now(), "进入审查")
          }
          applyTransition(workflow, "review", "approve", Date.now(), "审查清单四项通过且片段全部确认")
        }
        recomputeCommit(workflow)
      })
      return (
        `✅ 审查阶段通过（清单 4/4，理解确认 ${saved.stages.review.comprehension.length}/${saved.stages.review.comprehension.length}）。\n` +
        `提交门禁：${saved.commit.status}` +
        (saved.commit.blocked_by.length ? `（未完成：${saved.commit.blocked_by.join("、")}）` : "")
      )
    },
  })

  return { comprehension_add, comprehension_confirm, comprehension_ask, review_submit }
}
