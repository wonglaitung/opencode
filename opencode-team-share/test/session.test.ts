import { afterEach, describe, expect, test } from "bun:test"
import { createTestDb, seedProject, seedSession, type TestDb } from "./helpers"
import { decodeHandoff, encodeHandoff } from "../src/handoff"
import { exportHandoff, importSession, listProjects, listSessions, readSession } from "../src/session"

const dbs: TestDb[] = []

afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})

function makeDb(): TestDb {
  const db = createTestDb()
  dbs.push(db)
  return db
}

const by = { user: "zhang", machine: "HP-Laptop" }

describe("会话读取", () => {
  test("列出会话并带消息数、按最近更新倒序", () => {
    const { db } = makeDb()
    seedProject(db, "p1", "/work/proj")
    seedSession(db, {
      id: "ses_old",
      projectID: "p1",
      directory: "/work/proj",
      title: "旧的会话",
      timeUpdated: 1000,
      messages: [{ id: "m1", data: { role: "user" } }],
    })
    seedSession(db, {
      id: "ses_new",
      projectID: "p1",
      directory: "/work/proj",
      title: "新的会话",
      timeUpdated: 5000,
      messages: [
        { id: "m2", data: { role: "user" } },
        { id: "m3", data: { role: "assistant" } },
      ],
    })
    const items = listSessions(db)
    expect(items.map((item) => item.id)).toEqual(["ses_new", "ses_old"])
    expect(items[0]!.messages).toBe(2)
    expect(items[0]!.project).toBe("/work/proj")
  })

  test("归档会话不列出", () => {
    const { db } = makeDb()
    seedProject(db, "p1", "/work/proj")
    seedSession(db, {
      id: "ses_archived",
      projectID: "p1",
      directory: "/work/proj",
      title: "归档了",
      timeArchived: 3000,
      messages: [],
    })
    expect(listSessions(db)).toHaveLength(0)
  })

  test("读会话带出消息与 part", () => {
    const { db } = makeDb()
    seedProject(db, "p1", "/work/proj")
    seedSession(db, {
      id: "ses_1",
      projectID: "p1",
      directory: "/work/proj",
      title: "带 part 的会话",
      messages: [
        {
          id: "m1",
          data: { role: "assistant", text: "hello" },
          parts: [{ id: "pt1", data: { type: "text", text: "hello" } }],
        },
      ],
    })
    const snapshot = readSession(db, "ses_1")
    expect(snapshot?.messages).toHaveLength(1)
    expect(snapshot?.messages[0]!.parts).toHaveLength(1)
    expect(snapshot?.messages[0]!.info["id"]).toBe("m1")
    expect(readSession(db, "nope")).toBeUndefined()
  })

  test("列出项目", () => {
    const { db } = makeDb()
    seedProject(db, "p1", "/work/a", "A 项目")
    seedProject(db, "p2", "/work/b")
    expect(listProjects(db).map((item) => item.id)).toEqual(["p1", "p2"])
  })
})

