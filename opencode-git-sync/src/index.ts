import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { log } from "./log"
import { defaultPassphraseFiles, findOpencodeDb, projectStateDir, repoDir, setStateDir, stateDbPath } from "./paths"
import { detectRemote } from "./remote"
import { OpencodeDb } from "./ocdb"
import { SyncRepo } from "./repo"
import { State } from "./state"
import { SyncService, type PullResult } from "./sync"
import type { PluginEvent, PluginInput } from "./types"

/**
 * opencode-git-sync：跨机器会话漫游（纯插件，无外壳脚本）。
 *
 * 形态说明（对齐上游契约 packages/plugin/src/index.ts）：
 *   插件 = (input, options) => Promise<Hooks>，且模块只导出这一个函数，
 *   否则 legacy 加载器会把所有导出都当成插件工厂。
 *
 * 生命周期：
 *   - 工厂体：准备本地同步仓库 + 一次「有界」拉取（默认 1.5s），
 *     保证 `opencode -c` 首屏能拿到远端会话；超时即降级为离线，不阻塞启动。
 *   - event 钩子：session.idle → 抓快照 → 防抖推送。
 *   - dispose 钩子：实例销毁前冲刷未推送内容。
 */

export type GitSyncOptions = {
  /** 远端地址（可以是项目仓库本身，也可以是独立的同步仓库）。 */
  remote?: string
  /** passphrase：内容密钥来源。也可用环境变量 OPENCODE_GIT_SYNC_PASSPHRASE。 */
  passphrase?: string
  /** 口令文件路径（优先级低于 passphrase，高于环境变量）。文件内容会去掉首尾空白。 */
  passphraseFile?: string
  /** 机器名（默认自动生成，用于分支 ocsync/<machine>）。 */
  machine?: string
  /** 防抖推送间隔（毫秒）。 */
  debounceMs?: number
  /** 首屏同步上限（毫秒），超时降级离线。 */
  syncTimeoutMs?: number
  /** 单条 git 命令超时（毫秒）。 */
  gitTimeoutMs?: number
  /** 关闭插件（保留配置便于临时停用）。 */
  enabled?: boolean
}

const DEFAULTS = {
  debounceMs: 3000,
  // 首屏预算：首次 fetch 需要一次 SSH 握手（GitHub 约 1~2s），默认给到 5s。
  syncTimeoutMs: 5000,
  gitTimeoutMs: 30000,
}

/** 展开 ~ 并读取口令文件；失败返回 undefined。 */
function readPassphraseFile(file: string, quiet = false): string | undefined {
  try {
    const expanded = file.startsWith("~/") ? path.join(os.homedir(), file.slice(2)) : file
    const content = fs.readFileSync(expanded, "utf8").trim()
    return content.length > 0 ? content : undefined
  } catch {
    if (!quiet) log.warn(`读取口令文件失败: ${file}`)
    return undefined
  }
}

function readOptions(options: unknown): GitSyncOptions {
  const source = (options ?? {}) as GitSyncOptions
  return {
    remote: source.remote ?? process.env["OPENCODE_GIT_SYNC_REMOTE"],
    passphrase:
      source.passphrase ??
      (source.passphraseFile ? readPassphraseFile(source.passphraseFile) : undefined) ??
      process.env["OPENCODE_GIT_SYNC_PASSPHRASE"] ??
      firstExisting(defaultPassphraseFiles()),
    machine: source.machine ?? process.env["OPENCODE_GIT_SYNC_MACHINE"],
    debounceMs: source.debounceMs ?? DEFAULTS.debounceMs,
    syncTimeoutMs: source.syncTimeoutMs ?? DEFAULTS.syncTimeoutMs,
    gitTimeoutMs: source.gitTimeoutMs ?? DEFAULTS.gitTimeoutMs,
    enabled: source.enabled ?? true,
  }
}

/** 依次尝试候选口令文件，返回第一个读到内容的。 */
function firstExisting(files: string[]): string | undefined {
  for (const file of files) {
    const value = readPassphraseFile(file, true)
    if (value) return value
  }
  return undefined
}

