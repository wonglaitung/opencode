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
import {  mkdir, readdir, unlink } from "node:fs/promises"
import { join, relative } from "node:path"
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import {
  WORKFLOW_DEFINITIONS,
  getDefinition,
  parseRenderStructure,
  deriveQuestions,
  diffAgainstBaseline,
  baselineDiffSummary,
  kbDigest,
  kbGate,
  reviewRecord,
  templateGateCauseNotice,
  type BaselineDiff,
  type ComprehensionRecord,
  type ReqdocFeature,
  type RenderStructure,
  type WorkflowState,
} from "sm-shared"
import { assembleDir, assembleInto } from "./reqdoc-kb-tools"
import type { Store } from "../db"
/**
 * 服务端合法追加的两个章节 + 变更记录表体行。
 * **`stripServerAppended`（豁免）与 `verifyTraceback`（校验）必须共用同一组正则**——
 * 此前两处不一致（有 `$` / 无 `$`）导致伪造溯源能藏在变体里（对抗审查 F-1）。
 */
const SECTION_TRACEBACK_RE = /^##\s*确认溯源\s*$/
const SECTION_CHANGES_RE = /^##\s*第二章\s*文档变更过程\s*$/
const SERVICE_SECTION_RE = /^##\s/
const CHANGE_ROW_RE = /^\|\s*1\.\d+\s*\|[^|]*\|[^|]*\|[^|]*\|[^|]*\|$/
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
        .describe("确认来源标签（溯源）：如「文档 3.2 章」「对话第 4 轮业务原话」「要点 2.3」；reqdoc 要点确认时建议填写以便定稿溯源"),
      sourceQuote: z
        .string()
        .optional()
        .describe("确认来源引用原文/编号（溯源）：粘贴被确认要点的出处片段或编号；reqdoc 要点确认时建议填写"),
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
            await appendConfirmSourceToPrd(root, prdRelPath(root, wf.kb.features, wf.kb.assembledFile), args.codeSegmentId, src)
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
      /** 分支二定稿时「这次改了哪些」的差异（无基线快照 = null = 分支一全新需求）。 */
      let changeDiff: BaselineDiff | null = null
      // 组装产物读取（2c）：槽位是唯一事实源，产物只是投影——定稿只需重读产物比对内嵌摘要。
      // 来源记账/篡改检测等 Option A 机制随 reqdoc_patch 一并退役。
      let liveRender: RenderStructure | undefined
      let liveMd: string | undefined
      let prdMissing = false
      const wf0 = store.ensure(context.sessionID).workflow
      if (wf0?.kb) {
        try {
          const root = projectRoot(context)
          liveMd = await Bun.file(resolveWithinWorktree(root, prdRelPath(root, wf0.kb.features, wf0.kb.assembledFile))).text()
          liveRender = parseRenderStructure(liveMd)
        } catch {
          prdMissing = true
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
            candidates: kb.candidates,
            // 门禁不传 l1/l2：记忆只影响"问什么"，覆盖判定只看 confirmed 槽位（3.3.2 红线）
          }).unclosed
          const gate = kbGate(kb.slots, kb.features, {
            decls: kb.containers,
            unclosed,
            force: args.force_kb,
            threshold: 1,
          })
          if (!gate.pass) {
            // 真因优先（同 workflow_advance 的 prd 门禁）：模板不可读、或模板已更换时，
            // 「补齐」都是死路——前者必填集为空、后者补旧地址不计入覆盖率。
            const cause = templateGateCauseNotice(kb)
            if (cause) throw new WorkflowOpError(cause)
            throw new WorkflowOpError(
              `需求知识库未就绪：${gate.reasons.join("；")}。` +
                `覆盖率 ${gate.coverage.leafFilled}/${gate.coverage.leafTotal} 必填槽位。` +
                `请用 reqdoc_answer 补齐；确实无法补齐的，可 review_submit(force_kb=true, force_reason=<业务给的理由>) 放行。`,
            )
          }
          // 组装幂等校验（9.3 三分支）。产品缺失/无内嵌摘要都必须拦——
          // 否则模型用 write 手写一篇 PRD 就能绕开整个校验（重构审查发现的漏洞）。
          const current = kbDigest(kb.slots)
          if (prdMissing) {
            throw new WorkflowOpError(
              `未找到 PRD 产物（预期路径 ${prdRelPath(projectRoot(context), kb.features, kb.assembledFile)}）：` +
                `PRD 必须由 reqdoc_assemble 从槽位投影生成，不能用 write 手写。请先 reqdoc_assemble 再定稿。`,
            )
          }
          if (!liveRender?.kbDigest) {
            throw new WorkflowOpError(
              `PRD 产物缺少槽位摘要（<!-- kb-digest -->），无法校验与知识库的一致性：` +
                `该产物应为 reqdoc_assemble 生成。请用 reqdoc_assemble 重新组装后定稿，不要手工编辑或手写产物。`,
            )
          }
          if (liveRender.kbDigest !== current) {
            throw new WorkflowOpError(
              `PRD 产物与知识库不一致（槽位摘要 ${current} ≠ 产物内嵌 ${liveRender.kbDigest}）：` +
                `若槽位已变更请用 reqdoc_assemble 重新组装（过期产物）；若未变更则产物被手工改动，请还原后重组装。`,
            )
          }
          // 摘要相同≠内容相同：kbDigest 只哈希槽位，**纯内容手改（改字不增删槽位）摘要不变**。
          // 故再做一次「重组装 diff」：服务端用同一模板重投影一次，与磁盘产物逐行比对——
          // 这才是验收标准 4「组装出的 PRD 与槽位逐字一致」的完整语义。
          const rebuilt = assembleInto(kb)
          if (!rebuilt) {
            throw new WorkflowOpError("服务端无法重组装 PRD（模板不可用或功能点为空），无法校验产物一致性")
          }
          // 豁免服务端合法追加的尾部区块：确认溯源（P3.10）与文档变更过程行——
          // 它们由 comprehension_confirm / 定稿回填写入，不来自槽位，不参与「逐字一致」比对。
          // 过滤各自文本中的溯源正文（按行处理，两边独立扫描）
          const drift = diffLines(stripServerAppended(rebuilt.md), stripServerAppended(liveMd ?? ""))
          // 溯源节被整节豁免于 LCS 比对，故**独立校验**：其条目必须与 reviewRecord 逐条对应——
          // 否则模型可手写伪造证据（「业务总监口头批准」）混进交付件（对抗审查 P0-2）。
          verifyTraceback(liveMd ?? "", review)
          if (drift.length > 0) {
            const shown = drift.slice(0, 5).join("；")
            throw new WorkflowOpError(
              `PRD 内容与知识库不一致（重组装比对发现 ${drift.length} 处差异）：${shown}${drift.length > 5 ? " 等" : ""}。` +
                `产物必须完全由槽位投影生成：请用 reqdoc_assemble 覆盖重新组装，不要手工编辑产物。`,
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
          const rel = prdRelPath(root, saved.kb.features, saved.kb.assembledFile)
          // 分支二（改已有需求）：与承认基线时的快照逐地址比对，得出「这次到底改了什么」。
          // 无快照 = 分支一全新需求 → 无变更可言，返回 null。
          const diff = diffAgainstBaseline(saved.kb)
          // revision 0 = 初始定稿（1.0）；revisit 重做后定稿 = 修订行（1.<revision>）
          if (!preApproved) {
            await appendChangeRecordToPrd(root, rel, saved.stages[getDefinition(saved.type).reviewStage!].revision ?? 0)
          }
          await copyPrdToIterDir(root, saved)
          changeDiff = diff
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
      // 记忆回顾提示（3.6.1 ③）：定稿后请业务勾选要记住的组织知识——只提示，写入由 reqdoc_memory_recall 显式执行
      const recallCandidates = (saved.kb?.slots ?? []).filter((sl) => sl.source === "问答" && sl.status === "confirmed").length
      const recallNote =
        saved.type === "reqdoc" && recallCandidates > 0
          ? `\n🧠 记忆回顾：本次有 ${recallCandidates} 项来自业务口述的内容。请把它们整理成 2~4 条组织知识候选（系统名/接口/产品线等），` +
            `逐条问业务「这条要不要记入组织记忆供后续复用」，勾选的调用 reqdoc_memory_recall 写入。`
          : ""
      // 审查是最后阶段：通过即全部阶段 approved → 完成。此时在工具返回直接带出 /new 提醒
      // （弱模型未必等到下一轮注入片段才行动，完成瞬间的工具结果是最稳的触发点）。
      const locked = store.listLocks(context.sessionID)
      const lockedNote =
        def.hasCommitGate && locked.length > 0
          ? `\n⚠ 仍有 ${locked.length} 个文件被人工锁定（${locked.join("、")}）。` +
            `请询问开发者是否已完成手工修改，明确确认后逐个调用 unlock_file 解锁。`
          : ""
      // 分支二变更清单：业务说「只改这两处」，他就该看到「实际改了什么」——
      // 这是「不重问旧内容」这套设计敢成立的信任基础。措辞按 07 业务口语：可直接转述给业务。
      const changeNote = !changeDiff
        ? ""
        : `\n📋 本次变更（相对基线 ${saved.kb?.baselineSnapshot?.file?.split("/").pop() ?? "基线"}）：${baselineDiffSummary(changeDiff)}` +
          `\n  请把上面这份清单转述给业务（这是评审要看的，不必让业务自己对比新旧两版）。`
      return (
        `✅ 审查阶段通过（清单 ${def.checklist.length}/${def.checklist.length}，片段定论 ${total}/${total}）` +
        (rate !== null ? `，一次通过率 ${rate}%` : "") +
        `。\n提交门禁：${saved.commit.status}` +
        (saved.commit.blocked_by.length ? `（未完成：${saved.commit.blocked_by.join("、")}）` : "") +
        (saved.commit.status === "allowed"
          ? `\n⚑ 工作流已完成，请提醒开发者执行 /new 开始下一个需求（保持统计隔离）。`
          : "") +
        lockedNote + lazyNote + recallNote + changeNote
      )
    },
  })

  /**
   * 组装产物相对路径（2c）：由知识库功能点推导，供溯源回填/变更记录/迭代复制共用。
   * root 缺失（无 worktree 的调用方）时抛错——调用点均为 best-effort，不阻断定稿。
   */
  const prdRelPath = (root: string, features: readonly ReqdocFeature[], fileName?: string): string => {
    if (!root) throw new Error("无工作区根目录，无法定位组装产物")
    return join(relative(root, assembleDir(root, features)), fileName ?? "PRD.md")
  }

  /** P3.10 溯源回填：把要点的来源证据追加写入 PRD 交付件末尾的「确认溯源」章节（best-effort）。 */

  /**
   * 溯源节独立校验：其条目必须与 `reviewRecord` 的 `confirmSource` 严格一致。
   *
   * 溯源节整节不参与 LCS 比对（它不来自槽位），若不单独校验就成了伪造证据的后门。
   * 逐条比对：每条 `- 要点「X」来源：L —— Q` 都能在 reviewRecord 里找到同 (id,label,quote)。
   */
  function verifyTraceback(md: string, review: { comprehension: { id: string; confirmSource?: { label: string; quote: string } }[] }): void {
    const lines = md.split(/\r?\n/)
    const start = lines.findIndex((l) => SECTION_TRACEBACK_RE.test(l))
    // F-5：reviewRecord 里有 confirmSource 却没有落进 PRD → 整节被删，必须拦
    const expected = review.comprehension.filter((c) => c.confirmSource)
    if (start < 0) {
      if (expected.length > 0) {
        throw new WorkflowOpError(
          `PRD 缺少「确认溯源」章节，但有 ${expected.length} 个要点已回填来源证据（${expected.map((c) => c.id).join("、")}）。` +
            `该章节由 comprehension_confirm 自动写入，不得删除；请重新确认要点以重建。`,
        )
      }
      return
    }
    const end = lines.findIndex((l, i) => i > start && SERVICE_SECTION_RE.test(l))
    const section = lines.slice(start + 1, end < 0 ? lines.length : end)
    const claimed = section.flatMap((l) => {
      const m = /^-\s*要点「(.+?)」来源：(.*?)\s*——\s*(.*)$/.exec(l)
      return m ? [{ id: m[1]!, label: m[2]!, quote: m[3]! }] : []
    })
    // F-1：节内非空行若不匹配服务端写法 → 违规（此前静默放行，改 `*`/半角标点即可藏伪造）
    const malformed = section.filter((l) => l.trim() !== "" && !/^-\s*要点「.+?」来源：.+?\s*——\s*.+$/.test(l))
    if (malformed.length > 0) {
      throw new WorkflowOpError(
        `「确认溯源」章节有 ${malformed.length} 行不符合服务端写入格式（如「${malformed[0]!.trim().slice(0, 30)}」）。` +
          `该章节只能由 comprehension_confirm 回填，禁止手工编辑或改写格式。`,
      )
    }
    const known = new Map(review.comprehension.map((c) => [c.id, c.confirmSource]))
    const forged = claimed.filter((c) => {
      const rec = known.get(c.id)
      if (!rec) return true
      // quote 在写入时被截断到 200 字，比对时同样截断
      const q = rec.quote.replace(/\r?\n/g, " ").slice(0, 200)
      return rec.label !== c.label || q !== c.quote
    })
    if (forged.length > 0) {
      throw new WorkflowOpError(
        `「确认溯源」章节与理解确认记录不符（${forged.length} 条）：` +
          `${forged.map((f) => `要点「${f.id}」`).join("、")}。` +
          `该章节只能由 comprehension_confirm 回填，禁止手工编辑；请删除伪造内容或重新确认要点。`,
      )
    }
    // 反向完整性（I-4）：每条已确认的来源证据都必须在节内出现。
    // 此前只有「每行 → record」单向映射，逐条删除溯源记录能通过（交付件静默失去全部溯源）。
    const claimedIds = new Set(claimed.map((c) => c.id))
    const missing = expected.filter((c) => !claimedIds.has(c.id))
    if (missing.length > 0) {
      throw new WorkflowOpError(
        `「确认溯源」章节缺少 ${missing.length} 条已确认要点的来源证据：${missing.map((c) => c.id).join("、")}。` +
          `该章节必须逐条对应理解确认记录；请重新确认这些要点以重建。`,
      )
    }
  }

  /**
   * 服务端合法追加的区块处理：**逐行过滤**而非整节豁免。
   *
   * 「确认溯源」章节由 `comprehension_confirm` 写入、文档变更过程表由定稿回填，
   * 都不来自槽位，不参与「逐字一致」比对——但**只过滤该章节的正文行**，
   * 章节标题行本身仍参与比对（否则整节被替换/删除也检测不到，对抗审查 P0-2）。
   */
  function stripServerAppended(md: string): string {
    let skip: "traceback" | "changes" | null = null
    return md
      .split(/\r?\n/)
      .filter((line) => {
        // 两个服务端追加区块，**用与 verifyTraceback 完全相同的正则**判定——
        // 之前两处正则不一致（有 `$` / 无 `$`），导致伪造溯源能藏在变体里（F-1）。
        if (SECTION_TRACEBACK_RE.test(line)) {
          skip = "traceback"
          return false
        }
        if (SECTION_CHANGES_RE.test(line)) {
          skip = "changes"
          return false
        }
        if (skip && SERVICE_SECTION_RE.test(line)) {
          skip = null
          return false
        }
        // 溯源节整节滤掉
        if (skip === "traceback") return false
        // 变更记录章：只豁免**服务端自己写的那种行**（I-3）。
        // 此前用「任意 5 列表格行」豁免，等于允许伪造版本审计轨迹
        // （`| 9.9 | 【伪造】监管已出具无异议函 | 2020-01-01 | 张三 | 已通过 |` 能通过）。
        if (skip === "changes") return !CHANGE_ROW_RE.test(line)
        return true
      })
      .join("\n")
      .trimEnd()
  }


  /**
   * 保序行差异（LCS 定位增/删/改）——用于「重组装 vs 磁盘产物」比对。
   *
   * 早期版本用行多重集，会漏掉**行置换**（把 3.1 与 3.2 的内容对调后完全放行——
   * 槽位内容↔地址错位是最危险的一类手改，对抗审查 P0-2 实测）。故改为保序比对：
   * 先用最长公共子序列对齐未变行，剩下的即为新增/删除/替换。
   */
  function diffLines(expected: string, actual: string): string[] {
    const trim = (t: string) => t.trim()
    const a = expected.split(/\r?\n/).filter((l) => trim(l) !== "")
    const b = actual.split(/\r?\n/).filter((l) => trim(l) !== "")
    // LCS 表（规模为 PRD 行数，O(n·m) 可接受）
    const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
      }
    }
    // 沿 LCS 回溯，收集非对齐段
    const out: string[] = []
    let i = 0
    let j = 0
    const segExpected: string[] = []
    const segActual: string[] = []
    const flush = () => {
      if (segExpected.length === 0 && segActual.length === 0) return
      if (segExpected.length === segActual.length) {
        // 长度相同 → 逐位对照报「替换」（能定位到内容错位）
        for (let k = 0; k < segExpected.length; k++) {
          out.push(`「${segExpected[k]!.slice(0, 30)}」应为「${segActual[k]!.slice(0, 30)}」`)
        }
      } else {
        for (const l of segExpected) if (!segActual.includes(l)) out.push(`产物缺失：「${l.slice(0, 30)}」`)
        for (const l of segActual) if (!segExpected.includes(l)) out.push(`产物多出：「${l.slice(0, 30)}」`)
      }
      segExpected.length = 0
      segActual.length = 0
    }
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        flush()
        i++
        j++
      } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
        segExpected.push(a[i]!)
        i++
      } else {
        segActual.push(b[j]!)
        j++
      }
    }
    while (i < a.length) segExpected.push(a[i++]!)
    while (j < b.length) segActual.push(b[j++]!)
    flush()
    return out
  }

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
      const srcRel = prdRelPath(root, workflow.kb.features, workflow.kb.assembledFile) // F-4：漏传会丢迭代副本
      const srcAbs = resolveWithinWorktree(root, srcRel)
      const md = await Bun.file(srcAbs).text()

      // 版本号：revision 0 = V1，revision 1 = V2...
      const revision = workflow.stages.review?.revision ?? 0
      const version = `V${revision + 1}`

      const dstName = `PRD_${version}.md`
      const dstAbs = join(root, "00_初稿需求书", dstName)

      // 删除旧版本（00_初稿需求书/ 下的 PRD_V*.md）。
      // 该目录可能尚未创建（未跑过 reqdoc_init）——readdir 会抛 ENOENT 把整个拷贝吞掉，
      // 导致迭代副本静默丢失（F-4 实测：自定义 source 时 00_ 初稿始终不存在）。
      const dir = join(root, "00_初稿需求书")
      await mkdir(dir, { recursive: true })
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
