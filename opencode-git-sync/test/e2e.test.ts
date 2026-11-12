import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { git } from "../src/git"
import { createOpencodeDb, fakeClient, resetStateDir, tempDir } from "./helpers"
import type { PluginInput } from "../src/types"

/**
 * 真实形态端到端：两台机器各自有一个项目仓库（同一 origin），
 * 机器 A 产生会话 → 插件自动探测远端并推送 → 机器 B 首屏同步把会话导入本地库。
 */
async function makeMachine(root: string, name: string, remote: string) {
  const worktree = path.join(root, name, "project")
  fs.mkdirSync(worktree, { recursive: true })
  await git(["init", "-q", worktree], { cwd: root, timeoutMs: 10000 })
  await git(["remote", "add", "origin", remote], { cwd: worktree, timeoutMs: 10000 })
  const dbFile = path.join(root, name, "opencode.db")
  createOpencodeDb(dbFile)
  return { worktree, dbFile, stateDir: path.join(root, name, "state") }
}

describe("端到端：两台机器自动探测同一远端", () => {
  test("A 推送后 B 首屏同步能导入会话", async () => {
    const root = tempDir("e2e-")
    const remote = path.join(root, "origin.git")
    fs.mkdirSync(remote, { recursive: true })
    await git(["init", "-q", "--bare", remote], { cwd: root, timeoutMs: 10000 })

    const a = await makeMachine(root, "machine-a", remote)
    const b = await makeMachine(root, "machine-b", remote)

    const session = {
      id: "ses_e2e",
      title: "跨机接力",
      directory: a.worktree,
      version: "1.19.4",
      time: { created: 1000, updated: 2000 },
    }
    const messages = [
      {
        info: { id: "msg_e2e", sessionID: "ses_e2e", role: "user", time: { created: 1000 } },
        parts: [{ id: "prt_e2e", messageID: "msg_e2e", sessionID: "ses_e2e", type: "text", text: "继续" }],
      },
    ]

    const inputA: PluginInput = {
      client: fakeClient({ ses_e2e: { info: session, messages } }),
      project: { id: "proj" },
      directory: a.worktree,
      worktree: a.worktree,
    }

    // --- 机器 A：加载插件 → 触发 idle → 冲刷推送
    process.env["OPENCODE_GIT_SYNC_DIR"] = a.stateDir
    process.env["OPENCODE_DB"] = a.dbFile
    const mod = await import("../src/index")
    const hooksA = await mod.default(inputA, { passphrase: "e2e-passphrase", debounceMs: 10 })
    await hooksA.event?.({
      event: { type: "session.idle", properties: { sessionID: "ses_e2e" } },
    })
    await hooksA.dispose?.()

    // 远端应出现机器 A 的分支
    const refs = await git(["ls-remote", remote], { cwd: root, timeoutMs: 10000 })
    expect(refs.stdout).toContain("refs/heads/ocsync/")

    // --- 机器 B：加载插件（首屏同步）→ 会话应落到 B 的本地库
    process.env["OPENCODE_GIT_SYNC_DIR"] = b.stateDir
    process.env["OPENCODE_DB"] = b.dbFile
    const inputB: PluginInput = {
      client: fakeClient({}),
      project: { id: "proj" },
      directory: b.worktree,
      worktree: b.worktree,
    }
    const hooksB = await mod.default(inputB, { passphrase: "e2e-passphrase", syncTimeoutMs: 15000 })
    expect(typeof hooksB.event).toBe("function")

    const db = createOpencodeDb(b.dbFile)
    const sessionRow = db.query("SELECT * FROM session WHERE id = ?").get("ses_e2e") as Record<string, unknown> | null
    expect(sessionRow).not.toBeNull()
    expect(sessionRow?.["title"]).toBe("跨机接力")
    expect(sessionRow?.["directory"]).toBe(b.worktree)

    const messageRows = db.query("SELECT * FROM message WHERE session_id = ?").all("ses_e2e") as Array<
      Record<string, unknown>
    >
    expect(messageRows.length).toBe(1)
    db.close()

    resetStateDir()
    delete process.env["OPENCODE_DB"]
  })
})
