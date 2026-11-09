/**
 * websec 工作流专属工具（测试范围 / 证据索引 / 结构化报告）。
 *
 * 设计约束：
 * - 默认只读；本文件不发起任何网络请求，只落库开发者/Agent 已获得的结论。
 * - 证据只存元数据与哈希，正文落本地文件，不上行。
 * - 报告中的每条 finding 必须引用已登记证据；无证据不得标 confirmed。
 */
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import {
  WEBSEC_CATEGORY_KEYS,
  WEBSEC_FINDING_STATUS_KEYS,
  WEBSEC_SEVERITY_KEYS,
  type WebsecEvidence,
  type WebsecFinding,
  type WebsecReport,
  type WebsecState,
  type WorkflowState,
} from "sm-shared"
import type { Store } from "../db"
import { WorkflowOpError } from "../workflow-ops"

const z = tool.schema

function requireWebsec(workflow: WorkflowState | null | undefined): WorkflowState {
  if (!workflow || workflow.type !== "websec") {
    throw new WorkflowOpError("该工具仅适用于 WEB 安全测试工作流")
  }
  return workflow
}

function ensureWebsec(workflow: WorkflowState): WebsecState {
  return workflow.websec ?? { evidence: [] }
}

/** 规范化项目内证据目录；拒绝绝对路径、.. 与空路径。 */
function normalizeEvidenceDir(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim().replace(/\\/g, "/")
  if (!trimmed) throw new WorkflowOpError("evidence_dir 不能为空")
  if (trimmed.startsWith("/") || trimmed.startsWith("//") || /^[a-zA-Z]:\//.test(trimmed)) {
    throw new WorkflowOpError("evidence_dir 必须是项目内相对路径，不能是绝对路径")
  }
  const parts = trimmed.split("/").filter((part) => part !== "")
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new WorkflowOpError("evidence_dir 不能包含 . 或 ..，且不能为空")
  }
  return parts.join("/")
}

function requireScope(workflow: WorkflowState): WebsecState {
  const state = ensureWebsec(workflow)
  if (!state.scope) {
    throw new WorkflowOpError("尚未记录测试范围与边界：请先调用 websec_scope")
  }
  return state
}

const account = z.object({
  name: z.string().min(1).describe("账号代号（不要填真实口令/令牌）"),
  role: z.string().min(1).describe("角色/权限，如 admin、普通用户、只读用户"),
  note: z.string().optional().describe("备注（可选）"),
})

const evidence = z.object({
  id: z.string().min(1).optional().describe("证据 id（可选；缺省自动生成 ev-N）"),
  url: z.string().min(1).describe("请求 URL（可脱敏 query）"),
  method: z.string().min(1).describe("HTTP 方法"),
  identity: z.string().optional().describe("发起请求的身份/角色"),
  capturedAt: z.number().int().positive().optional().describe("采集时间（epoch ms）"),
  hash: z.string().min(8).describe("请求/响应正文的 SHA-256 或等价哈希（必填）"),
  localPath: z.string().optional().describe("证据正文的本地文件路径（可选）"),
  note: z.string().optional().describe("说明（可选）"),
  phase: z.enum(["single", "baseline", "privileged"]).optional().describe("证据阶段（普通/基线/高权）"),
  status: z.number().int().optional().describe("响应状态码（可选）"),
  mimeType: z.string().optional().describe("响应 MIME（可选）"),
  resourceType: z.string().optional().describe("CDP 资源类型（可选）"),
  bodyPresent: z.boolean().optional().describe("是否拿到了正文；false 表示仅元数据"),
})

const finding = z.object({
  id: z.string().min(1).optional().describe("发现 id（可选；缺省自动生成）"),
  title: z.string().min(1).describe("标题"),
  category: z.enum(WEBSEC_CATEGORY_KEYS).describe("检查类别"),
  severity: z.enum(WEBSEC_SEVERITY_KEYS).describe("严重度"),
  endpoint: z.string().min(1).describe("受影响端点/页面"),
  method: z.string().optional().describe("HTTP 方法（可选）"),
  identity: z.string().optional().describe("复现所用身份（可选）"),
  status: z.enum(WEBSEC_FINDING_STATUS_KEYS).describe("confirmed=已复现；suspected=待验证"),
  evidenceRef: z.string().min(1).describe("必须引用已登记的 websec_evidence id"),
  baselineEvidenceRef: z.string().optional().describe("越权测试：baseline 证据 id（普通账号）"),
  privilegedEvidenceRef: z.string().optional().describe("越权测试：privileged 证据 id（高权账号）"),
  reproduction: z.string().min(1).describe("复现步骤（baseline 与 proof）"),
  impact: z.string().min(1).describe("影响与利用前提"),
  remediation: z.string().min(1).describe("可执行的修复建议"),
})

