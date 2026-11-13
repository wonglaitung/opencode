import { decrypt, deriveKey, encrypt, keycheck, verifyKeycheck, KEYCHECK_PATH } from "./crypto"
import { log } from "./log"
import {
  decodePack,
  denormalize,
  encodePack,
  messageBytes,
  PACK_BYTES,
  packPath,
  parsePackPath,
  parseSessionPath,
  sessionMetaPath,
  sha256,
  type MessagePayload,
  type PathRules,
  type SessionMeta,
} from "./payload"
import { META_FILE, SyncRepo, type RepoMeta } from "./repo"
import type { OpencodeDb, LocalSessionScope } from "./ocdb"
import type { State } from "./state"
import type { OpencodeClient } from "./types"
import { captureSession } from "./snapshot"

/**
 * 同步编排：拉（解密 → 落库）与推（快照 → 加密 → 提交 → 推送）。
 *
 * 冲突策略：按 messageID 合并（同一会话不同机器各写各的分支，导入时取并集），
 * 会话元信息按 time.updated 取新，因此不会因为时钟漂移而回退覆盖。
 */

export type SyncDeps = {
  repo: SyncRepo
  state: State
  client: OpencodeClient
  rules: PathRules
  scope: LocalSessionScope
  passphrase: string
  machine: string
  timeoutMs: number
}

export type PullResult = { sessions: number; messages: number; skipped: boolean; changed: string[] }

export class SyncService {
  private deps: SyncDeps
  private key: Buffer | undefined
  private repoMeta: RepoMeta | undefined
  private pending = new Set<string>()
  private lastFetchAt = 0
  private disposed = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private pushing = false
  /** 串行化所有会改写工作区的操作（暂存 / 迁移 / 推送）。 */
  private lock: Promise<unknown> = Promise.resolve()

  constructor(deps: SyncDeps) {
    this.deps = deps
  }

  private withLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.lock.then(task, task)
    this.lock = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** 本地缓存的仓库元信息（无网时也能拿到 salt）。 */
  private cachedMeta(): RepoMeta | undefined {
    const repoId = this.deps.state.repoId()
    const salt = this.deps.state.salt()
    if (!repoId || !salt) return undefined
    return {
      version: 1,
      repoId,
      salt,
      machines: [],
      createdAt: Date.now(),
    }
  }

  private rememberMeta(meta: RepoMeta) {
    this.deps.state.setRepoId(meta.repoId)
    this.deps.state.setSalt(meta.salt)
    this.repoMeta = meta
  }

  private contentKey(salt: string): Buffer {
    if (!this.key) this.key = deriveKey(this.deps.passphrase, salt)
    return this.key
  }

