/**
 * SSH 执行层(设计文档 3.1)。
 * 用 `ssh2` 库在进程内实现 SSH 客户端——不再 spawn 系统 ssh 客户端。
 * 原因(决策记录 D1 修订)：Win32-OpenSSH 只从控制台读密码、忽略管道 stdin，
 * 旧实现(spawn + 管道喂密码)在 Windows 上会弹出密码提示并永久挂起；改为库后
 * 认证完全在进程内完成，不接触控制台，跨平台一致。
 *
 * 说明：
 * - ssh2 的可选原生依赖 cpu-features 在 Bun 下会崩溃，安装须 `--omit=optional`(纯 JS 路径)。
 * - ssh2 经动态 import 懒加载，避免插件启动即加载大模块，也隔离其潜在加载失败。
 * - 连接信息(address/user/password/私钥)仅存内存，close / 插件卸载即失(设计文档 6)。
 * - 主机密钥默认自动接受(等价原 StrictHostKeyChecking=accept-new)；暂不提供固定指纹。
 * - buildConnectConfig 为纯函数，便于单测；真实连接用 ssh2 自带 Server 做零 mock 集成测试。
 */
import type { ConnectConfig } from "ssh2"
import { ServerDebugError } from "./errors"

/** 远端服务器连接信息(仅存内存，退出即失，设计文档 6)。 */
export interface ServerConnection {
  host: string
  port: number
  user: string
  password?: string
  identityFile?: string
  logPaths: string[]
}

/** SSH 客户端能力(控制器仅依赖此接口，便于零 mock 测试)。 */
export interface SshClient {
  /** 验证连接可达(远端执行 echo 探针)。首次调用会建立并缓存连接。 */
  verify(conn: ServerConnection): Promise<void>
  /** 在远端执行命令，返回 stdout(exit != 0 抛 ServerDebugError)。复用已建立连接。 */
  run(conn: ServerConnection, remoteCmd: string): Promise<string>
  /** 断开并清空缓存连接；未连接时幂等无操作。 */
  close(): void
}

/** SSH 握手超时(毫秒)。 */
const SSH_READY_TIMEOUT_MS = 15_000
/** 单条远端命令执行超时(毫秒)。 */
const SSH_EXEC_TIMEOUT_MS = 30_000
/** 错误消息中远端 stderr 的最大保留字符数。 */
const MAX_STDERR_CHARS = 500

/** 已建立的连接状态(闭包内持有，不出模块)。 */
interface LiveConnection {
  client: import("ssh2").Client
  ready: boolean
}

/**
 * 组装 ssh2 连接配置(纯函数，可单测)。
 * 认证优先级：password 优先；无 password 时用 privateKey。
 * 不设 hostVerifier → 默认自动接受主机密钥。tryKeyboard 支持用键盘交互方式承载密码。
 */
export function buildConnectConfig(conn: ServerConnection, privateKey?: string): ConnectConfig {
  const config: ConnectConfig = {
    host: conn.host,
    port: conn.port,
    username: conn.user,
    readyTimeout: SSH_READY_TIMEOUT_MS,
    tryKeyboard: true,
  }
  if (conn.password) config.password = conn.password
  else if (privateKey) config.privateKey = privateKey
  return config
}

/** 给认证失败消息补上加密私钥的修复提示(纵深防御，避免日志泄露密钥内容)。 */
function describeConnectError(message: string): string {
  const base = `SSH 连接失败：${message}`
  if (/encrypted|passphrase/i.test(message)) {
    return `${base}（当前不支持加密私钥口令，请改用未加密私钥或密码认证）`
  }
  return base
}

/** 读取私钥文件内容；不存在或读取失败抛 ServerDebugError。 */
async function readPrivateKey(identityFile: string): Promise<string> {
  const file = Bun.file(identityFile)
  if (!(await file.exists())) {
    throw new ServerDebugError(`私钥文件不存在：${identityFile}`)
  }
  return await file.text()
}

/** 建立一条新的 SSH 连接并等待 ready。 */
async function connect(conn: ServerConnection): Promise<LiveConnection> {
  if (!conn.password && !conn.identityFile) {
    throw new ServerDebugError("未提供密码或私钥（identityFile），无法建立非交互 SSH 连接。")
  }
  const privateKey = !conn.password && conn.identityFile ? await readPrivateKey(conn.identityFile) : undefined
  const { Client } = await import("ssh2")
  const client = new Client()
  const state: LiveConnection = { client, ready: false }
  await new Promise<void>((resolve, reject) => {
    let settled = false
    client.on("error", (err: Error) => {
      state.ready = false
      if (settled) return
      settled = true
      reject(new ServerDebugError(describeConnectError(err.message)))
    })
    client.on("close", () => {
      state.ready = false
    })
    if (conn.password) {
      // 部分 sshd 用 keyboard-interactive 承载密码；回填密码而非弹提示。
      client.on("keyboard-interactive", (_name, _instructions, _lang, _prompts, finish) => {
        finish([conn.password ?? ""])
      })
    }
    client.on("ready", () => {
      state.ready = true
      if (settled) return
      settled = true
      resolve()
    })
    client.connect(buildConnectConfig(conn, privateKey))
  })
  return state
}

/** 执行一条远端命令，收集 stdout/stderr 与退出码；超时则断开并抛错。 */
function exec(state: LiveConnection, remoteCmd: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      state.ready = false
      state.client.end()
      reject(new ServerDebugError(`SSH 命令执行超时（${SSH_EXEC_TIMEOUT_MS / 1000} 秒），已断开连接。`))
    }, SSH_EXEC_TIMEOUT_MS)
    state.client.exec(remoteCmd, (err, stream) => {
      if (err) {
        clearTimeout(timer)
        if (settled) return
        settled = true
        reject(new ServerDebugError(`SSH 命令下发失败：${err.message}`))
        return
      }
      let stdout = ""
      let stderr = ""
      stream
        .on("close", (code: number | null) => {
          clearTimeout(timer)
          if (settled) return
          settled = true
          resolve({ stdout, stderr, code })
        })
        .on("data", (chunk: Buffer) => {
          stdout += chunk.toString()
        })
      stream.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString()
      })
    })
  })
}

/** 创建 SSH 客户端；连接按需建立并在多次 run 间复用，close 释放。 */
export async function createSshClient(): Promise<SshClient> {
  let live: LiveConnection | null = null

  async function ensure(conn: ServerConnection): Promise<LiveConnection> {
    if (live && live.ready) return live
    live = await connect(conn)
    return live
  }

  async function run(conn: ServerConnection, remoteCmd: string): Promise<string> {
    const state = await ensure(conn)
    const { stdout, stderr, code } = await exec(state, remoteCmd)
    if (code !== 0) {
      const detail = stderr.trim().slice(0, MAX_STDERR_CHARS)
      throw new ServerDebugError(
        `SSH 命令执行失败（退出码 ${code ?? "未知"}）。${detail ? `远端信息：${detail}` : "请检查账户、权限与网络可达性。"}`,
      )
    }
    return stdout
  }

  async function verify(conn: ServerConnection): Promise<void> {
    const out = await run(conn, "echo __server_debug_ok__")
    if (!out.includes("__server_debug_ok__")) {
      throw new ServerDebugError("SSH 连接已建立，但远端命令未返回预期结果，请检查账户 shell 环境与命令执行权限。")
    }
  }

  function close(): void {
    if (!live) return
    live.ready = false
    live.client.end()
    live = null
  }

  return { verify, run, close }
}
