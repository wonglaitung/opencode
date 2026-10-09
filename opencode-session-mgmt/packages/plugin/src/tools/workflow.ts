/**
 * 工作流工具（设计文档 session-management.md 4.1、3.3；reqdoc 打分卡门禁见 workflow-reqdoc.md 5 章）。
 * workflow_advance   —— 进入下一阶段 / 标记 approved（校验开发者确认语义）
 * workflow_revisit   —— 回退阶段（revision++）
 * workflow_baseline  —— 录入基线预估人工工时（6.3，AI 提效对比）
 * commit_gate_check  —— 提交门禁检查，返回未完成阶段列表
 */
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import {
  deriveQuestions,
  getDefinition,
  kbGate,
  templateGateCauseNotice,
  type WorkflowState,
} from "sm-shared"
import type { Store } from "../db"
import { WorkflowOpError, applyTransition, recomputeCommit } from "../workflow-ops"

const z = tool.schema

/**
 * reqdoc 各阶段进入前置条件清单（P3.8 门禁前置暴露，同源 reqdoc-r13/r14/r21/r23/r30 等）。
 * workflow_advance 进入/完成某阶段后，显式列出下一阶段的前置条件，让业务在动手前看到"须满足什么"。
 */
const REQDOC_STAGE_PREREQS: Record<string, string[]> = {
  rules: ["需求资料目录（01~05）已建", "业务已选择投放材料或确认直接口述", "已扫描提取已投放材料"],
  edge: ["已明确投放/口述方式", "03_制度与合规 / 04_角色与权限 已投且扫描（或确认口述）", "基线工时已录入"],
  prd: [
    "功能点清单已拆分并经业务确认（reqdoc_confirm_features）",
    "必填槽位覆盖率达标：未 confirmed 的必填槽位会拦截 enter prd",
    "无未收口项（停问项/conflict 项须用 reqdoc_answer 显式收口）",
    "术语容器与字段容器（清单里 kind=term / kind=field 的那两个）已有 confirmed 子项，或已用 containers 声明 required:false 并附理由",
    "确实无法补齐且业务坚持不做：force_kb=true + 业务给的 force_reason",
  ],
  review: [
    "PRD 已由 reqdoc_assemble 生成并写入 07_需求规格产出",
    "产物内嵌槽位摘要与当前槽位一致（槽位变更后须重新组装；手写产物会被拦）",
    "必填槽位覆盖率达标且无未收口项（同样可 force_kb + force_reason 放行）",
    "已登记理解确认要点且逐条回填来源证据",
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
      force_kb: z
        .boolean()
        .optional()
        .describe(
          "重构 2b：仅 kb 存在且需求知识库门禁（kbGate）未通过时使用——业务明确「不想再补」时放行。必须同时给 force_reason（业务给的理由）。默认 false。",
        ),
      force_reason: z
        .string()
        .optional()
        .describe("force_kb=true 时必填：业务给的不再补齐的理由（模型不得代填，与 business_confirmed 同纪律）"),
    },
    async execute(args, context) {
      if (args.force_kb && !args.force_reason) {
        throw new WorkflowOpError("force_kb=true 必须同时给 force_reason（理由须由业务给出，模型不得代填）")
      }
      const saved = store.mutateWorkflow(context.sessionID, (workflow) => {
        assertStage(workflow, args.stage)
        const def = getDefinition(workflow.type)
        // PRD 产出门禁（重构 2c）：reqdoc 进入 prd 前，知识库必须存在且通过 kbGate
        // （必填槽位覆盖率 + 无未收口项）。旧打分卡/探针门禁已于 2c 删除。
        if (args.action === "enter" && args.stage === "prd" && def.type === "reqdoc") {
          const kb = workflow.kb
          if (!kb) {
            throw new WorkflowOpError(
              "需求知识库未建：请先 reqdoc_ingest 提交需求内容槽位，再进入 prd。",
            )
          }
          const gate = kbGate(kb.slots, kb.features, {
            decls: kb.containers,
            unclosed: deriveQuestions(kb.features, {
              slots: kb.slots,
              askCounts: kb.askCounts,
              decls: kb.containers,
              candidates: kb.candidates,
              // 门禁不因记忆放行：记忆只影响"问什么"，覆盖判定只看 confirmed 槽位（3.3.2 红线）
            }).unclosed,
            force: args.force_kb,
            threshold: 1,
          })
          if (!gate.pass) {
            // 真因优先：模板读不到、或模板已更换时，默认文案都会把人指向
            // 「补齐槽位」这条死路（前者必填集为空、后者补旧地址不算覆盖），必须先说真因。
            const cause = templateGateCauseNotice(kb)
            throw new WorkflowOpError(
              (cause ?? `需求知识库未就绪：${gate.reasons.join("；")}。`) +
                (cause
                  ? ""
                  : `请用 reqdoc_ingest 补齐槽位、reqdoc_answer 逐项确认；确实无法补齐的，` +
                    `可 workflow_advance(stage=prd, action=enter, force_kb=true, force_reason=<业务给的理由>) 放行。`),
            )
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
        `提交状态：${saved.commit.status}` +
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
      const wf = store.get(context.sessionID)?.workflow
      const proposed = wf?.baselineProposedByDev
      // 服务端防线（types.ts 既定：测「尝试了也不得成功」，不测模型谨慎）：
      // developer_confirmed 自证无效，须有开发者在对话中明确给出的工时证据。
      if (!proposed) {
        throw new WorkflowOpError(
          "基线预估须由开发者在对话中明确给出（如「8 小时」）；未检测到开发者提供的预估工时，请勿自行填入数值（防止 AI 杜撰基线毒化 6.3 提效对比）。",
        )
      }
      const tol = Math.max(0.5, proposed.hours * 0.1)
      if (Math.abs(proposed.hours - args.estimated_hours) > tol) {
        throw new WorkflowOpError(
          `基线预估须与开发者在对话中给出的 ${proposed.hours} 小时一致；本次录入 ${args.estimated_hours} 小时不符，请按开发者实际表述录入（developer_confirmed 不得为 AI 自造数值）。`,
        )
      }
      const prev = wf?.baseline
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
