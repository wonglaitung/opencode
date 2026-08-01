#!/usr/bin/env bun
/**
 * opencode-sm —— OpenCode Session Management CLI（设计文档 §5）。
 * 独立安装，与上游零耦合。命令：init / tag / workflow / stats / list。
 */
import { runInit } from "./commands/init"
import { runList } from "./commands/list"
import { runStats } from "./commands/stats"
import { runTag } from "./commands/tag"
import { runWorkflow } from "./commands/workflow"

export interface ParsedArgs {
  /** 位置参数（不含命令名） */
  positionals: string[]
  /** 具名参数：--key value / --key=value / --flag；重复键聚合为数组 */
  flags: Record<string, string | boolean | string[]>
}

/** 极简参数解析（无第三方依赖）。 */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags: ParsedArgs["flags"] = {}
  const setFlag = (key: string, value: string | boolean) => {
    const existing = flags[key]
    if (existing === undefined) {
      flags[key] = value
    } else if (Array.isArray(existing)) {
      existing.push(typeof value === "string" ? value : String(value))
    } else {
      flags[key] = [typeof existing === "string" ? existing : String(existing), typeof value === "string" ? value : String(value)]
    }
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=")
      if (eq !== -1) {
        setFlag(arg.slice(2, eq), arg.slice(eq + 1))
      } else {
        const key = arg.slice(2)
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith("--")) {
          setFlag(key, next)
          i++
        } else {
          setFlag(key, true)
        }
      }
    } else {
      positionals.push(arg)
    }
  }
  return { positionals, flags }
}

/** 取字符串数组型参数（单值也归一为数组）。 */
export function asStringArray(value: string | boolean | string[] | undefined): string[] {
  if (value === undefined || typeof value === "boolean") return []
  return Array.isArray(value) ? value : [value]
}

const USAGE = `opencode-sm —— OpenCode 会话管理 CLI

用法:
  opencode-sm init                              每台机器一次：四问写入 identity.json
  opencode-sm tag <sessionID> [--add ...] [--remove ...] [--list]
  opencode-sm workflow <sessionID> [checklist|comprehension|stats] [--unconfirmed]
  opencode-sm stats [<sessionID>] [--project <name>] [--group "组名"] [--org] [--period <nd>] [--json]
  opencode-sm list [--status <s>] [--tag <t>] [--json]

说明:
  --project   本地插件库按项目目录存放：缺省按当前工作目录聚合；可传项目目录
              路径以查看他处项目；传名称（非目录）时退化为 CWD 并仅作展示标签。

环境变量:
  OPENCODE_SM_SERVER   上游 daemon 地址（未设置时 cost/tokens/会话列表不可用，退化为本机数据）
`

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv
  const args = parseArgs(rest)
  switch (command) {
    case "init":
      await runInit(args)
      break
    case "tag":
      await runTag(args)
      break
    case "workflow":
      await runWorkflow(args)
      break
    case "stats":
      await runStats(args)
      break
    case "list":
      await runList(args)
      break
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE)
      break
    default:
      process.stderr.write(`未知命令：${command}\n\n${USAGE}`)
      process.exitCode = 1
  }
}

// 仅在作为入口直接运行时执行（被 import 时不触发，便于测试复用 parseArgs）
if (import.meta.main) {
  await main()
}