/** 硬超时：超时后返回 undefined，调用方据此降级。 */
async function withTimeout<T>(task: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const GitSync = async (input: PluginInput, options?: unknown) => {
  // 先按项目锁定状态目录：本地 clone / 状态库 / 日志都归这个项目所有，
  // 否则多项目共用一份会互相 amend/force-push 覆盖。
  setStateDir(projectStateDir(input.worktree))
  const config = readOptions(options)
  if (config.enabled === false) return {}

  // 远端默认复用项目自身的 origin，用户无需再配一次远端仓库。
  const remote = config.remote ?? (await detectRemote(input.worktree, config.gitTimeoutMs ?? DEFAULTS.gitTimeoutMs))
  if (!remote) {
    log.warn("项目仓库没有可用远端，插件不启用")
    return {}
  }
  if (!config.passphrase) {
    log.warn(
      `未找到 passphrase，插件不启用（会话内容必须加密）。请创建 ${defaultPassphraseFiles()[0]} 或设置 OPENCODE_GIT_SYNC_PASSPHRASE`,
    )
    return {}
  }

  const state = new State(stateDbPath())
  const machine = config.machine ?? state.machineID()
  const repo = new SyncRepo({
    dir: repoDir(),
    remote,
    machine,
    timeoutMs: config.gitTimeoutMs ?? DEFAULTS.gitTimeoutMs,
  })

  const rules = { worktree: input.worktree, directory: input.directory }
  const scope = {
    projectID: input.project.id,
    directory: input.directory,
    path: path.relative(path.resolve(input.worktree), path.resolve(input.directory)).replaceAll("\\", "/"),
  }

  const service = new SyncService({
    repo,
    state,
    client: input.client,
    rules,
    scope,
    passphrase: config.passphrase,
    machine,
    timeoutMs: config.gitTimeoutMs ?? DEFAULTS.gitTimeoutMs,
  })

  // 1) 准备本地仓库（纯本地，不触网）。
  await service.prepare()

  // 2) 首屏同步（混合策略）：
  //    预算内拉完 → 首屏即可见远端会话；
  //    拉不完（网络慢/SSH 握手 2~3s）→ 不阻塞启动，转后台继续，
  //    落地后调用 session.update 触发 session.updated，列表自动刷新。
  const syncTask = (async () => {
    const file = await findOpencodeDb()
    if (!file) {
      log.warn("未找到 opencode 数据库，本次不同步")
      await service.migrateLegacy()
      return undefined
    }
    const db = new OpencodeDb(file)
    let result: PullResult | undefined
    try {
      result = await service.pull(db)
      if (result.changed.length > 0) await service.notifyChanged(result.changed)
    } finally {
      db.close()
    }
    // 旧布局（一条消息一个文件）合并成封包；先写包再删旧文件，失败不丢数据。
    await service.migrateLegacy()
    return result
  })()

  const budget = config.syncTimeoutMs ?? DEFAULTS.syncTimeoutMs
  const pulled = await withTimeout(syncTask, budget)
  if (pulled) {
    log.info(`首屏同步完成：会话 ${pulled.sessions}，消息 ${pulled.messages}`)
  } else {
    log.warn(`首屏同步未在 ${budget}ms 内完成，转入后台继续（完成后自动刷新会话列表）`)
    void syncTask
      .then((result) => {
        if (!result) return
        log.info(`后台同步完成：会话 ${result.sessions}，消息 ${result.messages}`)
      })
      .catch((error) => {
        log.warn(`后台同步失败: ${error instanceof Error ? error.message : String(error)}`)
      })
  }

  return {
    event: async ({ event }: { event: PluginEvent }) => {
      if (event.type !== "session.idle") return
      const sessionID = event.properties?.["sessionID"]
      if (typeof sessionID !== "string") return
      try {
        // 暂存失败就不入队：否则 flush 时会推一个空分支上去
        const staged = await service.stage(sessionID)
        if (!staged) {
          log.warn(`会话暂存为空（可能没有新消息）: ${sessionID}`)
          return
        }
        service.schedule(sessionID, config.debounceMs ?? DEFAULTS.debounceMs)
      } catch (error) {
        log.warn(`暂存会话失败 ${sessionID}: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    dispose: async () => {
      try {
        await withTimeout(service.flush(), 5000)
      } catch {
        // ignore
      }
      // 先标记失效再关库：实例销毁后可能还有迟到的 事件到达，不能再碰已关闭的状态库。
      service.dispose()
      state.close()
    },
  }
}

// 只导出这一个函数：上游 legacy 加载器会把模块里所有导出都当作插件工厂。
export default GitSync
