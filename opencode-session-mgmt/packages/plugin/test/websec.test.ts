/**
 * websec 工作流端到端护栏：范围门禁、证据引用校验、报告门禁与定稿。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import { identityPath, writeIdentity } from "sm-shared"
import { Store } from "../src/db"
import SessionMgmtPlugin from "../src/index"
import { resetSubagentCache } from "../src/subagent"

const ctx = (sessionID: string) => ({ sessionID }) as never

function fakeClient(): PluginInput["client"] {
  return {
    session: {
      get: async () => ({ data: { id: "s", title: "会话标题" } }),
      messages: async () => ({ data: [] }),
      list: async () => ({ data: [] }),
    },
  } as unknown as PluginInput["client"]
}

function current(sessionID: string, messageID: string, text: string) {
  return {
    message: { id: messageID, sessionID, role: "user", time: { created: Date.now() } },
    parts: [{ id: messageID, sessionID, messageID, type: "text", text }],
  } as never
}

const prevHome = process.env.HOME
let home = ""

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "sm-websec-home-"))
  process.env.HOME = home
})

afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  if (home) rmSync(home, { recursive: true, force: true })
})

async function startWebsecPlugin() {
  writeIdentity({ apiKey: "test", collector_url: "http://127.0.0.1:1", workflowType: "websec" })
  const project = mkdtempSync(join(tmpdir(), "sm-websec-"))
  resetSubagentCache()
  const hooks = await SessionMgmtPlugin({ directory: project, client: fakeClient() } as unknown as PluginInput)
  rmSync(identityPath(), { force: true })
  return { hooks, project }
}

const allChecked = {
  scopeAuthorized: true,
  surfaceCovered: true,
  checksEvidenced: true,
  falsePositiveReviewed: true,
  remediationActionable: true,
}

describe("websec 工作流", () => {
  test("未记录范围与边界不得进入安全检查；报告前必须有结构化报告", async () => {
    const { hooks, project } = await startWebsecPlugin()
    const sessionID = "w1"
    const c = ctx(sessionID)
    try {
      expect(hooks.tool!.websec_edge_capture).toBeDefined()
      await hooks.tool!.workflow_start!.execute({} as never, c)
      await expect(
        hooks.tool!.workflow_advance!.execute(
          { stage: "surface", action: "enter", developer_confirmed: true } as never,
          c,
        ),
      ).rejects.toThrow(/websec_scope/)

      await expect(
        hooks.tool!.websec_scope!.execute(
          {
            target: "https://example.test",
            environment: "staging",
            accounts: [{ name: "u1", role: "user" }],
            stopConditions: ["触发告警"],
            developer_confirmed: false,
          } as never,
          c,
        ),
      ).rejects.toThrow(/developer_confirmed/)

      await expect(
        hooks.tool!.websec_scope!.execute(
          {
            target: "https://example.test",
            environment: "staging",
            accounts: [{ name: "u1", role: "user" }],
            stopConditions: ["触发告警"],
            evidence_dir: "../outside",
            developer_confirmed: true,
          } as never,
          c,
        ),
      ).rejects.toThrow(/evidence_dir/)

      await expect(
        hooks.tool!.websec_scope!.execute(
          {
            target: "https://example.test",
            environment: "staging",
            accounts: [{ name: "u1", role: "user" }],
            stopConditions: ["触发告警"],
            developer_confirmed: true,
          } as never,
          c,
        ),
      ).resolves.toContain("测试范围与边界已记录")

      await expect(
        hooks.tool!.workflow_advance!.execute(
          { stage: "surface", action: "enter", developer_confirmed: true } as never,
          c,
        ),
      ).rejects.toThrow(/websec_edge_capture/)

      await expect(
        hooks.tool!.websec_edge_capture!.execute(
          { action: "fallback", mode: "normal", reason: "测试环境无 Edge", developer_confirmed: true } as never,
          c,
        ),
      ).rejects.toThrow(/start.*失败/)

      const db = Store.open(project, () => "websec")
      db.mutateWorkflow(sessionID, (wf) => {
        wf.websec = { ...wf.websec!, edgeError: "模拟启动失败" }
      })
      db.close()

      await expect(
        hooks.tool!.websec_edge_capture!.execute(
          { action: "fallback", mode: "normal", reason: "测试环境无 Edge", developer_confirmed: true } as never,
          c,
        ),
      ).resolves.toContain("fallback")

      await hooks.tool!.workflow_advance!.execute(
        { stage: "surface", action: "enter", developer_confirmed: true } as never,
        c,
      )
      await hooks.tool!.workflow_advance!.execute(
        { stage: "surface", action: "approve", developer_confirmed: true } as never,
        c,
      )
      await hooks.tool!.workflow_advance!.execute(
        { stage: "checks", action: "enter", developer_confirmed: true } as never,
        c,
      )
      await hooks.tool!.workflow_advance!.execute(
        { stage: "checks", action: "approve", developer_confirmed: true } as never,
        c,
      )
      await hooks.tool!.workflow_advance!.execute(
        { stage: "verify", action: "enter", developer_confirmed: true } as never,
        c,
      )
      await hooks.tool!.workflow_advance!.execute(
        { stage: "verify", action: "approve", developer_confirmed: true } as never,
        c,
      )
      await hooks.tool!.workflow_advance!.execute(
        { stage: "report", action: "enter", developer_confirmed: true } as never,
        c,
      )

      await expect(
        hooks.tool!.review_submit!.execute({ ...allChecked } as never, c),
      ).rejects.toThrow(/websec_report/)

      await hooks.tool!.websec_evidence!.execute(
        {
          id: "ev1",
          url: "https://example.test/api/users/1",
          method: "GET",
          identity: "u1",
          hash: "a".repeat(64),
          bodyPresent: true,
        } as never,
        c,
      )

      await expect(
        hooks.tool!.websec_report!.execute(
          {
            method: "manual + Edge/CDP",
            verdict: "issues_found",
            findings: [
              {
                title: "IDOR 读取他人资料",
                category: "authz",
                severity: "high",
                endpoint: "/api/users/1",
                status: "confirmed",
                evidenceRef: "ev-missing",
                reproduction: "baseline: 用户 1 读取自己；proof: 用户 1 读取用户 2",
                impact: "可读取他人资料",
                remediation: "按当前用户校验资源归属",
              },
            ],
          } as never,
          c,
        ),
      ).rejects.toThrow(/ev-missing/)

      await expect(
        hooks.tool!.websec_report!.execute(
          {
            method: "manual + Edge/CDP",
            verdict: "issues_found",
            findings: [
              {
                title: "IDOR 读取他人资料",
                category: "authz",
                severity: "high",
                endpoint: "/api/users/1",
                status: "confirmed",
                evidenceRef: "ev1",
                reproduction: "baseline: 用户 1 读取自己；proof: 用户 1 读取用户 2",
                impact: "可读取他人资料",
                remediation: "按当前用户校验资源归属",
              },
            ],
          } as never,
          c,
        ),
      ).resolves.toContain("WEB 安全测试报告已提交")

      await expect(
        hooks.tool!.review_submit!.execute({ ...allChecked } as never, c),
      ).rejects.toThrow(/预估工时/)

      await hooks["chat.message"]!(
        { sessionID, messageID: "m-est" },
        current(sessionID, "m-est", "这是安全测试，预估 2 小时"),
      )
      await expect(
        hooks.tool!.workflow_baseline!.execute({ estimated_hours: 2, developer_confirmed: true } as never, c),
      ).resolves.toContain("已记录")

      const final = await hooks.tool!.review_submit!.execute({ ...allChecked } as never, c)
      expect(String(final)).toContain("report.md")
      expect(String(final)).toContain("report.json")
    } finally {
      await hooks.dispose!()
      rmSync(project, { recursive: true, force: true })
    }
  })
})
