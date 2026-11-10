import {
  WEBSEC_CHECK_CATEGORY_LABELS,
  WEBSEC_REQUIRED_CHECK_CATEGORY_KEYS,
  type WebsecCoverageEntry,
  type WebsecEvidence,
  type WebsecRegressionEntry,
  type WebsecState,
  type WebsecSurfaceEntry,
} from "sm-shared"

/** 把完整 URL 或路径归一为“方法 + 路径”，用于 surface 与 evidence 匹配。 */
export function websecEndpointKey(method: string, endpoint: string): string {
  let path = endpoint
  try {
    const url = new URL(endpoint, "http://websec.local")
    path = url.pathname
  } catch {
    path = endpoint.split("?")[0] ?? endpoint
  }
  return `${method.toUpperCase()} ${path.replace(/\/+$/, "") || "/"}`
}

/** 从 Edge/匿名/HTTP 检查证据中补出资产清单，避免只依赖用户实际点击的页面。 */
export function surfaceFromEvidence(evidence: WebsecEvidence[]): WebsecSurfaceEntry[] {
  const seen = new Set<string>()
  const result: WebsecSurfaceEntry[] = []
  for (const item of evidence) {
    const key = websecEndpointKey(item.method, item.url)
    if (seen.has(key)) continue
    seen.add(key)
    let endpoint = item.url
    try {
      const url = new URL(item.url)
      endpoint = url.pathname
    } catch {
      // 保留原始值，交给覆盖矩阵按字符串匹配
    }
    result.push({
      id: `surface-${result.length + 1}`,
      method: item.method.toUpperCase(),
      endpoint,
      source: item.source ?? "manual",
      identity: item.identity,
      addedAt: Date.now(),
    })
  }
  return result
}

/** 为新增入口补齐所有必检类别的初始记录；不适用时也必须显式收口。 */
export function seedCoverage(surface: WebsecSurfaceEntry, existing: WebsecCoverageEntry[]): WebsecCoverageEntry[] {
  const keys = new Set(existing.map((item) => `${item.surfaceRef}:${item.category}`))
  return WEBSEC_REQUIRED_CHECK_CATEGORY_KEYS.flatMap((category) => {
    if (keys.has(`${surface.id}:${category}`)) return []
    return [
      {
        id: `${surface.id}:${category}`,
        surfaceRef: surface.id,
        category,
        status: "not_checked" as const,
        evidenceRefs: [],
        checkedAt: Date.now(),
      },
    ]
  })
}

export function coverageGaps(state: WebsecState | undefined): string[] {
  if (!state?.surface?.length) return []
  const evidenceIDs = new Set((state.evidence ?? []).map((item) => item.id))
  const gaps: string[] = []
  for (const surface of state.surface) {
    for (const category of WEBSEC_REQUIRED_CHECK_CATEGORY_KEYS) {
      const record = state.coverage?.find(
        (item) => item.surfaceRef === surface.id && item.category === category,
      )
      const label = `${surface.method} ${surface.endpoint} / ${WEBSEC_CHECK_CATEGORY_LABELS[category]}`
      if (!record || record.status === "not_checked") {
        gaps.push(label)
        continue
      }
      if (record.status === "not_applicable" && !record.note?.trim()) {
        gaps.push(`${label}（not_applicable 缺理由）`)
        continue
      }
      if (
        (record.status === "tested" || record.status === "finding") &&
        (record.evidenceRefs.length === 0 || record.evidenceRefs.some((id) => !evidenceIDs.has(id)))
      ) {
        gaps.push(`${label}（缺有效证据引用）`)
      }
    }
  }
  return gaps
}

export function coverageSummary(state: WebsecState | undefined): string {
  if (!state?.surface?.length) return "未建立入口清单"
  const total = state.surface.length * WEBSEC_REQUIRED_CHECK_CATEGORY_KEYS.length
  const done = state.surface.reduce(
    (sum, surface) =>
      sum +
      WEBSEC_REQUIRED_CHECK_CATEGORY_KEYS.filter((category) => {
        const record = state.coverage?.find(
          (item) => item.surfaceRef === surface.id && item.category === category,
        )
        return record?.status === "tested" || record?.status === "finding" || record?.status === "not_applicable"
      }).length,
    0,
  )
  const gaps = coverageGaps(state)
  return `${done}/${total} 已收口${gaps.length ? `，${gaps.length} 项未收口` : ""}`
}

export function regressionGaps(state: WebsecState | undefined): string[] {
  if (!state?.regression?.length) return []
  const evidenceIDs = new Set((state.evidence ?? []).map((item) => item.id))
  return state.regression.flatMap((item) => {
    const label = `${item.sourceFindingID} ${item.title}（${item.endpoint}）`
    if (item.status === "not_retested") return [label]
    if (item.status === "not_applicable" && !item.note?.trim()) return [`${label}（not_applicable 缺理由）`]
    if (
      (item.status === "still_present" || item.status === "fixed") &&
      (!item.evidenceRef || !evidenceIDs.has(item.evidenceRef))
    ) {
      return [`${label}（缺有效证据引用）`]
    }
    return []
  })
}

export function regressionSummary(state: WebsecState | undefined): string {
  const list = state?.regression ?? []
  if (list.length === 0) return "无历史 finding 回归任务"
  const done = list.filter((item) => item.status !== "not_retested").length
  return `${done}/${list.length} 已回归`
}

export function mergeRegression(
  current: WebsecRegressionEntry[] | undefined,
  next: WebsecRegressionEntry[],
): WebsecRegressionEntry[] {
  const byID = new Map((current ?? []).map((item) => [item.id, item]))
  for (const item of next) {
    if (!byID.has(item.id)) byID.set(item.id, item)
  }
  return [...byID.values()]
}
