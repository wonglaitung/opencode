/**
 * websec ↔ edge-debug-core 薄桥接。
 *
 * 模式化自测：
 * - normal：单账号操作一次，capture(single) → finish → 报告
 * - authz：普通账号 baseline → switch_identity → 高权账号 privileged → finish → 对比 → 报告
 *
 * 证据正文落本地并计算哈希；工具只回摘要，不把正文贴进对话。
 */
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import {
  disposeEdgeDebugController,
  getEdgeDebugController,
  shouldCaptureBody,
  WEBSEC_CAPTURE_POLICY,
  type EdgeDebugController,
  type NetworkCapturePolicy,
  type NetworkDetail,
} from "edge-debug-core"
import type { WebsecEvidence, WebsecPhase, WorkflowState } from "sm-shared"
import type { Store } from "../db"
import { WorkflowOpError } from "../workflow-ops"

const z = tool.schema

type EdgeLike = Pick<
  EdgeDebugController,
  | "start"
  | "stop"
  | "networkLogs"
  | "responseDetailData"
  | "setCapturePolicy"
  | "clearSession"
  | "clearNetworkLogs"
  | "isRunning"
>

function requireWebsec(workflow: WorkflowState | null | undefined): WorkflowState {
  if (!workflow || workflow.type !== "websec") {
    throw new WorkflowOpError("该工具仅适用于 WEB 安全测试工作流")
  }
  return workflow
}

function requireScope(workflow: WorkflowState): void {
  if (!workflow.websec?.scope) {
    throw new WorkflowOpError("尚未记录测试范围与边界：请先调用 websec_scope")
  }
}

