/**
 * 记忆读写（设计文档 3.5~3.7，阶段 3 接线）。
 *
 * 记忆**不可见给模型**——模型只能通过工具返回看到"命中/未命中"的结论，
 * 不能读到原始条目（3.6：读取由服务端完成，只返回命中项，这是 7.1 的封顶机制）。
 *
 * 四条硬规则（3.6）落在本文件：
 * 1. **L1 是唯一能消缺口的级**——`deriveQuestions` 据此把命中项视为已确认。
 * 2. **L2 不消缺口**，只作默认值带出（`reqdoc_answer` 时仍需业务点头）。
 * 3. **静默接受默认不入库**（`origin=accepted_default` 一律拒写）——这是防污染的唯一入口。
 * 4. **冲突优先于记忆**：材料与记忆不一致时不静默取记忆，交业务裁决（见 `matchMemory`）。
 *
 * 目录布局与 `opencode-sm memory` CLI 同源（该 CLI 是可见性入口，3.7）：
 *   ~/.config/opencode/session-mgmt/memory/{l1-glossary,l2-org,l4-prefs}/*.json
 */
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { MemoryFact, MemoryTerm } from "./reqdoc-slots"

/**
 * 记忆根目录（与 CLI `opencode-sm memory` 严格同源）。
 *
 * `SM_MEMORY_HOME` 优先——测试隔离用，也给自托管部署留一个覆盖口。
 * 注意不能用 `process.env.HOME` 覆盖：Node/Bun 的 `homedir()` 不读该变量。
 */
export function memoryRoot(): string {
  const override = process.env.SM_MEMORY_HOME
  if (override) return override
  return join(homedir(), ".config", "opencode", "session-mgmt", "memory")
}

/** 三层目录名（与 CLI 的 LAYERS 键一一对应）。 */
export const MEMORY_LAYERS = ["l1-glossary", "l2-org", "l4-prefs"] as const
export type MemoryLayer = (typeof MEMORY_LAYERS)[number]

/**
 * L4 偏好条目：只影响生成详略与措辞，**永不进槽位、永不影响门禁**（3.3.2 sdlc 红线同源）。
 */
export interface MemoryPref {
  key: string
  value: string
  scope: "org" | "reqdoc" | "sdlc"
  origin: "restated" | "explicit" | "accepted_default" | "inferred"
  confirmedAt: number
  fromProject: string
  retired?: boolean
}

/** 一次记忆读取的结果：只含命中的条目（未命中的不返回，也不计数）。 */
export interface MemoryHits {
  /** L1 术语命中（消缺口） */
  l1: MemoryTerm[]
  /** L2 组织知识命中（不消缺口，只作默认值） */
  l2: MemoryFact[]
}

/**
 * 记忆文件名：**必须消毒**。
 *
 * `term` / `content` / `key` 全部由模型经工具参数指定，若直接拼进路径可逃出记忆目录
 * （`../../pwned` → 写到目录外，对抗审查 P0-3a 实测）。
 * 同时追加内容哈希后缀，避免长前缀截断导致两条不同记忆落到同一文件、静默覆盖（P1 #9）。
 */
function safeFileName(raw: string): string {
  const cleaned = raw.replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 40)
  const digest = createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 8)
  return `${cleaned || "entry"}-${digest}.json`
}

/**
 * 静默接受默认的条目**一律不入库**（3.6 规则 3 / 硬红线）。
 * 业务点「同意默认」等于没真的认可，凭什么让下一个需求直接采信。
 */
export function isPollutingOrigin(origin: string): boolean {
  return origin === "accepted_default" || origin === "inferred"
}

/**
 * 读取一层记忆目录，**逐条校验**后返回。
 *
 * 记忆库是全局的且设计上允许用户手工维护（3.7），因此损坏条目不能拖垮调用方：
 * JSON 语法错误、字段类型不符（如 `term: 2024`）一律跳过而非让 `.replace` 抛错——
 * 否则一个坏文件会让该机器上**所有工作流的所有请求**失败（对抗审查 P0-3b 实测）。
 */
/**
 * 词边界包含判定：命中要求 `term` 两侧**不是字母/数字/下划线**。
 *
 * 裸 `includes` 会让 2 字母缩写点亮一切——实测一段没提术语的正文
 * （"…AUDIT留痕…CIPS通道…卡片管理…"）误命中 `IT` / `CI` / `IP` / `卡` 四个，
 * 而 L1 命中会**直接消缺口**（业务不问），误命中的代价是错误产出 + 跨需求污染。
 * 中文按字边界处理（`卡` 不应命中 `卡片`/`考核`）。
 */
