/**
 * websec 产物独立校验器（零 import）。
 *
 * 刻意不复用产出侧模块（websec.ts / websec-state.ts）：类别、状态、严重度在这里是
 * 独立字面量，避免「同一份错误一起变绿」。离线 CLI 见 script/validate-websec.ts。
 *
 * 校验对象：
 * - coverage-ledger.json：入口 × 9 个必检类别是否恰好各一条、证据引用是否有效、
 *   not_applicable 是否有理由。
 * - report.json：verdict 与 findings 是否自洽、suspected 是否携带严重度、
 *   confirmed 是否有严重度与独立复核会话。
 */

const REQUIRED_CATEGORIES = [
  "authn",
  "authz",
  "input",
  "cors",
  "headers",
  "options",
  "export",
  "debug",
  "logic",
] as const

const COVERAGE_STATUSES = ["not_checked", "tested", "finding", "not_applicable"] as const
const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.every((item) => typeof item === "string") ? value : null
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== ""
}

export function validateWebsecArtifacts(report: unknown, ledger: unknown): string[] {
  if (!isObject(ledger)) return ["coverage-ledger.json 缺失或不是对象"]
  if (!isObject(report)) return ["report.json 缺失或不是对象"]

  const errors: string[] = []

  const required = asStringArray(ledger.requiredCategories)
  if (!required) {
    errors.push("ledger.requiredCategories 必须是字符串数组")
  } else if (
    required.length !== REQUIRED_CATEGORIES.length ||
    REQUIRED_CATEGORIES.some((key) => !required.includes(key))
  ) {
    errors.push(`ledger.requiredCategories 与校验器口径不一致：期望 ${REQUIRED_CATEGORIES.join(",")}`)
  }

  const evidence = asStringArray(ledger.evidence)
  if (!evidence) errors.push("ledger.evidence 必须是字符串数组")
  const evidenceSet = new Set(evidence ?? [])

  const surfaces = Array.isArray(ledger.surfaces) ? ledger.surfaces : null
  if (!surfaces) errors.push("ledger.surfaces 必须是数组")
  const surfaceIDs = new Set<string>()
  for (const [index, surface] of (surfaces ?? []).entries()) {
    if (!isObject(surface) || !nonEmptyString(surface.id)) {
      errors.push(`ledger.surfaces[${index}] 缺少 id`)
      continue
    }
    if (surfaceIDs.has(surface.id)) errors.push(`ledger.surfaces[${index}] 的 id 重复：${surface.id}`)
    surfaceIDs.add(surface.id)
  }

  const coverage = Array.isArray(ledger.coverage) ? ledger.coverage : null
  if (!coverage) errors.push("ledger.coverage 必须是数组")

  const seen = new Set<string>()
  for (const [index, record] of (coverage ?? []).entries()) {
    if (!isObject(record)) {
      errors.push(`ledger.coverage[${index}] 不是对象`)
      continue
    }
    const surfaceRef = record.surfaceRef
    const category = record.category
    const status = record.status
    if (!nonEmptyString(surfaceRef) || !surfaceIDs.has(surfaceRef)) {
      errors.push(`ledger.coverage[${index}] 的 surfaceRef 未登记：${String(surfaceRef)}`)
      continue
    }
    if (typeof category !== "string" || !(REQUIRED_CATEGORIES as readonly string[]).includes(category)) {
      errors.push(`ledger.coverage[${index}] 的 category 非法：${String(category)}`)
      continue
    }
    if (typeof status !== "string" || !(COVERAGE_STATUSES as readonly string[]).includes(status)) {
      errors.push(`${surfaceRef}/${category} 的 status 非法：${String(status)}`)
      continue
    }
    const key = `${surfaceRef}::${category}`
    if (seen.has(key)) errors.push(`覆盖记录重复：${key}`)
    seen.add(key)

    const refs = asStringArray(record.evidenceRefs) ?? []
    if (status === "tested" || status === "finding") {
      if (refs.length === 0) errors.push(`${key} 标 ${status} 但没有证据引用`)
      for (const ref of refs) {
        if (!evidenceSet.has(ref)) errors.push(`${key} 引用了未登记证据 ${ref}`)
      }
    }
    if (status === "not_applicable" && !nonEmptyString(record.note)) {
      errors.push(`${key} 标 not_applicable 但没有理由`)
    }
  }

  for (const surfaceID of surfaceIDs) {
    for (const category of REQUIRED_CATEGORIES) {
      if (!seen.has(`${surfaceID}::${category}`)) errors.push(`缺少覆盖记录：${surfaceID}/${category}`)
    }
  }

  const verdict = report.verdict
  if (verdict !== "passed" && verdict !== "issues_found") {
    errors.push(`report.verdict 非法：${String(verdict)}`)
  }
  const findings = Array.isArray(report.findings) ? report.findings : null
  if (!findings) {
    errors.push("report.findings 必须是数组")
    return errors
  }
  if (verdict === "passed" && findings.length > 0) errors.push("verdict=passed 时不能包含 findings")
  if (verdict === "issues_found" && findings.length === 0) errors.push("verdict=issues_found 时 findings 不能为空")

  for (const [index, finding] of findings.entries()) {
    const label = `report.findings[${index}]`
    if (!isObject(finding)) {
      errors.push(`${label} 不是对象`)
      continue
    }
    const status = finding.status
    if (status !== "confirmed" && status !== "suspected") {
      errors.push(`${label} 的 status 非法：${String(status)}`)
      continue
    }
    if (!nonEmptyString(finding.evidenceRef) || !evidenceSet.has(finding.evidenceRef)) {
      errors.push(`${label} 的 evidenceRef 未登记：${String(finding.evidenceRef)}`)
    }
    if (status === "suspected") {
      if (finding.severity !== undefined) errors.push(`${label} 是 suspected，不得携带 severity`)
      if (finding.verifierSessionID !== undefined) errors.push(`${label} 是 suspected，不得携带 verifierSessionID`)
      if (finding.verifierDecision !== undefined) errors.push(`${label} 是 suspected，不得携带 verifierDecision`)
      continue
    }
    if (typeof finding.severity !== "string" || !(SEVERITIES as readonly string[]).includes(finding.severity)) {
      errors.push(`${label} 是 confirmed，severity 非法：${String(finding.severity)}`)
    }
    if (!nonEmptyString(finding.verifierSessionID)) errors.push(`${label} 是 confirmed，缺少 verifierSessionID`)
    if (finding.verifierDecision !== "confirmed") {
      errors.push(`${label} 是 confirmed，verifierDecision 必须为 confirmed`)
    }
  }

  return errors
}
