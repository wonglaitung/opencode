import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { git } from "../src/git"
import { OpencodeDb } from "../src/ocdb"
import { SyncRepo } from "../src/repo"
import { State } from "../src/state"
import { SyncService } from "../src/sync"
import { createOpencodeDb, fakeClient, tempDir } from "./helpers"
import { useTempStateDir } from "./helpers"

useTempStateDir()
import type { MessageWithParts, SessionInfo } from "../src/types"

const PASSPHRASE = "shared-passphrase"

const sessionInfo: SessionInfo = {
  id: "ses_1",
  title: "跨机会话",
  directory: "/home/a/proj",
  parentID: undefined,
  version: "1.19.4",
  time: { created: 1000, updated: 2000 },
}

const messages: MessageWithParts[] = [
  {
    info: { id: "msg_1", sessionID: "ses_1", role: "user", time: { created: 1000 } },
    parts: [{ id: "prt_1", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "你好" }],
  },
  {
    info: { id: "msg_2", sessionID: "ses_1", role: "assistant", time: { created: 1100 } },
    parts: [{ id: "prt_2", messageID: "msg_2", sessionID: "ses_1", type: "text", text: "在 /home/a/proj 里看到了" }],
  },
]

async function setupRemote(root: string): Promise<string> {
  const remote = path.join(root, "remote.git")
  fs.mkdirSync(remote, { recursive: true })
  await git(["init", "-q", "--bare", remote], { cwd: root, timeoutMs: 10000 })
  return remote
}

