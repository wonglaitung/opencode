/**
 * 纯只读代码扫描与 git 只读读取。
 *
 * 约束（code_review 子任务）：
 * - 不执行 build/test/lint，不安装依赖，不联网；
 * - 只读文件内容做 regex 匹配；git 只允许 diff/status/log/show/ls-files，
 *   并带 GIT_OPTIONAL_LOCKS=0，避免刷新 index；
 * - 不写项目文件，扫描结果只写插件自己的 WorkflowState。
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import {
  TASK_REVIEW_DIMENSION_KEYS,
  TASK_SCAN_SEVERITIES,
  type TaskReviewDimensionKey,
  type TaskScanFinding,
  type TaskScanReport,
  type TaskScanSeverity,
  type TaskScanSummary,
} from "sm-shared"

const SEVERITY_ORDER: Record<TaskScanSeverity, number> = {
  blocker: 0,
  critical: 1,
  major: 2,
  minor: 3,
  info: 4,
}

const MAX_FILE_BYTES = 1_000_000
const MAX_FILES = 2_000
const MAX_FINDINGS = 500
const MAX_FINDINGS_PER_RULE_FILE = 20
const MAX_GIT_OUTPUT = 60_000

const DEFAULT_EXCLUDES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/target/**",
  "**/vendor/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.cache/**",
  "**/__pycache__/**",
  "**/*.min.js",
  "**/*.map",
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/bun.lock",
  "**/bun.lockb",
]

export interface ReviewRule {
  id: string
  title: string
  severity: TaskScanSeverity
  dimension: TaskReviewDimensionKey
  globs: string[]
  excludeGlobs?: string[]
  pattern: string
  flags?: string
  message: string
  remediation?: string
  sonarKey?: string
  enabled?: boolean
}

export interface LoadedRules {
  rules: ReviewRule[]
  warnings: string[]
}

export interface ChangedFiles {
  files: string[]
  diffStats: { files: number; insertions: number; deletions: number }
}

const SEVERITY_SET = new Set<string>(TASK_SCAN_SEVERITIES)
const DIMENSION_SET = new Set<string>(TASK_REVIEW_DIMENSION_KEYS)

function normalizePath(path: string): string {
  return path.split(sep).join("/")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function validateRule(value: unknown, source: string, warnings: string[]): ReviewRule | null {
  if (!isRecord(value)) {
    warnings.push(`${source}: 规则不是对象，已跳过`)
    return null
  }
  const id = value.id
  if (typeof id !== "string" || id.trim() === "") {
    warnings.push(`${source}: 规则缺少 id，已跳过`)
    return null
  }
  const severity = value.severity
  const dimension = value.dimension
  const pattern = value.pattern
  if (typeof severity !== "string" || !SEVERITY_SET.has(severity)) {
    warnings.push(`${source}#${id}: severity 非法，已跳过`)
    return null
  }
  if (typeof dimension !== "string" || !DIMENSION_SET.has(dimension)) {
    warnings.push(`${source}#${id}: dimension 非法，已跳过`)
    return null
  }
  if (typeof pattern !== "string" || pattern === "") {
    warnings.push(`${source}#${id}: pattern 缺失，已跳过`)
    return null
  }
  const globs = Array.isArray(value.globs)
    ? value.globs.filter((g): g is string => typeof g === "string" && g !== "")
    : ["**/*"]
  const excludeGlobs = Array.isArray(value.excludeGlobs)
    ? value.excludeGlobs.filter((g): g is string => typeof g === "string" && g !== "")
    : undefined
  const flags = typeof value.flags === "string" ? value.flags : ""
  try {
    new RegExp(pattern, flags.includes("g") ? flags : flags + "g")
  } catch {
    warnings.push(`${source}#${id}: 正则无法编译，已跳过`)
    return null
  }
  return {
    id,
    title: typeof value.title === "string" && value.title !== "" ? value.title : id,
    severity: severity as TaskScanSeverity,
    dimension: dimension as TaskReviewDimensionKey,
    globs: globs.length > 0 ? globs : ["**/*"],
    excludeGlobs,
    pattern,
    flags,
    message: typeof value.message === "string" && value.message !== "" ? value.message : id,
    remediation: typeof value.remediation === "string" ? value.remediation : undefined,
    sonarKey: typeof value.sonarKey === "string" ? value.sonarKey : undefined,
    enabled: value.enabled !== false,
  }
}

function readCatalog(path: string, warnings: string[], includeDisabled: boolean): ReviewRule[] {
  if (!existsSync(path)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    warnings.push(`${path}: JSON 无法解析，已忽略`)
    return []
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.rules)) {
    warnings.push(`${path}: 缺少 rules 数组，已忽略`)
    return []
  }
  const rules: ReviewRule[] = []
  for (const item of parsed.rules) {
    // 项目目录允许只写 { id, enabled: false } 禁用内置规则，不必重复整条规则。
    if (includeDisabled && isRecord(item) && item.enabled === false && typeof item.id === "string") {
      rules.push({
        id: item.id,
        title: item.id,
        severity: "info",
        dimension: "readability",
        globs: ["**/*"],
        pattern: "",
        message: "",
        enabled: false,
      })
      continue
    }
    const rule = validateRule(item, path, warnings)
    if (rule && (includeDisabled || rule.enabled !== false)) rules.push(rule)
  }
  return rules
}

