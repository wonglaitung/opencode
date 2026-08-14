/**
 * IDE 进程与参数层(设计文档 2.3、3.1)。
 * 纯函数:二进制定位、CLI 参数构造;spawn 用 detached + unref,daemon 不挂起。
 * 探测函数可注入以便测试(零 mock:注入真实而轻量的探针)。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { IdeEntry } from "./config"
import { OpenIdeError } from "./errors"
import type { IdeKind } from "./presets"

/** 待打开的目标:项目目录,或项目目录 + 相对文件(可带行/列定位)。 */
export interface OpenTarget {
  directory: string
  file?: string
  line?: number
  column?: number
}

/** 二进制定位结果:命中的 entry + 解析后的可执行路径。 */
export interface ResolvedIde {
  entry: IdeEntry
  binary: string
}

/**
 * 探测候选,命中返回解析后的可执行路径(供 spawn 直接用),未命中返回 null。
 * 真实实现查 PATH/绝对路径/glob;测试注入假探针。
 */
export type BinaryProbe = (candidate: string) => string | null

/** 在 PATH 中查找可执行文件;未找到返回 null。win32 用 where,其余用 which。 */
function findInPath(name: string): string | null {
  const cmd = process.platform === "win32" ? "where" : "which"
  const res = spawnSync(cmd, [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  if (res.status !== 0) return null
  const first = (res.stdout ?? "").split(/\r?\n/)[0]?.trim()
  return first && first !== "" ? first : null
}

/** 展开 `~` 前缀(仅简单替换 HOME,不含 shell 语义)。 */
function expandHome(path: string): string {
  return path.replace(/^~/, process.env["HOME"] ?? "")
}

/**
 * glob 模式展开,返回首个命中;无 `*` 时退化为普通存在性检查。
 * 用 Bun.Glob(零依赖);命中后取第一项。
 */
function resolveGlob(pattern: string): string | null {
  if (!pattern.includes("*")) {
    const expanded = expandHome(pattern)
    return existsSync(expanded) ? expanded : null
  }
  const scanner = new Bun.Glob(expandHome(pattern).replace(/\\/g, "/"))
  for (const match of scanner.scanSync()) {
    return match
  }
  return null
}

/**
 * 真实探测:含 `*` 按 glob 展开取首个命中;绝对/相对路径(含 `~`)查存在性;
 * 否则查 PATH。命中返回可执行路径,未命中返回 null。
 */
export function probeBinary(candidate: string): string | null {
  if (candidate.includes("/") || candidate.includes("\\") || candidate.startsWith("~")) {
    return resolveGlob(candidate)
  }
  return findInPath(candidate)
}

/**
 * 按 order 顺序探测,返回第一个可用的 IDE;全部不可用抛中文错误(含安装指引)。
 * probe 可注入以便测试。返回的 binary 为解析后的绝对/相对路径(供 spawn 使用)。
 */
export function resolveIdeBinary(entries: IdeEntry[], probe: BinaryProbe = probeBinary): ResolvedIde {
  for (const entry of entries) {
    for (const candidate of entry.candidates) {
      const resolved = probe(candidate)
      if (resolved === null) continue
      return { entry, binary: resolved }
    }
  }
  const tried = entries
    .flatMap((e) => e.candidates)
    .join("、")
  throw new OpenIdeError(
    `未找到可用的 IDE(已尝试:${tried})。请安装 VS Code 或 IntelliJ IDEA 并确保命令行工具在 PATH 中,` +
      `或在插件 config.json 的 tools 中指定 binary 绝对路径。`,
  )
}

/** 解析文件目标为绝对路径:相对路径以项目目录为基准。 */
export function resolveFilePath(directory: string, file: string): string {
  return resolve(directory, file)
}

/**
 * 构造 IDE 启动参数(纯函数,便于单测)。kind 决定定位语法:
 * - vscode:`-g <path>:<line>[:<col>]`;无 file 时直接开目录
 * - idea:`--line <n> [--column <n>] <path>`;无 file 时直接开目录
 * 无定位需求时返回 [<路径>] 形式的目录/文件打开参数。
 */
export function buildOpenArgs(kind: IdeKind, target: OpenTarget): string[] {
  const filePath = target.file ? resolveFilePath(target.directory, target.file) : null
  if (!filePath) return [target.directory]
  if (kind === "vscode") {
    if (target.line !== undefined) {
      const position = `${filePath}:${target.line}${target.column !== undefined ? `:${target.column}` : ""}`
      return ["-g", position]
    }
    return [filePath]
  }
  if (kind === "idea") {
    const args: string[] = []
    if (target.line !== undefined) {
      args.push("--line", String(target.line))
      if (target.column !== undefined) args.push("--column", String(target.column))
    }
    args.push(filePath)
    return args
  }
  return [filePath]
}

/**
 * 启动 IDE(design 3.1)。
 * posix:detached + stdio ignore + unref,自成进程组、daemon 不挂起;
 * win32:code/idea 经 .cmd shim,须 shell:true 才能解析,含空格参数手动加引号。
 */
export function launchIde(binary: string, args: string[], directory: string): ChildProcess {
  const isWin = process.platform === "win32"
  const finalArgs = isWin ? args.map(quoteIfSpaced) : args
  const child = spawn(binary, finalArgs, {
    cwd: directory,
    detached: true,
    stdio: "ignore",
    shell: isWin,
  })
  child.unref()
  return child
}

/** win32 shell 模式下为含空格的参数加双引号(避免路径空格被 shell 拆词)。 */
function quoteIfSpaced(arg: string): string {
  return arg.includes(" ") ? `"${arg}"` : arg
}
