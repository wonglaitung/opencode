/**
 * opencode-sm tag <sessionID> [--add ...] [--remove ...] [--list]
 * 读写本机插件库 workflow_session.tags（设计文档 5.1）。
 */
import { asStringArray, type ParsedArgs } from "../index"
import { openPluginStore } from "../api"

export async function runTag(args: ParsedArgs): Promise<void> {
  const sessionID = args.positionals[0]
  if (!sessionID) {
    process.stderr.write("用法: opencode-sm tag <sessionID> [--add ...] [--remove ...] [--list]\n")
    process.exitCode = 1
    return
  }
  const store = openPluginStore(process.cwd())
  try {
    const add = asStringArray(args.flags.add)
    const remove = asStringArray(args.flags.remove)
    if (add.length > 0 || remove.length > 0) {
      const current = new Set(store.getTags(sessionID))
      for (const t of add) current.add(t)
      for (const t of remove) current.delete(t)
      store.setTags(sessionID, [...current])
    }
    const tags = store.getTags(sessionID)
    process.stdout.write(`${sessionID} 标签: ${tags.length > 0 ? tags.join(", ") : "（无）"}\n`)
  } finally {
    store.close()
  }
}
