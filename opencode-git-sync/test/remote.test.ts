import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { git } from "../src/git"
import { detectRemote } from "../src/remote"
import { createOpencodeDb, fakeClient, tempDir } from "./helpers"
import { useTempStateDir } from "./helpers"

useTempStateDir()
import type { PluginInput } from "../src/types"

/** 建一个带 origin 远端的项目仓库，模拟真实项目。 */
async function makeProject(root: string): Promise<{ worktree: string; remote: string }> {
  const worktree = path.join(root, "project")
  const remote = path.join(root, "origin.git")
  fs.mkdirSync(worktree, { recursive: true })
  fs.mkdirSync(remote, { recursive: true })
  await git(["init", "-q", "--bare", remote], { cwd: root, timeoutMs: 10000 })
  await git(["init", "-q", worktree], { cwd: root, timeoutMs: 10000 })
  await git(["remote", "add", "origin", remote], { cwd: worktree, timeoutMs: 10000 })
  return { worktree, remote }
}

describe("远端自动探测", () => {
  test("取项目自身的 origin", async () => {
    const root = tempDir("remote-")
    const { worktree, remote } = await makeProject(root)
    expect(await detectRemote(worktree)).toBe(remote)
  })

  test("没有 origin 时退到第一个 remote", async () => {
    const root = tempDir("remote-")
    const { worktree, remote } = await makeProject(root)
    await git(["remote", "remove", "origin"], { cwd: worktree, timeoutMs: 10000 })
    await git(["remote", "add", "upstream", remote], { cwd: worktree, timeoutMs: 10000 })
    expect(await detectRemote(worktree)).toBe(remote)
  })

  test("不是 git 仓库时返回 undefined", async () => {
    const root = tempDir("remote-")
    const plain = path.join(root, "plain")
    fs.mkdirSync(plain, { recursive: true })
    expect(await detectRemote(plain)).toBeUndefined()
  })
})

describe("零配置启用", () => {
  test("口令文件放在默认位置即可启用（无需任何配置项）", async () => {
    const root = tempDir("zeroconf-")
    const { worktree, remote } = await makeProject(root)

    const configHome = path.join(root, "config")
    fs.mkdirSync(path.join(configHome, "opencode"), { recursive: true })
    fs.writeFileSync(path.join(configHome, "opencode", "git-sync.key"), "default-passphrase\n")

    process.env["XDG_CONFIG_HOME"] = configHome
    process.env["OPENCODE_GIT_SYNC_DIR"] = path.join(root, "state")
    process.env["OPENCODE_DB"] = path.join(root, "opencode.db")
    createOpencodeDb(process.env["OPENCODE_DB"])

    const input: PluginInput = {
      client: fakeClient({}),
      project: { id: "proj" },
      directory: worktree,
      worktree,
    }
    const mod = await import("../src/index")
    const hooks = await mod.default(input, {})
    expect(typeof hooks.event).toBe("function")

    // 同步仓库应指向项目自身的 origin
    const repoRemote = await git(["remote", "get-url", "origin"], {
      cwd: path.join(root, "state", "repo"),
      timeoutMs: 10000,
    })
    expect(repoRemote.stdout.trim()).toBe(remote)

    delete process.env["XDG_CONFIG_HOME"]
    delete process.env["OPENCODE_GIT_SYNC_DIR"]
    delete process.env["OPENCODE_DB"]
  })
})
