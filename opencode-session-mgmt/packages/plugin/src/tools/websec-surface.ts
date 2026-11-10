/**
 * websec 资产清单、覆盖矩阵与历史 finding 回归。
 * 这三类状态只存元数据，不发起网络请求；用于把“用户点了什么”升级为“必须证明覆盖了什么”。
 */
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import {
  WEBSEC_CHECK_CATEGORY_KEYS,
  WEBSEC_CHECK_STATUS_KEYS,
  WEBSEC_REGRESSION_STATUS_KEYS,
  WEBSEC_SURFACE_SOURCE_KEYS,
  type WebsecCoverageEntry,
  type WebsecRegressionEntry,
  type WebsecState,
  type WebsecSurfaceEntry,
  type WorkflowState,
} from "sm-shared"
import type { Store } from "../db"
import { WorkflowOpError } from "../workflow-ops"
import { resolveEvidenceRoot, safeName } from "./websec-paths"
import { mergeRegression, seedCoverage, surfaceFromEvidence, websecEndpointKey } from "./websec-state"

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

function requireScope(state: WebsecState): void {
  if (!state.scope) throw new WorkflowOpError("尚未记录测试范围与边界：请先调用 websec_scope")
}

const surfaceEntry = z.object({
  id: z.string().min(1).optional().describe("入口 id（可选；缺省自动生成）"),
  method: z.string().min(1).describe("HTTP 方法，如 GET/POST"),
  endpoint: z.string().min(1).describe("路径或 URL，如 /api/tasks 或 https://host/api/tasks"),
  source: z.enum(WEBSEC_SURFACE_SOURCE_KEYS).describe("来源：edge=用户走查；source=源码/配置；manual=人工；anonymous-probe/http-check/write-probe=对应探测"),
  identity: z.string().optional().describe("该入口使用的身份/角色"),
  params: z.array(z.string()).optional().describe("参数位置，如 query:id、body:title"),
  requires_auth: z.enum(["yes", "no", "unknown"]).optional().describe("源码/观察判断是否需要登录"),
  note: z.string().optional().describe("备注"),
})

const coverageRecord = z.object({
  surface_ref: z.string().min(1).describe("websec_surface 返回的入口 id"),
  category: z.enum(WEBSEC_CHECK_CATEGORY_KEYS).describe("检查类别"),
  status: z.enum(WEBSEC_CHECK_STATUS_KEYS).describe("tested=已检查；finding=发现问题；not_applicable=不适用"),
  evidence_refs: z.array(z.string()).optional().describe("tested/finding 必须引用已登记证据 id"),
  note: z.string().optional().describe("not_applicable 必须写理由；其他状态可写说明"),
})

const regressionRecord = z.object({
  id: z.string().min(1).optional().describe("回归记录 id；缺省按来源拼接"),
  source_session_id: z.string().min(1).describe("历史 finding 的来源会话 id"),
  source_finding_id: z.string().min(1).describe("历史 finding id"),
  status: z.enum(WEBSEC_REGRESSION_STATUS_KEYS).describe("复测结果"),
  evidence_ref: z.string().optional().describe("still_present/fixed 必须引用本轮证据"),
  note: z.string().optional().describe("not_applicable 必须写理由"),
})

