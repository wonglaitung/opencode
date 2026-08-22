/**
 * 工作流工具（设计文档 session-management.md 4.1、3.3；reqdoc 打分卡门禁见 workflow-reqdoc.md 5 章）。
 * workflow_advance   —— 进入下一阶段 / 标记 approved（校验开发者确认语义）
 * workflow_revisit   —— 回退阶段（revision++）
 * workflow_baseline  —— 录入基线预估人工工时（6.3，AI 提效对比）
 * commit_gate_check  —— 提交门禁检查，返回未完成阶段列表
 */
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { REQDOC_SCORE_PASS, getDefinition, probeGapViolations, scoreDimZeroViolations, type WorkflowState } from "sm-shared"
import type { Store } from "../db"
import { WorkflowOpError, applyTransition, recomputeCommit } from "../workflow-ops"

const z = tool.schema

/**
 * reqdoc 各阶段进入前置条件清单（P3.8 门禁前置暴露，同源 reqdoc-r13/r14/r21/r23/r30 等）。
 * workflow_advance 进入/完成某阶段后，显式列出下一阶段的前置条件，让业务在动手前看到"须满足什么"。
 */
const REQDOC_STAGE_PREREQS: Record<string, string[]> = {
  rules: ["需求资料目录（01~04）已建", "业务已选择投放材料或确认直接口述", "已扫描提取已投放材料"],
  edge: ["已明确投放/口述方式", "02_制度与合规 / 04_角色与权限 已投且扫描（或确认口述）", "基线工时已录入（workflow_baseline）"],
  prd: [
    "功能点清单已拆分并经业务确认（reqdoc_confirm_features）",
    "打分卡 ≥85 且业务确认（reqdoc_score，business_confirmed=true）",
    "字段定义已落库（reqdoc_field_dict 数据字典）",
    "追问缺口已如实扣分，无缺口+满分矛盾",
  ],
  review: [
    "PRD 已按模板渲染并写入 06_需求规格产出",
    "已 reqdoc_check 结构合规（章节齐全/功能点块/字段来源）",
    "来源真实性达标（[文档] 占比 ≥30% 或 ≥2 功能点含文档支撑），或业务确认无书面材料",
    "已登记理解确认要点且逐条回填来源证据（comprehension_confirm 的 sourceLabel/sourceQuote）",
  ],
}

/** 运行时校验 stage 属于定义 stages（3.2 def 驱动；schema 用 string，因注册表类型运行时才定）。 */
function assertStage(workflow: WorkflowState, stage: string): void {
  const def = getDefinition(workflow.type)
  if (!def.stages.includes(stage)) {
    throw new WorkflowOpError(`阶段 ${stage} 不存在（工作流类型 ${def.type} 的阶段：${def.stages.join("、")}）`)
  }
}

