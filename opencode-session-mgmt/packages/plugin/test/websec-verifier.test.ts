/**
 * 独立复核门禁与「待验证不评严重度」：
 * - schema：confirmed 必须带 verifierSessionID/verifierDecision；suspected 不得带 severity。
 * - 运行时：复核会话必须是当前会话的子会话，且不能是当前会话。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { WebsecEvidence } from "sm-shared"
import { Store } from "../src/db"
import { createWebsecTools, websecFindingSchema } from "../src/tools/websec"

const ctx = { sessionID: "s1" } as never
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function evidence(id: string): WebsecEvidence {
  return {
    id,
    url: "http://127.0.0.1:18086/api/users/1",
    method: "GET",
    identity: "u1",
    phase: "single",
    source: "edge",
    capturedAt: 1000,
    hash: "a".repeat(64),
    bodyPresent: true,
  }
}

function setup(
  isVerifierSession: (child: string, parent: string) => Promise<boolean> = async (child, parent) =>
    child === `${parent}-verifier`,
) {
  const store = Store.memory(() => "websec")
  store.ensure("s1")
  store.mutateWorkflow("s1", (wf) => {
    wf.stages.verify.status = "approved"
    wf.stages.report.status = "in_progress"
    wf.websec = {
      testMode: "normal",
      edge: { started: true, finished: true, startedAt: 1000, finishedAt: 2000 },
      evidence: [evidence("n1")],
      scope: {
        target: "http://127.0.0.1:18086",
        environment: "test",
        accounts: [{ name: "u1", role: "user" }],
        stopConditions: ["需要写操作"],
        confirmedAt: 1000,
      },
    }
  })
  const projectDir = mkdtempSync(join(tmpdir(), "sm-websec-verifier-"))
  dirs.push(projectDir)
  return { store, tools: createWebsecTools(store, projectDir, isVerifierSession) }
}

function baseFinding(overrides: Record<string, unknown> = {}) {
  return {
    title: "设置接口泄露 token",
    category: "config",
    endpoint: "/api/settings",
    evidenceRef: "n1",
    reproduction: "匿名 GET 返回 token",
    impact: "token 泄露",
    remediation: "移除明文 token 并加鉴权",
    ...overrides,
  }
}

describe("finding schema", () => {
  test("suspected 不允许携带 severity", () => {
    const parsed = websecFindingSchema.safeParse(baseFinding({ status: "suspected", severity: "high" }))
    expect(parsed.success).toBe(false)
  })

  test("suspected 不带 severity 时通过", () => {
    const parsed = websecFindingSchema.safeParse(baseFinding({ status: "suspected" }))
    expect(parsed.success).toBe(true)
  })

  test("confirmed 必须带 verifierSessionID 与 verifierDecision", () => {
    expect(websecFindingSchema.safeParse(baseFinding({ status: "confirmed", severity: "high" })).success).toBe(false)
    expect(
      websecFindingSchema.safeParse(
        baseFinding({ status: "confirmed", severity: "high", verifierSessionID: "s1-verifier" }),
      ).success,
    ).toBe(false)
    expect(
      websecFindingSchema.safeParse(
        baseFinding({
          status: "confirmed",
          severity: "high",
          verifierSessionID: "s1-verifier",
          verifierDecision: "confirmed",
        }),
      ).success,
    ).toBe(true)
  })

  test("suspected 不允许携带复核字段", () => {
    const parsed = websecFindingSchema.safeParse(
      baseFinding({ status: "suspected", verifierSessionID: "s1-verifier", verifierDecision: "confirmed" }),
    )
    expect(parsed.success).toBe(false)
  })
})

describe("独立复核门禁", () => {
  test("复核会话不能是当前会话", async () => {
    const { store, tools } = setup()
    try {
      await expect(
        tools.websec_report!.execute(
          {
            method: "manual",
            verdict: "issues_found",
            findings: [
              baseFinding({
                status: "confirmed",
                severity: "high",
                verifierSessionID: "s1",
                verifierDecision: "confirmed",
              }),
            ],
          } as never,
          ctx,
        ),
      ).rejects.toThrow(/不能是当前会话/)
    } finally {
      store.close()
    }
  })

  test("复核会话必须是当前会话的子会话", async () => {
    const { store, tools } = setup(async () => false)
    try {
      await expect(
        tools.websec_report!.execute(
          {
            method: "manual",
            verdict: "issues_found",
            findings: [
              baseFinding({
                status: "confirmed",
                severity: "high",
                verifierSessionID: "other-verifier",
                verifierDecision: "confirmed",
              }),
            ],
          } as never,
          ctx,
        ),
      ).rejects.toThrow(/不是本会话的子会话/)
    } finally {
      store.close()
    }
  })

  test("子会话复核通过时报告提交成功，并写出覆盖台账", async () => {
    const { store, tools } = setup()
    try {
      const result = await tools.websec_report!.execute(
        {
          method: "manual",
          verdict: "issues_found",
          findings: [
            baseFinding({
              status: "confirmed",
              severity: "high",
              verifierSessionID: "s1-verifier",
              verifierDecision: "confirmed",
            }),
          ],
        } as never,
        ctx,
      )
      expect(String(result)).toContain("已确认 1")
      const report = store.get("s1")!.workflow!.websec!.report!
      expect(report.ledgerPath!.endsWith("coverage-ledger.json")).toBe(true)
    } finally {
      store.close()
    }
  })

  test("suspected 不需要复核，且报告里不出现严重度", async () => {
    const { store, tools } = setup()
    try {
      const result = await tools.websec_report!.execute(
        {
          method: "manual",
          verdict: "issues_found",
          findings: [baseFinding({ status: "suspected" })],
        } as never,
        ctx,
      )
      expect(String(result)).toContain("待验证 1")
      const report = store.get("s1")!.workflow!.websec!.report!
      expect(report.findings[0]!.status).toBe("suspected")
      expect(report.findings[0]!.severity).toBeUndefined()
    } finally {
      store.close()
    }
  })
})
