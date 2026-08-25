/**
 * config.json 读取与合并(设计文档 2.2、决策记录 D1；open-ide 合并)。
 * 配置文件位于插件包根(本文件上溯一层,即 packages/plugin/config.json),用户编辑它来定自己的次序与工具。
 * 合并语义:order 逐项取 tools 覆盖后的 binary;config.json 缺失/字段缺失 → 内置预设;
 * 无效 JSON 记 warning 回退默认,不崩溃。插件加载时只读一次。
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_ORDER, IDE_PRESETS, type IdeKind } from "./presets"

/** 单个 IDE 工具的最终解析结果:id + 启动候选二进制列表 + CLI 语法 kind。 */
export interface IdeEntry {
  id: string
  kind: IdeKind
  candidates: string[]
}

/** config.json 中 tools 的单条覆盖/新增定义。 */
export interface IdeToolOverride {
  binary: string
  kind: IdeKind
}

/** config.json 的可选字段(raw 形态,字段缺失时按预设兜底)。 */
export interface IdeConfigFile {
  order?: string[]
  tools?: Record<string, IdeToolOverride>
}

/** 从插件目录读取并解析 config.json;缺失或无效时回退内置预设。 */
export function loadIdeConfig(pluginDir: string): IdeEntry[] {
  const file = join(pluginDir, "config.json")
  if (!existsSync(file)) return resolveEntries({})
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    // 常见诱因:Windows 路径里的反斜杠。JSON 中 `\P` 属非法转义会导致解析失败,
    // 而 `\b`/`\n` 是合法转义会被静默转成控制字符。提示改用正斜杠或双反斜杠。
    console.warn(
      `[open-ide] config.json 解析失败(${String(error)}),已回退内置预设。` +
        `若 tools.binary 是 Windows 路径,请改用正斜杠(如 C:/Program Files/...)或双反斜杠(\\\\),` +
        `切勿写单反斜杠(\\ 是 JSON 转义符)。`,
    )
    return resolveEntries({})
  }
  return resolveEntries(parseConfigFile(raw))
}

/** 校验 config.json 结构,字段缺失/类型不符按缺省处理(读侧容忍)。 */
function parseConfigFile(raw: unknown): IdeConfigFile {
  if (typeof raw !== "object" || raw === null) return {}
  const source = raw as Record<string, unknown>
  const order = Array.isArray(source.order) ? source.order.filter((v): v is string => typeof v === "string") : undefined
  let tools: Record<string, IdeToolOverride> | undefined
  if (typeof source.tools === "object" && source.tools !== null) {
    tools = {}
    for (const [id, value] of Object.entries(source.tools)) {
      if (typeof value !== "object" || value === null) continue
      const v = value as Record<string, unknown>
      const binary = typeof v.binary === "string" && v.binary.trim() !== "" ? v.binary.trim() : undefined
      const kind = v.kind === "idea" ? "idea" : v.kind === "vscode" ? "vscode" : undefined
      if (binary && kind) tools[id] = { binary, kind }
    }
    if (Object.keys(tools).length === 0) tools = undefined
  }
  return { order, tools }
}

/**
 * 合并 config.json 与内置预设,产出按 order 排序的解析条目。
 * - order 缺省用 DEFAULT_ORDER(vscode → idea);
 * - order 中的每个 id:tools 有覆盖 → 用覆盖的 binary/kind;否则用内置预设;
 * - 既无覆盖也无预设的 id 直接丢弃(order 里可不含它);
 * - tools 单独出现、未出现在 order 中的 id 不生效(只影响其对应 id 的覆盖)。
 */
export function resolveEntries(config: IdeConfigFile): IdeEntry[] {
  const order = Array.isArray(config.order) && config.order.length > 0 ? config.order : DEFAULT_ORDER
  const entries: IdeEntry[] = []
  for (const id of order) {
    const override = config.tools?.[id]
    const preset = IDE_PRESETS[id]
    if (override && (override.kind === "vscode" || override.kind === "idea") && override.binary.trim() !== "") {
      entries.push({ id, kind: override.kind, candidates: [override.binary] })
    } else if (preset) {
      entries.push({ id, kind: preset.kind, candidates: preset.candidates(process.platform) })
    }
  }
  return entries
}