function containsTerm(haystack: string, term: string): boolean {
  const t = term.trim()
  if (!t) return false
  // 纯 ASCII 字母数字词（如 CRD / AML）要求非单词字符边界
  if (/^[A-Za-z0-9_]+$/.test(t)) {
    const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(t)}(?![A-Za-z0-9_])`, "i")
    return re.test(haystack)
  }
  // 含中文或符号的词：要求左右不与「组成该词的字符集」相邻，避免「卡」命中「卡片」
  const first = [...t][0]!
  const last = [...t].at(-1)!
  let from = 0
  for (;;) {
    const idx = haystack.indexOf(t, from)
    if (idx < 0) return false
    const before = haystack[idx - 1]
    const after = haystack[idx + t.length]
    if (!isSameCharClass(before, first) && !isSameCharClass(after, last)) return true
    from = idx + 1
  }
}

function isSameCharClass(neighbor: string | undefined, boundary: string): boolean {
  if (neighbor === undefined) return false
  return /[\p{L}\p{N}_]/u.test(neighbor) === /[\p{L}\p{N}_]/u.test(boundary)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function readJsonDir<T>(layer: MemoryLayer, isValid: (x: unknown) => boolean): T[] {
  const dir = join(memoryRoot(), layer)
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"))
  } catch {
    return []
  }
  const out: T[] = []
  for (const file of files) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), "utf8"))
    } catch {
      continue // 语法错误：跳过
    }
    if (!isValid(parsed)) continue // 字段类型不符：跳过
    const entry = parsed as T & { retired?: boolean }
    if (entry.retired === true) continue
    out.push(entry)
  }
  return out
}

const isL1Entry = (x: unknown): boolean =>
  typeof x === "object" && x !== null && typeof (x as MemoryTerm).term === "string" && (x as MemoryTerm).term !== ""
const isL2Entry = (x: unknown): boolean =>
  typeof x === "object" && x !== null && typeof (x as MemoryFact).content === "string" && (x as MemoryFact).content !== ""

/**
 * 按材料文本做关键词匹配，只返回命中条目（3.6：由材料驱动 + 封顶）。
 *
 * 匹配口径：条目 key（term / content）作为子串出现在材料文本中即命中——
 * 刻意保守（宁可少命中也不误命中），因为 L1 命中会直接消缺口。
 */
export function matchMemory(text: string): MemoryHits {
  const hay = text
  if (!hay.trim()) return { l1: [], l2: [] }
  return {
    l1: readJsonDir<MemoryTerm>("l1-glossary", isL1Entry).filter((t) => containsTerm(hay, t.term)),
    l2: readJsonDir<MemoryFact>("l2-org", isL2Entry).filter((f) => containsTerm(hay, f.content)),
  }
}

/** 关键词匹配用的材料摘要：从已提交槽位正文聚合（模型不提供原始材料，避免上下文膨胀）。 */
export function materialOf(contents: readonly string[]): string {
  return contents.join("\n")
}

/**
 * 写 L1 术语（3.6.1 ①：业务**复述**后立即写，`origin=restated`）。
 *
 * 防污染：accepted_default / inferred 一律拒写并返回原因——调用方据此提示模型改走确认式提问。
 * 同名不同义（3.3.1）不静默覆盖：已存在不同 definition 时返回 conflict，交业务裁决。
 */
export function writeL1Term(
  term: string,
  definition: string,
  opts: {
    kind: MemoryTerm["kind"]
    scope: MemoryTerm["scope"]
    origin: MemoryTerm["origin"]
    fromProject: string
  },
): { ok: true; path: string } | { ok: false; reason: "polluting_origin" } | { ok: false; reason: "conflict"; existing: string } {
  if (isPollutingOrigin(opts.origin)) return { ok: false, reason: "polluting_origin" }
  const dir = join(memoryRoot(), "l1-glossary")
  const path = join(dir, safeFileName(term))
  const existing = readJsonDir<MemoryTerm>("l1-glossary", isL1Entry).find((t) => t.term === term)
  if (existing && existing.definition !== definition) {
    return { ok: false, reason: "conflict", existing: existing.definition }
  }
  const entry: MemoryTerm = {
    term,
    definition,
    kind: opts.kind,
    scope: opts.scope,
    origin: opts.origin,
    confirmedAt: Date.now(),
    fromProject: opts.fromProject,
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(entry, null, 2) + "\n", "utf8")
  return { ok: true, path }
}

/**
 * 写 L2 组织知识（3.6.1 ③：定稿回顾勾选后才写）。
 * 与 L1 同样的防污染入口——accepted_default / inferred 拒写。
 */
export function writeL2Fact(
  content: string,
  opts: {
    source: MemoryFact["source"]
    scope: MemoryFact["scope"]
    origin: MemoryFact["origin"]
    fromProject: string
  },
): { ok: true; path: string } | { ok: false; reason: "polluting_origin" } {
  if (isPollutingOrigin(opts.origin)) return { ok: false, reason: "polluting_origin" }
  const dir = join(memoryRoot(), "l2-org")
  const path = join(dir, safeFileName(content))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path,
    JSON.stringify({ content, source: opts.source, scope: opts.scope, origin: opts.origin, confirmedAt: Date.now(), fromProject: opts.fromProject } satisfies MemoryFact, null, 2) + "\n",
    "utf8",
  )
  return { ok: true, path }
}

/** 写 L4 偏好（只影响表达，不影响事实与门禁）。 */
export function writeL4Pref(
  key: string,
  value: string,
  opts: { scope: MemoryPref["scope"]; origin: MemoryPref["origin"]; fromProject: string },
): { ok: true; path: string } | { ok: false; reason: "polluting_origin" } {
  if (isPollutingOrigin(opts.origin)) return { ok: false, reason: "polluting_origin" }
  const dir = join(memoryRoot(), "l4-prefs")
  const path = join(dir, safeFileName(key))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path,
    JSON.stringify({ key, value, scope: opts.scope, origin: opts.origin, confirmedAt: Date.now(), fromProject: opts.fromProject } satisfies MemoryPref, null, 2) + "\n",
    "utf8",
  )
  return { ok: true, path }
}