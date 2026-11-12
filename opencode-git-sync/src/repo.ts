import fs from "node:fs"
import path from "node:path"
import { git, gitOrThrow, readBlobs } from "./git"
import { log } from "./log"
import { randomRepoId, randomSalt } from "./crypto"
import type { PayloadFile } from "./payload"

/**
 * 同步仓库层。
 *
 * 远端形态：一个 git 远端（可以是项目仓库本身）承载若干 `ocsync/<machine>` 分支，
 * 每个分支只属于一台机器，各自 amend 提交，历史恒定 1 条，互不冲突。
 * 分支内是加密后的会话分片文件，仓库里不存在明文。
 */

export const BRANCH_PREFIX = "ocsync"
export const META_FILE = "sync-meta.json"
export const ENCRYPTED_EXT = ".ocgs"

export type RepoMeta = {
  version: 1
  repoId: string
  salt: string
  machines: string[]
  createdAt: number
}

export type RepoOptions = {
  dir: string
  remote: string
  machine: string
  timeoutMs: number
}

export class SyncRepo {
  private options: RepoOptions

  constructor(options: RepoOptions) {
    this.options = options
  }

  /** 本地工作副本目录。 */
  get dir(): string {
    return this.options.dir
  }

  branch(): string {
    return `${BRANCH_PREFIX}/${this.options.machine}`
  }

  /** 本地仓库是否已就绪。 */
  exists(): boolean {
    return fs.existsSync(path.join(this.options.dir, ".git"))
  }

  /** 初始化本地仓库（只 fetch ocsync/* 分支，不拉项目代码）。 */
  async ensure(): Promise<void> {
    const { dir, remote, timeoutMs } = this.options
    if (!this.exists()) {
      fs.mkdirSync(dir, { recursive: true })
      await gitOrThrow(["init", "-q", "-b", this.branch()], { cwd: dir, timeoutMs })
    }
    const remotes = await git(["remote"], { cwd: dir, timeoutMs })
    const hasOrigin = remotes.stdout.split("\n").includes("origin")
    if (!hasOrigin) {
      await gitOrThrow(["remote", "add", "origin", remote], { cwd: dir, timeoutMs })
    } else {
      await git(["remote", "set-url", "origin", remote], { cwd: dir, timeoutMs })
    }
    await gitOrThrow(["config", "remote.origin.fetch", `+refs/heads/${BRANCH_PREFIX}/*:refs/remotes/origin/${BRANCH_PREFIX}/*`], {
      cwd: dir,
      timeoutMs,
    })
    await gitOrThrow(["config", "user.name", "opencode-git-sync"], { cwd: dir, timeoutMs })
    await gitOrThrow(["config", "user.email", "opencode-git-sync@localhost"], { cwd: dir, timeoutMs })
    await gitOrThrow(["config", "commit.gpgsign", "false"], { cwd: dir, timeoutMs })

    // 首次使用时还没有提交，先造一个空提交作为 amend 的基线。
    const head = await git(["rev-parse", "--verify", "HEAD"], { cwd: dir, timeoutMs })
    if (head.code !== 0) {
      await gitOrThrow(["commit", "-q", "--allow-empty", "-m", "opencode-git-sync: init"], { cwd: dir, timeoutMs })
    }
    await git(["checkout", "-q", "-B", this.branch()], { cwd: dir, timeoutMs })
  }

  /** 读取本地分支上的 sync-meta.json（明文，不含机密）。 */
  async readMeta(): Promise<RepoMeta | undefined> {
    const file = path.join(this.options.dir, META_FILE)
    try {
      const raw = await Bun.file(file).text()
      const parsed = JSON.parse(raw) as Partial<RepoMeta>
      if (typeof parsed.repoId !== "string" || typeof parsed.salt !== "string") return undefined
      return {
        version: 1,
        repoId: parsed.repoId,
        salt: parsed.salt,
        machines: Array.isArray(parsed.machines) ? parsed.machines : [],
        createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
      }
    } catch {
      return undefined
    }
  }

  async writeMeta(meta: RepoMeta): Promise<void> {
    fs.mkdirSync(this.options.dir, { recursive: true })
    await Bun.write(path.join(this.options.dir, META_FILE), JSON.stringify(meta, null, 2))
  }

