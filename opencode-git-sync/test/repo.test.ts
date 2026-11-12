import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { git } from "../src/git"
import { SyncRepo } from "../src/repo"
import { tempDir } from "./helpers"

function initBare(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
  return git(["init", "-q", "--bare", dir], { cwd: tempDir("cwd-"), timeoutMs: 10000 })
}

describe("sync repo", () => {
  test("amend 提交保持历史恒定 1 条", async () => {
    const root = tempDir("repo-")
    const remote = path.join(root, "remote.git")
    await initBare(remote)

    const repo = new SyncRepo({ dir: path.join(root, "work"), remote, machine: "m1", timeoutMs: 10000 })
    await repo.ensure()

    for (let i = 0; i < 3; i++) {
      await repo.writeFiles([{ path: `sessions/s${i}/meta.ocgs`, content: Buffer.from(`payload-${i}`) }])
      await repo.commit(`round ${i}`)
    }
    await repo.push()

    const log = await git(["log", "--oneline", repo.branch()], { cwd: repo.dir, timeoutMs: 10000 })
    expect(log.stdout.trim().split("\n").filter(Boolean).length).toBe(1)
  })

  test("两台机器通过远端互相可见（各自一条分支）", async () => {
    const root = tempDir("repo-")
    const remote = path.join(root, "remote.git")
    await initBare(remote)

    const a = new SyncRepo({ dir: path.join(root, "a"), remote, machine: "machine-a", timeoutMs: 10000 })
    const b = new SyncRepo({ dir: path.join(root, "b"), remote, machine: "machine-b", timeoutMs: 10000 })
    await a.ensure()
    await b.ensure()

    await a.writeFiles([{ path: "sessions/s1/msg_1.ocgs", content: Buffer.from("hello") }])
    await a.commit("a")
    expect(await a.push()).toBe(true)

    expect(await b.fetch()).toBe(true)
    const branches = await b.remoteBranches()
    expect(branches).toContain("ocsync/machine-a")

    const files = await b.readRemoteFiles()
    const branch = files.get("ocsync/machine-a")
    expect(branch?.get("sessions/s1/msg_1.ocgs")?.toString("utf8")).toBe("hello")
  })

  test("远端为空时 fetch 不报错", async () => {
    const root = tempDir("repo-")
    const remote = path.join(root, "remote.git")
    await initBare(remote)
    const repo = new SyncRepo({ dir: path.join(root, "work"), remote, machine: "m1", timeoutMs: 10000 })
    await repo.ensure()
    expect(await repo.fetch()).toBe(true)
    expect(await repo.remoteBranches()).toEqual([])
  })
})
