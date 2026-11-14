/**
 * websec 覆盖矩阵 / 历史回归 / 只读配置检查 / 显式写探测。
 * 这些测试直接调用工具实现，验证状态落库与门禁，不依赖 Edge 或真实网络。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WEBSEC_REQUIRED_CHECK_CATEGORY_KEYS } from "sm-shared"
import { Store } from "../src/db"
import { safeResponseHeaders } from "../src/tools/websec-headers"
import { createWebsecHttpTools } from "../src/tools/websec-http"
import { createWebsecSurfaceTools } from "../src/tools/websec-surface"
import { createWebsecTools } from "../src/tools/websec"

const ctx = { sessionID: "s1" } as never
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const projectDir = mkdtempSync(join(tmpdir(), "sm-websec-coverage-"))
  dirs.push(projectDir)
  const store = Store.memory(() => "websec")
  store.ensure("s1")
  store.mutateWorkflow("s1", (wf) => {
    wf.stages.verify.status = "approved"
    wf.stages.report.status = "in_progress"
    wf.websec = {
      testMode: "normal",
      edge: { started: true, finished: true, startedAt: 1000, finishedAt: 2000 },
      scope: {
        target: "http://127.0.0.1:18086",
        environment: "test",
        accounts: [{ name: "u1", role: "普通用户" }],
        stopConditions: ["异常即停"],
        confirmedAt: 1000,
      },
      evidence: [
        {
          id: "edge-get",
          url: "http://127.0.0.1:18086/api/tasks",
          method: "GET",
          identity: "u1",
          source: "edge",
          phase: "single",
          hash: "a".repeat(64),
          bodyPresent: true,
        },
      ],
    }
  })
  return { store, projectDir, surfaceTools: createWebsecSurfaceTools(store, projectDir), tools: createWebsecTools(store, projectDir, async (child, parent) => child === `${parent}-verifier`) }
}

function allCoverage(surfaceRef: string, status: "tested" | "not_applicable" = "tested") {
  return WEBSEC_REQUIRED_CHECK_CATEGORY_KEYS.map((category) => ({
    surface_ref: surfaceRef,
    category,
    status,
    ...(status === "tested" ? { evidence_refs: ["edge-get"] } : { note: "该入口不涉及此类别" }),
  }))
}

describe("websec 覆盖矩阵", () => {
  test("同步 Edge 入口后自动生成必检类别，未收口时报告被拦截", async () => {
    const { store, projectDir, surfaceTools, tools } = setup()
    try {
      const output = String(
        await surfaceTools.websec_surface!.execute({ sync_edge: true } as never, ctx),
      )
      expect(output).toContain("新增 1 个")
      const state = store.get("s1")!.workflow!.websec!
      expect(state.surface).toHaveLength(1)
      expect(state.coverage).toHaveLength(WEBSEC_REQUIRED_CHECK_CATEGORY_KEYS.length)

      const surfaceRef = state.surface![0]!.id
      await expect(
        tools.websec_report!.execute(
          {
            method: "manual + Edge",
            verdict: "issues_found",
            findings: [
              {
                title: "测试发现",
                category: "authz",
                severity: "medium",
                endpoint: "/api/tasks",
                status: "confirmed",
                verifierSessionID: "s1-verifier",
                verifierDecision: "confirmed",
                evidenceRef: "edge-get",
                reproduction: "baseline/proof",
                impact: "测试",
                remediation: "测试",
              },
            ],
          } as never,
          ctx,
        ),
      ).rejects.toThrow(/覆盖矩阵未收口/)

      await expect(
        surfaceTools.websec_coverage!.execute(
          { records: [{ surface_ref: surfaceRef, category: "authz", status: "tested" }] } as never,
          ctx,
        ),
      ).rejects.toThrow(/必须提供 evidence_refs/)
      await expect(
        surfaceTools.websec_coverage!.execute(
          { records: [{ surface_ref: surfaceRef, category: "cors", status: "not_applicable" }] } as never,
          ctx,
        ),
      ).rejects.toThrow(/必须写理由/)

      await surfaceTools.websec_coverage!.execute({ records: allCoverage(surfaceRef) } as never, ctx)
      expect(store.get("s1")!.workflow!.websec!.coverage!.every((item) => item.status === "tested")).toBe(true)

      const report = String(
        await tools.websec_report!.execute(
          {
            method: "manual + Edge",
            verdict: "issues_found",
            findings: [
              {
                title: "测试发现",
                category: "authz",
                severity: "medium",
                endpoint: "/api/tasks",
                status: "confirmed",
                verifierSessionID: "s1-verifier",
                verifierDecision: "confirmed",
                evidenceRef: "edge-get",
                reproduction: "baseline/proof",
                impact: "测试",
                remediation: "测试",
              },
            ],
          } as never,
          ctx,
        ),
      )
      expect(report).toContain("WEB 安全测试报告已提交")
      const mdPath = store.get("s1")!.workflow!.websec!.report!.markdownPath!
      expect(readFileSync(mdPath, "utf8")).toContain("覆盖矩阵：9/9 已收口")
      expect(projectDir).toBeTruthy()
    } finally {
      store.close()
    }
  })

  test("加载历史 finding 后必须逐条回归，not_applicable 需理由", async () => {
    const { store, projectDir, surfaceTools, tools } = setup()
    try {
      mkdirSync(join(projectDir, "websec-evidence", "old"), { recursive: true })
      writeFileSync(
        join(projectDir, "websec-evidence", "old", "report.json"),
        JSON.stringify({
          findings: [
            {
              id: "f-old",
              title: "历史越权",
              endpoint: "/api/tasks/1",
              severity: "high",
            },
          ],
        }),
      )
      const loaded = String(
        await surfaceTools.websec_regression!.execute({ action: "load" } as never, ctx),
      )
      expect(loaded).toContain("已加载 1 条历史 finding")
      expect(store.get("s1")!.workflow!.websec!.regression).toHaveLength(1)

      const surfaceRef = store.get("s1")!.workflow!.websec!.surface?.[0]?.id
      if (!surfaceRef) {
        await surfaceTools.websec_surface!.execute({ sync_edge: true } as never, ctx)
      }
      const id = store.get("s1")!.workflow!.websec!.surface![0]!.id
      await surfaceTools.websec_coverage!.execute({ records: allCoverage(id) } as never, ctx)

      await expect(
        tools.websec_report!.execute({ method: "manual + Edge", verdict: "passed", findings: [] } as never, ctx),
      ).rejects.toThrow(/历史 finding 未完成回归/)

      await expect(
        surfaceTools.websec_regression!.execute(
          {
            action: "record",
            records: [{ source_session_id: "old", source_finding_id: "f-old", status: "not_applicable" }],
          } as never,
          ctx,
        ),
      ).rejects.toThrow(/必须写理由/)

      await surfaceTools.websec_regression!.execute(
        {
          action: "record",
          records: [
            {
              source_session_id: "old",
              source_finding_id: "f-old",
              status: "not_applicable",
              note: "旧入口已删除",
            },
          ],
        } as never,
        ctx,
      )
      await expect(
        tools.websec_report!.execute({ method: "manual + Edge", verdict: "passed", findings: [] } as never, ctx),
      ).resolves.toContain("WEB 安全测试报告已提交")
    } finally {
      store.close()
    }
  })
})

describe("websec 只读配置检查与写探测", () => {
  test("响应头白名单只保留安全判断字段，不落 Cookie 值", () => {
    const headers = new Headers({ "x-powered-by": "Express" })
    headers.append("set-cookie", "session=secret; Path=/; HttpOnly; Secure; SameSite=Lax")
    headers.set("content-type", "text/html")
    const safe = safeResponseHeaders(headers)
    expect(safe["x-powered-by"]).toBe("Express")
    expect(safe["content-type"]).toBe("text/html")
    expect(safe["set-cookie-attributes"]).toContain("httponly")
    expect(safe["set-cookie-attributes"]).toContain("secure")
    expect(safe["set-cookie-attributes"]).toContain("SameSite=Lax")
    expect(JSON.stringify(safe)).not.toContain("secret")
  })

  test("配置检查采集 CORS/安全头并自动登记覆盖", async () => {
    const { store, projectDir } = setup()
    try {
      await createWebsecSurfaceTools(store, projectDir).websec_surface!.execute(
        { entries: [{ method: "GET", endpoint: "/api/tasks", source: "source" }] } as never,
        ctx,
      )
      const calls: Array<{ url: string; init?: RequestInit }> = []
      const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        calls.push({ url, init })
        const headers = new Headers({
          "content-type": "application/json",
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST",
          "x-powered-by": "Express",
        })
        return new Response("ok", { status: 200, headers })
      }) as typeof fetch
      const tools = createWebsecHttpTools(store, projectDir, fetchImpl)
      await expect(
        tools.websec_config_check!.execute({ developer_confirmed: false } as never, ctx),
      ).rejects.toThrow(/developer_confirmed/)
      await expect(
        tools.websec_config_check!.execute(
          { developer_confirmed: true, urls: ["http://evil.example/api/tasks"] } as never,
          ctx,
        ),
      ).rejects.toThrow(/同源/)
      await expect(
        tools.websec_config_check!.execute(
          { developer_confirmed: true, urls: ["http://127.0.0.1:18086/api/not-registered"] } as never,
          ctx,
        ),
      ).rejects.toThrow(/已登记入口/)
      const output = String(
        await tools.websec_config_check!.execute({ developer_confirmed: true, origin: "https://evil.example" } as never, ctx),
      )
      expect(output).toContain("只读配置检查完成")
      expect(calls).toHaveLength(2)
      expect(calls.every((call) => call.init?.headers && (call.init.headers as Record<string, string>).Origin === "https://evil.example")).toBe(true)
      const state = store.get("s1")!.workflow!.websec!
      const checkEvidence = state.evidence.filter((item) => item.source === "http-check")
      expect(checkEvidence).toHaveLength(2)
      expect(checkEvidence[0]!.responseHeaders?.["access-control-allow-origin"]).toBe("*")
      expect(checkEvidence[0]!.responseHeaders?.["x-powered-by"]).toBe("Express")
      const surface = state.surface![0]!
      const covered = state.coverage!.filter((item) => item.surfaceRef === surface.id)
      expect(covered.filter((item) => item.status === "tested").map((item) => item.category).sort()).toEqual([
        "cors",
        "headers",
        "options",
      ])
      expect(covered.find((item) => item.category === "cors")!.evidenceRefs).toContain(checkEvidence[0]!.id)
    } finally {
      store.close()
    }
  })

  test("写探测必须逐次授权、只发一次且写入授权记录", async () => {
    const { store, projectDir } = setup()
    try {
      await createWebsecSurfaceTools(store, projectDir).websec_surface!.execute(
        { entries: [{ method: "POST", endpoint: "/api/tasks", source: "source" }] } as never,
        ctx,
      )
      const calls: Array<{ url: string; init?: RequestInit }> = []
      const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init })
        return new Response(JSON.stringify({ ok: true }), { status: 201, headers: { "content-type": "application/json" } })
      }) as typeof fetch
      const tools = createWebsecHttpTools(store, projectDir, fetchImpl)
      await expect(
        tools.websec_write_probe!.execute(
          {
            url: "http://127.0.0.1:18086/api/tasks",
            method: "POST",
            body: '{"title":"test"}',
            authorization_note: "测试数据可删除",
            developer_confirmed: false,
          } as never,
          ctx,
        ),
      ).rejects.toThrow(/developer_confirmed/)

      const output = String(
        await tools.websec_write_probe!.execute(
          {
            url: "http://127.0.0.1:18086/api/tasks",
            method: "POST",
            body: '{"title":"test"}',
            authorization_note: "测试数据可删除",
            developer_confirmed: true,
          } as never,
          ctx,
        ),
      )
      expect(output).toContain("写探测已执行一次")
      expect(calls).toHaveLength(1)
      expect(calls[0]!.init?.method).toBe("POST")
      const state = store.get("s1")!.workflow!.websec!
      expect(state.writeAuthorization?.note).toBe("测试数据可删除")
      const probe = state.evidence.find((item) => item.source === "write-probe")!
      expect(probe.bodyPresent).toBe(true)
      expect(probe.localPath && existsSync(probe.localPath)).toBe(true)
    } finally {
      store.close()
    }
  })
})
