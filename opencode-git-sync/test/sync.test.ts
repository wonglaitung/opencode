import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { deriveKey, encrypt } from "../src/crypto"
import { git } from "../src/git"
import { OpencodeDb } from "../src/ocdb"
import { encodePack, packPath } from "../src/payload"
import { SyncRepo } from "../src/repo"
import { State } from "../src/state"
import { SyncService } from "../src/sync"
import { createOpencodeDb, fakeClient, tempDir } from "./helpers"
import { useTempStateDir } from "./helpers"

useTempStateDir()
import type { MessageWithParts, OpencodeClient, SessionInfo } from "../src/types"

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
    expect(listing.stdout).toContain("sessions/ses_1/packs/pack-000001.ocgs")
    expect(listing.stdout).not.toContain("sessions/ses_1/msg_1.ocgs")

    const blob = await git(["show", "ocsync/machine-a:sessions/ses_1/packs/pack-000001.ocgs"], {
      cwd: repoA.dir,
      timeoutMs: 10000,
    })
    expect(blob.stdout).not.toContain("在 /home/a/proj 里看到了")
    expect(blob.stdout).not.toContain("你好")
  })
})

function buildService(root: string, remote: string, machine: string, client: OpencodeClient) {
  const state = new State(path.join(root, `${machine}.db`))
  const repo = new SyncRepo({ dir: path.join(root, machine), remote, machine, timeoutMs: 10000 })
  const service = new SyncService({
    repo,
    state,
    client,
    rules: { worktree: "/home/a/proj", directory: "/home/a/proj" },
    scope: { projectID: "proj_a", directory: "/home/a/proj", path: "" },
    passphrase: PASSPHRASE,
    machine,
    timeoutMs: 10000,
  })
  return { state, repo, service }
}

function manyMessages(sessionID: string, count: number, size = 1200): MessageWithParts[] {
  return Array.from({ length: count }, (_, index) => ({
    info: { id: `msg_${index}`, sessionID, role: "user", time: { created: 1000 + index } },
    parts: [
      {
        id: `prt_${index}`,
        messageID: `msg_${index}`,
        sessionID,
        type: "text",
        text: `${index}:`.padEnd(size, "x"),
      },
    ],
  }))
}

/** 从 `git ls-tree -r` 输出里取某个路径的 blob SHA。 */
function blobOf(listing: string, pathSuffix: string): string | undefined {
  return listing
    .split("\n")
    .find((line) => line.endsWith(pathSuffix))
    ?.split(/\s+/)[2]
}

describe("消息封包", () => {
  test("大量消息按 256KB 封口，只重写最后一个包", async () => {
    const root = tempDir("sync-pack-")
    const remote = await setupRemote(root)
    const session = { ...sessionInfo, id: "ses_big" }
    const messages = manyMessages("ses_big", 300)
    const { state, repo, service } = buildService(
      root,
      remote,
      "machine-a",
      fakeClient({ ses_big: { info: session, messages } }),
    )

    await service.prepare()
    expect(await service.stage("ses_big")).toBe(true)
    expect(await service.push()).toBe(true)

    const first = await git(["ls-tree", "-r", "ocsync/machine-a"], { cwd: repo.dir, timeoutMs: 10000 })
    const packs = first.stdout.split("\n").filter((line) => line.includes("/packs/pack-"))
    expect(packs.length).toBeGreaterThan(1)
    expect(first.stdout).not.toContain("msg_0.ocgs")

    messages.push({
      info: { id: "msg_new", sessionID: "ses_big", role: "user", time: { created: 9999 } },
      parts: [{ id: "prt_new", messageID: "msg_new", sessionID: "ses_big", type: "text", text: "new" }],
    })
    expect(await service.stage("ses_big")).toBe(true)

    const second = await git(["ls-tree", "-r", "ocsync/machine-a"], { cwd: repo.dir, timeoutMs: 10000 })
    expect(blobOf(second.stdout, "packs/pack-000001.ocgs")).toBe(blobOf(first.stdout, "packs/pack-000001.ocgs"))

    state.close()
  })

  test("旧布局文件迁移成封包后可被另一台机器导入", async () => {
    const root = tempDir("sync-migrate-")
    const remote = await setupRemote(root)
    const a = buildService(root, remote, "machine-a", fakeClient({}))

    await a.service.prepare()
    await a.service.push()

    const key = deriveKey(PASSPHRASE, a.state.salt()!)
    const repoId = a.state.repoId()!
    const metaPath = "sessions/ses_1/meta.ocgs"
    await a.repo.writeFiles([
      ...messages.map((message) => {
        const filePath = `sessions/ses_1/${message.info.id}.ocgs`
        return { path: filePath, content: encrypt(Buffer.from(JSON.stringify(message)), key, repoId, filePath) }
      }),
      { path: metaPath, content: encrypt(Buffer.from(JSON.stringify(sessionInfo)), key, repoId, metaPath) },
    ])
    await a.service.migrateLegacy()

    const listing = await git(["ls-tree", "-r", "ocsync/machine-a"], { cwd: a.repo.dir, timeoutMs: 10000 })
    expect(listing.stdout).toContain("sessions/ses_1/packs/pack-000001.ocgs")
    expect(listing.stdout).toContain("sessions/ses_1/meta.ocgs")
    expect(listing.stdout).not.toContain("msg_1.ocgs")

    const dbFile = path.join(root, "opencode.db")
    createOpencodeDb(dbFile)
    const b = buildService(root, remote, "machine-b", fakeClient({}))
    await b.service.prepare()
    const db = new OpencodeDb(dbFile)
    const result = await b.service.pull(db)
    expect(result.messages).toBe(2)
    expect(db.hasSession("ses_1")).toBe(true)
    db.close()

    a.state.close()
    b.state.close()
  })

  test("后序封包里的同 ID 消息覆盖前序封包", async () => {
    const root = tempDir("sync-overlay-")
    const remote = await setupRemote(root)
    const a = buildService(root, remote, "machine-a", fakeClient({ ses_1: { info: sessionInfo, messages } }))

    await a.service.prepare()
    await a.service.stage("ses_1")
    await a.service.push()

    const key = deriveKey(PASSPHRASE, a.state.salt()!)
    const edited: MessageWithParts = {
      info: { ...messages[0]!.info },
      parts: [{ id: "prt_1", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "改写后的内容" }],
    }
    const overlayPath = packPath("ses_1", 2)
    await a.repo.writeFiles([
      { path: overlayPath, content: encrypt(encodePack([edited]), key, a.state.repoId()!, overlayPath) },
    ])
    await a.repo.commit("overlay")
    await a.repo.push()

    const dbFile = path.join(root, "opencode.db")
    createOpencodeDb(dbFile)
    const b = buildService(root, remote, "machine-b", fakeClient({}))
    await b.service.prepare()
    const db = new OpencodeDb(dbFile)
    await b.service.pull(db)
    db.close()

    const raw = createOpencodeDb(dbFile)
    const row = raw.query("SELECT data FROM part WHERE id = 'prt_1'").get() as { data?: string } | null
    expect(String(row?.data)).toContain("改写后的内容")
    raw.close()

    a.state.close()
    b.state.close()
  })
})
