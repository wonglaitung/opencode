/**
 * AI 代码行数：行数计算、业务/测试/配置三分类与分类汇总（设计文档 3.2「AI 代码行数统计」、7.4 规则 26-27）。
 * 纯函数，不触碰存储：plugin quality.ts 在 tool.execute.after 累计 linesByFile，
 * plugin stats.ts 汇总展示。
 * 隐私（12）：linesByFile 的键为文件路径，仅存本机插件库；汇报投影只上行三分类聚合数字。
 */

/** AI 净增行数三分类聚合（累加型指标：项目/组/组织级对会话求和、不做平均，6.3）。 */
export interface LinesCategory {
  business: number
  test: number
  config: number
}

export type FileCategory = keyof LinesCategory

/** 配置文件扩展名（3.2 三分类规则，小写后匹配）。 */
const CONFIG_EXTENSIONS = new Set([
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".conf",
  ".cfg",
  ".properties",
  ".env",
])

/** 配置文件 basename（3.2 三分类规则，小写后匹配）。.env 为 dotfile、extname 为空，也须经此通道。 */
const CONFIG_BASENAMES = new Set([
  ".npmrc",
  ".editorconfig",
  ".gitignore",
  ".prettierrc",
  ".eslintrc",
  ".prettierignore",
  ".eslintignore",
  ".env",
  "dockerfile",
  "makefile",
])

/** 测试目录路径段（3.2 三分类规则；仅匹配目录段，basename 不算，故 src/tests.ts 不是测试文件）。 */
const TEST_DIR_SEGMENTS = new Set(["test", "tests", "__tests__"])

/**
 * 测试文件 basename 模式（3.2）：*.test.* / *.spec.* / *_test.* / *_spec.* / test_*.*。
 * 边界：test.ts / tests.ts 不命中任何模式（glob *.test.* 需要前缀 + 字面点号），归业务代码。
 */
function isTestBasename(basename: string): boolean {
  return /\.(test|spec)\./.test(basename) || /_(test|spec)\./.test(basename) || /^test_.+\./.test(basename)
}

/** 物理行数：末尾换行不多计一行，空串计 0。 */
export function countLines(text: string): number {
  if (text === "") return 0
  return text.replace(/\n$/, "").split("\n").length
}

/**
 * 三分类（3.2，优先级 测试 → 配置 → 业务，大小写不敏感）：
 * 测试 = basename 命中测试命名，或含 test/tests/__tests__ 目录段；
 * 配置 = 配置扩展名或配置 basename；其余为业务代码。
 */
export function classifyFile(filePath: string): FileCategory {
  const segments = filePath.replace(/\\/g, "/").split("/")
  const basename = (segments[segments.length - 1] ?? "").toLowerCase()
  if (isTestBasename(basename) || segments.slice(0, -1).some((s) => TEST_DIR_SEGMENTS.has(s.toLowerCase()))) {
    return "test"
  }
  const dot = basename.lastIndexOf(".")
  const ext = dot > 0 ? basename.slice(dot) : ""
  if (CONFIG_EXTENSIONS.has(ext) || CONFIG_BASENAMES.has(basename)) return "config"
  return "business"
}

/**
 * 分类汇总（3.2 汇总口径）：分类累加，逐文件 clamp ≥ 0——
 * AI 净删除代码的文件不产生负贡献，避免「删代码」让会话行数出现反直觉的负值。
 */
export function sumLinesByCategory(linesByFile: Record<string, number>): LinesCategory {
  const total: LinesCategory = { business: 0, test: 0, config: 0 }
  for (const [file, lines] of Object.entries(linesByFile)) {
    total[classifyFile(file)] += Math.max(0, lines)
  }
  return total
}

/**
 * apply_patch patchText 轻量扫描器：逐文件净增量（+行数 − −行数，规则 26）。
 * 格式依据（只读核对，铁律不 import 上游模块，上游升级后需复核）：
 * 上游 packages/core/src/patch.ts——`*** Begin/End Patch`、`*** Add/Update/Delete File:`、
 * `*** Move to:` 紧跟 Update File 出现、`@@` hunk；
 * 上游 packages/opencode/src/tool/apply_patch.ts——CRLF 归一化。
 * 统计侧解析从宽：畸形行跳过不抛错（7 健壮性）。
 */
export function parsePatchLines(patchText: string): Record<string, number> {
  const result: Record<string, number> = {}
  const lines = patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
  let file: string | null = null
  let mode: "add" | "update" | "delete" | null = null
  let inHunk = false
  for (const line of lines) {
    if (line.startsWith("*** Add File:")) {
      file = line.slice("*** Add File:".length).trim()
      mode = "add"
      inHunk = false
      continue
    }
    if (line.startsWith("*** Update File:")) {
      file = line.slice("*** Update File:".length).trim()
      mode = "update"
      inHunk = false
      continue
    }
    if (line.startsWith("*** Delete File:")) {
      file = line.slice("*** Delete File:".length).trim()
      mode = "delete"
      inHunk = false
      continue
    }
    // `*** Move to:` 为改名（不计行数），不能重置当前文件；其余 *** 标记（Begin/End Patch）重置
    if (line.startsWith("*** Move to:")) continue
    if (line.startsWith("***")) {
      file = null
      mode = null
      inHunk = false
      continue
    }
    if (!file || !mode) continue
    if (mode === "add" && line.startsWith("+")) {
      result[file] = (result[file] ?? 0) + 1
    } else if (mode === "delete" && line.startsWith("-")) {
      result[file] = (result[file] ?? 0) - 1
    } else if (mode === "update") {
      if (line.startsWith("@@")) {
        inHunk = true
        continue
      }
      // Update 段仅统计 @@ hunk 内的 +/- 行（hunk 外为文件级元信息）
      if (!inHunk) continue
      if (line.startsWith("+")) result[file] = (result[file] ?? 0) + 1
      else if (line.startsWith("-")) result[file] = (result[file] ?? 0) - 1
    }
  }
  return result
}
