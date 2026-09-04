/**
 * SSH 执行器(设计文档 2、3.1)。
 * 零依赖:直接调系统 OpenSSH 客户端(Bun.spawn),不引入 ssh2/node-ssh。
 * 跨平台:win32 用 where 多行结果按扩展名优先级选 .exe(.cmd/.bat 兜底),
 * 跳过无后缀行——cmd.exe 无法执行无后缀 POSIX sh 脚本,会静默失败(plugin-guide 7)。
 * 密码认证:ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no,
 * 密码经 stdin pipe 喂入(不进进程参数、不被记录)。
 * runner 可注入,便于零 mock 测试(对标 edge-debug 的 interval/time 注入)。
 */
import { ServerDebugError } from "./errors"

/** 远端服务器连接信息(仅存内存,退出即失,设计文档 6)。 */
export interface ServerConnection {
  host: string
  port: number
  user: string
  password?: string
  identityFile?: string
  logPaths: string[]
}

/** 一次命令执行的原始结果。 */
export interface SshRunResult {
  stdout: string
  stderr: string
  exitCode: number | null
}

/** 命令执行器:注入真实 Bun.spawn 或测试假实现。 */
export type CommandRunner = (cmd: string[], options: { stdin?: string }) => Promise<SshRunResult>

/** SSH 客户端能力(控制器仅依赖此接口,便于零 mock 测试)。 */
export interface SshClient {
  /** 验证连接可达(远端执行 echo 探针)。 */
  verify(conn: ServerConnection): Promise<void>
  /** 在远端执行命令,返回 stdout( exit != 0 抛 ServerDebugError )。 */
  run(conn: ServerConnection, remoteCmd: string): Promise<string>
}

const EXEC_PRIORITY = [".exe", ".cmd", ".bat"]

/**
 * win32 where 多行结果按扩展名优先级挑选可执行文件(plugin-guide 7)。
 * 同名命令常同时有 .cmd shim 与 .exe,首行可能是无法被 cmd 执行的脚本。
 */
export function pickWindowsExecutable(candidates: string[]): string | null {
  const withExt = candidates.filter((c) => /\.[a-z0-9]+$/i.test(c))
  for (const ext of EXEC_PRIORITY) {
    const hit = withExt.find((c) => c.toLowerCase().endsWith(ext))
    if (hit) return hit
  }
  return candidates[0] ?? null
}

/** 定位 ssh 客户端:win32 走 where,其余走 which;缺失抛中文错误并引导安装。 */
export async function resolveSshBinary(runner: CommandRunner = createBunRunner()): Promise<string> {
  if (process.platform === "win32") {
    const { stdout } = await runner(["where", "ssh"], {})
    const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const picked = pickWindowsExecutable(lines)
    if (!picked) {
      throw new ServerDebugError(
        "未找到 ssh 客户端(where ssh 无结果)。请在 Windows「设置 → 可选功能」中安装 OpenSSH 客户端后重试。",
      )
    }
    return picked
  }
  const { stdout } = await runner(["which", "ssh"], {})
  const path = stdout.trim().split(/\r?\n/)[0]
  if (!path) {
    throw new ServerDebugError("未找到 ssh 客户端(which ssh 无结果)。请安装 OpenSSH 客户端后重试。")
  }
  return path
}

/** 组装 ssh 参数(在二进制之后)。user@host 与远端命令始终在末尾。 */
export function buildSshArgs(conn: ServerConnection, remoteCmd: string, usePassword: boolean): string[] {
  const args = ["-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10", "-p", String(conn.port)]
  if (conn.identityFile && !usePassword) args.push("-i", conn.identityFile)
  if (usePassword) {
    args.push("-o", "PreferredAuthentications=password", "-o", "PubkeyAuthentication=no")
  }
  args.push(`${conn.user}@${conn.host}`)
  args.push(remoteCmd)
  return args
}

/** 去除可能意外泄露的敏感片段(密码不会出现在 stderr,此处为纵深防御)。 */
function sanitizeStderr(stderr: string, password?: string): string {
  let out = stderr.trim()
  if (password) out = out.split(password).join("***")
  return out.slice(0, 500)
}

/** 默认 runner:用 Bun.spawn 调真实系统命令,捕获 stdout/stderr,stdin 按需 pipe。 */
export function createBunRunner(): CommandRunner {
  return async (cmd, options) => {
    const proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: options.stdin !== undefined ? "pipe" : "ignore",
    })
    let writeDone: Promise<void> = Promise.resolve()
    const stdin = proc.stdin
    const data = options.stdin
    if (data !== undefined && stdin) {
      writeDone = (async () => {
        await stdin.write(data)
        await stdin.end()
      })()
    }
    const [stdout, stderr] = await Promise.all([
      proc.stdout ? Bun.readableStreamToText(proc.stdout) : Promise.resolve(""),
      proc.stderr ? Bun.readableStreamToText(proc.stderr) : Promise.resolve(""),
    ])
    await writeDone
    const exitCode = await proc.exited
    return { stdout, stderr, exitCode }
  }
}

/** 创建 SSH 客户端;二进制解析一次缓存。runner 可注入。 */
export async function createSshClient(runner: CommandRunner = createBunRunner()): Promise<SshClient> {
  const binary = await resolveSshBinary(runner)

  async function run(conn: ServerConnection, remoteCmd: string): Promise<string> {
    const usePassword = Boolean(conn.password)
    const cmd = [binary, ...buildSshArgs(conn, remoteCmd, usePassword)]
    const result = await runner(cmd, { stdin: usePassword ? conn.password : undefined })
    if (result.exitCode !== 0) {
      const detail = sanitizeStderr(result.stderr, conn.password)
      throw new ServerDebugError(
        `SSH 命令执行失败(退出码 ${result.exitCode ?? "未知"})。${detail ? `远端信息:${detail}` : "请检查账户、权限与网络可达性。"}`,
      )
    }
    return result.stdout
  }

  async function verify(conn: ServerConnection): Promise<void> {
    const out = await run(conn, "echo __server_debug_ok__")
    if (!out.includes("__server_debug_ok__")) {
      throw new ServerDebugError("SSH 连接已建立,但远端命令未返回预期结果,请检查账户 shell 环境与命令执行权限。")
    }
  }

  return { run, verify }
}
