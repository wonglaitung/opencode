/**
 * chat.message 工时证据捕获端到端护栏（6.3 防 AI 杜撰基线，线上 P1 回归）。
 *
 * 缺陷史：上游在消息**落库前**触发 chat.message（prompt.ts 先 trigger 后 updateMessage），
 * 旧实现丢弃 hook 传入的当前消息、回读历史消息 → 恒少当前这条：证据滞后一条，且被上一条
 * 无工时消息清空 → workflow_baseline 对开发者已报出的数字连续拒收。
 *
 * 两条端到端断言方向相反（该放行的放行 / 该拒收的拒收），配合文本契约——回退旧实现在
 * 三处全红。fake client 复现线上时序：session.messages 只含**上一条**用户消息。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import SessionMgmtPlugin from "../src/index"
import { resetSubagentCache } from "../src/subagent"

const ctx = (sessionID: string) => ({ sessionID }) as never

/** 上一条用户消息文本（当前消息尚未落库，回读只能看到它）。 */
function staleClient(lastUserText: string): PluginInput["client"] {
  return {
    session: {
      get: async () => ({ data: { id: "s", title: "会话标题" } }),
      messages: async () => ({
        data: [
          {
            info: { id: "prev", role: "user", sessionID: "s" },
            parts: [
              { id: "p0", sessionID: "s", messageID: "prev", type: "text", text: lastUserText },
            ],
          },
        ],
      }),
      list: async () => ({ data: [] }),
    },
  } as unknown as PluginInput["client"]
}

/** 当前用户消息（hook 第 2 参），与落库前的上游形态一致。 */
function current(sessionID: string, messageID: string, text: string) {
  return {
    message: {
      id: messageID,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: "p", modelID: "m" },
    },
    parts: [{ id: messageID, sessionID, messageID, type: "text", text }],
  } as never
}

/** 起一个插件实例（每测试独立临时项目库，HOME 指向空目录保证无身份外联）。 */
async function start(client: PluginInput["client"], sessionID: string) {
  const project = mkdtempSync(join(tmpdir(), "sm-hook-"))
  resetSubagentCache()
  const hooks = await SessionMgmtPlugin({ directory: project, client } as unknown as PluginInput)
  // 会话 + 工作流记录须先存在（生产由启动流程保证），否则证据写入会空转
  await hooks.tool!.commit_gate_check!.execute({}, ctx(sessionID))
  return { hooks, project }
}

const prevHome = process.env.HOME
let home = ""
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "sm-hook-home-"))
  process.env.HOME = home
})
afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  if (home) rmSync(home, { recursive: true, force: true })
})

describe("chat.message 工时证据取本次消息（6.3，线上 P1 回归）", () => {
  test("当前消息报数即放行：不因回读滞后一条被拒", async () => {
    const { hooks, project } = await start(staleClient("好的，继续"), "hook-accept")
    const c = ctx("hook-accept")
    try {
      await hooks["chat.message"]!(
        { sessionID: "hook-accept", messageID: "cur-a" },
        current("hook-accept", "cur-a", "预估全人工写这份需求书要 24 小时"),
      )
      await expect(
        hooks.tool!.workflow_baseline!.execute({ estimated_hours: 24, developer_confirmed: true } as never, c),
      ).resolves.toContain("已记录基线预估人工工时：24 小时")
    } finally {
      await hooks.dispose!()
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("当前消息无数即拒收：即便库中上一条报过数也不得复用陈旧证据", async () => {
    const { hooks, project } = await start(
      staleClient("预估全人工写这份需求书要 24 小时"),
      "hook-reject",
    )
    const c = ctx("hook-reject")
    try {
      await hooks["chat.message"]!(
        { sessionID: "hook-reject", messageID: "cur-b" },
        current("hook-reject", "cur-b", "先不动，继续边界与异常阶段"),
      )
      await expect(
        hooks.tool!.workflow_baseline!.execute({ estimated_hours: 24, developer_confirmed: true } as never, c),
      ).rejects.toThrow(/未检测到|数字/)
    } finally {
      await hooks.dispose!()
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("文本契约：证据走 output.parts，旧回读路径不得复现", () => {
    const src = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8")
    expect(src).toContain("output.parts.flatMap")
    expect(src).toContain("output.message.id")
    expect(src).not.toContain("captureBaselineFromMessages")
    // 契约只圈 chat.message handler 段（usage 汇总合法使用同一接口，不在此列）
    const handler = src.slice(src.indexOf('"chat.message"'), src.indexOf("dispose:"))
    expect(handler).not.toContain("session.messages")
  })
})
