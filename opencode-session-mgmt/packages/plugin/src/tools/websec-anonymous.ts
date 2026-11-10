/**
 * websec 匿名只读探测：基于 Edge 走查发现的 GET/HEAD 端点，使用无 Cookie 请求检查匿名暴露。
 * 不重放写操作，不要求用户在匿名状态下重新走完整页面。
 */
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { createHash } from "node:crypto"
import type { WebsecEvidence, WorkflowState } from "sm-shared"
import type { Store } from "../db"
import { WorkflowOpError } from "../workflow-ops"
import { safeResponseHeaders } from "./websec-headers"
import { ensureEvidenceGitignore, evidenceSessionDir, resolveEvidenceRoot, safeName, writeEvidenceFile } from "./websec-paths"

const z = tool.schema

function requireWebsec(workflow: WorkflowState | null | undefined): WorkflowState {
  if (!workflow || workflow.type !== "websec") {
    throw new WorkflowOpError("该工具仅适用于 WEB 安全测试工作流")
  }
  if (!workflow.websec?.scope) {
    throw new WorkflowOpError("尚未记录测试范围与边界：请先调用 websec_scope")
  }
  return workflow
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

type ProbeTarget = { url: string; method: "GET" | "HEAD" }

export function createWebsecAnonymousTool(
  store: Store,
  projectDir: string,
  fetchImpl: typeof fetch = fetch,
): Record<string, ToolDefinition> {
  const websec_anonymous_probe = tool({
    description:
      "匿名只读探测：对 Edge 走查发现的 GET/HEAD 端点发送无 Cookie 请求，检查未登录访问是否被正确拒绝。" +
      "只发 GET/HEAD，不发写操作；需开发者明确授权。基于已捕获端点，不要求用户匿名重走完整页面。",
    args: {
      urls: z.array(z.string().url()).max(50).optional().describe("要探测的 URL；缺省从 Edge 证据中的 GET/HEAD 端点推导"),
      url_contains: z.string().optional().describe("只探测 URL 包含该字符串的端点"),
      limit: z.number().int().min(1).max(50).optional().describe("最多探测条数，默认 20"),
      developer_confirmed: z.boolean().describe("必须为 true，表示开发者已授权匿名只读探测"),
    },
    async execute(args, context) {
      if (args.developer_confirmed !== true) {
        throw new WorkflowOpError("匿名探测需要开发者明确授权：developer_confirmed 必须为 true")
      }
      const workflow = requireWebsec(store.get(context.sessionID)?.workflow)
      const scope = workflow.websec!.scope!
      const targetOrigin = originOf(scope.target)
      if (!targetOrigin) throw new WorkflowOpError("scope.target 不是合法 URL，无法限制匿名探测范围")

      const fromEvidence: ProbeTarget[] = workflow.websec!.evidence
        .filter((item) => item.source === "edge" && (item.method === "GET" || item.method === "HEAD"))
        .map((item) => ({ url: item.url, method: item.method as "GET" | "HEAD" }))
      const requested: ProbeTarget[] = args.urls
        ? args.urls.map((url) => ({ url, method: "GET" as const }))
        : fromEvidence
      const capturedUrls = new Set(fromEvidence.map((item) => item.url))
      const unique = new Map<string, ProbeTarget>()
      for (const item of requested) {
        if (args.url_contains && !item.url.includes(args.url_contains)) continue
        const origin = originOf(item.url)
        if (!origin || origin !== targetOrigin) {
          throw new WorkflowOpError(`匿名探测只能访问 scope.target 同源地址：${item.url}`)
        }
        if (!capturedUrls.has(item.url)) {
          throw new WorkflowOpError(`匿名探测只能访问 Edge 已捕获的端点：${item.url}`)
        }
        unique.set(`${item.method} ${item.url}`, item)
      }
      const targets = [...unique.values()].slice(0, args.limit ?? 20)
      if (targets.length === 0) {
        return "ℹ️ 没有可匿名探测的 GET/HEAD 端点：本轮跳过匿名覆盖，请在报告 limitations 写明。"
      }

      const evidenceRoot = resolveEvidenceRoot(projectDir, scope.evidenceDir)
      const evidenceDir = evidenceSessionDir(projectDir, scope.evidenceDir, context.sessionID)
      await ensureEvidenceGitignore(evidenceRoot)

      const captured: WebsecEvidence[] = []
      const lines: string[] = []
      for (const [index, target] of targets.entries()) {
        const response = await fetchImpl(target.url, {
          method: target.method,
          redirect: "manual",
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        })
        const body = target.method === "HEAD" ? "" : (await response.text()).slice(0, 1_000_000)
        const file = `${evidenceDir}/${Date.now()}-anon-${index + 1}-${safeName(target.url)}.txt`
        await writeEvidenceFile(file, body)
        const evidence: WebsecEvidence = {
          id: `anon-${Date.now()}-${index + 1}`,
          url: target.url,
          method: target.method,
          identity: "anonymous",
          phase: "anonymous",
          source: "anonymous-probe",
          capturedAt: Date.now(),
          hash: sha256(body),
          localPath: file,
          note: "无 Cookie 匿名只读探测",
          status: response.status,
          mimeType: response.headers.get("content-type") ?? undefined,
          responseHeaders: safeResponseHeaders(response.headers),
          bodyPresent: target.method !== "HEAD" && body.length > 0,
        }
        captured.push(evidence)
        lines.push(`- [${response.status}] ${target.method} ${target.url} → ${evidence.id}`)
      }

      const saved = store.mutateWorkflow(context.sessionID, (wf) => {
        requireWebsec(wf)
        const base = wf.websec!
        const ids = new Set(base.evidence.map((item) => item.id))
        wf.websec = { ...base, evidence: [...base.evidence, ...captured.filter((item) => !ids.has(item.id))] }
      })
      const exposed = captured.filter((item) => item.status !== undefined && item.status < 400).length
      return (
        `✅ 匿名只读探测完成：${captured.length} 条（${exposed} 条匿名可访问）\n` +
        `${lines.join("\n")}\n证据目录：${evidenceDir}\n` +
        `请重点复核匿名 2xx/3xx 响应，并把未授权访问写入 finding；写操作仍未覆盖。`
      )
    },
  })

  return { websec_anonymous_probe }
}
