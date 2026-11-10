import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NetworkDetail, NetworkEntry, PageNavigation } from "edge-debug-core"
import { Store } from "../src/db"
import { createReviewTools } from "../src/tools/review"
import { createWebsecAnonymousTool } from "../src/tools/websec-anonymous"
import { createWebsecEdgeTools } from "../src/tools/websec-edge"
import { createWebsecTools } from "../src/tools/websec"
import { createWorkflowTools } from "../src/tools/workflow"

const ctx = { sessionID: "s1" } as never
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const projectDir = mkdtempSync(join(tmpdir(), "sm-websec-transitions-"))
  dirs.push(projectDir)
  const store = Store.memory(() => "websec")
  store.ensure("s1")
  let failStart: Error | null = null
  let logs: NetworkEntry[] = []
  const details = new Map<string, NetworkDetail>()
  const controller = {
    isRunning: () => true,
    start: async () => {
      if (failStart) throw failStart
      return "started"
    },
    stop: async () => true,
    networkLogs: () => logs,
    pageNavigations: (): PageNavigation[] => [],
    responseDetailData: async (requestId: string) => {
      const detail = details.get(requestId)
      if (!detail) throw new Error("no detail")
      return detail
    },
    setCapturePolicy: () => {},
    clearSession: async () => "cleared",
    clearNetworkLogs: () => {},
  }
  const workflow = createWorkflowTools(store)
  const websec = createWebsecTools(store, projectDir)
  const edge = createWebsecEdgeTools(store, projectDir, () => controller)
  const anon = createWebsecAnonymousTool(
    store,
    projectDir,
    (async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
  )
  const review = createReviewTools(store, "websec")
  const scope = {
    target: "http://127.0.0.1:18086",
    environment: "test",
    accounts: [{ name: "u1", role: "普通用户" }],
    stopConditions: ["异常即停"],
    confirmedAt: 1000,
  }
  const setScope = (status: "in_progress" | "approved" = "in_progress") => {
    store.mutateWorkflow("s1", (wf) => {
      wf.stages.scope.status = status
      wf.websec = { evidence: [], scope }
    })
  }
  const setEdge = (evidence = true) => {
    store.mutateWorkflow("s1", (wf) => {
      wf.websec = {
        evidence: evidence
          ? [
              {
                id: "edge-1",
                url: "http://127.0.0.1:18086/api/settings",
                method: "GET",
                source: "edge",
                phase: "single",
                hash: "a".repeat(64),
                bodyPresent: true,
              },
            ]
          : [],
        scope,
        testMode: "normal",
        edge: { started: true, finished: true },
      }
    })
  }
  return {
    projectDir,
    store,
    workflow,
    websec,
    edge,
    anon,
    review,
    setScope,
    setEdge,
    setFailStart: (error: Error | null) => {
      failStart = error
    },
    setLogs: (next: NetworkEntry[]) => {
      logs = next
    },
    setDetail: (entry: NetworkEntry, body: string) => {
      details.set(entry.requestId, {
        time: entry.time,
        method: entry.method,
        url: entry.url,
        status: entry.status,
        requestHeaders: {},
        responseHeaders: {},
        body,
        base64Encoded: false,
      })
    },
  }
}

