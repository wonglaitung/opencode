import { describe, expect, test } from "bun:test"
import path from "node:path"
import { git } from "../src/git"
import { projectKey, projectStateDir } from "../src/paths"
import { createOpencodeDb, fakeClient, resetStateDir, tempDir, useTempStateDir } from "./helpers"
import type { PluginInput } from "../src/types"

useTempStateDir()

/** 建一个带 origin 远端的项目仓库，模拟真实项目。 */
async function makeProject(root: string, name: string) {
  const worktree = path.join(root, name, "project")
  const remote = path.join(root, name, "origin.git")
  await Bun.write(path.join(root, name, ".keep"), "")
  const { mkdir } = await import("node:fs/promises")
  await mkdir(worktree, { recursive: true })
  await mkdir(remote, { recursive: true })
  await git(["init", "-q", "--bare", remote], { cwd: root, timeoutMs: 10000 })
  await git(["init", "-q", worktree], { cwd: root, timeoutMs: 10000 })
  await git(["remote", "add", "origin", remote], { cwd: worktree, timeoutMs: 10000 })
  return { worktree, remote }
}

describe("按项目隔离状态目录", () => {
  test("项目键：同路径同键、异路径异键、文件名安全", () => {
    expect(projectKey("/a/proj")).toBe(projectKey("/a/proj"))
    expect(projectKey("/a/proj")).not.toBe(projectKey("/b/proj"))
    expect(projectKey("/a/my proj")).toMatch(/^[A-Za-z0-9._-]+$/)
  })

  test("两个项目的同步仓各指向自己的 origin，互不覆盖", async () => {
    const root = tempDir("per-project-")
    const a = await makeProject(root, "a")
    const b = await makeProject(root, "b")
    process.env["OPENCODE_GIT_SYNC_DIR"] = path.join(root, "state")
    process.env["OPENCODE_DB"] = path.join(root, "opencode.db")
    createOpencodeDb(process.env["OPENCODE_DB"])

    const mod = await import("../src/index")
    const input = (worktree: string): PluginInput => ({
      client: fakeClient({}),
      project: { id: worktree },
      directory: worktree,
      worktree,
    })
    const originOf = async (worktree: string) =>
      (
        await git(["remote", "get-url", "origin"], {
          cwd: path.join(projectStateDir(worktree), "repo"),
          timeoutMs: 10000,
        })
      ).stdout.trim()

    await mod.default(input(a.worktree), { passphrase: "p" })
    expect(await originOf(a.worktree)).toBe(a.remote)

    await mod.default(input(b.worktree), { passphrase: "p" })
    expect(await originOf(b.worktree)).toBe(b.remote)

    // 后加载的项目不得改写前一个项目的远端
    expect(await originOf(a.worktree)).toBe(a.remote)
    expect(projectStateDir(a.worktree)).not.toBe(projectStateDir(b.worktree))

    resetStateDir()
    delete process.env["OPENCODE_DB"]
  })
})