function builtinCatalogPath(): string {
  const candidates = [
    join(import.meta.dir, "..", "review-rules", "catalog.json"),
    join(import.meta.dir, "review-rules", "catalog.json"),
    join(import.meta.dir, "..", "..", "packages", "plugin", "review-rules", "catalog.json"),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

/** 加载内置规则 + 项目 .opencode/review-rules/catalog.json（按 id 覆盖/禁用）。 */
export function loadReviewRules(root: string): LoadedRules {
  const warnings: string[] = []
  const builtin = readCatalog(builtinCatalogPath(), warnings, false)
  const project = readCatalog(join(root, ".opencode", "review-rules", "catalog.json"), warnings, true)
  const merged = new Map<string, ReviewRule>()
  for (const rule of builtin) merged.set(rule.id, rule)
  for (const rule of project) {
    if (rule.enabled === false) {
      merged.delete(rule.id)
      continue
    }
    merged.set(rule.id, rule)
  }
  return { rules: [...merged.values()], warnings }
}

function matchesAny(globs: string[], path: string): boolean {
  return globs.some((glob) => new Bun.Glob(glob).match(path))
}

function isExcluded(rule: ReviewRule, path: string): boolean {
  if (matchesAny(DEFAULT_EXCLUDES, path)) return true
  if (rule.excludeGlobs && matchesAny(rule.excludeGlobs, path)) return true
  return false
}

function lineColumn(text: string, index: number): { line: number; column: number } {
  let line = 1
  let last = -1
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) {
      line++
      last = i
    }
  }
  return { line, column: index - last }
}

function safeRelative(root: string, file: string): string | null {
  const full = resolve(root, file)
  const base = resolve(root)
  if (full !== base && !full.startsWith(base + sep)) return null
  return normalizePath(relative(base, full))
}

function isDefaultExcluded(path: string): boolean {
  return matchesAny(DEFAULT_EXCLUDES, path)
}

/** 递归列出项目内文本候选文件（不跟随符号链接；受 MAX_FILES 限制）。 */
export function listCandidateFiles(root: string, warnings: string[] = []): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    if (out.length >= MAX_FILES) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return
      const full = join(dir, entry.name)
      const rel = normalizePath(relative(root, full))
      if (isDefaultExcluded(rel)) continue
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) out.push(rel)
    }
  }
  walk(root)
  if (out.length >= MAX_FILES) warnings.push(`文件数超过 ${MAX_FILES}，已截断`)
  return out
}

export async function runGitReadOnly(root: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd: root,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { ok: code === 0, stdout: stdout.slice(0, MAX_GIT_OUTPUT), stderr: stderr.trim().slice(0, 500) }
  } catch (error) {
    return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) }
  }
}

/** 读取工作区改动文件（staged + unstaged + untracked），并返回 numstat 汇总。 */
export async function readChangedFiles(root: string): Promise<ChangedFiles | null> {
  const unstaged = await runGitReadOnly(root, ["diff", "--relative", "--name-only", "--diff-filter=ACMRT"])
  if (!unstaged.ok) return null
  const staged = await runGitReadOnly(root, ["diff", "--relative", "--cached", "--name-only", "--diff-filter=ACMRT"])
  const untracked = await runGitReadOnly(root, ["ls-files", "--others", "--exclude-standard"])
  const names = new Set<string>()
  for (const source of [unstaged.stdout, staged.stdout, untracked.stdout]) {
    for (const line of source.split(/\r?\n/)) {
      const rel = line.trim()
      if (rel !== "") names.add(rel)
    }
  }
  const stats = await readDiffStats(root)
  if (stats) stats.files = names.size
  return { files: [...names], diffStats: stats ?? { files: names.size, insertions: 0, deletions: 0 } }
}

async function readDiffStats(root: string): Promise<ChangedFiles["diffStats"] | null> {
  const parts = await Promise.all([
    runGitReadOnly(root, ["diff", "--relative", "--numstat"]),
    runGitReadOnly(root, ["diff", "--relative", "--cached", "--numstat"]),
  ])
  let insertions = 0
  let deletions = 0
  for (const part of parts) {
    if (!part.ok) continue
    for (const line of part.stdout.split(/\r?\n/)) {
      const [added, removed] = line.split("\t")
      if (added === undefined || removed === undefined) continue
      if (/^\d+$/.test(added)) insertions += Number(added)
      if (/^\d+$/.test(removed)) deletions += Number(removed)
    }
  }
  return { files: 0, insertions, deletions }
}

