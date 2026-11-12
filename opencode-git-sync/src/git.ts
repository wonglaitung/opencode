import { spawn } from "node:child_process"
import { log } from "./log"

/**
 * git 进程封装。
 *
 * 关键约束：所有网络相关命令都必须有硬超时并杀掉子进程，
 * 否则断网时 `opencode -c` 会被 TCP/SSH 超时拖住几十秒到数分钟。
 */

const BASE_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/bin/true",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new",
  GIT_CONFIG_NOSYSTEM: "1",
  LC_ALL: "C",
}

export type GitResult = { code: number; stdout: string; stderr: string }

export function gitEnv(extra?: Record<string, string>): Record<string, string> {
  return { ...process.env, ...BASE_ENV, ...extra } as Record<string, string>
}

/** 执行一条 git 命令；超时后 kill 子进程并返回 code=124。 */
export function git(
  args: string[],
  opts: { cwd: string; timeoutMs?: number; env?: Record<string, string> },
): Promise<GitResult> {
  const timeoutMs = opts.timeoutMs ?? 8000
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env: gitEnv(opts.env),
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill("SIGKILL")
      resolve({ code: 124, stdout, stderr: `timeout after ${timeoutMs}ms` })
    }, timeoutMs)
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: 127, stdout, stderr: String(error) })
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

/** 执行并在失败时抛错的 git 包装。 */
export async function gitOrThrow(args: string[], opts: { cwd: string; timeoutMs?: number }): Promise<GitResult> {
  const result = await git(args, opts)
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} 失败(${result.code}): ${result.stderr.trim() || result.stdout.trim()}`)
  }
  return result
}

/**
 * 批量读取 blob 内容（一次进程读完多个对象）。
 * 输入形如 "sha path" 的列表，返回 sha → Buffer 映射。
 */
export async function readBlobs(
  shas: string[],
  opts: { cwd: string; timeoutMs?: number },
): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>()
  if (shas.length === 0) return result
  const unique = [...new Set(shas)]

  const payload = await new Promise<{ stdout: Buffer; stderr: string; code: number }>((resolve) => {
    const child = spawn("git", ["cat-file", "--batch"], {
      cwd: opts.cwd,
      env: gitEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    })
    const chunks: Buffer[] = []
    let stderr = ""
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill("SIGKILL")
      resolve({ stdout: Buffer.concat(chunks), stderr: "timeout", code: 124 })
    }, opts.timeoutMs ?? 15000)
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk))
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout: Buffer.concat(chunks), stderr: String(error), code: 127 })
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout: Buffer.concat(chunks), stderr, code: code ?? 1 })
    })
    for (const sha of unique) child.stdin?.write(sha + "\n")
    child.stdin?.end()
  })

  if (payload.code !== 0) {
    log.warn(`git cat-file --batch 失败: ${payload.stderr.trim()}`)
    return result
  }

  // 协议：每条记录为 "<sha> <type> <size>\n" + size 字节内容 + "\n"
  let offset = 0
  const buffer = payload.stdout
  while (offset < buffer.length) {
    const headerEnd = buffer.indexOf(0x0a, offset)
    if (headerEnd < 0) break
    const header = buffer.subarray(offset, headerEnd).toString("utf8").trim()
    offset = headerEnd + 1
    const parts = header.split(/\s+/)
    const sha = parts[0] ?? ""
    const size = Number(parts[2] ?? "0")
    if (!Number.isFinite(size) || size < 0) break
    const body = buffer.subarray(offset, offset + size)
    offset += size + 1
    if (body.length < size) break
    result.set(sha, Buffer.from(body))
  }
  return result
}
