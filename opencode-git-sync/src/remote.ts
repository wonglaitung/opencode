import { git } from "./git"
import { log } from "./log"

/**
 * 自动探测项目自身的远端。
 *
 * 同步通道直接复用项目仓库的 origin —— 用户不需要再配一次远端：
 * 会话数据落在项目仓库的 `ocsync/<machine>` 分支上。
 */
export async function detectRemote(worktree: string, timeoutMs = 8000): Promise<string | undefined> {
  const origin = await git(["remote", "get-url", "origin"], { cwd: worktree, timeoutMs })
  const url = origin.stdout.trim()
  if (origin.code === 0 && url) return url

  // 没有 origin 时退而求其次：用第一个 remote。
  const remotes = await git(["remote"], { cwd: worktree, timeoutMs })
  if (remotes.code !== 0) return undefined
  const first = remotes.stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!first) return undefined
  const fallback = await git(["remote", "get-url", first], { cwd: worktree, timeoutMs })
  const value = fallback.stdout.trim()
  if (fallback.code !== 0 || !value) {
    log.warn(`项目仓库没有可用远端（${worktree}）`)
    return undefined
  }
  return value
}