describe("端到端：机器 A 推送 → 机器 B 导入", () => {
  test("B 能解密并导入 A 的会话与消息", async () => {
    const root = tempDir("sync-")
    const remote = await setupRemote(root)

    const stateA = new State(path.join(root, "a.db"))
    const repoA = new SyncRepo({ dir: path.join(root, "a"), remote, machine: "machine-a", timeoutMs: 10000 })
    const serviceA = new SyncService({
      repo: repoA,
      state: stateA,
      client: fakeClient({ ses_1: { info: sessionInfo, messages } }),
      rules: { worktree: "/home/a/proj", directory: "/home/a/proj" },
      scope: { projectID: "proj_a", directory: "/home/a/proj", path: "" },
      passphrase: PASSPHRASE,
      machine: "machine-a",
      timeoutMs: 10000,
    })

    await serviceA.prepare()
    expect(await serviceA.stage("ses_1")).toBe(true)
    expect(await serviceA.push()).toBe(true)

    // 机器 B
    const dbFile = path.join(root, "opencode.db")
    createOpencodeDb(dbFile)
    const stateB = new State(path.join(root, "b.db"))
    const repoB = new SyncRepo({ dir: path.join(root, "b"), remote, machine: "machine-b", timeoutMs: 10000 })
    const serviceB = new SyncService({
      repo: repoB,
      state: stateB,
      client: fakeClient({}),
      rules: { worktree: "/home/b/proj", directory: "/home/b/proj" },
      scope: { projectID: "proj_b", directory: "/home/b/proj", path: "" },
      passphrase: PASSPHRASE,
      machine: "machine-b",
      timeoutMs: 10000,
    })

    await serviceB.prepare()
    const db = new OpencodeDb(dbFile)
    const result = await serviceB.pull(db)

    expect(result.skipped).toBe(false)
    expect(result.sessions).toBe(1)
    expect(result.messages).toBe(2)

    const raw = createOpencodeDb(dbFile)
    const session = raw.query("SELECT * FROM session WHERE id = ?").get("ses_1") as Record<string, unknown>
    expect(session["project_id"]).toBe("proj_b")
    expect(session["directory"]).toBe("/home/b/proj")
    expect(session["title"]).toBe("跨机会话")

    const messageRows = raw.query("SELECT * FROM message WHERE session_id = ? ORDER BY time_created").all("ses_1") as Array<
      Record<string, unknown>
    >
    expect(messageRows.length).toBe(2)

    const partRows = raw.query("SELECT * FROM part WHERE session_id = ?").all("ses_1") as Array<Record<string, unknown>>
    expect(partRows.length).toBe(2)
    const assistantPart = partRows.find((row) => row["id"] === "prt_2")
    expect(String(assistantPart?.["data"])).toContain("/home/b/proj")
    expect(String(assistantPart?.["data"])).not.toContain("/home/a/proj")

    db.close()
    raw.close()
    stateA.close()
    stateB.close()
  })

  test("passphrase 不匹配时不导入任何数据", async () => {
    const root = tempDir("sync-")
    const remote = await setupRemote(root)

    const stateA = new State(path.join(root, "a.db"))
    const repoA = new SyncRepo({ dir: path.join(root, "a"), remote, machine: "machine-a", timeoutMs: 10000 })
    const serviceA = new SyncService({
      repo: repoA,
      state: stateA,
      client: fakeClient({ ses_1: { info: sessionInfo, messages } }),
      rules: { worktree: "/home/a/proj", directory: "/home/a/proj" },
      scope: { projectID: "proj_a", directory: "/home/a/proj", path: "" },
      passphrase: PASSPHRASE,
      machine: "machine-a",
      timeoutMs: 10000,
    })
    await serviceA.prepare()
    await serviceA.stage("ses_1")
    await serviceA.push()

    const dbFile = path.join(root, "opencode.db")
    createOpencodeDb(dbFile)
    const stateB = new State(path.join(root, "b.db"))
    const repoB = new SyncRepo({ dir: path.join(root, "b"), remote, machine: "machine-b", timeoutMs: 10000 })
    const serviceB = new SyncService({
      repo: repoB,
      state: stateB,
      client: fakeClient({}),
      rules: { worktree: "/home/b/proj", directory: "/home/b/proj" },
      scope: { projectID: "proj_b", directory: "/home/b/proj", path: "" },
      passphrase: "wrong-passphrase",
      machine: "machine-b",
      timeoutMs: 10000,
    })
    await serviceB.prepare()
    const db = new OpencodeDb(dbFile)
    const result = await serviceB.pull(db)
    expect(result.skipped).toBe(true)

    const raw = createOpencodeDb(dbFile)
    const count = raw.query("SELECT COUNT(*) AS count FROM session").get() as { count: number }
    expect(count.count).toBe(0)

    db.close()
    raw.close()
    stateA.close()
    stateB.close()
  })

  test("仓库里只有密文，没有明文会话内容", async () => {
    const root = tempDir("sync-")
    const remote = await setupRemote(root)

    const stateA = new State(path.join(root, "a.db"))
    const repoA = new SyncRepo({ dir: path.join(root, "a"), remote, machine: "machine-a", timeoutMs: 10000 })
    const serviceA = new SyncService({
      repo: repoA,
      state: stateA,
      client: fakeClient({ ses_1: { info: sessionInfo, messages } }),
      rules: { worktree: "/home/a/proj", directory: "/home/a/proj" },
      scope: { projectID: "proj_a", directory: "/home/a/proj", path: "" },
      passphrase: PASSPHRASE,
      machine: "machine-a",
      timeoutMs: 10000,
    })
    await serviceA.prepare()
    await serviceA.stage("ses_1")
    await serviceA.push()

    const listing = await git(["ls-tree", "-r", "ocsync/machine-a"], { cwd: repoA.dir, timeoutMs: 10000 })
    expect(listing.stdout).toContain("sessions/ses_1/meta.ocgs")
    expect(listing.stdout).toContain("sessions/ses_1/msg_1.ocgs")

    const blob = await git(["show", "ocsync/machine-a:sessions/ses_1/msg_2.ocgs"], { cwd: repoA.dir, timeoutMs: 10000 })
    expect(blob.stdout).not.toContain("在 /home/a/proj 里看到了")
    expect(blob.stdout).not.toContain("你好")
  })
})
