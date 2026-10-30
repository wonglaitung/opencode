/**
 * task 启动链路端到端护栏：chat.message 只建行、不自动启动；
 * 模型未调 workflow_start 前 task_classify 必须拒绝，启动后才能归类。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import { identityPath, writeIdentity } from "sm-shared"
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
  home = mkdtempSync(join(tmpdir(), "sm-task-home-"))
  process.env.HOME = home
})

async function startTaskPlugin() {
  writeIdentity({ apiKey: "test", collector_url: "http://127.0.0.1:1", workflowType: "task" })
  const project = mkdtempSync(join(tmpdir(), "sm-task-hook-"))
  resetSubagentCache()
  const hooks = await SessionMgmtPlugin({ directory: project, client: fakeClient() } as unknown as PluginInput)
  // 插件已按 task 类型加载；移除身份只让汇报退化为仅本机，避免测试联网产生告警噪声。
  rmSync(identityPath(), { force: true })
  return { hooks, project }
}

afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  if (home) rmSync(home, { recursive: true, force: true })
})

describe("task 启动链路", () => {
  test("首条消息只建行不启动，task_classify 拒绝；workflow_start 后才可归类", async () => {
    const { hooks, project } = await startTaskPlugin()
    const c = ctx("s1")
    try {
      await hooks["chat.message"]!(
        { sessionID: "s1", messageID: "m1" },
        current("s1", "m1", "帮我写一份项目说明文档，预估 2 小时"),
      )
      await expect(
        hooks.tool!.task_classify!.execute({ category: "documentation" } as never, c),
      ).rejects.toThrow(/尚未启动/)
      await hooks.tool!.workflow_start!.execute({} as never, c)
      await expect(
        hooks.tool!.workflow_baseline!.execute({ estimated_hours: 2, developer_confirmed: true } as never, c),
      ).resolves.toContain("已记录")
      await expect(
        hooks.tool!.task_classify!.execute({ category: "documentation" } as never, c),
      ).resolves.toContain("已记录")
    } finally {
      await hooks.dispose!()
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("code_review 只读、报告后完成，完全不关联其他工作流", async () => {
    const { hooks, project } = await startTaskPlugin()
    const sessionID = "r1"
    const c = ctx(sessionID)
    const dimensions = {
      correctness: { status: "pass", notes: "ok" },
      security: { status: "pass", notes: "ok" },
      design: { status: "pass", notes: "ok" },
      tests: { status: "pass", notes: "ok" },
      impact: { status: "pass", notes: "ok" },
      readability: { status: "pass", notes: "ok" },
    }
    try {
      await hooks["chat.message"]!(
        { sessionID, messageID: "m3" },
        current(sessionID, "m3", "帮我审核 src/auth.ts 的登录改动，预估 2 小时"),
      )
      await hooks.tool!.workflow_start!.execute({} as never, c)
      await hooks.tool!.workflow_baseline!.execute(
        { estimated_hours: 2, developer_confirmed: true } as never,
        c,
      )
      await hooks.tool!.task_classify!.execute({ category: "code_review" } as never, c)
      await expect(
        hooks["tool.execute.before"]!(
          { tool: "edit", sessionID, callID: "e1" },
          { args: { filePath: "src/auth.ts" } } as never,
        ),
      ).rejects.toThrow(/只读/)
      await expect(
        hooks.tool!.workflow_advance!.execute(
          { stage: "execute", action: "approve", developer_confirmed: true } as never,
          c,
        ),
      ).rejects.toThrow(/task_review|报告/)
      await expect(
        hooks.tool!.task_review!.execute(
          {
            scope: ["src/auth.ts"],
            dimensions,
            findings: [],
          } as never,
          c,
        ),
      ).resolves.toContain("代码审核报告已提交")
      await expect(
        hooks.tool!.workflow_advance!.execute(
          { stage: "execute", action: "approve", developer_confirmed: true } as never,
          c,
        ),
      ).resolves.toContain("approve")
    } finally {
      await hooks.dispose!()
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("question 选择菜单的预估作为证据，workflow_baseline 放行", async () => {
    const { hooks, project } = await startTaskPlugin()
    const sessionID = "s2"
    const c = ctx(sessionID)
    try {
      await hooks["chat.message"]!(
        { sessionID, messageID: "m2" },
        current(sessionID, "m2", "帮我写一份项目说明文档"),
      )
      await hooks.tool!.workflow_start!.execute({} as never, c)
      // question 工具的答案不会触发 chat.message，必须由 tool.execute.after 捕获
      await hooks["tool.execute.after"]!(
        {
          tool: "question",
          sessionID,
          callID: "q1",
          args: { questions: [{ question: "请提供预估工时（小时）" }] },
        } as never,
        { metadata: { answers: [["2 小时"]] } } as never,
      )
      await expect(
        hooks.tool!.workflow_baseline!.execute({ estimated_hours: 2, developer_confirmed: true } as never, c),
      ).resolves.toContain("已记录")
    } finally {
      await hooks.dispose!()
      rmSync(project, { recursive: true, force: true })
    }
  })
})
