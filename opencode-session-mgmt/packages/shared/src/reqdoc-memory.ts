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
 * 静默接受默认的条目**一律不入库**（3.6 规则 3 / 硬红线）。
 * 业务点「同意默认」等于没真的认可，凭什么让下一个需求直接采信。
 */
export function isPollutingOrigin(origin: string): boolean {
  return origin === "accepted_default" || origin === "inferred"
}

function readJsonDir<T>(layer: MemoryLayer): T[] {
  const dir = join(memoryRoot(), layer)
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"))
  } catch {
    return []
  }
  return files
    .map((file) => {
      try {
        return JSON.parse(readFileSync(join(dir, file), "utf8")) as T
      } catch {
        return null
      }
    })
    .filter((x): x is T => x !== null && (x as { retired?: boolean }).retired !== true)
}

/**
 * 按材料文本做关键词匹配，只返回命中条目（3.6：由材料驱动 + 封顶）。
 *
 * 匹配口径：条目 key（term / content）作为子串出现在材料文本中即命中——
 * 刻意保守（宁可少命中也不误命中），因为 L1 命中会直接消缺口。
 */
export function matchMemory(text: string): MemoryHits {
  const hay = text.replace(/\s+/g, "")
  if (!hay) return { l1: [], l2: [] }
  return {
    l1: readJsonDir<MemoryTerm>("l1-glossary").filter((t) => t.term && hay.includes(t.term.replace(/\s+/g, ""))),
    l2: readJsonDir<MemoryFact>("l2-org").filter((f) => f.content && hay.includes(f.content.replace(/\s+/g, ""))),
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
  const path = join(dir, `${term}.json`)
  const existing = readJsonDir<MemoryTerm>("l1-glossary").find((t) => t.term === term)
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
  const path = join(dir, `${content.replace(/[^\p{L}\p{N}]+/gu, "_").slice(0, 60)}.json`)
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
  const path = join(dir, `${key.replace(/[^\p{L}\p{N}]+/gu, "_").slice(0, 60)}.json`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path,
    JSON.stringify({ key, value, scope: opts.scope, origin: opts.origin, confirmedAt: Date.now(), fromProject: opts.fromProject } satisfies MemoryPref, null, 2) + "\n",
    "utf8",
  )
  return { ok: true, path }
}