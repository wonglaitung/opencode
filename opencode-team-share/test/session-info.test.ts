import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createTestDb, seedProject, seedSession, type TestDb } from "./helpers"

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url))
const smModule = fileURLToPath(
  new URL("../../opencode-session-mgmt/packages/plugin/src/db/index.ts", import.meta.url),
)

type SmStore = { ensure(id: string): unknown }

let db: TestDb | undefined
let projectDir = ""
let prev: string | undefined

beforeEach(() => {
  db = createTestDb("team-share-session-info")
  projectDir = mkdtempSync(join(tmpdir(), "team-share-project-"))
  const directory = projectDir.replace(/\\/g, "/")
  seedProject(db.db, "proj", directory)
  seedSession(db.db, {
    id: "ses_old",
    projectID: "proj",
    directory,
    title: "旧会话",
    timeUpdated: 1000,
    messages: [],
  })
  seedSession(db.db, {
    id: "ses_new",
    projectID: "proj",
    directory,
    title: "新会话",
    timeUpdated: 2000,
    messages: [],
  })
  prev = process.env["TEAM_SHARE_SM_DB"]
  process.env["TEAM_SHARE_SM_DB"] = smModule
})

afterEach(() => {
  db?.close()
  db = undefined
  rmSync(projectDir, { recursive: true, force: true })
  if (prev === undefined) delete process.env["TEAM_SHARE_SM_DB"]
  else process.env["TEAM_SHARE_SM_DB"] = prev
})

function run(args: string[]) {
  if (!db) throw new Error("db not ready")
  return Bun.spawnSync([process.execPath, cli, ...args, "--db", db.path], {
    env: { ...process.env },
    cwd: join(import.meta.dir, ".."),
  })
}

function info(args: string[]) {
  const result = run(["session-info", ...args])
  expect(result.exitCode).toBe(0)
  return JSON.parse(result.stdout.toString()) as {
    sessionID: string | null
    title?: string
    directory?: string
    workflow?: string | null
  }
}

describe("session-info", () => {
  test("按目录返回最近主会话及其工作流类型", async () => {
    const mod = (await import(smModule)) as { Store: { open(dir: string, resolve: () => string): SmStore } }
    mod.Store.open(projectDir, () => "reqdoc").ensure("ses_new")

    const result = info(["--dir", projectDir])
    expect(result.sessionID).toBe("ses_new")
    expect(result.title).toBe("新会话")
    expect(result.workflow).toBe("reqdoc")
  })

  test("反斜线目录也能匹配（上游存正斜线）", async () => {
    const result = info(["--dir", projectDir.replace(/\//g, "\\")])
    expect(result.sessionID).toBe("ses_new")
  })

  test("没有历史会话时返回 null", () => {
    const empty = mkdtempSync(join(tmpdir(), "team-share-empty-"))
    try {
      expect(info(["--dir", empty])).toEqual({ sessionID: null })
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  test("按会话 id 查询", async () => {
    const mod = (await import(smModule)) as { Store: { open(dir: string, resolve: () => string): SmStore } }
    mod.Store.open(projectDir, () => "sdlc").ensure("ses_old")

    const result = info(["--session", "ses_old"])
    expect(result.sessionID).toBe("ses_old")
    expect(result.workflow).toBe("sdlc")
  })
})