export function createWorkflowTools(store: Store): Record<string, ToolDefinition> {
  const workflow_advance = tool({
    description:
      "推进工作流阶段：enter 进入某阶段（in_progress），approve 在开发者明确确认后标记该阶段完成。" +
      "审查阶段不可用本工具 approve，必须经 review_submit。",
    args: {
      stage: z.string().describe("目标阶段（当前工作流类型的有效阶段之一）"),
      action: z.enum(["enter", "approve"]).describe("enter=开始该阶段；approve=确认完成"),
      developer_confirmed: z
        .boolean()
        .describe("approve 时必须为 true，表示开发者已在对话中明确确认；否则调用将被拒绝"),
      note: z.string().optional().describe("本次转换的备注"),
    },
    async execute(args, context) {
      const saved = store.mutateWorkflow(context.sessionID, (workflow) => {
        assertStage(workflow, args.stage)
        const def = getDefinition(workflow.type)
        // 打分卡硬门禁（实施方案第三节）：reqdoc 进入 prd（渲染）前须已打分且 total ≥ 85 并获业务确认。
        if (args.action === "enter" && args.stage === "prd" && def.type === "reqdoc") {
          const score = workflow.score
          if (!score) {
            throw new WorkflowOpError(
              "进入 prd 前须先打分：请对照打分卡调用 reqdoc_score 输出各维得分与扣分明细并请业务确认（见 reqdoc-r21）",
            )
          }
          if (score.total < REQDOC_SCORE_PASS) {
            throw new WorkflowOpError(
              `PRD 质量未达标（${score.total}/100 < ${REQDOC_SCORE_PASS}）：请按扣分明细回 edge 追问补缺后重打 reqdoc_score`,
            )
          }
          if (!score.confirmed) {
            throw new WorkflowOpError("PRD 打分结果未获业务确认：请向业务展示并确认扣分明细后重调 reqdoc_score(business_confirmed=true)")
          }
          // 柔性一致校验（质量飞轮 P1）：缺口探针对应维度不得打满分（报缺口却打满分 = 自评不诚实）。
          const violations = probeGapViolations(workflow.probes, score)
          if (violations.length > 0) {
            throw new WorkflowOpError(
              `追问缺口与打分自相矛盾：${violations.join("；")}。请回 edge 补齐缺口后重打 reqdoc_score 如实扣分，或去掉缺口记录（reqdoc_probe）`,
            )
          }
          // 可实施性门禁（P1：material/nfr/acceptability 三维度任一 0 分 = 不可照着做）。
          const zeroV = scoreDimZeroViolations(score)
          if (zeroV.length > 0) {
            throw new WorkflowOpError(`可实施性不足：${zeroV.join("；")}。`)
          }
        }
        if (args.action === "approve") {
          if (def.reviewStage !== null && args.stage === def.reviewStage) {
            throw new WorkflowOpError("审查阶段不可由 AI 自行 approve，请改用 review_submit 工具")
          }
          if (args.developer_confirmed !== true) {
            throw new WorkflowOpError("approve 需开发者明确确认：developer_confirmed 必须为 true")
          }
        }
        // 进入下一阶段即自动确认（approve）上一阶段（工具强制，防"进入即进行中、确认未落库"缝隙，
        // 见报告#7）：仅把处于 in_progress 的前序阶段补 approve，已 approved 跳过、not_started 不动。
        if (args.action === "enter") {
          const idx = def.stages.indexOf(args.stage)
          for (let i = idx - 1; i >= 0; i--) {
            const pred = def.stages[i]!
            if (workflow.stages[pred].status === "in_progress") {
              applyTransition(workflow, pred, "approve", Date.now(), "进入下一阶段自动确认上一阶段")
            }
          }
        }
        applyTransition(workflow, args.stage, args.action, Date.now(), args.note)
      })
      const def = getDefinition(saved.type)
      const stage = saved.stages[args.stage]
      // 门禁前置暴露（P3.8）：进入/完成某阶段后，显式列出下一阶段的前置条件清单，
      // 让业务/开发者在动手前就看到"进下一阶段前必须满足什么"，避免中途才发现缺料。仅 reqdoc 有显式清单。
      const idx = def.stages.indexOf(args.stage)
      const nextKey = idx >= 0 && idx + 1 < def.stages.length ? def.stages[idx + 1]! : null
      const prereqLines =
        nextKey && def.type === "reqdoc" && REQDOC_STAGE_PREREQS[nextKey]
          ? `\n🚧 下一阶段「${def.labels[nextKey] ?? nextKey}」前置条件（须满足后再推进）：\n  - ${REQDOC_STAGE_PREREQS[nextKey]!.join("\n  - ")}`
          : ""
      return (
        `✅ ${def.labels[args.stage] ?? args.stage} → ${stage.status}\n` +
        `提交门禁：${saved.commit.status}` +
        (saved.commit.blocked_by.length ? `（未完成：${saved.commit.blocked_by.join("、")}）` : "") +
        prereqLines
      )
    },
  })

  const workflow_revisit = tool({
    description: "回退到指定阶段（该阶段 revision++，状态回到 in_progress）。开发者说『回到XX』时调用。",
    args: {
      stage: z.string().describe("要回退到的阶段（当前工作流类型的有效阶段之一）"),
      note: z.string().optional().describe("回退原因"),
    },
    async execute(args, context) {
      // 快照回退前的下游阶段状态，用于精确判定本次级联回退了哪些阶段（approved → in_progress）。
      const before = store.get(context.sessionID)?.workflow
      const saved = store.mutateWorkflow(context.sessionID, (workflow) => {
        assertStage(workflow, args.stage)
        applyTransition(workflow, args.stage, "revisit", Date.now(), args.note)
      })
      const def = getDefinition(saved.type)
      const idx = def.stages.indexOf(args.stage)
      const cascaded = def.stages
        .slice(idx + 1)
        .filter((name) => {
          const prev = before ? before.stages[name] : null
          return prev?.status === "approved" && saved.stages[name].status === "in_progress"
        })
        .map((name) => def.labels[name] ?? name)
      const cascadeNote = cascaded.length > 0 ? `（级联回退：${cascaded.join("、")}）` : ""
      return (
        `↩ 已回退到 ${def.labels[args.stage] ?? args.stage}（revision=${saved.stages[args.stage].revision}）${cascadeNote}`
      )
    },
  })

  const workflow_baseline = tool({
    description:
      "录入本会话的基线预估人工工时（项目经理在需求创建时给出的预估，如 8 小时），" +
      "用于会话结束后与实际周期对比、计算 AI 提效百分比（6.3）。可重复调用以重设（幂等覆盖，记最新值）。",
    args: {
      estimated_hours: z.number().positive().describe("预估人工工时（小时，可小数），由项目经理给出，如 8"),
      developer_confirmed: z
        .boolean()
        .describe("必须为 true，表示开发者已在对话中明确给出/确认该预估值（防止 AI 杜撰基线）"),
    },
    async execute(args, context) {
      if (args.developer_confirmed !== true) {
        throw new WorkflowOpError("基线预估须由开发者明确给出或确认：developer_confirmed 必须为 true")
      }
      const prev = store.get(context.sessionID)?.workflow?.baseline
      store.mutateWorkflow(context.sessionID, (workflow) => {
        workflow.baseline = { estimatedHours: args.estimated_hours, setAt: Date.now() }
      })
      const resetNote = prev ? `（已覆盖原预估 ${prev.estimatedHours}h）` : ""
      return (
        `✅ 已记录基线预估人工工时：${args.estimated_hours} 小时${resetNote}\n` +
        `会话结束后将按（预估 − 实际周期）÷ 预估 计算 AI 提效百分比；预估调整时可再次调用本工具重设。`
      )
    },
  })

  const commit_gate_check = tool({
    description:
      "提交门禁检查：返回各阶段的完成状况；未全部 approved 时列出未完成阶段。提交前应调用。" +
      "仅当前工作流类型有提交门禁时生效（sdlc）。",
    args: {},
    async execute(_args, context) {
      const saved = store.mutateWorkflow(context.sessionID, (workflow) => {
        recomputeCommit(workflow)
      })
      const def = getDefinition(saved.type)
      if (!def.hasCommitGate) {
        return `本工作流类型（${def.type}）无 git 提交门禁，无需检查。`
      }
      if (saved.commit.status === "allowed") {
        return `✓ 全部 ${def.stages.length} 个阶段已 approved，允许提交。`
      }
      const pending = saved.commit.blocked_by.map((s) => def.labels[s] ?? s).join("、")
      const forceNote =
        saved.commit.force && !saved.commit.force.used
          ? `\n⚠ 已有一次性强制提交授权（原因：${saved.commit.force.reason}），下次 git commit 将放行。`
          : ""
      return `✗ 尚不可提交，未完成阶段：${pending}${forceNote}`
    },
  })

  const commit_force_unlock = tool({
    description:
      "强制提交授权（3.4 逃生口）：仅当开发者明确要求强制提交并说明原因时调用。" +
      "写入一次性授权后，下一次 git commit 将被门禁放行（即使仍有未完成阶段），授权随即标记已用并留痕。" +
      "仅当前工作流类型有提交门禁时生效（sdlc）。",
    args: {
      reason: z.string().describe("强制提交原因（开发者口述，必填，将留痕于 WorkflowState）"),
      developer_confirmed: z.boolean().describe("必须为 true，表示开发者已明确要求强制提交"),
    },
    async execute(args, context) {
      if (args.developer_confirmed !== true) {
        throw new WorkflowOpError("强制提交需开发者明确要求：developer_confirmed 必须为 true")
      }
      const reason = args.reason.trim()
      if (reason === "") {
        throw new WorkflowOpError("强制提交必须填写原因")
      }
      const saved = store.mutateWorkflow(context.sessionID, (workflow) => {
        recomputeCommit(workflow)
        const def = getDefinition(workflow.type)
        if (!def.hasCommitGate) {
          throw new WorkflowOpError(`工作流类型 ${def.type} 无提交门禁，无需强制授权`)
        }
        workflow.commit.force = { reason, at: Date.now(), used: false }
      })
      const def = getDefinition(saved.type)
      if (saved.commit.status === "allowed") {
        return "工作流本已全部 approved，无需强制提交，直接 git commit 即可。"
      }
      const pending = saved.commit.blocked_by.map((s) => def.labels[s] ?? s).join("、")
      return (
        `⚠ 已授权一次性强制提交（原因：${reason}）。未完成阶段：${pending}。\n` +
        `下一次 git commit 将被放行，授权随即失效；此操作已在 WorkflowState 留痕。`
      )
    },
  })

  return { workflow_advance, workflow_revisit, workflow_baseline, commit_gate_check, commit_force_unlock }
}