export function createWebsecTools(store: Store): Record<string, ToolDefinition> {
  const websec_scope = tool({
    description:
      "记录 WEB 安全测试的范围与边界（scope 阶段）。必须由开发者确认目标属于其负责或获准自测的范围后调用；" +
      "未记录 scope 不得进入安全检查。内部开发自测不需要工单/邮件/合同。只存账号代号/角色，不存口令或令牌。",
    args: {
      target: z.string().min(1).describe("目标 URL 或环境标识"),
      environment: z.string().min(1).describe("环境，如 dev/staging/prod"),
      authorization: z.string().min(1).optional().describe("可选：授权说明；内部开发自测可省略"),
      accounts: z.array(account).min(1).describe("可用测试账号（至少一个）"),
      window: z.string().optional().describe("允许测试的时间窗"),
      rateLimit: z.string().optional().describe("限速要求"),
      stopConditions: z.array(z.string().min(1)).min(1).describe("必须停止的条件（至少一条）"),
      evidence_dir: z.string().optional().describe("证据正文目录（项目内相对路径，默认 websec-evidence）"),
      developer_confirmed: z.boolean().describe("必须为 true，表示开发者已明确确认测试范围与边界"),
    },
    async execute(args, context) {
      if (args.developer_confirmed !== true) {
        throw new WorkflowOpError("记录测试范围与边界需开发者明确确认：developer_confirmed 必须为 true")
      }
      const saved = store.mutateWorkflow(context.sessionID, (workflow) => {
        const state = requireWebsec(workflow)
        if (state.stages.scope?.status === "not_started") {
          throw new WorkflowOpError("请先调用 workflow_start 启动工作流，再记录测试范围与边界")
        }
        const base = ensureWebsec(workflow)
        workflow.websec = {
          ...base,
          scope: {
            target: args.target,
            environment: args.environment,
            authorization: args.authorization,
            accounts: args.accounts,
            window: args.window,
            rateLimit: args.rateLimit,
            stopConditions: args.stopConditions,
            evidenceDir: normalizeEvidenceDir(args.evidence_dir),
            confirmedAt: Date.now(),
          },
        }
      })
      const scope = saved.websec?.scope
      return (
        `✅ 测试范围与边界已记录：${scope?.target}（${scope?.environment}）\n` +
        (scope?.authorization ? `授权说明：${scope.authorization}\n` : "") +
        `账号：${scope?.accounts.map((item) => `${item.name}/${item.role}`).join("、")}\n` +
        `停止条件：${scope?.stopConditions.join("；")}\n` +
        `证据目录：${scope?.evidenceDir ?? "websec-evidence"}（项目内，正文不会上行）\n` +
        `下一步：进入「资产与接口」阶段枚举入口。`
      )
    },
  })

  const websec_evidence = tool({
    description:
      "登记一条证据索引（只存 URL/方法/身份/时间/哈希/本地路径，不存正文）。" +
      "报告中的 finding 必须引用已登记的证据 id；无证据结论不得标 confirmed。",
    args: { ...evidence.shape },
    async execute(args, context) {
      const saved = store.mutateWorkflow(context.sessionID, (workflow) => {
        const state = requireWebsec(workflow)
        requireScope(state)
        const base = ensureWebsec(workflow)
        const list = [...base.evidence]
        const id = args.id ?? `ev-${list.length + 1}`
        if (list.some((item) => item.id === id)) {
          throw new WorkflowOpError(`证据 id 已存在：${id}；请换一个 id 或直接引用已有证据`)
        }
        const item: WebsecEvidence = {
          id,
          url: args.url,
          method: args.method,
          identity: args.identity,
          capturedAt: args.capturedAt,
          hash: args.hash,
          localPath: args.localPath,
          note: args.note,
          phase: args.phase,
          status: args.status,
          mimeType: args.mimeType,
          resourceType: args.resourceType,
          bodyPresent: args.bodyPresent,
        }
        list.push(item)
        workflow.websec = { ...base, evidence: list }
      })
      const count = saved.websec?.evidence.length ?? 0
      return `✅ 证据已登记：${args.id ?? `ev-${count}`}（当前共 ${count} 条）`
    },
  })

  const websec_report = tool({
    description:
      "提交 WEB 安全测试结构化报告（report 阶段）。每条 finding 必须引用已登记的 evidenceRef；" +
      "无发现时 verdict=passed。报告会展示给开发者，并作为 review_submit 的前置条件。",
    args: {
      method: z.string().min(1).describe("测试方法概述"),
      findings: z.array(finding).describe("发现清单（可为空）"),
      limitations: z.array(z.string().min(1)).optional().describe("局限与未覆盖项"),
      verdict: z.enum(["passed", "issues_found"]).describe("passed=未发现问题；issues_found=存在发现"),
    },
    async execute(args, context) {
      const saved = store.mutateWorkflow(context.sessionID, (workflow) => {
        const state = requireWebsec(workflow)
        const base = requireScope(state)
        if (base.edge?.started && !base.edge.finished) {
          throw new WorkflowOpError("Edge 会话尚未完成：请先调用 websec_edge_capture(finish) 再生成报告")
        }
        if (state.stages.verify?.status !== "approved") {
          throw new WorkflowOpError("提交报告前须先完成「验证与定级」阶段")
        }
        if (state.stages.report?.status === "not_started") {
          throw new WorkflowOpError("请先用 workflow_advance 进入「报告与修复」阶段，再提交报告")
        }
        const byId = new Map(base.evidence.map((item) => [item.id, item]))
        const findings: WebsecFinding[] = args.findings.map((item, index) => {
          const id = item.id ?? `f-${index + 1}`
          const primary = byId.get(item.evidenceRef)
          if (!primary) {
            throw new WorkflowOpError(`发现 ${id} 引用了不存在的证据 ${item.evidenceRef}；请先调用 websec_evidence 登记`)
          }
          if (base.testMode === "authz" && item.status === "confirmed") {
            if (!item.baselineEvidenceRef || !item.privilegedEvidenceRef) {
              throw new WorkflowOpError(
                `发现 ${id} 是越权 confirmed，必须同时提供 baselineEvidenceRef 与 privilegedEvidenceRef`,
              )
            }
            const baseline = byId.get(item.baselineEvidenceRef)
            const privileged = byId.get(item.privilegedEvidenceRef)
            if (!baseline || baseline.phase !== "baseline") {
              throw new WorkflowOpError(`发现 ${id} 的 baselineEvidenceRef 不存在或不是 baseline 阶段证据`)
            }
            if (!privileged || privileged.phase !== "privileged") {
              throw new WorkflowOpError(`发现 ${id} 的 privilegedEvidenceRef 不存在或不是 privileged 阶段证据`)
            }
            if (!baseline.bodyPresent && !privileged.bodyPresent) {
              throw new WorkflowOpError(`发现 ${id} 的越权证据缺少正文：confirmed 至少需要一条带正文的证据`)
            }
          }
          if (base.testMode === "normal" && item.status === "confirmed" && !primary.bodyPresent) {
            throw new WorkflowOpError(`发现 ${id} 的证据只有元数据（bodyPresent=false），不能标 confirmed`)
          }
          if (item.baselineEvidenceRef && !byId.has(item.baselineEvidenceRef)) {
            throw new WorkflowOpError(`发现 ${id} 的 baselineEvidenceRef 不存在：${item.baselineEvidenceRef}`)
          }
          if (item.privilegedEvidenceRef && !byId.has(item.privilegedEvidenceRef)) {
            throw new WorkflowOpError(`发现 ${id} 的 privilegedEvidenceRef 不存在：${item.privilegedEvidenceRef}`)
          }
          return {
            id,
            title: item.title,
            category: item.category,
            severity: item.severity,
            endpoint: item.endpoint,
            method: item.method,
            identity: item.identity,
            status: item.status,
            evidenceRef: item.evidenceRef,
            baselineEvidenceRef: item.baselineEvidenceRef,
            privilegedEvidenceRef: item.privilegedEvidenceRef,
            reproduction: item.reproduction,
            impact: item.impact,
            remediation: item.remediation,
          }
        })
        if (args.verdict === "passed" && findings.length > 0) {
          throw new WorkflowOpError("verdict=passed 时不能包含 findings；有发现请用 issues_found")
        }
        if (args.verdict === "issues_found" && findings.length === 0) {
          throw new WorkflowOpError("verdict=issues_found 时 findings 不能为空")
        }
        const report: WebsecReport = {
          status: "submitted",
          testMode: base.testMode,
          method: args.method,
          findings,
          limitations: args.limitations ?? [],
          verdict: args.verdict,
          submittedAt: Date.now(),
        }
        workflow.websec = { ...base, report }
      })
      const report = saved.websec?.report
      if (!report) throw new WorkflowOpError("报告写入失败")
      const bySeverity = WEBSEC_SEVERITY_KEYS.map((severity) => {
        const count = report.findings.filter((item) => item.severity === severity).length
        return count > 0 ? `${severity} ${count}` : null
      })
        .filter(Boolean)
        .join(" / ")
      const findingLines =
        report.findings.length > 0
          ? report.findings
              .map(
                (item, index) =>
                  `${index + 1}. [${item.severity}] ${item.title}（${item.endpoint}，${item.status}，证据 ${item.evidenceRef}）`,
              )
              .join("\n")
          : "无"
      return (
        `✅ WEB 安全测试报告已提交\n` +
        `结论：${report.verdict === "passed" ? "未发现问题（passed）" : "存在发现（issues_found）"}\n` +
        `发现：${report.findings.length}${bySeverity ? `（${bySeverity}）` : ""}\n` +
        `方法：${report.method}\n` +
        `发现清单：\n${findingLines}\n` +
        `局限：${report.limitations.length > 0 ? report.limitations.join("；") : "无"}\n` +
        `下一步：用 review_submit 完成审查清单并定稿。`
      )
    },
  })

  return { websec_scope, websec_evidence, websec_report }
}