function requireStarted(workflow: WorkflowState): void {
  if (!workflow.websec?.edge?.started) {
    throw new WorkflowOpError("Edge 会话尚未启动：请先调用 websec_edge_capture(start, mode=...)")
  }
  if (workflow.websec.edge.finished) {
    throw new WorkflowOpError("本次 Edge 会话已完成：请直接生成报告；如需新一轮请开新会话")
  }
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "evidence"
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

function capturePolicyFor(workflow: WorkflowState): NetworkCapturePolicy {
  const target = workflow.websec?.scope?.target
  let origins: string[] | undefined
  if (target) {
    try {
      origins = [new URL(target).origin]
    } catch {
      origins = undefined
    }
  }
  return { ...WEBSEC_CAPTURE_POLICY, origins }
}

function modeLabel(mode: "normal" | "authz"): string {
  return mode === "authz" ? "越权测试" : "普通测试"
}

/** 解析项目内证据根目录；拒绝绝对路径与越界。 */
function resolveEvidenceRoot(projectDir: string, configured: string | undefined): string {
  const root = resolve(projectDir)
  const rel = configured ?? "websec-evidence"
  if (isAbsolute(rel) || rel.split(/[\\/]+/).some((part) => part === "." || part === "..")) {
    throw new WorkflowOpError("evidence_dir 必须是项目内相对路径")
  }
  const resolved = resolve(root, rel)
  const check = relative(root, resolved)
  if (check.startsWith("..") || isAbsolute(check) || check === "") {
    throw new WorkflowOpError("evidence_dir 不能跳出项目目录")
  }
  return resolved
}

async function ensureEvidenceGitignore(root: string): Promise<void> {
  try {
    await writeFile(join(root, ".gitignore"), "*\n!.gitignore\n", { encoding: "utf8", flag: "wx" })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
}

function phaseLabel(phase: WebsecPhase): string {
  if (phase === "baseline") return "baseline（普通账号）"
  if (phase === "privileged") return "privileged（高权账号）"
  return "single（普通测试）"
}

function endpointKey(ev: WebsecEvidence): string {
  try {
    const u = new URL(ev.url)
    const path = u.pathname
      .replace(/\/\d+(?=\/|$)/g, "/:id")
      .replace(/\/[0-9a-f-]{8,}(?=\/|$)/gi, "/:id")
    return `${ev.method.toUpperCase()} ${u.origin}${path}`
  } catch {
    return `${ev.method.toUpperCase()} ${ev.url}`
  }
}

/** 插件卸载时兜底关闭 websec 启动的 Edge（共享 controller）。 */
export async function disposeWebsecEdge(projectDir: string): Promise<boolean> {
  try {
    return await disposeEdgeDebugController(projectDir)
  } catch {
    return false
  }
}

export function createWebsecEdgeTools(
  store: Store,
  projectDir: string,
  controllerFactory: () => EdgeLike = () => getEdgeDebugController(projectDir),
): Record<string, ToolDefinition> {
  const websec_edge_capture = tool({
    description:
      "通过 Edge/CDP 进行模式化安全自测。开始前先问用户：普通测试还是越权测试，然后 start(mode)。" +
      "normal：用户操作后 capture；authz：普通账号 capture(baseline) → switch_identity → 高权账号 capture(privileged)。" +
      "用户说完成后调用 finish，再生成报告。正文落本地，只返回摘要。需先记录 websec_scope。",
    args: {
      action: z
        .enum(["start", "capture", "switch_identity", "finish", "stop"])
        .describe("start=启动；capture=采集；switch_identity=清登录态；finish=确认完成；stop=关闭"),
      mode: z.enum(["normal", "authz"]).optional().describe("start 必填：normal=普通测试；authz=越权测试"),
      url: z.string().url().optional().describe("start 的目标地址；缺省使用 scope 中记录的 target"),
      phase: z
        .enum(["single", "baseline", "privileged"])
        .optional()
        .describe("capture 阶段：normal 用 single；authz 用 baseline/privileged"),
      identity: z.string().optional().describe("capture 的身份标签；authz 必填，如 u1/user、admin/admin"),
      url_contains: z.string().optional().describe("只采集 URL 包含该字符串的条目"),
      limit: z.number().int().min(1).max(50).optional().describe("本次最多采集条数，默认 20"),
      note: z.string().optional().describe("证据备注"),
    },
    async execute(args, context) {
      const workflow = requireWebsec(store.get(context.sessionID)?.workflow)
      const controller = controllerFactory()
      const policy = capturePolicyFor(workflow)

      if (args.action === "stop") {
        const closed = await controller.stop()
        const note =
          workflow.websec?.edge?.started && !workflow.websec.edge.finished
            ? "；本次 Edge 会话尚未 finish，报告仍会被门禁拦截"
            : ""
        return closed ? `🛑 Edge 已关闭，调试监听已停止${note}。` : "ℹ️ Edge 未在运行，无需关闭。"
      }

      requireScope(workflow)

      if (args.action === "start") {
        if (!args.mode) {
          throw new WorkflowOpError("启动 Edge 前必须先问用户：这次是普通测试，还是越权测试？")
        }
        if (workflow.websec?.edge?.finished) {
          throw new WorkflowOpError("本次 Edge 会话已完成：请直接生成报告；如需新一轮请开新会话")
        }
        const currentMode = workflow.websec?.testMode
        if (currentMode && currentMode !== args.mode) {
          throw new WorkflowOpError(
            `本次会话模式已定为「${modeLabel(currentMode)}」，不能中途切换；请开新会话再选另一种模式。`,
          )
        }
        if (args.mode === "authz") {
          const accounts = workflow.websec?.scope?.accounts ?? []
          const roles = new Set(accounts.map((item) => item.role))
          if (accounts.length < 2 || roles.size < 2) {
            throw new WorkflowOpError("越权测试需要至少两个不同角色的账号（普通 + 高权）：请先补充 websec_scope")
          }
        }
        const url = args.url ?? workflow.websec?.scope?.target
        if (!url) throw new WorkflowOpError("缺少目标地址：请在 scope 中记录 target 或传 url")
        controller.setCapturePolicy(policy)
        const message = await controller.start(url)
        const saved = store.mutateWorkflow(context.sessionID, (wf) => {
          requireWebsec(wf)
          const base = wf.websec ?? { evidence: [] }
          wf.websec = {
            ...base,
            testMode: args.mode,
            edge: {
              started: true,
              finished: base.edge?.finished ?? false,
              startedAt: base.edge?.startedAt ?? Date.now(),
              finishedAt: base.edge?.finishedAt,
            },
          }
        })
        return `${message}\n本次模式：${modeLabel(saved.websec!.testMode!)}。${
          args.mode === "authz"
            ? "请先用普通账号登录并操作，完成后说「普通账号完成」。"
            : "请登录并操作，完成后说「完成」。"
        }`
      }

      if (!workflow.websec?.testMode) {
        throw new WorkflowOpError("尚未选择测试模式：请先 start(mode=normal|authz)")
      }
      if (args.action === "finish" && workflow.websec.edge?.finished) {
        return "✅ 采集已完成，请直接生成报告并提交 review_submit。"
      }
      requireStarted(workflow)
      controller.setCapturePolicy(policy)

      if (args.action === "switch_identity") {
        if (workflow.websec.testMode !== "authz") {
          throw new WorkflowOpError("switch_identity 仅用于越权测试")
        }
        const existing = new Set(workflow.websec.evidence.map((item) => item.id))
        const uncaptured = controller
          .networkLogs()
          .filter(
            (entry) =>
              !existing.has(`edge-baseline-${entry.requestId}`) &&
              (entry.status >= 400 || shouldCaptureBody(entry, policy)),
          )
        if (uncaptured.length > 0) {
          throw new WorkflowOpError(
            `还有 ${uncaptured.length} 条 baseline 网络日志未采集：请先 capture(phase=baseline) 再切换身份`,
          )
        }
        controller.clearNetworkLogs()
        const message = await controller.clearSession()
        return `${message}\n请用高权账号登录并走与普通账号相同的流程，完成后说「高权账号完成」。`
      }

      if (args.action === "finish") {
        const evidence = workflow.websec.evidence
        const has = (phase: WebsecPhase) => evidence.some((item) => item.phase === phase)
        if (workflow.websec.testMode === "normal") {
          if (!has("single")) {
            throw new WorkflowOpError("还没有采集到普通测试证据：请先 capture(phase=single)")
          }
        } else {
          const missing: string[] = []
          if (!has("baseline")) missing.push("baseline（普通账号）")
          if (!has("privileged")) missing.push("privileged（高权账号）")
          if (missing.length > 0) {
            throw new WorkflowOpError(`越权测试阶段未完成，缺少：${missing.join("、")}`)
          }
        }
        const saved = store.mutateWorkflow(context.sessionID, (wf) => {
          requireWebsec(wf)
          const base = wf.websec ?? { evidence: [] }
          wf.websec = {
            ...base,
            edge: { started: true, finished: true, startedAt: base.edge?.startedAt, finishedAt: Date.now() },
          }
        })
        const counts = {
          single: saved.websec!.evidence.filter((item) => item.phase === "single").length,
          baseline: saved.websec!.evidence.filter((item) => item.phase === "baseline").length,
          privileged: saved.websec!.evidence.filter((item) => item.phase === "privileged").length,
        }
        const detail =
          saved.websec!.testMode === "authz"
            ? `baseline ${counts.baseline} 条 / privileged ${counts.privileged} 条`
            : `single ${counts.single} 条`
        return `✅ 采集完成（${detail}）。下一步：${
          saved.websec!.testMode === "authz" ? "调用 websec_authz_compare 对比两组证据，" : ""
        }生成报告并提交 review_submit。`
      }

      // capture
      const mode = workflow.websec.testMode
      let phase: WebsecPhase
      if (mode === "normal") {
        phase = "single"
        if (args.phase && args.phase !== "single") {
          throw new WorkflowOpError("普通测试只能使用 phase=single")
        }
      } else {
        if (args.phase !== "baseline" && args.phase !== "privileged") {
          throw new WorkflowOpError("越权测试 capture 必须指定 phase=baseline 或 phase=privileged")
        }
        phase = args.phase
        if (!args.identity) {
          throw new WorkflowOpError("越权测试 capture 必须提供 identity（普通/高权账号标签）")
        }
      }

      const logs = controller.networkLogs()
      if (logs.length === 0) {
        return "当前没有可采集的网络条目：请确认已 start，并让用户在页面中登录/操作后再 capture。"
      }

      const existing = new Set((workflow.websec.evidence ?? []).map((item) => item.id))
      const limit = args.limit ?? 20
      const candidates = logs
        .filter((entry) => {
          if (args.url_contains && !entry.url.includes(args.url_contains)) return false
          return !existing.has(`edge-${phase}-${entry.requestId}`)
        })
        .slice(0, limit)

      if (candidates.length === 0) {
        return `没有新的可采集条目（当前已有 ${existing.size} 条证据）。`
      }

      const evidenceRoot = resolveEvidenceRoot(projectDir, workflow.websec.scope?.evidenceDir)
      const evidenceDir = join(evidenceRoot, safeName(context.sessionID))
      await mkdir(evidenceDir, { recursive: true })
      await ensureEvidenceGitignore(evidenceRoot)

      const captured: WebsecEvidence[] = []
      const lines: string[] = []
      let bodyFailed = 0
      let bodySkipped = 0

      for (const entry of candidates) {
        let detail: NetworkDetail | null = null
        let bodyNote: string | undefined
        if (shouldCaptureBody(entry, policy)) {
          try {
            detail = await controller.responseDetailData(entry.requestId)
          } catch {
            bodyFailed += 1
            bodyNote = "响应体获取失败，仅记录元数据"
          }
        } else {
          bodySkipped += 1
          bodyNote = "未拉取正文（脚本/静态资源），仅记录元数据"
        }
        const raw = detail
          ? detail.base64Encoded
            ? `base64:${detail.body}`
            : detail.body
          : JSON.stringify(
              {
                time: entry.time,
                method: entry.method,
                url: entry.url,
                status: entry.status,
                mimeType: entry.mimeType,
                resourceType: entry.resourceType,
                requestHeaders: entry.requestHeaders ?? {},
                responseHeaders: entry.responseHeaders ?? {},
                postData: entry.postData,
              },
              null,
              2,
            )
        const hash = sha256(raw)
        const file = join(
          evidenceDir,
          `${Date.now()}-${safeName(entry.requestId)}.${detail?.base64Encoded ? "b64" : "txt"}`,
        )
        await writeFile(file, raw, { encoding: "utf8", mode: 0o600 })
        const note =
          [args.note, bodyNote, detail?.base64Encoded ? "base64" : undefined]
            .filter(Boolean)
            .join("；") || undefined
        const bodyPresent = detail !== null && (detail.body.length > 0 || detail.base64Encoded)
        captured.push({
          id: `edge-${phase}-${entry.requestId}`,
          url: entry.url,
          method: entry.method,
          identity: args.identity,
          phase,
          capturedAt: Date.now(),
          hash,
          localPath: file,
          note,
          status: entry.status,
          mimeType: entry.mimeType,
          resourceType: entry.resourceType,
          bodyPresent,
        })
        lines.push(`- [${entry.status}] ${entry.method} ${entry.url} → edge-${phase}-${entry.requestId}`)
      }

      const saved = store.mutateWorkflow(context.sessionID, (wf) => {
        requireWebsec(wf)
        const base = wf.websec ?? { evidence: [] }
        const ids = new Set(base.evidence.map((item) => item.id))
        wf.websec = {
          ...base,
          evidence: [...base.evidence, ...captured.filter((item) => !ids.has(item.id))],
        }
      })
      const total = saved.websec?.evidence.length ?? 0

      return (
        `✅ 已采集 ${captured.length} 条 ${phaseLabel(phase)} 证据（本地共 ${total} 条）` +
        (bodyFailed > 0 ? `；${bodyFailed} 条响应体获取失败，已记录元数据` : "") +
        (bodySkipped > 0 ? `；${bodySkipped} 条仅记录元数据（脚本/静态资源）` : "") +
        `\n${lines.join("\n")}\n正文目录：${evidenceDir}\n提示：对话中只展示摘要，正文保留在本地。`
      )
    },
  })

  const websec_authz_compare = tool({
    description:
      "越权测试专用：按 method + URL 模式对比 baseline（普通账号）与 privileged（高权账号）证据，" +
      "只返回状态码/正文有无/哈希是否相同的摘要，不返回正文。需先完成两个阶段 capture。",
    args: {
      url_contains: z.string().optional().describe("只看 URL 包含该字符串的端点"),
      method: z.string().optional().describe("只看指定 HTTP 方法，如 GET/POST"),
    },
    async execute(args, context) {
      const workflow = requireWebsec(store.get(context.sessionID)?.workflow)
      if (workflow.websec?.testMode !== "authz") {
        throw new WorkflowOpError("websec_authz_compare 仅用于越权测试")
      }
      const evidence = workflow.websec.evidence.filter((item) => {
        if (item.phase !== "baseline" && item.phase !== "privileged") return false
        if (args.url_contains && !item.url.includes(args.url_contains)) return false
        if (args.method && item.method.toUpperCase() !== args.method.toUpperCase()) return false
        return true
      })
      const groups = new Map<string, { baseline: WebsecEvidence[]; privileged: WebsecEvidence[] }>()
      for (const item of evidence) {
        const key = endpointKey(item)
        const group = groups.get(key) ?? { baseline: [], privileged: [] }
        if (item.phase === "baseline") group.baseline.push(item)
        else group.privileged.push(item)
        groups.set(key, group)
      }
      const pairs = [...groups.entries()].filter(([, group]) => group.baseline.length > 0 && group.privileged.length > 0)
      if (pairs.length === 0) {
        return "没有找到同时具备 baseline 与 privileged 证据的端点：请确认两个阶段都 capture 过相同流程。"
      }
      const lines = pairs.map(([key, group]) => {
        const b = group.baseline[group.baseline.length - 1]!
        const p = group.privileged[group.privileged.length - 1]!
        return (
          `- ${key} | baseline ${b.status ?? "?"}（正文 ${b.bodyPresent ? "有" : "无"}）` +
          ` | privileged ${p.status ?? "?"}（正文 ${p.bodyPresent ? "有" : "无"}）` +
          ` | hash ${b.hash === p.hash ? "相同" : "不同"}`
        )
      })
      return (
        `🔍 可对比端点 ${pairs.length} 个：\n${lines.join("\n")}\n` +
        `请重点看：普通账号是否拿到高权数据、状态码是否异常放行、正文/哈希差异是否来自越权。`
      )
    },
  })

  return { websec_edge_capture, websec_authz_compare }
}