  /**
   * 准备本地仓库与元信息。
   *
   * - 首台机器：本地没有 meta → 远端也没有 → 生成新的 repoId/salt 并写入本机分支；
   * - 后加入的机器：本地没有 meta → 先尝试拉远端 meta 并继承（salt 必须一致，否则解不开）。
   */
  async prepare(): Promise<void> {
    try {
      await this.deps.repo.ensure()
      const existing = await this.deps.repo.readMeta()
      if (existing) {
        this.rememberMeta(existing)
        return
      }

      // 本地还没有 meta：不联网、不新建。
      // 「继承远端」还是「本地新建」由 pull() 在首屏预算内决定，避免冷启动多等一次 SSH 握手。
      const cached = this.cachedMeta()
      if (cached) this.rememberMeta(cached)
    } catch (error) {
      log.warn(`准备同步仓库失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 继承远端元信息并落盘（保证本机后续推送与远端同源）。 */
  private async adoptMeta(meta: RepoMeta): Promise<void> {
    const changed = !this.repoMeta || this.repoMeta.repoId !== meta.repoId
    this.rememberMeta(meta)
    if (!changed) return
    await this.deps.repo.writeMeta(meta)
    await this.deps.repo.writeFiles([
      { path: KEYCHECK_PATH, content: keycheck(this.contentKey(meta.salt), meta.repoId) },
    ])
    log.info("已继承远端同步仓库元信息")
  }

  /** 确保本地有一份元信息（首台机器：新建）。 */
  private async ensureMeta(): Promise<RepoMeta | undefined> {
    const existing = this.repoMeta ?? this.cachedMeta()
    if (existing) {
      this.rememberMeta(existing)
      return existing
    }
    const meta = SyncRepo.newMeta(this.deps.machine)
    this.rememberMeta(meta)
    await this.deps.repo.writeMeta(meta)
    await this.deps.repo.writeFiles([
      { path: KEYCHECK_PATH, content: keycheck(this.contentKey(meta.salt), meta.repoId) },
    ])
    return meta
  }

  /** 实例被销毁后不再做任何事（避免用到已关闭的状态库）。 */
  dispose() {
    this.disposed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.pending.clear()
  }

  /** 拉取远端并导入本地数据库。 */
  async pull(db: OpencodeDb | undefined): Promise<PullResult> {
    if (this.disposed) return { sessions: 0, messages: 0, skipped: true, changed: [] }
    const fetched = await this.deps.repo.fetch()
    if (!fetched) return { sessions: 0, messages: 0, skipped: true, changed: [] }
    this.lastFetchAt = Date.now()

    const branches = await this.deps.repo.readRemoteFiles()

    // 元信息决策：远端有就继承（后加入的机器），没有就本地新建（首台机器）。
    const remoteMeta = findRemoteMeta(branches)
    if (remoteMeta) {
      if (this.repoMeta && this.repoMeta.repoId !== remoteMeta.repoId) {
        log.warn(
          `远端仓库 ID 不一致（本地 ${this.repoMeta.repoId} / 远端 ${remoteMeta.repoId}），跳过导入；` +
            `如需改用该远端，请清空 ${this.deps.state.dbPath} 后重试`,
        )
        return { sessions: 0, messages: 0, skipped: true, changed: [] }
      }
      await this.adoptMeta(remoteMeta)
    } else {
      await this.ensureMeta()
    }
    const effective = this.repoMeta
    if (!effective) return { sessions: 0, messages: 0, skipped: true, changed: [] }
    if (branches.size === 0) return { sessions: 0, messages: 0, skipped: false, changed: [] }

    const key = this.contentKey(effective.salt)

    // 校验 passphrase：任何分支里存在 keycheck 就必须通过，否则一律不写远端。
    for (const files of branches.values()) {
      const check = files.get(KEYCHECK_PATH)
      if (!check) continue
      if (!verifyKeycheck(check, key, effective.repoId)) {
        log.error("passphrase 不匹配，已中止同步（不会推送任何数据）")
        return { sessions: 0, messages: 0, skipped: true, changed: [] }
      }
      break
    }

    if (!db) return { sessions: 0, messages: 0, skipped: true, changed: [] }

    let sessions = 0
    let messages = 0
    const changed: string[] = []

    for (const [branch, files] of branches) {
      const metas: Map<string, SessionMeta> = new Map()
      const payloads: Map<string, MessagePayload[]> = new Map()

      // 按路径字典序处理：旧布局（<messageID>.ocgs）在 packs/ 之前，
      // 封包之间按序号升序 → 后面的覆盖前面的（覆盖项写在更新的封包里）。
      for (const filePath of [...files.keys()].sort()) {
        const blob = files.get(filePath)!
        const pack = parsePackPath(filePath)
        const parsed = pack ? undefined : parseSessionPath(filePath)
        if (!pack && !parsed) continue

        let plain: Buffer
        try {
          plain = decrypt(blob, key, effective.repoId, filePath)
        } catch (error) {
          log.warn(`跳过无法解密的文件 ${branch}:${filePath} (${error instanceof Error ? error.message : String(error)})`)
          continue
        }

        if (pack) {
          let packed: MessagePayload[]
          try {
            packed = decodePack(plain)
          } catch (error) {
            log.warn(`跳过无法解析的封包 ${branch}:${filePath} (${error instanceof Error ? error.message : String(error)})`)
            continue
          }
          const list = payloads.get(pack.sessionID) ?? []
          for (const message of packed) list.push(denormalize(message, this.deps.rules) as MessagePayload)
          payloads.set(pack.sessionID, list)
          continue
        }
        if (!parsed) continue

        const value = denormalize(JSON.parse(plain.toString("utf8")), this.deps.rules)
        if (parsed.messageID === undefined) {
          metas.set(parsed.sessionID, value as SessionMeta)
        } else {
          const list = payloads.get(parsed.sessionID) ?? []
          list.push(value as MessagePayload)
          payloads.set(parsed.sessionID, list)
        }
      }

      db.transaction(() => {
        for (const [sessionID, sessionMeta] of metas) {
          const updated = db.upsertSession(sessionMeta, this.deps.scope)
          if (updated) changed.push(sessionID)
          sessions += 1
        }
        for (const [sessionID, list] of payloads) {
          for (const message of list) {
            if (db.upsertMessage(sessionID, message.info, message.parts)) messages += 1
          }
        }
      })
    }

    this.deps.state.setLastSyncAt(Date.now())
    return { sessions, messages, skipped: false, changed }
  }

  /** 通知上游「会话已更新」，让 TUI 列表刷新。 */
  async notifyChanged(sessionIDs: string[]) {
    for (const sessionID of sessionIDs) {
      try {
        const result = await this.deps.client.session.get({ path: { id: sessionID } })
        const title = result.data?.title
        if (!title) continue
        await this.deps.client.session.update({ path: { id: sessionID }, body: { title } })
      } catch {
        // 通知失败不影响导入结果
      }
    }
  }

  /** 抓取并加密写入本机分支（不推送）。 */
  async stage(sessionID: string): Promise<boolean> {
    if (this.disposed) return false
    return this.withLock(() => this.stageUnlocked(sessionID))
  }

  private async stageUnlocked(sessionID: string): Promise<boolean> {
    const meta = await this.ensureMeta()
    if (!meta) return false
    const snapshot = await captureSession(this.deps.client, sessionID, this.deps.rules)
    if (!snapshot) return false

    const key = this.contentKey(meta.salt)
    const files: Array<{ path: string; content: Buffer }> = []
    const staged: MessagePayload[] = []

    const metaHash = sha256(snapshot.meta)
    if (this.deps.state.sessionHash(sessionID) !== metaHash) {
      const path = sessionMetaPath(sessionID)
      files.push({ path, content: encrypt(Buffer.from(JSON.stringify(snapshot.meta)), key, meta.repoId, path) })
    }

    for (const message of snapshot.messages) {
      if (this.deps.state.messageHash(sessionID, message.info.id) === sha256(message)) continue
      staged.push(message)
    }
    if (staged.length > 0) files.push(...(await this.appendToPacks(sessionID, staged, key, meta.repoId)))

    if (files.length === 0) return false
    await this.deps.repo.writeFiles(files)

    if (this.deps.state.sessionHash(sessionID) !== metaHash) this.deps.state.setSessionHash(sessionID, metaHash)
    for (const message of staged) this.deps.state.setMessageHash(sessionID, message.info.id, sha256(message))
    log.info(`已暂存会话 ${sessionID}：${staged.length} 条消息（${files.length} 个文件）`)
    return true
  }

  /**
   * 把变化的消息追加到最后一个封包；包满（PACK_BYTES）后开新包。
   * 已封口的包不再改写：旧消息被修改时作为覆盖项追加到当前开口包，
   * 拉取按文件名升序处理，后者覆盖前者。
   */
  private async appendToPacks(
    sessionID: string,
    incoming: MessagePayload[],
    key: Buffer,
    repoId: string,
  ): Promise<Array<{ path: string; content: Buffer }>> {
    const packs = await this.deps.repo.listPackFiles(sessionID)
    let seq = packs.at(-1)?.seq ?? 0
    let open = seq > 0
    let entries: MessagePayload[] = []
    let size = 0

    if (open) {
      const current = packPath(sessionID, seq)
      const blob = await this.deps.repo.readLocalFile(current)
      if (!blob) {
        open = false
        seq = 0
      } else {
        entries = decodePack(decrypt(blob, key, repoId, current))
        size = entries.reduce((total, entry) => total + messageBytes(entry), 0)
        // 上一个包已经写满：不再追加，直接开新包。
        if (size >= PACK_BYTES) {
          open = false
          entries = []
          size = 0
        }
      }
    }

    const files: Array<{ path: string; content: Buffer }> = []
    const write = () => {
      if (entries.length === 0) return
      if (!open) {
        seq += 1
        open = true
      }
      const path = packPath(sessionID, seq)
      files.push({ path, content: encrypt(encodePack(entries), key, repoId, path) })
    }

    for (const message of incoming) {
      const index = entries.findIndex((entry) => entry.info.id === message.info.id)
      if (index >= 0) {
        size += messageBytes(message) - messageBytes(entries[index]!)
        entries[index] = message
        continue
      }
      const addition = messageBytes(message)
      if (entries.length > 0 && size + addition > PACK_BYTES) {
        write()
        open = false
        entries = []
        size = 0
      }
      entries.push(message)
      size += addition
    }
    write()
    return files
  }

  /**
   * 把旧布局（一条消息一个文件）合并成封包。
   * 先写包、再删旧文件：中途失败最多留下重复文件，不会丢消息。
   */
  async migrateLegacy(): Promise<void> {
    if (this.disposed) return
    await this.withLock(async () => {
      const meta = this.repoMeta ?? this.cachedMeta()
      if (!meta) return
      const key = this.contentKey(meta.salt)
      let changed = false

      for (const sessionID of await this.deps.repo.listSessionIDs()) {
        const legacy = await this.deps.repo.listLegacyMessageFiles(sessionID)
        if (legacy.length === 0) continue

        const messages: MessagePayload[] = []
        const migrated: string[] = []
        for (const filePath of legacy) {
          const blob = await this.deps.repo.readLocalFile(filePath)
          if (!blob) continue
          try {
            messages.push(JSON.parse(decrypt(blob, key, meta.repoId, filePath).toString("utf8")) as MessagePayload)
            migrated.push(filePath)
          } catch (error) {
            // 解不开的文件保留原样，绝不在没写进封包前删掉。
            log.warn(`迁移时跳过无法解密的文件 ${filePath} (${error instanceof Error ? error.message : String(error)})`)
          }
        }
        if (messages.length === 0) continue

        messages.sort(
          (a, b) =>
            (a.info.time?.created ?? 0) - (b.info.time?.created ?? 0) || a.info.id.localeCompare(b.info.id),
        )
        const packs = await this.buildPacks(sessionID, messages, key, meta.repoId)
        await this.deps.repo.writeFiles(packs)
        await this.deps.repo.removeFiles(migrated)
        changed = true
        log.info(`已合并会话 ${sessionID}：${messages.length} 条消息 → ${packs.length} 个封包`)
      }

      if (changed) await this.push()
    })
  }

  /** 把消息按 PACK_BYTES 切分成封包（追加在已有封包之后）。 */
  private async buildPacks(
    sessionID: string,
    messages: MessagePayload[],
    key: Buffer,
    repoId: string,
  ): Promise<Array<{ path: string; content: Buffer }>> {
    const existing = await this.deps.repo.listPackFiles(sessionID)
    let seq = existing.at(-1)?.seq ?? 0
    const files: Array<{ path: string; content: Buffer }> = []
    let entries: MessagePayload[] = []
    let size = 0

    const flush = () => {
      if (entries.length === 0) return
      seq += 1
      const path = packPath(sessionID, seq)
      files.push({ path, content: encrypt(encodePack(entries), key, repoId, path) })
      entries = []
      size = 0
    }

    for (const message of messages) {
      const addition = messageBytes(message)
      if (entries.length > 0 && size + addition > PACK_BYTES) flush()
      entries.push(message)
      size += addition
    }
    flush()
    return files
  }

  /** 把待推送的会话提交并推送（失败静默，下次再推）。 */
  async push(): Promise<boolean> {
    if (this.pushing) return false
    this.pushing = true
    try {
      const meta = await this.ensureMeta()
      if (!meta) return false
      // 保证 meta / keycheck 始终在分支上（首台机器靠它分发 salt）。
      await this.deps.repo.writeMeta(meta)
      const key = this.contentKey(meta.salt)
      const existing = await this.deps.repo.readLocalFile(KEYCHECK_PATH)
      if (!existing || !verifyKeycheck(existing, key, meta.repoId)) {
        await this.deps.repo.writeFiles([{ path: KEYCHECK_PATH, content: keycheck(key, meta.repoId) }])
      }

      const changed = await this.deps.repo.hasChanges()
      if (!changed) {
        // 没有新内容就不推：避免把本地那个 "init" 空提交推成远端空分支
        log.warn("没有待推送内容，跳过 push（若远端分支是空的，说明本机还没成功暂存过会话）")
        return false
      }
      await this.deps.repo.commit(`opencode-git-sync ${new Date().toISOString()}`)
      const pushed = await this.deps.repo.push()
      if (pushed) log.info(`已推送到 ${this.deps.repo.branch()}`)
      return pushed
    } catch (error) {
      log.warn(`推送失败: ${error instanceof Error ? error.message : String(error)}`)
      return false
    } finally {
      this.pushing = false
    }
  }

  /** 防抖：把会话加入待推队列，安静期结束后统一推送。 */
  schedule(sessionID: string, debounceMs: number) {
    if (this.disposed) return
    this.pending.add(sessionID)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.flush()
    }, debounceMs)
  }

  /** 立即推送队列内容。 */
  async flush(): Promise<void> {
    if (this.disposed) return
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    const sessions = [...this.pending]
    this.pending.clear()
    if (sessions.length === 0) return
    try {
      await this.withLock(async () => {
        if (this.disposed) return
        for (const sessionID of sessions) await this.stageUnlocked(sessionID)
        await this.push()
      })
    } catch (error) {
      log.warn(`同步推送异常: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** 从各分支的明文 meta 里取出仓库元信息（repoId / salt 必须多机一致）。 */
function findRemoteMeta(branches: Map<string, Map<string, Buffer>>): RepoMeta | undefined {
  for (const files of branches.values()) {
    const raw = files.get(META_FILE)
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw.toString("utf8")) as Partial<RepoMeta>
      if (typeof parsed.repoId !== "string" || typeof parsed.salt !== "string") continue
      return {
        version: 1,
        repoId: parsed.repoId,
        salt: parsed.salt,
        machines: Array.isArray(parsed.machines) ? parsed.machines : [],
        createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
      }
    } catch {
      continue
    }
  }
  return undefined
}
