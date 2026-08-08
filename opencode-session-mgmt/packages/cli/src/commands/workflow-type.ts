/**
 * opencode-sm workflow-type set <type> / get —— 查看/修改主要工作流类型（设计文档 5.1）。
 * 工作流类型是用户级身份属性（identity.json 第五问），由用户角色决定。
 * 角色变化时用本命令轻量改身份，比重跑 init 更轻（与"调组重跑 init"同语义）。
 * 只影响之后新建会话，历史归属不追溯（身份快照语义，3.1）。
 */
import { identityPath, readIdentity, resolveWorkflowType, writeIdentity } from "sm-shared"
import type { ParsedArgs } from "../index"

export async function runWorkflowType(args: ParsedArgs): Promise<void> {
  const sub = args.positionals[0]
  if (sub === "get" || sub === undefined) {
    const identity = readIdentity()
    if (!identity) {
      process.stdout.write(`尚未初始化身份，请先运行 opencode-sm init。\n`)
      process.exitCode = 1
      return
    }
    process.stdout.write(`工作流类型: ${identity.workflowType ?? "sdlc"}\n`)
    return
  }
  if (sub === "set") {
    const value = args.positionals[1]
    if (!value) {
      process.stderr.write("用法: opencode-sm workflow-type set <sdlc|reqdoc>\n")
      process.exitCode = 1
      return
    }
    const identity = readIdentity()
    if (!identity) {
      process.stdout.write(`尚未初始化身份，请先运行 opencode-sm init。\n`)
      process.exitCode = 1
      return
    }
    const type = resolveWorkflowType(value)
    writeIdentity({ ...identity, workflowType: type })
    process.stdout.write(`✓ 已更新 ${identityPath()}\n  工作流类型: ${type}\n（仅影响之后新建会话，历史归属不追溯）\n`)
    return
  }
  process.stderr.write("用法: opencode-sm workflow-type get | set <sdlc|reqdoc>\n")
  process.exitCode = 1
}