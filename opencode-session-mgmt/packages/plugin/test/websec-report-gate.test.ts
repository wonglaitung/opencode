/**
 * websec_report 门禁：Edge finish、普通测试正文、越权双阶段证据。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { WebsecEvidence, WebsecTestMode } from "sm-shared"
import { Store } from "../src/db"
import { createWebsecTools } from "../src/tools/websec"

const ctx = { sessionID: "s1" } as never
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function evidence(id: string, phase: "single" | "baseline" | "privileged", bodyPresent: boolean): WebsecEvidence {
  return {
    id,
    url: "http://127.0.0.1:18086/api/users/1",
    method: "GET",
    identity: phase === "privileged" ? "admin" : "u1",
    phase,
    source: "edge",
    capturedAt: 1000,
    hash: "a".repeat(64),
    bodyPresent,
  }
}

function setup(mode: WebsecTestMode, items: WebsecEvidence[], finished = true) {
  const store = Store.memory(() => "websec")
  store.ensure("s1")
  store.mutateWorkflow("s1", (wf) => {
    wf.stages.verify.status = "approved"
    wf.stages.report.status = "in_progress"
    wf.websec = {
      testMode: mode,
      edge: { started: true, finished, startedAt: 1000, finishedAt: finished ? 2000 : undefined },
      evidence: items,
      scope: {
        target: "http://127.0.0.1:18086",
        environment: "test",
        accounts: [
          { name: "u1", role: "user" },
          { name: "admin", role: "admin" },
        ],
        stopConditions: ["需要写操作"],
        confirmedAt: 1000,
      },
    }
  })
  const projectDir = mkdtempSync(join(tmpdir(), "sm-websec-report-"))
  dirs.push(projectDir)
  return { store, tools: createWebsecTools(store, projectDir), projectDir }
}

function finding(overrides: Record<string, unknown> = {}) {
  return {
    title: "越权读取",
    category: "authz",
    severity: "medium",
    endpoint: "/api/users/1",
    status: "confirmed",
    evidenceRef: "p1",
    reproduction: "baseline 200 / privileged 200",
    impact: "普通账号可读取",
    remediation: "校验资源归属",
    ...overrides,
  }
}

describe("websec_report 门禁", () => {
  test("Edge 未 finish 时拒绝报告", async () => {
    const { store, tools } = setup("normal", [evidence("n1", "single", true)], false)
    try {
      await expect(
        tools.websec_report!.execute({ method: "manual", verdict: "issues_found", findings: [finding({ evidenceRef: "n1" })] } as never, ctx),
      ).rejects.toThrow(/finish/)
    } finally {
      store.close()
    }
  })

  test("报告阶段已完成后拒绝重复提交", async () => {
    const { store, tools } = setup("normal", [evidence("n1", "single", true)])
    try {
      store.mutateWorkflow("s1", (wf) => {
        for (const stage of Object.values(wf.stages)) stage.status = "approved"
      })
      await expect(
        tools.websec_report!.execute({ method: "manual", verdict: "issues_found", findings: [finding({ evidenceRef: "n1" })] } as never, ctx),
      ).rejects.toThrow(/已完成.*不能重复提交/)
    } finally {
      store.close()
    }
  })

  test("未启动 Edge 时拒绝报告", async () => {
    const { store, tools } = setup("normal", [evidence("n1", "single", true)])
    try {
      store.mutateWorkflow("s1", (wf) => {
        wf.websec!.edge = undefined
      })
      await expect(
        tools.websec_report!.execute({ method: "manual", verdict: "issues_found", findings: [finding({ evidenceRef: "n1" })] } as never, ctx),
      ).rejects.toThrow(/Edge 用户走查/)
    } finally {
      store.close()
    }
  })

  test("普通测试 confirmed 可以使用匿名探测证据", async () => {
    const { store, tools } = setup("normal", [evidence("a1", "single", true)])
    try {
      store.mutateWorkflow("s1", (wf) => {
        wf.websec!.evidence[0]!.source = "anonymous-probe"
      })
      await expect(
        tools.websec_report!.execute({ method: "anonymous probe", verdict: "issues_found", findings: [finding({ evidenceRef: "a1" })] } as never, ctx),
      ).resolves.toContain("报告已提交")
    } finally {
      store.close()
    }
  })

  test("普通测试 confirmed 必须有正文证据，并写出项目内报告文件", async () => {
    const { store, tools, projectDir } = setup("normal", [evidence("n1", "single", false)])
    try {
      await expect(
        tools.websec_report!.execute({ method: "manual", verdict: "issues_found", findings: [finding({ evidenceRef: "n1" })] } as never, ctx),
      ).rejects.toThrow(/bodyPresent/)
      store.mutateWorkflow("s1", (wf) => {
        wf.websec!.evidence[0]!.bodyPresent = true
      })
      const result = await tools.websec_report!.execute(
        { method: "manual", verdict: "issues_found", findings: [finding({ evidenceRef: "n1" })] } as never,
        ctx,
      )
      expect(String(result)).toContain("report.md")
      expect(String(result)).toContain("report.json")
      expect(existsSync(join(projectDir, "websec-evidence", "s1", "report.md"))).toBe(true)
      expect(existsSync(join(projectDir, "websec-evidence", "s1", "report.json"))).toBe(true)
    } finally {
      store.close()
    }
  })

  test("越权 confirmed 必须同时有 baseline 与 privileged 证据", async () => {
    const items = [evidence("b1", "baseline", true), evidence("p1", "privileged", true)]
    const { store, tools } = setup("authz", items)
    try {
      await expect(
        tools.websec_report!.execute({ method: "manual", verdict: "issues_found", findings: [finding()] } as never, ctx),
      ).rejects.toThrow(/baselineEvidenceRef/)
      await expect(
        tools.websec_report!.execute(
          {
            method: "manual",
            verdict: "issues_found",
            findings: [finding({ baselineEvidenceRef: "b1", privilegedEvidenceRef: "p1" })],
          } as never,
          ctx,
        ),
      ).resolves.toContain("报告已提交")
    } finally {
      store.close()
    }
  })
})
