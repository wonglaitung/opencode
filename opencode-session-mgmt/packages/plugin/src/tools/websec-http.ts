/**
 * websec 只读配置探测 + 显式授权的单次写探测。
 * 所有请求都限制在 scope 同源，且 URL 必须已在入口清单或证据中出现。
 */
import { createHash } from "node:crypto"
import { join } from "node:path"
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import {
  WEBSEC_CHECK_CATEGORY_KEYS,
  type WebsecCoverageEntry,
  type WebsecEvidence,
  type WebsecState,
  type WebsecSurfaceEntry,
  type WorkflowState,
} from "sm-shared"
import type { Store } from "../db"
import { WorkflowOpError } from "../workflow-ops"
import { ensureEvidenceGitignore, evidenceSessionDir, resolveEvidenceRoot, safeName, writeEvidenceFile } from "./websec-paths"
import { safeResponseHeaders } from "./websec-headers"
import { seedCoverage, websecEndpointKey } from "./websec-state"

const z = tool.schema

const MAX_BODY = 1_000_000

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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

function pathOf(value: string): string {
  try {
    return new URL(value, "http://websec.local").pathname.replace(/\/+$/, "") || "/"
  } catch {
    return value.split("?")[0]?.replace(/\/+$/, "") || "/"
  }
}

function resolveEndpoint(target: string, endpoint: string): string | null {
  try {
    const base = new URL(target)
    return new URL(endpoint, base).toString()
  } catch {
    return null
  }
}

function allowedPaths(state: WebsecState): Set<string> {
  const paths = new Set<string>()
  for (const surface of state.surface ?? []) paths.add(pathOf(surface.endpoint))
  for (const item of state.evidence) paths.add(pathOf(item.url))
  return paths
}

function candidates(state: WebsecState): Array<{ url: string; surface?: WebsecSurfaceEntry }> {
  const target = state.scope?.target
  if (!target) return []
  const result = new Map<string, { url: string; surface?: WebsecSurfaceEntry }>()
  for (const surface of state.surface ?? []) {
    const url = resolveEndpoint(target, surface.endpoint)
    if (url) result.set(websecEndpointKey("GET", url), { url, surface })
  }
  for (const item of state.evidence) {
    if (originOf(item.url) !== originOf(target)) continue
    const key = websecEndpointKey("GET", item.url)
    const existing = result.get(key)
    if (!existing) result.set(key, { url: item.url })
  }
  return [...result.values()]
}

function mergeCoverage(
  state: WebsecState,
  surface: WebsecSurfaceEntry,
  categories: Array<(typeof WEBSEC_CHECK_CATEGORY_KEYS)[number]>,
  evidenceRefs: string[],
): WebsecCoverageEntry[] {
  const coverage = [...(state.coverage ?? [])]
  for (const item of seedCoverage(surface, coverage)) coverage.push(item)
  for (const category of categories) {
    const record = coverage.find((item) => item.surfaceRef === surface.id && item.category === category)
    if (!record) continue
    record.status = "tested"
    record.evidenceRefs = evidenceRefs
    record.checkedAt = Date.now()
    record.note = "只读配置探测自动登记；如有发现请改为 finding"
  }
  return coverage
}

function missingHeaderNotes(headers: Record<string, string>): string[] {
  const notes: string[] = []
  if (!headers["content-security-policy"]) notes.push("缺 CSP")
  if (!headers["x-frame-options"] && !headers["content-security-policy"]) notes.push("缺 X-Frame-Options")
  if (!headers["x-content-type-options"]) notes.push("缺 X-Content-Type-Options")
  if (!headers["referrer-policy"]) notes.push("缺 Referrer-Policy")
  if (headers["x-powered-by"]) notes.push(`暴露 x-powered-by=${headers["x-powered-by"]}`)
  return notes
}

