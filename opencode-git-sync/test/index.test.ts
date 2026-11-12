import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { git } from "../src/git"
import { createOpencodeDb, fakeClient, resetStateDir, tempDir, useTempStateDir } from "./helpers"

useTempStateDir()
import type { PluginEvent, PluginInput } from "../src/types"

const PASSPHRASE = "plugin-passphrase"

/** 以插件加载器的视角调用工厂：模块只导出这一个函数。 */
async function loadPlugin(input: PluginInput, options: Record<string, unknown>) {
  const mod = await import("../src/index")
  const factory = mod.default
  expect(typeof factory).toBe("function")
  return factory(input, options)
}

describe("插件入口", () => {
  test("返回 event / dispose 钩子，且 session.idle 会触发推送", async () => {
    const root = tempDir("plugin-")
    const remote = path.join(root, "remote.git")
    fs.mkdirSync(remote, { recursive: true })
    await git(["init", "-q", "--bare", remote], { cwd: root, timeoutMs: 10000 })

    process.env["OPENCODE_GIT_SYNC_DIR"] = path.join(root, "state")
    process.env["OPENCODE_DB"] = path.join(root, "opencode.db")
    createOpencodeDb(process.env["OPENCODE_DB"])

    const session = {
      id: "ses_hook",
      title: "钩子测试",
      directory: "/home/a/proj",
      version: "1.19.4",
      time: { created: 1000, updated: 2000 },
    }
    const input: PluginInput = {
      client: fakeClient({
        ses_hook: {
          info: session,
          messages: [
            {
              info: { id: "msg_1", sessionID: "ses_hook", role: "user", time: { created: 1000 } },
              parts: [{ id: "prt_1", messageID: "msg_1", sessionID: "ses_hook", type: "text", text: "hi" }],
            },
          ],
        },
      }),
      project: { id: "proj_x" },
      directory: "/home/a/proj",
      worktree: "/home/a/proj",
    }

    const hooks = await loadPlugin(input, {
      remote,
      passphrase: PASSPHRASE,
      machine: "machine-a",
      debounceMs: 10,
      syncTimeoutMs: 5000,
    })

    expect(typeof hooks.event).toBe("function")
    expect(typeof hooks.dispose).toBe("function")

    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_hook" } } as PluginEvent })
    await hooks.dispose?.()

    // 远端应当出现本机分支，且包含加密后的会话文件
    const refs = await git(["ls-remote", remote], { cwd: root, timeoutMs: 10000 })
    expect(refs.stdout).toContain("refs/heads/ocsync/machine-a")

    resetStateDir()
    delete process.env["OPENCODE_DB"]
  })

  test("缺少 remote 或 passphrase 时不启用", async () => {
    const root = tempDir("plugin-off-")
    process.env["OPENCODE_GIT_SYNC_DIR"] = path.join(root, "state")
    const input: PluginInput = {
      client: fakeClient({}),
      project: { id: "p" },
      directory: "/tmp",
      worktree: "/tmp",
    }
    expect(Object.keys(await loadPlugin(input, { passphrase: "x" })).length).toBe(0)
    expect(Object.keys(await loadPlugin(input, { remote: "x" })).length).toBe(0)
    expect(Object.keys(await loadPlugin(input, { remote: "x", passphrase: "y", enabled: false })).length).toBe(0)
    resetStateDir()
  })

  test("支持从口令文件读取 passphrase", async () => {
    const root = tempDir("plugin-")
    const keyFile = path.join(root, "key.txt")
    fs.writeFileSync(keyFile, "  file-passphrase\n")
    const remote = path.join(root, "remote.git")
    fs.mkdirSync(remote, { recursive: true })
    await git(["init", "-q", "--bare", remote], { cwd: root, timeoutMs: 10000 })

    const input: PluginInput = {
      client: fakeClient({}),
      project: { id: "p" },
      directory: "/tmp",
      worktree: "/tmp",
    }
    const hooks = await loadPlugin(input, { remote, passphraseFile: keyFile })
    expect(typeof hooks.event).toBe("function")
  })
})