describe("导出与导入", () => {
  test("导出后不含源机器绝对路径", () => {
    const { db } = makeDb()
    seedProject(db, "p1", "/work/proj")
    seedSession(db, {
      id: "ses_1",
      projectID: "p1",
      directory: "/work/proj/sub",
      path: "sub",
      title: "改的是 /work/proj/main.ts 的鉴权",
      messages: [
        {
          id: "m1",
          data: { role: "user", text: "看 /work/proj/src/auth.ts" },
          parts: [{ id: "pt1", data: { type: "text", filePath: "/work/proj/src/auth.ts" } }],
        },
      ],
    })
    const file = exportHandoff(db, "ses_1", "交接说明", by)
    const raw = JSON.stringify(file)
    expect(raw).not.toContain("/work/proj")
    expect(raw).toContain("${WORKSPACE_ROOT}")
  })

  test("导出→导入：会话 ID 保留、消息数一致、路径换成本机目录", () => {
    const source = makeDb()
    seedProject(source.db, "p1", "/work/proj")
    seedSession(source.db, {
      id: "ses_1",
      projectID: "p1",
      directory: "/work/proj/sub",
      path: "sub",
      title: "支付网关重构",
      messages: [
        {
          id: "m1",
          data: { role: "user", text: "看 /work/proj/src/auth.ts" },
          parts: [{ id: "pt1", data: { type: "text", filePath: "/work/proj/src/auth.ts" } }],
        },
        { id: "m2", data: { role: "assistant", text: "好的" } },
      ],
    })
    const file = exportHandoff(source.db, "ses_1", "卡在鉴权", by)

    const target = makeDb()
    seedProject(target.db, "p2", "/other/work")
    const result = importSession(target.db, file, {
      projectID: "p2",
      worktree: "/other/work",
      directory: "/other/work/sub",
    })
    expect(result.sessionID).toBe("ses_1")
    expect(result.created).toBe(true)
    expect(result.messages).toBe(2)

    const row = target.db.query("SELECT id, title, project_id, directory, path FROM session").get() as {
      id: string
      title: string
      project_id: string
      directory: string
      path: string
    }
    expect(row.id).toBe("ses_1")
    expect(row.title).toBe("支付网关重构")
    expect(row.project_id).toBe("p2")
    expect(row.directory).toBe("/other/work/sub")

    const messages = target.db.query("SELECT id, data FROM message ORDER BY id").all() as Array<{
      id: string
      data: string
    }>
    expect(messages).toHaveLength(2)
    expect(messages[0]!.data).toContain("/other/work/src/auth.ts")
    expect(messages[0]!.data).not.toContain("/work/proj")

    const parts = target.db.query("SELECT data FROM part").all() as Array<{ data: string }>
    expect(parts[0]!.data).toContain("/other/work/src/auth.ts")
  })

  test("重复导入不产生重复会话与消息", () => {
    const source = makeDb()
    seedProject(source.db, "p1", "/work/proj")
    seedSession(source.db, {
      id: "ses_1",
      projectID: "p1",
      directory: "/work/proj",
      title: "会话",
      messages: [{ id: "m1", data: { role: "user", text: "hi" } }],
    })
    const file = exportHandoff(source.db, "ses_1", "", by)

    const target = makeDb()
    seedProject(target.db, "p2", "/other/work")
    const scope = { projectID: "p2", worktree: "/other/work", directory: "/other/work" }
    importSession(target.db, file, scope)
    const second = importSession(target.db, file, scope)
    expect(second.created).toBe(false)
    expect((target.db.query("SELECT COUNT(*) AS n FROM session").get() as { n: number }).n).toBe(1)
    expect((target.db.query("SELECT COUNT(*) AS n FROM message").get() as { n: number }).n).toBe(1)
  })

  test("目标项目不存在时拒绝导入", () => {
    const source = makeDb()
    seedProject(source.db, "p1", "/work/proj")
    seedSession(source.db, {
      id: "ses_1",
      projectID: "p1",
      directory: "/work/proj",
      title: "会话",
      messages: [],
    })
    const file = exportHandoff(source.db, "ses_1", "", by)
    const target = makeDb()
    expect(() =>
      importSession(target.db, file, { projectID: "missing", worktree: "/x", directory: "/x" }),
    ).toThrow(/目标项目不存在/)
  })

  test("导出找不到的会话会报错", () => {
    const { db } = makeDb()
    expect(() => exportHandoff(db, "nope", "", by)).toThrow(/找不到会话/)
  })

  test("交接文件可完整往返", () => {
    const source = makeDb()
    seedProject(source.db, "p1", "/work/proj")
    seedSession(source.db, {
      id: "ses_1",
      projectID: "p1",
      directory: "/work/proj",
      title: "往返",
      messages: [{ id: "m1", data: { role: "user", text: "hi" } }],
    })
    const file = exportHandoff(source.db, "ses_1", "说明", by)
    const decoded = decodeHandoff(encodeHandoff(file))
    expect(decoded.session.id).toBe("ses_1")
    expect(decoded.note).toBe("说明")
    expect(decoded.messages).toHaveLength(1)
  })
})

describe("回归：根路径与相对 path", () => {
  test("global 项目（worktree 为根）不会破坏相对 path", () => {
    const { db } = makeDb()
    seedProject(db, "global", "/")
    seedSession(db, {
      id: "ses_g",
      projectID: "global",
      directory: "/projects/scheduler",
      path: "projects/scheduler",
      title: "全局会话",
      messages: [{ id: "m1", data: { role: "user", text: "hi" } }],
    })
    const file = exportHandoff(db, "ses_g", "", by)
    expect(file.session.path).toBe("projects/scheduler")
    expect(JSON.stringify(file)).not.toContain("projects${WORKSPACE_ROOT}")

    const target = makeDb()
    seedProject(target.db, "p2", "/other/work")
    importSession(target.db, file, { projectID: "p2", worktree: "/other/work", directory: "/other/work" })
    const row = target.db.query("SELECT path FROM session WHERE id = ?").get("ses_g") as { path: string }
    expect(row.path).toBe("projects/scheduler")
  })
})

describe("回归：路径过短不替换", () => {
  test("会话目录本身是根时，不把分隔符当工作区根替换", () => {
    const { db } = makeDb()
    seedProject(db, "global", "/")
    seedSession(db, {
      id: "ses_root",
      projectID: "global",
      directory: "/",
      path: "a/b",
      title: "根目录会话",
      messages: [{ id: "m1", data: { role: "user", text: "看 a/b/c.ts" } }],
    })
    const file = exportHandoff(db, "ses_root", "", by)
    expect(file.session.path).toBe("a/b")
    expect(file.messages[0]!.info["text"]).toBe("看 a/b/c.ts")
    expect(JSON.stringify(file)).not.toContain("${WORKSPACE_ROOT}")
  })
})
