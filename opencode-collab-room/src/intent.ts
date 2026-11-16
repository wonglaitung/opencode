import { unlink } from "node:fs/promises"
import path from "node:path"

export const INTENT_DIR = ".opencode"
export const INTENT_FILE = "collab-room.json"
export const INTENT_TTL_MS = 60_000

export type Intent = { mode: "host" } | { mode: "join"; invite: string; name: string }

export type ConsumedIntent = { intent: Intent; path: string }

/**
 * 启动器把意图写到选定目录的 .opencode/ 下，但 opencode 的 project directory
 * 可能是 git 根目录（子目录启动时），所以两个位置都找。
 */
export function intentCandidates(input: { directory: string; cwd: string }) {
  const dirs = [input.directory, input.cwd].filter((dir) => dir.length > 0)
  return [...new Set(dirs.map((dir) => path.join(dir, INTENT_DIR, INTENT_FILE)))]
}

export function parseIntent(text: string): Intent | undefined {
  const raw = parseJson(text)
  if (!isRecord(raw)) return
  if (raw.mode === "host") return { mode: "host" }
  if (raw.mode !== "join") return
  const invite = typeof raw.invite === "string" ? raw.invite.trim() : ""
  const name = typeof raw.name === "string" ? raw.name.trim() : ""
  if (!invite || !name) return
  return { mode: "join", invite, name }
}

// 读后即删：避免下一次普通启动误开协作房间；过期文件同样删除。
export async function consumeIntent(candidates: string[], now = Date.now()): Promise<ConsumedIntent | undefined> {
  for (const file of candidates) {
    const handle = Bun.file(file)
    if (!(await handle.exists())) continue
    const fresh = now - handle.lastModified <= INTENT_TTL_MS
    const text = fresh ? await handle.text().catch(() => undefined) : undefined
    await unlink(file).catch(() => {})
    if (text === undefined) continue
    const intent = parseIntent(text)
    if (intent) return { intent, path: file }
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
