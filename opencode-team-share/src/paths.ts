/**
 * 路径归一化与文件名处理。
 *
 * 交接文件要跨机器流转：文件里不能出现源机器的绝对路径，否则接收方看到的是
 * 指向别人磁盘的路径，既无用又泄露目录结构。因此导出时把本机的
 * 工作区根与项目目录换成占位符，导入时再换成本机对应路径。
 *
 * 占位符口径与 opencode-git-sync 保持一致（${WORKSPACE_ROOT} / ${PROJECT_DIR}），
 * 两边互相导出的文件也能互认。
 */

export const WORKSPACE_PLACEHOLDER = "${WORKSPACE_ROOT}"
export const PROJECT_PLACEHOLDER = "${PROJECT_DIR}"

/**
 * 可用作工作区根的 worktree。
 * 非 git 目录的会话落在内置 global 项目里，worktree 是文件系统根（"/"、"C:/"），
 * 既不能当项目路径显示，也不能拿来拼接会话目录或替换路径。
 */
export function usableWorktree(worktree?: string | null): string | undefined {
  if (!worktree) return undefined
  const trimmed = worktree.replace(/[\\/]+$/, "")
  if (trimmed === "" || /^[A-Za-z]:$/.test(trimmed)) return undefined
  return worktree
}

/** 归一化规则：worktree 是项目根，directory 是会话所在目录。 */
export type PathRules = { worktree: string; directory: string }

function replaceInString(value: string, rules: PathRules, restore: boolean): string {
  const pairs: Array<[string, string]> = restore
    ? [
        [WORKSPACE_PLACEHOLDER, rules.worktree],
        [PROJECT_PLACEHOLDER, rules.directory],
      ]
    : [
        [rules.worktree, WORKSPACE_PLACEHOLDER],
        [rules.directory, PROJECT_PLACEHOLDER],
      ]
  // 长路径优先替换：directory 可能是 worktree 的子目录，先换 worktree 会把 directory 也吃掉。
  pairs.sort((a, b) => b[0].length - a[0].length)
  let result = value
  for (const [from, to] of pairs) {
    // 过短的 from（"/"、"C:\\"）会把无关字符串里的分隔符也替换掉，
    // 曾把会话 path 破坏成 "projects${WORKSPACE_ROOT}scheduler"。宁可不替换。
    if (!from || from.length < 4) continue
    result = result.split(from).join(to)
  }
  return result
}

/** 递归替换字符串值中的路径（restore=false 归一化，true 还原）。 */
export function mapStrings(value: unknown, rules: PathRules, restore: boolean): unknown {
  if (typeof value === "string") return replaceInString(value, rules, restore)
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, rules, restore))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = mapStrings(item, rules, restore)
    }
    return out
  }
  return value
}

/** 绝对路径 → 占位符。 */
export function normalize(value: unknown, rules: PathRules): unknown {
  return mapStrings(value, rules, false)
}

/** 占位符 → 本机绝对路径。 */
export function denormalize(value: unknown, rules: PathRules): unknown {
  return mapStrings(value, rules, true)
}

/** 会话 slug：照抄上游 Slug.create 的形容词-名词词表，避免与 opencode 生成的风格不一致。 */
const ADJECTIVES = [
  "brave", "calm", "clever", "cosmic", "crisp", "curious", "eager", "gentle", "glowing", "happy",
  "hidden", "jolly", "kind", "lucky", "mighty", "misty", "neon", "nimble", "playful", "proud",
  "quick", "quiet", "shiny", "silent", "stellar", "sunny", "swift", "tidy", "witty",
] as const

const NOUNS = [
  "cabin", "cactus", "canyon", "circuit", "comet", "eagle", "engine", "falcon", "forest", "garden",
  "harbor", "island", "knight", "lagoon", "meadow", "moon", "mountain", "nebula", "orchid", "otter",
  "panda", "pixel", "planet", "river", "rocket", "sailor", "squid", "star", "tiger", "wizard", "wolf",
] as const

export function createSlug(): string {
  return [
    ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]!,
    NOUNS[Math.floor(Math.random() * NOUNS.length)]!,
  ].join("-")
}

/** 文件名里的非法字符（Windows 为主）。 */
const ILLEGAL_FILENAME = /[\\/:*?"<>|]/g

/** 把会话标题洗成可用的文件名片段。 */
export function safeFileName(title: string, limit = 40): string {
  const cleaned = title.replace(ILLEGAL_FILENAME, "_").replace(/\s+/g, " ").trim()
  const cut = cleaned.slice(0, limit).trim()
  return cut.length > 0 ? cut : "session"
}

/** 交接文件默认名：会话交接-<标题>-<日期>.ocsave */
export function defaultHandoffFileName(title: string, at = new Date()): string {
  const date = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`
  return `会话交接-${safeFileName(title)}-${date}.ocsave`
}