  /** 生成全新的 meta（首次初始化仓库时）。 */
  static newMeta(machine: string): RepoMeta {
    return {
      version: 1,
      repoId: randomRepoId(),
      salt: randomSalt(),
      machines: [machine],
      createdAt: Date.now(),
    }
  }

  /** 读取工作区里的本地文件。 */
  async readLocalFile(file: string): Promise<Buffer | undefined> {
    try {
      const target = path.join(this.options.dir, file)
      if (!fs.existsSync(target)) return undefined
      return Buffer.from(await Bun.file(target).arrayBuffer())
    } catch {
      return undefined
    }
  }

  /** 写入加密文件到工作区。 */
  async writeFiles(files: PayloadFile[]): Promise<void> {
    for (const file of files) {
      const target = path.join(this.options.dir, file.path)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      await Bun.write(target, file.content)
    }
  }

  /** 是否有待提交的内容。 */
  async hasChanges(): Promise<boolean> {
    const status = await git(["status", "--porcelain"], { cwd: this.options.dir, timeoutMs: this.options.timeoutMs })
    return status.stdout.trim().length > 0
  }

  /** 提交（amend，保持历史恒定 1 条）。 */
  async commit(message: string): Promise<void> {
    const { dir, timeoutMs } = this.options
    await gitOrThrow(["add", "-A"], { cwd: dir, timeoutMs })
    const status = await git(["status", "--porcelain"], { cwd: dir, timeoutMs })
    if (status.stdout.trim().length === 0) return
    await gitOrThrow(["commit", "-q", "--amend", "-m", message], { cwd: dir, timeoutMs })
  }

  /** 推送本机分支（force：只推自己那条）。 */
  async push(): Promise<boolean> {
    const { dir, timeoutMs } = this.options
    const result = await git(["push", "--force", "origin", this.branch()], { cwd: dir, timeoutMs: timeoutMs * 2 })
    if (result.code !== 0) {
      log.warn(`push 失败: ${result.stderr.trim() || result.stdout.trim()}`)
      return false
    }
    return true
  }

  /** 拉取所有 ocsync/* 分支。 */
  async fetch(): Promise<boolean> {
    const { dir, timeoutMs } = this.options
    const result = await git(["fetch", "origin", "--prune", "--no-write-fetch-head"], {
      cwd: dir,
      timeoutMs,
    })
    if (result.code !== 0) {
      log.warn(`fetch 失败: ${result.stderr.trim() || result.stdout.trim()}`)
      return false
    }
    return true
  }

  /** 远端各机器分支上的加密文件：分支 → (仓库相对路径 → 密文)。 */
  async readRemoteFiles(): Promise<Map<string, Map<string, Buffer>>> {
    const { dir, timeoutMs } = this.options
    const branches = await this.remoteBranches()
    const output = new Map<string, Map<string, Buffer>>()
    for (const branch of branches) {
      // branch 是 "ocsync/<machine>"，本地对应的是远端跟踪分支 origin/<branch>。
      const ref = `origin/${branch}`
      const listing = await git(["ls-tree", "-r", ref], { cwd: dir, timeoutMs })
      if (listing.code !== 0) continue
      const entries: Array<{ sha: string; path: string }> = []
      for (const line of listing.stdout.split("\n")) {
        if (!line.trim()) continue
        const match = /^(\d+)\s+(\w+)\s+([0-9a-f]+)\t(.+)$/.exec(line)
        if (!match) continue
        entries.push({ sha: match[3]!, path: match[4]! })
      }
      const blobs = await readBlobs(
        entries.map((entry) => entry.sha),
        { cwd: dir, timeoutMs: timeoutMs * 3 },
      )
      const files = new Map<string, Buffer>()
      for (const entry of entries) {
        const blob = blobs.get(entry.sha)
        if (blob) files.set(entry.path, blob)
      }
      output.set(branch, files)
    }
    return output
  }

  /** 远端分支列表（refs/remotes/origin/ocsync/*）。 */
  async remoteBranches(): Promise<string[]> {
    const { dir, timeoutMs } = this.options
    const result = await git(
      ["for-each-ref", "--format=%(refname:short)", `refs/remotes/origin/${BRANCH_PREFIX}`],
      { cwd: dir, timeoutMs },
    )
    if (result.code !== 0) return []
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith(`origin/${BRANCH_PREFIX}/`))
      .map((line) => line.replace(/^origin\//, ""))
  }
}