function scanText(
  root: string,
  rel: string,
  text: string,
  rules: ReviewRule[],
  minSeverity: TaskScanSeverity,
  findings: TaskScanFinding[],
  warnings: string[],
): void {
  for (const rule of rules) {
    if (isExcluded(rule, rel)) continue
    if (!matchesAny(rule.globs, rel)) continue
    if (SEVERITY_ORDER[rule.severity] > SEVERITY_ORDER[minSeverity]) continue
    const flags = rule.flags?.includes("g") ? rule.flags : (rule.flags ?? "") + "g"
    let regex: RegExp
    try {
      regex = new RegExp(rule.pattern, flags)
    } catch {
      warnings.push(`${rule.id}: 正则无法编译，已跳过`)
      continue
    }
    let match: RegExpExecArray | null
    let count = 0
    const seen = new Set<number>()
    while ((match = regex.exec(text)) !== null && count < MAX_FINDINGS_PER_RULE_FILE) {
      if (match[0] === "") {
        regex.lastIndex++
        continue
      }
      const pos = match.index
      if (seen.has(pos)) continue
      seen.add(pos)
      const { line, column } = lineColumn(text, pos)
      findings.push({
        ruleId: rule.id,
        title: rule.title,
        severity: rule.severity,
        dimension: rule.dimension,
        file: rel,
        line,
        column,
        message: rule.message,
        remediation: rule.remediation,
        sonarKey: rule.sonarKey,
      })
      count++
      if (findings.length >= MAX_FINDINGS) {
        warnings.push(`findings 超过 ${MAX_FINDINGS}，已截断`)
        return
      }
    }
  }
}

export interface ScanOptions {
  scope: string[]
  files: string[]
  ruleIds?: string[]
  severity?: TaskScanSeverity
  diffStats?: ChangedFiles["diffStats"]
  skippedReason?: string
}

function emptySummary(): TaskScanSummary {
  return {
    status: "completed",
    scannedFiles: 0,
    findingCount: 0,
    bySeverity: { blocker: 0, critical: 0, major: 0, minor: 0, info: 0 },
    byDimension: {
      correctness: 0,
      security: 0,
      design: 0,
      tests: 0,
      impact: 0,
      readability: 0,
    },
    warnings: [],
  }
}

/** 对显式文件列表做纯 regex 扫描。 */
export function scanFiles(root: string, options: ScanOptions): TaskScanReport {
  const { rules, warnings } = loadReviewRules(root)
  const selected = options.ruleIds?.length
    ? rules.filter((rule) => options.ruleIds!.includes(rule.id))
    : rules
  const minSeverity = options.severity ?? "info"
  const findings: TaskScanFinding[] = []
  const files = [...new Set(options.files)]
  let scannedFiles = 0
  let scannedLines = 0
  for (const file of files) {
    const rel = safeRelative(root, file)
    if (!rel) {
      warnings.push(`${file}: 越界路径，已跳过`)
      continue
    }
    const full = join(root, rel)
    let stat
    try {
      stat = lstatSync(full)
    } catch {
      warnings.push(`${rel}: 文件不存在，已跳过`)
      continue
    }
    if (!stat.isFile() || stat.isSymbolicLink()) continue
    if (stat.size > MAX_FILE_BYTES) {
      warnings.push(`${rel}: 文件超过 ${MAX_FILE_BYTES} 字节，已跳过`)
      continue
    }
    let text: string
    try {
      text = readFileSync(full, "utf8")
    } catch {
      warnings.push(`${rel}: 无法读取，已跳过`)
      continue
    }
    if (text.includes("\u0000")) continue
    scannedFiles++
    scannedLines += text.split("\n").length
    scanText(root, rel, text, selected, minSeverity, findings, warnings)
  }
  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  )
  const summary = emptySummary()
  summary.status = options.skippedReason ? "skipped" : "completed"
  summary.scannedFiles = scannedFiles
  summary.findingCount = findings.length
  summary.diffStats = options.diffStats
  summary.reviewSize = options.diffStats
    ? { files: options.diffStats.files, lines: options.diffStats.insertions + options.diffStats.deletions }
    : { files: scannedFiles, lines: scannedLines }
  const size = summary.reviewSize
  if (size.files > 20 || size.lines > 500) {
    warnings.push(`审核规模 ${size.files} 文件/${size.lines} 行：建议控制在 20 文件/500 行以内，必要时说明拆分理由`)
  }
  if (size.files > 50 || size.lines > 1500) {
    warnings.push(`审核规模超过 50 文件/1500 行：必须在报告中说明拆分理由，或拆成多次审核`)
  }
  summary.skippedReason = options.skippedReason
  summary.warnings = warnings
  for (const finding of findings) {
    summary.bySeverity[finding.severity]++
    summary.byDimension[finding.dimension]++
  }
  return {
    ...summary,
    scope: options.scope,
    findings,
    engine: "regex",
    scannedAt: Date.now(),
  }
}