export function createWebsecSurfaceTools(store: Store, projectDir: string): Record<string, ToolDefinition> {
  const websec_surface = tool({
    description:
      "登记/补全资产与接口清单（surface 阶段）。可把 Edge 已采集证据同步为清单，也可补充源码路由或人工入口。" +
      "新增入口会自动创建必检类别的覆盖记录；后续必须用 websec_coverage 逐项收口。",
    args: {
      sync_edge: z.boolean().optional().describe("true=把 Edge/匿名/HTTP 证据同步为入口清单；可与其他 entries 同时使用"),
      entries: z.array(surfaceEntry).optional().describe("要登记的入口；可来自源码路由或人工补充"),
    },
    async execute(args, context) {
      let added: WebsecSurfaceEntry[] = []
      let total = 0
      let coverageCount = 0
      store.mutateWorkflow(context.sessionID, (workflow) => {
        const wf = requireWebsec(workflow)
        const state = ensureWebsec(wf)
        requireScope(state)
        const existing = state.surface ?? []
        const seed = args.sync_edge ? surfaceFromEvidence(state.evidence) : []
        const requested = (args.entries ?? []).map((item, index) => ({
          id: item.id ?? `surface-manual-${existing.length + seed.length + index + 1}`,
          method: item.method.toUpperCase(),
          endpoint: item.endpoint,
          source: item.source,
          identity: item.identity,
          params: item.params,
          requiresAuth: item.requires_auth,
          note: item.note,
          addedAt: Date.now(),
        }))
        const candidates = [...seed, ...requested]
        if (candidates.length === 0 && existing.length === 0) {
          throw new WorkflowOpError("没有可登记的入口：请传 entries，或先采集 Edge 证据后 sync_edge=true")
        }
        const usedIDs = new Set(existing.map((item) => item.id))
        for (const item of candidates) {
          if (!usedIDs.has(item.id)) {
            usedIDs.add(item.id)
            continue
          }
          let index = 1
          while (usedIDs.has(`surface-${index}`)) index += 1
          item.id = `surface-${index}`
          usedIDs.add(item.id)
        }
        const seen = new Set(existing.map((item) => websecEndpointKey(item.method, item.endpoint)))
        const addedEntries: WebsecSurfaceEntry[] = []
        for (const item of candidates) {
          const key = websecEndpointKey(item.method, item.endpoint)
          if (seen.has(key)) continue
          seen.add(key)
          addedEntries.push(item)
        }
        const surface = [...existing, ...addedEntries]
        const coverage = [...(state.coverage ?? [])]
        for (const item of surface) coverage.push(...seedCoverage(item, coverage))
        wf.websec = { ...state, surface, coverage }
        added = addedEntries
        total = surface.length
        coverageCount = coverage.length
      })
      return (
        `✅ 资产清单已更新：新增 ${added.length} 个，共 ${total} 个；覆盖记录共 ${coverageCount} 条。\n` +
        added
          .map((item) => `- ${item.id} | ${item.method} ${item.endpoint} | ${item.source}`)
          .join("\n") +
        `\n下一步：用 websec_coverage 逐项标记 tested/finding/not_applicable（not_applicable 必须写理由）。`
      )
    },
  })

  const websec_coverage = tool({
    description:
      "记录入口 × 检查类别的覆盖结果。tested/finding 必须引用已登记证据；not_applicable 必须写理由。" +
      "必检类别未收口时，checks 阶段不能完成，报告也不能提交。",
    args: {
      records: z.array(coverageRecord).min(1).max(200).describe("要写入的覆盖记录（按 surface_ref + category 覆盖更新）"),
    },
    async execute(args, context) {
      let count = 0
      store.mutateWorkflow(context.sessionID, (workflow) => {
        const wf = requireWebsec(workflow)
        const state = ensureWebsec(wf)
        const surfaces = state.surface ?? []
        if (surfaces.length === 0) {
          throw new WorkflowOpError("尚未建立入口清单：请先调用 websec_surface 登记或同步入口")
        }
        const evidenceIDs = new Set(state.evidence.map((item) => item.id))
        const coverage = [...(state.coverage ?? [])]
        for (const item of args.records) {
          if (!surfaces.some((surface) => surface.id === item.surface_ref)) {
            throw new WorkflowOpError(`入口不存在：${item.surface_ref}`)
          }
          if (item.status === "not_applicable" && !item.note?.trim()) {
            throw new WorkflowOpError(`${item.surface_ref}/${item.category} 标 not_applicable 必须写理由`)
          }
          if (item.status === "tested" || item.status === "finding") {
            if (!item.evidence_refs?.length) {
              throw new WorkflowOpError(`${item.surface_ref}/${item.category} 标 ${item.status} 必须提供 evidence_refs`)
            }
            const missing = item.evidence_refs.find((id) => !evidenceIDs.has(id))
            if (missing) throw new WorkflowOpError(`覆盖记录引用了不存在的证据：${missing}`)
          }
          const existing = coverage.find(
            (record) => record.surfaceRef === item.surface_ref && record.category === item.category,
          )
          const next: WebsecCoverageEntry = {
            id: existing?.id ?? `${item.surface_ref}:${item.category}`,
            surfaceRef: item.surface_ref,
            category: item.category,
            status: item.status,
            evidenceRefs: item.evidence_refs ?? [],
            note: item.note,
            checkedAt: Date.now(),
          }
          if (existing) Object.assign(existing, next)
          else coverage.push(next)
        }
        wf.websec = { ...state, coverage }
        count = coverage.length
      })
      return `✅ 覆盖矩阵已更新（共 ${count} 条记录）。下一步：收口所有必检类别后进入 verify。`
    },
  })

  const websec_regression = tool({
    description:
      "加载历史报告中的 finding 作为回归清单，或登记本轮复测结果。存在回归清单时，未复测项会阻止报告提交。",
    args: {
      action: z.enum(["load", "record"]).describe("load=扫描历史 report.json；record=登记本轮复测结果"),
      records: z.array(regressionRecord).optional().describe("record 必填：复测结果"),
    },
    async execute(args, context) {
      if (args.action === "load") {
        const workflow = requireWebsec(store.get(context.sessionID)?.workflow)
        const state = ensureWebsec(workflow)
        requireScope(state)
        const root = resolveEvidenceRoot(projectDir, state.scope?.evidenceDir)
        const currentDir = safeName(context.sessionID)
        const dirs = await readdir(root, { withFileTypes: true }).catch(() => [])
        const loaded: WebsecRegressionEntry[] = []
        for (const dir of dirs) {
          if (!dir.isDirectory() || dir.name === currentDir) continue
          const report = await Bun.file(join(root, dir.name, "report.json"))
            .json()
            .catch(() => null)
          const findings = report?.findings
          if (!Array.isArray(findings)) continue
          for (const finding of findings) {
            if (!finding || typeof finding !== "object") continue
            const item = finding as Record<string, unknown>
            if (typeof item.id !== "string" || typeof item.title !== "string") continue
            loaded.push({
              id: `reg-${safeName(dir.name)}-${safeName(item.id)}`,
              sourceSessionID: dir.name,
              sourceFindingID: item.id,
              title: item.title,
              endpoint: typeof item.endpoint === "string" ? item.endpoint : "未记录",
              severity: typeof item.severity === "string" ? (item.severity as WebsecRegressionEntry["severity"]) : "info",
              status: "not_retested",
            })
          }
        }
        let loadedCount = 0
        let regressionTotal = 0
        store.mutateWorkflow(context.sessionID, (wf) => {
          const wfState = ensureWebsec(requireWebsec(wf))
          const regression = mergeRegression(wfState.regression, loaded)
          wf.websec = { ...wfState, regression }
          loadedCount = loaded.length
          regressionTotal = regression.length
        })
        return loadedCount > 0
          ? `✅ 已加载 ${loadedCount} 条历史 finding（共 ${regressionTotal} 条回归任务）。请逐条复测并用 action=record 登记。`
          : `ℹ️ 未发现其它会话的历史 report.json；本轮无历史回归任务。`
      }

      if (!args.records?.length) {
        throw new WorkflowOpError("record 动作必须提供 records")
      }
      let regressionCount = 0
      store.mutateWorkflow(context.sessionID, (workflow) => {
        const wf = requireWebsec(workflow)
        const state = ensureWebsec(wf)
        const existing = state.regression ?? []
        const evidenceIDs = new Set(state.evidence.map((item) => item.id))
        if (existing.length === 0) {
          throw new WorkflowOpError("尚未加载历史 finding 回归清单：请先调用 websec_regression(action=load)")
        }
        for (const item of args.records!) {
          const id = item.id ?? `reg-${safeName(item.source_session_id)}-${safeName(item.source_finding_id)}`
          const target = existing.find((record) => record.id === id)
          if (!target) throw new WorkflowOpError(`回归任务不存在：${id}；请先 load`)
          if (item.status === "not_applicable" && !item.note?.trim()) {
            throw new WorkflowOpError(`${id} 标 not_applicable 必须写理由`)
          }
          if ((item.status === "still_present" || item.status === "fixed") && !item.evidence_ref) {
            throw new WorkflowOpError(`${id} 标 ${item.status} 必须提供 evidence_ref`)
          }
          if (item.evidence_ref && !evidenceIDs.has(item.evidence_ref)) {
            throw new WorkflowOpError(`${id} 引用了不存在的证据：${item.evidence_ref}`)
          }
          target.status = item.status
          target.evidenceRef = item.evidence_ref
          target.note = item.note
          target.checkedAt = Date.now()
        }
        wf.websec = { ...state, regression: existing }
        regressionCount = existing.length
      })
      return `✅ 回归结果已登记（共 ${regressionCount} 条任务）。`
    },
  })

  return { websec_surface, websec_coverage, websec_regression }
}
