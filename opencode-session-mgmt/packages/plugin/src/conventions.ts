/**
 * 编写规约送达：按工作流类型（reqdoc/sdlc/…）加载「绑定规约」目录内 *.md，注入系统提示。
 * 只注入、无门禁（质量飞轮不参与）；新增工作流 = 丢一个 conventions/<type>/ 目录，零代码。
 *
 * 阶段化注入（对齐 rulesForStage 的「global + 当前阶段」哲学，降低弱模型上下文负担）：
 *   每个规约文件头部可用 frontmatter 声明所属阶段：
 *       ---
 *       stage: <阶段键 | global>
 *       ---
 *   无 frontmatter 或 stage: global 视为「常驻」，全程注入；否则仅在对应阶段注入。
 *   stage 为 null（未开始/完成态）时只注入 global 规约。
 *
 * 两层来源，合并后返回：
 *   - 基线：随插件打包，位于 packages/plugin/conventions/<type>/（以 import.meta.dir 相对探测，仿 template.ts）。
 *   - 覆盖：机构/项目自定义，位于 <projectRoot>/conventions/<type>/（按类型读取，类型隔离不跨流泄漏）。
 * 基线在前、覆盖在后，各自目录内按文件名排序，最终按 stage 过滤拼接；无匹配返回 null（调用方不注入）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const CONVENTIONS_DIRNAME = "conventions"
const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

interface ConventionFile {
  stage: string
  body: string
}

/** 解析单个规约文件的 frontmatter；返回 { stage, body }，无 frontmatter 视为 global。 */
function parseConvention(text: string): ConventionFile {
  const m = text.match(FRONTMATTER)
  if (!m) return { stage: "global", body: text }
  const stage = m[1].match(/(?:^|\n)[ \t]*stage[ \t]*:[ \t]*([^\s]+)/)?.[1] ?? "global"
  return { stage, body: text.slice(m[0].length).trim() }
}

/** 基线候选路径（相对 import.meta.dir，覆盖源码与打包两种形态）。 */
function baselineCandidates(type: string): string[] {
  const here = import.meta.dir
  return [join(here, "../conventions", type), join(here, "conventions", type)]
}

/** 读单个目录下全部规约（过滤 .md、跳过点文件、按文件名排序、去空文件、解析 frontmatter）。 */
function readDirFiles(dir: string): ConventionFile[] {
  if (!existsSync(dir)) return []
  let files: string[] = []
  try {
    files = readdirSync(dir)
  } catch {
    return []
  }
  return files
    .filter((name) => name.endsWith(".md") && !name.startsWith("."))
    .sort()
    .flatMap((name) => {
      try {
        const text = readFileSync(join(dir, name), "utf8").trim()
        if (text.length === 0) return []
        const parsed = parseConvention(text)
        return parsed.body.length > 0 ? [parsed] : []
      } catch {
        return []
      }
    })
}

/** 从已解析规约中筛出「global + 当前阶段」并拼接。 */
function selectStage(files: ConventionFile[], stage: string | null): string {
  return files
    .filter((f) => f.stage === "global" || (stage !== null && f.stage === stage))
    .map((f) => f.body)
    .join("\n\n")
}

const cache = new Map<string, string | null>()

/** 加载指定工作流类型 + 阶段的绑定规约（基线 + 项目覆盖），无匹配返回 null。 */
export function loadWorkflowConventions(type: string, stage: string | null, projectRoot = process.cwd()): string | null {
  const key = `${type}:${stage ?? "*"}:${projectRoot}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit

  const parts: string[] = []
  for (const dir of baselineCandidates(type)) {
    const section = selectStage(readDirFiles(dir), stage)
    if (section) {
      parts.push(section)
      break
    }
  }
  const overlay = selectStage(readDirFiles(join(projectRoot, CONVENTIONS_DIRNAME, type)), stage)
  if (overlay) parts.push(overlay)

  const result = parts.length > 0 ? parts.join("\n\n") : null
  cache.set(key, result)
  return result
}