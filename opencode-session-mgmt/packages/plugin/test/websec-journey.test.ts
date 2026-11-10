import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NetworkDetail, NetworkEntry, PageNavigation } from "edge-debug-core"
import { Store } from "../src/db"
import { createReviewTools } from "../src/tools/review"
import { createWebsecAnonymousTool } from "../src/tools/websec-anonymous"
import { createWebsecEdgeTools } from "../src/tools/websec-edge"
import { createWebsecTools } from "../src/tools/websec"
import { createWorkflowStartTools } from "../src/tools/workflow-start"
import { createWorkflowTools } from "../src/tools/workflow"

const ctx = { sessionID: "s1" } as never
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const allChecked = {
  scopeAuthorized: true,
  surfaceCovered: true,
  checksEvidenced: true,
  falsePositiveReviewed: true,
  remediationActionable: true,
}

describe("websec 完整客户旅程", () => {
  test("start → scope → Edge 走查 → capture → 匿名探测 → checks → report → review", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "sm-websec-journey-"))
    dirs.push(projectDir)
    const store = Store.memory(() => "websec")
    store.ensure("s1")
    const workflow = createWorkflowTools(store)
    const start = createWorkflowStartTools(store)
    const websec = createWebsecTools(store, projectDir)
    const workflowStart = start.workflow_start!

    let logs: NetworkEntry[] = []
    let navigations: PageNavigation[] = []
    const details = new Map<string, NetworkDetail>()
    const controller = {
      isRunning: () => true,
      start: async () => "started",
      stop: async () => true,
      networkLogs: () => logs,
      pageNavigations: () => navigations,
      responseDetailData: async (requestId: string) => {
        const detail = details.get(requestId)
        if (!detail) throw new Error("no detail")
        return detail
      },
      setCapturePolicy: () => {},
      clearSession: async () => "cleared",
      clearNetworkLogs: () => {},
    }
    const edge = createWebsecEdgeTools(store, projectDir, () => controller)
    const anon = createWebsecAnonymousTool(
      store,
      projectDir,
      (async () =>
        new Response(JSON.stringify({ id: 1, token: "123456" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    )
    const review = createReviewTools(store, "websec")

    try {
      await workflowStart.execute({ type: "websec" } as never, ctx)
      await websec.websec_scope!.execute(
        {
          target: "http://127.0.0.1:18086",
          environment: "test",
          accounts: [{ name: "u1", role: "普通用户" }],
          stopConditions: ["异常即停"],
          developer_confirmed: true,
        } as never,
        ctx,
      )
      store.mutateWorkflow("s1", (wf) => {
        wf.baselineProposedByDev = { hours: 1, messageID: "m1", at: Date.now() }
      })
      await workflow.workflow_baseline!.execute({ estimated_hours: 1, developer_confirmed: true } as never, ctx)
      await edge.websec_edge_capture!.execute({ action: "start", mode: "normal" } as never, ctx)

      const entered = String(
        await workflow.workflow_advance!.execute(
          { stage: "surface", action: "enter", developer_confirmed: true } as never,
          ctx,
        ),
      )
      expect(entered).toContain("资产与接口")

      const entry: NetworkEntry = {
        time: "12:00:00",
        requestId: "r1",
        method: "GET",
        url: "http://127.0.0.1:18086/api/settings",
        status: 200,
        mimeType: "application/json",
        resourceType: "XHR",
      }
      logs = [entry]
      navigations = [{ time: "12:00:01", url: "http://127.0.0.1:18086/" }]
      details.set("r1", {
        time: entry.time,
        method: entry.method,
        url: entry.url,
        status: 200,
        requestHeaders: {},
        responseHeaders: {},
        body: '{"id":1,"token":"123456"}',
        base64Encoded: false,
      })

      const captured = String(
        await edge.websec_edge_capture!.execute({ action: "capture", phase: "single" } as never, ctx),
      )
      expect(captured).toContain("已采集")
      const finished = String(await edge.websec_edge_capture!.execute({ action: "finish" } as never, ctx))
      expect(finished).toContain("匿名")
      await expect(
        anon.websec_anonymous_probe!.execute({ developer_confirmed: true } as never, ctx),
      ).resolves.toContain("匿名只读探测完成")

      await workflow.workflow_advance!.execute(
        { stage: "surface", action: "approve", developer_confirmed: true } as never,
        ctx,
      )
      await workflow.workflow_advance!.execute(
        { stage: "checks", action: "enter", developer_confirmed: true } as never,
        ctx,
      )
      await workflow.workflow_advance!.execute(
        { stage: "checks", action: "approve", developer_confirmed: true } as never,
        ctx,
      )
      await workflow.workflow_advance!.execute(
        { stage: "verify", action: "enter", developer_confirmed: true } as never,
        ctx,
      )
      await workflow.workflow_advance!.execute(
        { stage: "verify", action: "approve", developer_confirmed: true } as never,
        ctx,
      )
      await workflow.workflow_advance!.execute(
        { stage: "report", action: "enter", developer_confirmed: true } as never,
        ctx,
      )
      const reported = String(
        await websec.websec_report!.execute(
          {
            method: "Edge 用户走查 + 匿名只读探测",
            verdict: "issues_found",
            findings: [
              {
                title: "设置接口泄露 token",
                category: "config",
                severity: "high",
                endpoint: "/api/settings",
                status: "confirmed",
                evidenceRef: "edge-single-r1",
                reproduction: "匿名探测返回 200 且包含 token",
                impact: "token 泄露",
                remediation: "移除明文 token 并加鉴权",
              },
            ],
          } as never,
          ctx,
        ),
      )
      expect(reported).toContain("report.md")
      const final = String(await review.review_submit!.execute({ ...allChecked } as never, ctx))
      expect(final).toContain("report.md")
      expect(final).toContain("report.json")
      expect(existsSync(join(projectDir, "websec-evidence", "s1", "report.md"))).toBe(true)
      expect(existsSync(join(projectDir, "websec-evidence", "s1", "report.json"))).toBe(true)
    } finally {
      store.close()
    }
  })
})
