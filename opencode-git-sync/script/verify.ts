/**
 * 口令 / 同步仓库一致性校验。
 *
 * 用法：
 *   bun run script/verify.ts                      # 远端 = 当前目录的 git origin
 *   bun run script/verify.ts --remote <url>       # 指定远端
 *   bun run script/verify.ts --key-file <file>    # 指定口令文件
 *
 * 输出：
 *   - 远端 sync-meta.json 的 repoId / salt
 *   - 远端是否已有 keycheck.ocgs
 *   - 本机口令能否解开 keycheck（= 两台机器是否用同一个同步仓库）
 *   - 本地 state.db 记录的 repoId（是否已加入该同步仓库）
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { decrypt, deriveKey, KEYCHECK_PATH } from "../src/crypto"
import { git } from "../src/git"
import { decodePack, parsePackPath } from "../src/payload"
import { detectRemote } from "../src/remote"
import { META_FILE, SyncRepo } from "../src/repo"
import { projectStateDir } from "../src/paths"

const args = process.argv.slice(2)
function arg(name: string): string | undefined {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}

const keyFile = arg("key-file") ?? path.join(os.homedir(), ".config", "opencode", "git-sync.key")
const remoteArg = arg("remote")

function fail(message: string): never {
  console.error(`✗ ${message}`)
  process.exit(1)
}

// 1) 口令
if (!fs.existsSync(keyFile)) fail(`口令文件不存在: ${keyFile}`)
const passphrase = fs.readFileSync(keyFile, "utf8").trim()
if (!passphrase) fail(`口令文件为空: ${keyFile}`)

// 2) 远端
const remote = remoteArg ?? (await detectRemote(process.cwd()))
if (!remote) fail("无法确定远端（当前目录不是 git 仓库或没有远端），请用 --remote 指定")
console.log(`远端: ${remote}`)

// 3) 抓取远端 ocsync/* 分支
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "git-sync-verify-"))
const repo = new SyncRepo({ dir: workdir, remote, machine: "verify", timeoutMs: 15000 })
await repo.ensure()
const fetched = await repo.fetch()
if (!fetched) fail("fetch 失败（网络或凭据问题）")

const branches = await repo.readRemoteFiles()
if (branches.size === 0) {
  console.log("远端还没有 ocsync/* 分支（还没有任何机器推送过），本机将是第一台。")
  process.exit(0)
}

let repoId: string | undefined
let salt: string | undefined
let keycheck: Buffer | undefined
for (const files of branches.values()) {
  const meta = files.get(META_FILE)
  if (meta && !repoId) {
    try {
      const parsed = JSON.parse(meta.toString("utf8")) as { repoId?: string; salt?: string }
      repoId = parsed.repoId
      salt = parsed.salt
    } catch {
      // ignore
    }
  }
  if (!keycheck) {
    const check = files.get(KEYCHECK_PATH)
    if (check) keycheck = check
  }
}

console.log(`远端 repoId: ${repoId ?? "(无)"}`)
console.log(`远端 salt:   ${salt ?? "(无)"}`)
console.log(`远端分支:    ${[...branches.keys()].join(", ")}`)

if (!repoId || !salt) {
  console.log("远端缺少 sync-meta.json，无法校验口令。")
  process.exit(0)
}

let contentKey: Buffer | undefined
if (!keycheck) {
  console.log("远端没有 keycheck.ocgs，跳过口令校验。")
} else {
  contentKey = deriveKey(passphrase, salt)
  try {
    decrypt(keycheck, contentKey, repoId, KEYCHECK_PATH)
    console.log("口令: ✓ 与远端一致（可以用这个口令继续同步）")
  } catch {
    console.log("口令: ✗ 与远端不一致（换机器时必须填「现有机器正在用的那个口令」）")
    process.exit(2)
  }
}

// 4) 本地状态（状态目录按项目隔离，取当前目录对应的那一份）
const localStateDb = path.join(projectStateDir(process.cwd()), "state.db")
if (fs.existsSync(localStateDb)) {
  const { Database } = await import("bun:sqlite")
  const db = new Database(localStateDb, { readonly: true })
  const row = db.query("SELECT value FROM meta WHERE key = 'repo_id'").get() as { value?: string } | null
  db.close()
  console.log(`本地 repoId: ${row?.value ?? "(尚未加入任何同步仓库)"}`)
  if (row?.value && repoId && row.value !== repoId) {
    console.log("        ⚠ 本地记录与远端不是同一个同步仓库，需要清空本地状态目录后重新加入。")
  }
}

// 5) 逐分支统计——空分支要一眼看出来
console.log("")
console.log("各机器分支内容：")
let totalSessions = 0
let totalMessages = 0
for (const [branch, files] of branches) {
  let sessions = 0
  let messages = 0
  let packs = 0
  let hasMeta = false
  for (const [filePath, blob] of files) {
    if (filePath === META_FILE) hasMeta = true
    else if (filePath === KEYCHECK_PATH) continue
    else if (filePath.endsWith("/meta.ocgs")) sessions += 1
    else if (parsePackPath(filePath)) {
      packs += 1
      if (!contentKey) continue
      try {
        messages += decodePack(decrypt(blob, contentKey, repoId!, filePath)).length
      } catch {
        // 解不开的包不计入消息数
      }
    } else if (filePath.endsWith(".ocgs")) messages += 1
  }
  totalSessions += sessions
  totalMessages += messages
  const flag = sessions === 0 ? "  ← 空分支：该机器没推上任何会话" : ""
  const packInfo = packs > 0 ? `  封包 ${String(packs).padStart(3)}` : ""
  console.log(
    `  ${branch.padEnd(28)} 会话 ${String(sessions).padStart(3)}  消息 ${String(messages).padStart(4)}  ` +
      `${hasMeta ? "meta ✓" : "meta ✗"}${packInfo}${flag}`,
  )
}
console.log(`  合计：会话 ${totalSessions}，消息 ${totalMessages}`)
