#!/usr/bin/env bun
/**
 * opencode-team-share —— 会话交接 CLI（供启动器调用）。
 *
 * 一次交接 = 一个 .ocsave 文件：同事导出后自行传递，对方导入后接着做。
 * 不依赖 git、不联网、不做 opencode 插件。
 *
 * 命令：
 *   list-sessions [筛选/分页参数]          列出可交接的会话（默认只列主会话、每页 50 条）
 *   list-projects                          列出本机可作为导入目标的项目
 *   session-info --dir <目录> | --session <id>
 *                                          查询可恢复的会话及其工作流类型（启动器恢复用）
 *   inspect --file <文件>                  只读解析交接文件（导入前确认）
 *   export --session <id> --out <文件> [--note <说明>]
 *   import --file <文件> --project <projectId>
 *
 * 约定：stdout 输出 JSON（给启动器解析），stderr 输出人话错误；退出码 0 成功 / 1 失败 / 2 参数错。
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { hostname, userInfo } from "node:os"
import { dirname, join } from "node:path"
import { backupDb, openDb, resolveDbPath } from "./src/db"
import { TeamShareError } from "./src/errors"
import { decodeHandoff, encodeHandoff, handoffSummary, type HandoffFile } from "./src/handoff"
import { denormalize } from "./src/paths"
import { exportHandoff, importSession, listProjects, listSessions, sessionWorktree } from "./src/session"
import { usableWorktree } from "./src/paths"
import { readWorkflowState, writeWorkflowState } from "./src/workflow-state"

const USAGE = `用法（--db 可选，指定 opencode 数据库路径；缺省自动探测）：
  team-share list-sessions [--search <关键词>] [--project <id>] [--since <epochMs>]
                           [--sort updated|created|messages] [--include-children true]
                           [--limit N] [--cursor <游标>] [--db <库>]
  team-share list-projects [--db <库>]
  team-share session-info --dir <项目目录> | --session <id> [--db <库>]
  team-share inspect --file <文件>
  team-share export --session <id> --out <文件> [--note <说明>] [--db <库>]
  team-share import --file <文件> --project <projectId> [--mode handoff|reference] [--db <库>]`

type Args = { command: string; flags: Record<string, string> }

function parseArgs(argv: string[]): Args {
  const [command = "", ...rest] = argv
  const flags: Record<string, string> = {}
  for (let index = 0; index < rest.length; index++) {
    const item = rest[index]!
    if (!item.startsWith("--")) continue
    const key = item.slice(2)
    const next = rest[index + 1]
    if (next === undefined || next.startsWith("--")) {
      flags[key] = "true"
      continue
    }
    flags[key] = next
    index++
  }
  return { command, flags }
}

function required(flags: Record<string, string>, key: string): string {
  const value = flags[key]
  if (!value || value === "true") throw new UsageError(`缺少 --${key}`)
  return value
}

class UsageError extends Error {}

function exportedBy() {
  let user = "unknown"
  try {
    user = userInfo().username
  } catch {
    // 取不到用户名不阻断导出
  }
  return { user, machine: hostname() }
}

function dbFor(args: Args, readonly = true) {
  const dbPath = resolveDbPath(args.flags["db"])
  return { dbPath, db: openDb(dbPath, { readonly }) }
}

function commandListSessions(args: Args) {
  const { db, dbPath } = dbFor(args)
  try {
    const sinceRaw = args.flags["since"]
    const since = sinceRaw === undefined ? undefined : Number(sinceRaw)
    if (since !== undefined && !Number.isFinite(since)) throw new TeamShareError("--since 需为 epoch 毫秒")
    const sortRaw = args.flags["sort"]
    const sort = sortRaw === "created" || sortRaw === "messages" ? sortRaw : "updated"
    const page = listSessions(db, {
      search: args.flags["search"],
      projectID: args.flags["project"],
      since,
      includeChildren: args.flags["include-children"] === "true",
      sort,
      limit: args.flags["limit"] === undefined ? undefined : Number(args.flags["limit"]),
      cursor: args.flags["cursor"],
    })
    console.log(
      JSON.stringify({
        db: dbPath,
        items: page.items,
        total: page.total,
        nextCursor: page.nextCursor,
        filters: {
          search: args.flags["search"] ?? "",
          project: args.flags["project"] ?? "",
          since: since ?? null,
          sort,
          includeChildren: args.flags["include-children"] === "true",
        },
      }),
    )
  } finally {
    db.close()
  }
}

function commandListProjects(args: Args) {
  const { db, dbPath } = dbFor(args)
  try {
    console.log(JSON.stringify({ db: dbPath, items: listProjects(db) }))
  } finally {
    db.close()
  }
}

async function commandInspect(args: Args) {
  const file = required(args.flags, "file")
  const buffer = await Bun.file(file).arrayBuffer()
  const parsed = decodeHandoff(Buffer.from(buffer))
  console.log(JSON.stringify(handoffSummary(parsed)))
}

async function commandExport(args: Args) {
  const sessionID = required(args.flags, "session")
  const out = required(args.flags, "out")
  const note = args.flags["note"] ?? ""
  const { db, dbPath } = dbFor(args)
  try {
    // 工作流状态在 <项目>/.opencode/session-mgmt.db，随交接文件一起搬
    const worktree = sessionWorktree(db, sessionID)
    const workflow = worktree ? await readWorkflowState(worktree, sessionID) : undefined
    const file = exportHandoff(db, sessionID, note, exportedBy(), workflow)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, encodeHandoff(file))
    console.log(
      JSON.stringify({
        db: dbPath,
        path: out,
        workflow: file.workflow ? "included" : "none",
        sessionId: file.session.id,
        title: file.session.title,
        messages: file.messages.length,
        exportedAt: file.exportedAt,
      }),
    )
  } finally {
    db.close()
  }
}

async function commandImport(args: Args) {
  const file = required(args.flags, "file")
  const projectID = required(args.flags, "project")
  const mode = args.flags["mode"] === "reference" ? "reference" : "handoff"
  const parsed = decodeHandoff(Buffer.from(await Bun.file(file).arrayBuffer()))
  const { db, dbPath } = dbFor(args, false)
  try {
    const project = db.query("SELECT id, worktree FROM project WHERE id = ?").get(projectID) as
      | { id: string; worktree: string }
      | undefined
    if (!project) {
      const available = listProjects(db)
      throw new TeamShareError(
        `目标项目不存在（project id=${projectID}）。本机可用项目：${
          available.length > 0 ? available.map((item) => item.worktree).join("、") : "无"
        }`,
      )
    }
    // global 项目的 worktree 是 "/"，拼出来的目录会落到盘符根；这种项目不作为导入目标
    if (usableWorktree(project.worktree) === undefined) {
      throw new TeamShareError(
        "目标项目不是独立项目（global，路径为文件系统根），不能作为导入目标。请先在目标目录用 opencode 打开一次后重试。",
      )
    }
    const directory = parsed.session.path ? join(project.worktree, parsed.session.path) : project.worktree
    const backup = backupDb(dbPath)
    const result = importSession(
      db,
      parsed,
      { projectID: project.id, worktree: project.worktree, directory },
      { mode },
    )
    // 工作流状态：仅「接手继续」模式写回；参考副本不带状态（避免门禁与统计串到本机）
    let workflowApplied = false
    if (mode === "handoff" && parsed.workflow) {
      const restored = {
        ...parsed.workflow,
        state: denormalize(parsed.workflow.state, { worktree: project.worktree, directory }) as Record<string, unknown>,
      }
      workflowApplied = await writeWorkflowState(project.worktree, result.sessionID, restored)
    }
    console.log(
      JSON.stringify({
        ok: true,
        backup,
        worktree: project.worktree,
        directory,
        workflow: parsed.workflow ? "included" : "none",
        workflowApplied,
        ...result,
      }),
    )
  } finally {
    db.close()
  }
}

async function commandSessionInfo(args: Args) {
  const { db } = dbFor(args)
  try {
    const id = args.flags["session"] && args.flags["session"] !== "true" ? args.flags["session"] : undefined
    const dir = args.flags["dir"] && args.flags["dir"] !== "true" ? args.flags["dir"] : undefined
    if (!id && !dir) throw new UsageError("session-info 需要 --session <id> 或 --dir <项目目录>")

    // 上游 session.directory 存正斜线（D:/projects/x），启动器传进来是反斜线。
    const normalized = dir ? dir.replace(/\\/g, "/").replace(/\/+$/, "") : undefined
    type SessionRow = { id: string; title: string; directory: string; time_updated: number }
    let row: SessionRow | null = null
    if (id) {
      row = db
        .query("SELECT id, title, directory, time_updated FROM session WHERE id = ?")
        .get(id) as SessionRow | null
    } else if (normalized) {
      row = db
        .query(
          `SELECT id, title, directory, time_updated FROM session
            WHERE parent_id IS NULL AND time_archived IS NULL AND lower(directory) = lower(?)
            ORDER BY time_updated DESC LIMIT 1`,
        )
        .get(normalized) as SessionRow | null
    }

    if (!row) {
      console.log(JSON.stringify({ sessionID: null }))
      return
    }

    const workflow = await readWorkflowState(row.directory, row.id)
    const type = typeof workflow?.state["type"] === "string" ? (workflow.state["type"] as string) : null
    console.log(
      JSON.stringify({
        sessionID: row.id,
        title: row.title,
        directory: row.directory,
        updated: row.time_updated,
        workflow: type,
      }),
    )
  } finally {
    db.close()
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  switch (args.command) {
    case "list-sessions":
      return commandListSessions(args)
    case "list-projects":
      return commandListProjects(args)
    case "session-info":
      return commandSessionInfo(args)
    case "inspect":
      return commandInspect(args)
    case "export":
      return commandExport(args)
    case "import":
      return commandImport(args)
    case "":
    case "-h":
    case "--help":
      console.log(USAGE)
      return
    default:
      throw new UsageError(`未知命令：${args.command}`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    if (error instanceof UsageError) {
      console.error(error.message)
      console.error(USAGE)
      process.exit(2)
    }
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
