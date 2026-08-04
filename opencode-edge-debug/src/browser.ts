/**
 * Edge 进程管理(设计文档 3.1、决策记录 D2、D3)。
 * 三平台二进制定位、以专用 profile spawn、进程树清理。
 * 优雅关闭(Browser.close)由 controller 编排,本模块只提供杀进程兜底。
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { EdgeDebugError } from "./errors"

/** 在 PATH 中查找可执行文件;未找到返回 null。 */
function which(name: string): string | null {
  try {
    const out = execFileSync("which", [name], { encoding: "utf8" }).trim()
    return out === "" ? null : out
  } catch {
    return null
  }
}

/**
 * 按平台定位 Edge 可执行文件;未找到抛带安装指引的中文错误。
 * platform 参数可注入以便测试。
 */
export function resolveEdgeBinary(platform: string = process.platform): string {
  if (platform === "win32") {
    const candidates = [
      join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Microsoft\\Edge\\Application\\msedge.exe"),
      join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "Microsoft\\Edge\\Application\\msedge.exe"),
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    throw new EdgeDebugError("未找到 Microsoft Edge(已检查 Program Files 常见路径)。请先安装 Edge。")
  }
  if (platform === "darwin") {
    const candidate = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    if (existsSync(candidate)) return candidate
    throw new EdgeDebugError("未找到 Microsoft Edge(/Applications)。请先安装 Edge。")
  }
  // linux(及其他 unix):按 stable 优先顺序在 PATH 中查找
  for (const name of ["microsoft-edge", "microsoft-edge-stable", "microsoft-edge-dev"]) {
    const found = which(name)
    if (found) return found
  }
  throw new EdgeDebugError(
    "PATH 中未找到 microsoft-edge / microsoft-edge-stable / microsoft-edge-dev。请先安装 Edge(见 https://www.microsoft.com/edge)。",
  )
}

export interface LaunchOptions {
  port: number
  url: string
  userDataDir: string
}

/**
 * 拉起带调试端口的 Edge(设计文档 3.1)。
 * 关键点:
 * - 必须使用专用 --user-data-dir:若用户已有 Edge 实例在运行,
 *   共用默认 profile 时调试端口不会生效(决策记录 D2);
 * - detached:true 使其自成进程组,便于整组清理。
 */
export function launchEdge(binary: string, options: LaunchOptions): ChildProcess {
  const args = [
    `--remote-debugging-port=${options.port}`,
    `--user-data-dir=${options.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    options.url,
  ]
  const child = spawn(binary, args, { detached: true, stdio: "ignore" })
  // 守护进程(daemon)不因浏览器存活而挂起;dispose 与 stop 负责显式清理
  child.unref()
  return child
}

/**
 * 强杀浏览器进程树(CDP Browser.close 失败时的兜底,决策记录 D3)。
 * posix:detached 启动的进程组可经 -pid 整组 SIGKILL;
 * win32:taskkill /T /F 递归结束。
 */
export function killProcessTree(child: ChildProcess | null): void {
  if (!child || child.pid === undefined) return
  if (child.exitCode !== null || child.signalCode !== null) return
  const pid = child.pid
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"])
      return
    }
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      // 非进程组 leader 或组已消失:退化为单进程 kill
      process.kill(pid, "SIGKILL")
    }
  } catch {
    // 进程可能已退出,忽略
  }
}
