/**
 * opencode-sm memory list|forget —— 记忆可见性与遗忘（设计文档 3.7）。
 *
 * 可见性刻意走 CLI 而非模型工具：用户查记忆，终端敲命令比问模型可靠，
 * 也避免模型成为"它自己记得什么"的传声筒。**删文件即遗忘**。
 */
import { readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { MEMORY_LAYERS, memoryRoot } from "sm-shared"
import type { ParsedArgs } from "../index"

/**
 * 记忆目录（与插件同源）。
 *
 * 必须与 `packages/shared/src/reqdoc-memory.ts` 的 `memoryRoot()` **完全一致**，
 * 否则「删文件即遗忘」会删错地方、用户看到的记忆不是插件实际在用的
 * —— 对抗审查 P2-d：`SM_MEMORY_HOME` 自托管覆盖口下两者曾指向不同的库。
 */
function memoryDir(): string {
  return memoryRoot()
}

/**
 * 三层目录 → 中文名与说明（设计 3.4）。
 *
 * **目录名来自 `MEMORY_LAYERS`（shared）而非本地字面量**——此前的两份清单
 * 靠人工约定保持一致，正是要消除的漂移面（对抗审查 F-8）。
 */
const LAYER_META = {
  "l1-glossary": { label: "L1 术语", hint: "内部简称/机构/系统名；命中可消缺口（仅业务复述过的条目）" },
  "l2-org": { label: "L2 组织知识", hint: "系统清单/接口/产品线；命中只作草稿，不消缺口" },
  "l4-prefs": { label: "L4 偏好", hint: "措辞/详略/分工等个人习惯；只影响表达，不影响事实" },
} as const satisfies Record<(typeof MEMORY_LAYERS)[number], { label: string; hint: string }>

/** 层名 → 展示元数据（键集合由 MEMORY_LAYERS 约束，新增层必须补 meta 才会编译报错）。 */
const LAYERS = Object.fromEntries(
  MEMORY_LAYERS.map((layer) => [layer, LAYER_META[layer]]),
) as Record<(typeof MEMORY_LAYERS)[number], { label: string; hint: string }>

type LayerKey = (typeof MEMORY_LAYERS)[number]

interface MemoryEntry {
  term?: string
  key?: string
  definition?: string
  value?: string
  kind?: string
  scope?: string
  origin?: string
  fromProject?: string
  confirmedAt?: number
  retired?: boolean
}

function readLayer(layer: string): { file: string; entry: MemoryEntry }[] {
  const dir = join(memoryDir(), layer)
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"))
  } catch {
    return []
  }
  return files.map((file) => {
    try {
      return { file, entry: JSON.parse(readFileSync(join(dir, file), "utf8")) as MemoryEntry }
    } catch {
      return { file, entry: {} }
    }
  })
}

function fmtTime(ms: number | undefined): string {
  return ms ? new Date(ms).toISOString().slice(0, 10) : "—"
}

export async function runMemory(args: ParsedArgs): Promise<void> {
  const sub = args.positionals[0] ?? "list"
  if (sub === "forget") {
    const term = args.positionals[1]
    if (!term) {
      process.stdout.write("用法：opencode-sm memory forget <关键词>\n")
      return
    }
    let removed = 0
    for (const layer of Object.keys(LAYERS)) {
      for (const { file } of readLayer(layer)) {
        if (!file.includes(term)) continue
        rmSync(join(memoryDir(), layer, file), { force: true })
        removed++
      }
    }
    process.stdout.write(
      removed > 0
        ? `已遗忘 ${removed} 条与「${term}」相关的记忆。\n注意：若这些记忆正被未完成项目的槽位引用，请先在对话中改写对应槽位（reqdoc_answer），否则来源会悬空。\n`
        : `未找到与「${term}」相关的记忆。\n`,
    )
    return
  }

  if (sub !== "list") {
    process.stdout.write("用法：opencode-sm memory [list | forget <关键词>]\n")
    return
  }

  const lines: string[] = ["记忆（仅本机，不上行汇报）:"]
  let total = 0
  for (const [layer, meta] of Object.entries(LAYERS) as [LayerKey, (typeof LAYERS)[LayerKey]][]) {
    const entries = readLayer(layer)
    lines.push(`\n${meta.label}（${layer}/）—— ${meta.hint}`)
    if (entries.length === 0) {
      lines.push("  （无）")
      continue
    }
    total += entries.length
    for (const { file, entry } of entries) {
      const name = entry.term ?? entry.key ?? file
      const body = entry.definition ?? entry.value ?? ""
      const mark = entry.retired ? " [已作废]" : ""
      lines.push(
        `  - ${name}：${body}${mark}\n      范围 ${entry.scope ?? "org"}｜来源 ${entry.origin ?? "?"}｜${entry.kind ?? ""}｜项目 ${entry.fromProject ?? "?"}｜确认于 ${fmtTime(entry.confirmedAt)}｜${file}`,
      )
    }
  }
  lines.push(`\n合计 ${total} 条。遗忘：opencode-sm memory forget <关键词>（删文件即遗忘）`)
  process.stdout.write(lines.join("\n") + "\n")
}