describe("websec 状态转换矩阵", () => {
  test("未记录 scope 不能进入 surface", async () => {
    const { workflow, store } = setup()
    try {
      store.mutateWorkflow("s1", (wf) => {
        wf.stages.scope.status = "in_progress"
      })
      await expect(
        workflow.workflow_advance!.execute(
          { stage: "surface", action: "enter", developer_confirmed: true } as never,
          ctx,
        ),
      ).rejects.toThrow(/websec_scope/)
    } finally {
      store.close()
    }
  })

  test("有 scope 但未选模式不能进入 surface", async () => {
    const { workflow, store, setScope } = setup()
    try {
      setScope()
      await expect(
        workflow.workflow_advance!.execute(
          { stage: "surface", action: "enter", developer_confirmed: true } as never,
          ctx,
        ),
      ).rejects.toThrow(/websec_edge_capture/)
    } finally {
      store.close()
    }
  })

  test("surface 没有 Edge 证据不能 approve", async () => {
    const { workflow, store, setScope } = setup()
    try {
      setScope("approved")
      store.mutateWorkflow("s1", (wf) => {
        wf.stages.surface.status = "in_progress"
        wf.websec = { ...wf.websec!, testMode: "normal", edge: { started: true, finished: false } }
      })
      await expect(
        workflow.workflow_advance!.execute(
          { stage: "surface", action: "approve", developer_confirmed: true } as never,
          ctx,
        ),
      ).rejects.toThrow(/Edge/)
    } finally {
      store.close()
    }
  })

  test("enter checks 自动确认 surface 也不能绕过 Edge 证据", async () => {
    const { workflow, store, setScope } = setup()
    try {
      setScope("approved")
      store.mutateWorkflow("s1", (wf) => {
        wf.stages.surface.status = "in_progress"
        wf.websec = { ...wf.websec!, testMode: "normal", edge: { started: true, finished: false } }
      })
      await expect(
        workflow.workflow_advance!.execute(
          { stage: "checks", action: "enter", developer_confirmed: true } as never,
          ctx,
        ),
      ).rejects.toThrow(/Edge/)
    } finally {
      store.close()
    }
  })

  test("start 失败后才能 fallback，且 fallback 可以继续到 checks", async () => {
    const { workflow, websec, edge, store, setScope, setFailStart } = setup()
    try {
      setScope()
      await expect(
        websec.websec_scope!.execute(
          {
            target: "http://127.0.0.1:18086",
            environment: "test",
            accounts: [{ name: "u1", role: "普通用户" }],
            stopConditions: ["异常即停"],
            developer_confirmed: true,
          } as never,
          ctx,
        ),
      ).resolves.toContain("测试范围")
      await expect(
        edge.websec_edge_capture!.execute(
          { action: "fallback", mode: "normal", reason: "无 Edge", developer_confirmed: true } as never,
          ctx,
        ),
      ).rejects.toThrow(/start.*失败/)

      setFailStart(new Error("Edge 启动失败"))
      await expect(
        edge.websec_edge_capture!.execute({ action: "start", mode: "normal" } as never, ctx),
      ).rejects.toThrow(/Edge 启动失败/)
      await expect(
        edge.websec_edge_capture!.execute(
          { action: "fallback", mode: "normal", reason: "无 Edge", developer_confirmed: true } as never,
          ctx,
        ),
      ).resolves.toContain("fallback")
      await expect(
        workflow.workflow_advance!.execute(
          { stage: "surface", action: "enter", developer_confirmed: true } as never,
          ctx,
        ),
      ).resolves.toContain("资产与接口")
      await expect(
        workflow.workflow_advance!.execute(
          { stage: "surface", action: "approve", developer_confirmed: true } as never,
          ctx,
        ),
      ).resolves.toContain("approved")
      await expect(
        workflow.workflow_advance!.execute(
          { stage: "checks", action: "enter", developer_confirmed: true } as never,
          ctx,
        ),
      ).resolves.toContain("安全检查")
    } finally {
      store.close()
    }
  })

  test("匿名探测必须授权，且只允许同源已捕获端点", async () => {
    const { anon, store, setScope } = setup()
    try {
      setScope("approved")
      store.mutateWorkflow("s1", (wf) => {
        wf.websec = {
          ...wf.websec!,
          testMode: "normal",
          edge: { started: true, finished: true },
          evidence: [
            {
              id: "edge-1",
              url: "http://127.0.0.1:18086/api/settings",
              method: "GET",
              source: "edge",
              phase: "single",
              hash: "a".repeat(64),
              bodyPresent: true,
            },
          ],
        }
      })
      await expect(
        anon.websec_anonymous_probe!.execute({ developer_confirmed: false } as never, ctx),
      ).rejects.toThrow(/developer_confirmed/)
      await expect(
        anon.websec_anonymous_probe!.execute(
          { urls: ["http://evil.example/api/settings"], developer_confirmed: true } as never,
          ctx,
        ),
      ).rejects.toThrow(/同源/)
      await expect(
        anon.websec_anonymous_probe!.execute(
          { urls: ["http://127.0.0.1:18086/api/not-visited"], developer_confirmed: true } as never,
          ctx,
        ),
      ).rejects.toThrow(/已捕获/)
    } finally {
      store.close()
    }
  })

  test("报告必须完成 verify 并进入 report 阶段", async () => {
    const { websec, store, setEdge } = setup()
    try {
      setEdge()
      store.mutateWorkflow("s1", (wf) => {
        wf.stages.scope.status = "approved"
        wf.stages.surface.status = "approved"
        wf.stages.checks.status = "in_progress"
        wf.stages.verify.status = "in_progress"
        wf.stages.report.status = "not_started"
      })
      await expect(
        websec.websec_report!.execute({ method: "test", findings: [], verdict: "passed" } as never, ctx),
      ).rejects.toThrow(/验证与定级/)
      store.mutateWorkflow("s1", (wf) => {
        wf.stages.checks.status = "approved"
        wf.stages.verify.status = "approved"
        wf.stages.report.status = "not_started"
      })
      await expect(
        websec.websec_report!.execute({ method: "test", findings: [], verdict: "passed" } as never, ctx),
      ).rejects.toThrow(/报告与修复/)
    } finally {
      store.close()
    }
  })

  test("authz 分支可以完成 baseline/privileged 对比和报告", async () => {
    const { workflow, websec, edge, review, store, setScope, setLogs, setDetail } = setup()
    try {
      setScope()
      store.mutateWorkflow("s1", (wf) => {
        wf.websec!.scope!.accounts = [
          { name: "u1", role: "普通用户" },
          { name: "admin", role: "管理员" },
        ]
        wf.baselineProposedByDev = { hours: 1, messageID: "m1", at: 1000 }
      })
      await workflow.workflow_baseline!.execute({ estimated_hours: 1, developer_confirmed: true } as never, ctx)
      await edge.websec_edge_capture!.execute({ action: "start", mode: "authz" } as never, ctx)
      const baseline = {
        time: "12:00:00",
        requestId: "b1",
        method: "GET",
        url: "http://127.0.0.1:18086/api/settings",
        status: 200,
        mimeType: "application/json",
        resourceType: "XHR",
      }
      setLogs([baseline])
      setDetail(baseline, '{"id":1,"token":"123456"}')
      await edge.websec_edge_capture!.execute({ action: "capture", phase: "baseline", identity: "u1" } as never, ctx)
      await edge.websec_edge_capture!.execute({ action: "switch_identity" } as never, ctx)
      const privileged = { ...baseline, requestId: "p1" }
      setLogs([privileged])
      setDetail(privileged, '{"id":1,"token":"admin"}')
      await edge.websec_edge_capture!.execute({ action: "capture", phase: "privileged", identity: "admin" } as never, ctx)
      await edge.websec_edge_capture!.execute({ action: "finish" } as never, ctx)

      await workflow.workflow_advance!.execute(
        { stage: "surface", action: "enter", developer_confirmed: true } as never,
        ctx,
      )
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
      await expect(
        websec.websec_report!.execute(
          {
            method: "authz Edge",
            verdict: "issues_found",
            findings: [
              {
                title: "越权读取",
                category: "authz",
                severity: "high",
                endpoint: "/api/settings",
                status: "confirmed",
                evidenceRef: "edge-baseline-b1",
                baselineEvidenceRef: "edge-baseline-b1",
                privilegedEvidenceRef: "edge-privileged-p1",
                reproduction: "普通账号与管理员均读到设置",
                impact: "越权",
                remediation: "按角色限制",
              },
            ],
          } as never,
          ctx,
        ),
      ).resolves.toContain("report.md")
      await expect(
        review.review_submit!.execute(
          {
            scopeAuthorized: true,
            surfaceCovered: true,
            checksEvidenced: true,
            falsePositiveReviewed: true,
            remediationActionable: true,
          } as never,
          ctx,
        ),
      ).resolves.toContain("report.md")
    } finally {
      store.close()
    }
  })

  test("fallback 分支可以从范围走到报告和 review_submit", async () => {
    const { workflow, websec, edge, review, store, setScope, setFailStart } = setup()
    try {
      setScope()
      setFailStart(new Error("Edge 启动失败"))
      await expect(
        edge.websec_edge_capture!.execute({ action: "start", mode: "normal" } as never, ctx),
      ).rejects.toThrow(/Edge 启动失败/)
      await expect(
        edge.websec_edge_capture!.execute(
          { action: "fallback", mode: "normal", reason: "Edge 不可用", developer_confirmed: true } as never,
          ctx,
        ),
      ).resolves.toContain("fallback")
      store.mutateWorkflow("s1", (wf) => {
        wf.baselineProposedByDev = { hours: 1, messageID: "m1", at: 1000 }
      })
      await workflow.workflow_baseline!.execute({ estimated_hours: 1, developer_confirmed: true } as never, ctx)
      await workflow.workflow_advance!.execute(
        { stage: "surface", action: "enter", developer_confirmed: true } as never,
        ctx,
      )
      await workflow.workflow_advance!.execute(
        { stage: "surface", action: "approve", developer_confirmed: true } as never,
        ctx,
      )
      await workflow.workflow_advance!.execute(
        { stage: "checks", action: "enter", developer_confirmed: true } as never,
        ctx,
      )
      await websec.websec_evidence!.execute(
        {
          id: "manual-1",
          url: "http://127.0.0.1:18086/api/settings",
          method: "GET",
          hash: "a".repeat(64),
          bodyPresent: true,
        } as never,
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
      await expect(
        websec.websec_report!.execute(
          {
            method: "manual fallback",
            verdict: "issues_found",
            findings: [
              {
                title: "匿名可读",
                category: "authz",
                severity: "high",
                endpoint: "/api/settings",
                status: "confirmed",
                evidenceRef: "manual-1",
                reproduction: "无 Cookie GET 200",
                impact: "匿名可读",
                remediation: "加鉴权",
              },
            ],
          } as never,
          ctx,
        ),
      ).resolves.toContain("report.md")
      await expect(
        review.review_submit!.execute(
          {
            scopeAuthorized: true,
            surfaceCovered: true,
            checksEvidenced: true,
            falsePositiveReviewed: true,
            remediationActionable: true,
          } as never,
          ctx,
        ),
      ).resolves.toContain("report.md")
    } finally {
      store.close()
    }
  })

  test("没有 baseline 时 review_submit 必须拒绝", async () => {
    const { review, store } = setup()
    try {
      store.mutateWorkflow("s1", (wf) => {
        for (const stage of ["scope", "surface", "checks", "verify", "report"]) wf.stages[stage].status = "approved"
        wf.websec = {
          evidence: [],
          scope: {
            target: "http://127.0.0.1:18086",
            environment: "test",
            accounts: [{ name: "u1", role: "普通用户" }],
            stopConditions: ["异常即停"],
            confirmedAt: 1000,
          },
          report: {
            status: "submitted",
            method: "test",
            findings: [],
            limitations: [],
            verdict: "passed",
            submittedAt: 1000,
          },
        }
      })
      await expect(
        review.review_submit!.execute(
          {
            scopeAuthorized: true,
            surfaceCovered: true,
            checksEvidenced: true,
            falsePositiveReviewed: true,
            remediationActionable: true,
          } as never,
          ctx,
        ),
      ).rejects.toThrow(/预估/)
    } finally {
      store.close()
    }
  })
})