export function createWebsecHttpTools(
  store: Store,
  projectDir: string,
  fetchImpl: typeof fetch = fetch,
): Record<string, ToolDefinition> {
  const websec_config_check = tool({
    description:
      "只读配置检查：对入口清单/证据中的同源 URL 发无 Cookie GET 与 OPTIONS，采集 CORS、安全响应头与方法允许情况。" +
      "不发写操作；需开发者明确授权。结果自动写入 cors/headers/options 覆盖记录。",
    args: {
      urls: z.array(z.string().url()).max(50).optional().describe("要检查的 URL；缺省从入口清单和证据推导"),
      include_options: z.boolean().optional().describe("是否发 OPTIONS 预检，默认 true"),
      origin: z.string().url().optional().describe("CORS 探测使用的 Origin，默认 https://evil.example"),
      limit: z.number().int().min(1).max(50).optional().describe("最多检查的 URL 数，默认 20"),
      developer_confirmed: z.boolean().describe("必须为 true，表示开发者已授权只读配置探测"),
    },
    async execute(args, context) {
      if (args.developer_confirmed !== true) {
        throw new WorkflowOpError("配置检查需要开发者明确授权：developer_confirmed 必须为 true")
      }
      const workflow = requireWebsec(store.get(context.sessionID)?.workflow)
      const state = ensureWebsec(workflow)
      requireScope(state)
      const target = state.scope!.target
      const targetOrigin = originOf(target)
      if (!targetOrigin) throw new WorkflowOpError("scope.target 不是合法 URL，无法限制配置探测范围")
      const allowed = allowedPaths(state)
      const requested =
        args.urls?.map((url) => ({
          url,
          surface: state.surface?.find((surface) => pathOf(surface.endpoint) === pathOf(url)),
        })) ?? candidates(state)
      const unique = new Map<string, { url: string; surface?: WebsecSurfaceEntry }>()
      for (const item of requested) {
        const origin = originOf(item.url)
        if (!origin || origin !== targetOrigin) throw new WorkflowOpError(`配置检查只能访问 scope 同源地址：${item.url}`)
        if (!allowed.has(pathOf(item.url))) {
          throw new WorkflowOpError(`配置检查只能访问已登记入口或证据端点：${item.url}`)
        }
        unique.set(websecEndpointKey("GET", item.url), item)
      }
      const targets = [...unique.values()].slice(0, args.limit ?? 20)
      if (targets.length === 0) return "ℹ️ 没有可检查的同源入口：请先用 websec_surface 登记入口。"

      const evidenceRoot = resolveEvidenceRoot(projectDir, state.scope?.evidenceDir)
      const evidenceDir = evidenceSessionDir(projectDir, state.scope?.evidenceDir, context.sessionID)
      await ensureEvidenceGitignore(evidenceRoot)
      const origin = args.origin ?? "https://evil.example"
      const includeOptions = args.include_options !== false
      const captured: WebsecEvidence[] = []
      const coverageUpdates: Array<{ surface: WebsecSurfaceEntry; categories: Array<(typeof WEBSEC_CHECK_CATEGORY_KEYS)[number]>; refs: string[] }> = []
      const lines: string[] = []
      for (const [index, item] of targets.entries()) {
        const getResponse = await fetchImpl(item.url, {
          method: "GET",
          headers: { Origin: origin },
          redirect: "manual",
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        })
        const getBody = (await getResponse.text()).slice(0, MAX_BODY)
        const getHeaders = safeResponseHeaders(getResponse.headers)
        const getID = `http-check-${Date.now()}-${index + 1}-get`
        const getFile = join(evidenceDir, `${Date.now()}-http-${index + 1}-get-${safeName(item.url)}.txt`)
        await writeEvidenceFile(getFile, getBody)
        captured.push({
          id: getID,
          url: item.url,
          method: "GET",
          identity: "anonymous",
          phase: "anonymous",
          source: "http-check",
          capturedAt: Date.now(),
          hash: sha256(getBody),
          localPath: getFile,
          note: `只读配置探测 GET（Origin=${origin}）`,
          status: getResponse.status,
          mimeType: getResponse.headers.get("content-type") ?? undefined,
          responseHeaders: getHeaders,
          bodyPresent: getBody.length > 0,
        })
        const notes = missingHeaderNotes(getHeaders)
        const cors = getHeaders["access-control-allow-origin"]
        if (cors === "*" || cors === origin) notes.push(`CORS 允许 ${cors}`)
        if (getHeaders["access-control-allow-credentials"] === "true" && cors === "*") {
          notes.push("CORS 通配且允许凭据")
        }
        lines.push(`- [${getResponse.status}] GET ${item.url} | CORS ${cors ?? "无"}${notes.length ? ` | ${notes.join("；")}` : ""}`)

        const refs = [getID]
        const categories: Array<(typeof WEBSEC_CHECK_CATEGORY_KEYS)[number]> = ["cors", "headers"]
        if (includeOptions) {
          const optionsResponse = await fetchImpl(item.url, {
            method: "OPTIONS",
            headers: {
              Origin: origin,
              "Access-Control-Request-Method": "GET",
            },
            redirect: "manual",
            cache: "no-store",
            signal: AbortSignal.timeout(10_000),
          })
          const optionsBody = (await optionsResponse.text()).slice(0, MAX_BODY)
          const optionsHeaders = safeResponseHeaders(optionsResponse.headers)
          const optionsID = `http-check-${Date.now()}-${index + 1}-options`
          const optionsFile = join(evidenceDir, `${Date.now()}-http-${index + 1}-options-${safeName(item.url)}.txt`)
          await writeEvidenceFile(optionsFile, optionsBody)
          captured.push({
            id: optionsID,
            url: item.url,
            method: "OPTIONS",
            identity: "anonymous",
            phase: "anonymous",
            source: "http-check",
            capturedAt: Date.now(),
            hash: sha256(optionsBody),
            localPath: optionsFile,
            note: `只读配置探测 OPTIONS（Origin=${origin}）`,
            status: optionsResponse.status,
            mimeType: optionsResponse.headers.get("content-type") ?? undefined,
            responseHeaders: optionsHeaders,
            bodyPresent: optionsBody.length > 0,
          })
          refs.push(optionsID)
          categories.push("options")
          const methods = optionsHeaders["access-control-allow-methods"] ?? optionsHeaders["allow"] ?? "未返回"
          lines.push(`- [${optionsResponse.status}] OPTIONS ${item.url} | 方法 ${methods}`)
        }
        if (item.surface) coverageUpdates.push({ surface: item.surface, categories, refs })
      }

      const saved = store.mutateWorkflow(context.sessionID, (wf) => {
        const wfState = ensureWebsec(requireWebsec(wf))
        const ids = new Set(wfState.evidence.map((item) => item.id))
        let coverage = [...(wfState.coverage ?? [])]
        for (const update of coverageUpdates) {
          coverage = mergeCoverage({ ...wfState, coverage }, update.surface, update.categories, update.refs)
        }
        wf.websec = {
          ...wfState,
          evidence: [...wfState.evidence, ...captured.filter((item) => !ids.has(item.id))],
          coverage,
        }
      })
      const total = saved.websec?.evidence.length ?? 0
      return (
        `✅ 只读配置检查完成：${targets.length} 个入口，新增 ${captured.length} 条证据（本地共 ${total} 条）。\n` +
        `${lines.join("\n")}\n证据目录：${evidenceDir}\n` +
        `请把确认的 CORS/安全头/OPTIONS 问题写入 finding，并用 websec_coverage 把对应类别标为 finding。`
      )
    },
  })

  const websec_write_probe = tool({
    description:
      "显式授权的单次写探测：对已登记入口发一次无 Cookie POST/PUT/PATCH，检查服务端是否拒绝未授权写。" +
      "仅用于可丢弃测试数据；不发 DELETE，不做批量/爆破；必须逐次授权并写明影响。",
    args: {
      url: z.string().url().describe("同源且已登记入口/证据的 URL"),
      method: z.enum(["POST", "PUT", "PATCH"]).describe("写方法；不支持 DELETE"),
      body: z.string().max(10_000).optional().describe("可选请求体；不要放真实用户数据"),
      authorization_note: z.string().min(1).describe("开发者授权说明与可丢弃数据说明"),
      developer_confirmed: z.boolean().describe("必须为 true，表示开发者已逐次授权这次写操作"),
    },
    async execute(args, context) {
      if (args.developer_confirmed !== true) {
        throw new WorkflowOpError("写探测需要开发者逐次明确授权：developer_confirmed 必须为 true")
      }
      if (!args.authorization_note.trim()) {
        throw new WorkflowOpError("写探测必须写明授权说明与可丢弃数据说明")
      }
      const workflow = requireWebsec(store.get(context.sessionID)?.workflow)
      const state = ensureWebsec(workflow)
      requireScope(state)
      const targetOrigin = originOf(state.scope!.target)
      if (!targetOrigin || originOf(args.url) !== targetOrigin) {
        throw new WorkflowOpError("写探测只能访问 scope 同源地址")
      }
      if (!allowedPaths(state).has(pathOf(args.url))) {
        throw new WorkflowOpError("写探测只能访问已登记入口或证据端点；请先用 websec_surface 登记")
      }
      const response = await fetchImpl(args.url, {
        method: args.method,
        headers: args.body ? { "content-type": "application/json" } : undefined,
        body: args.body,
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      })
      const body = (await response.text()).slice(0, MAX_BODY)
      const headers = safeResponseHeaders(response.headers)
      const evidenceID = `write-probe-${Date.now()}`
      const evidenceRoot = resolveEvidenceRoot(projectDir, state.scope?.evidenceDir)
      const evidenceDir = evidenceSessionDir(projectDir, state.scope?.evidenceDir, context.sessionID)
      await ensureEvidenceGitignore(evidenceRoot)
      const file = join(evidenceDir, `${Date.now()}-write-probe-${safeName(args.url)}.txt`)
      await writeEvidenceFile(file, body)
      const evidence: WebsecEvidence = {
        id: evidenceID,
        url: args.url,
        method: args.method,
        identity: "anonymous",
        phase: "anonymous",
        source: "write-probe",
        capturedAt: Date.now(),
        hash: sha256(body),
        localPath: file,
        note: `显式授权写探测：${args.authorization_note}`,
        status: response.status,
        mimeType: response.headers.get("content-type") ?? undefined,
        responseHeaders: headers,
        bodyPresent: body.length > 0,
      }
      store.mutateWorkflow(context.sessionID, (wf) => {
        const wfState = ensureWebsec(requireWebsec(wf))
        wf.websec = {
          ...wfState,
          writeAuthorization: { note: args.authorization_note, confirmedAt: Date.now() },
          evidence: [...wfState.evidence, evidence],
        }
      })
      const risky = response.status >= 200 && response.status < 300
      return (
        `⚠ 写探测已执行一次：[${response.status}] ${args.method} ${args.url} → ${evidenceID}\n` +
        (risky
          ? "2xx 说明服务端可能未拦截未授权写；请确认数据影响，并用 websec_coverage 标 finding。"
          : "响应非 2xx；请结合正文判断是否被鉴权/校验拒绝。") +
        `\n授权记录已保存，本地证据：${file}\n` +
        `如产生测试数据，请按授权说明清理；不要重复跑批量写。`
      )
    },
  })

  return { websec_config_check, websec_write_probe }
}
