/**
 * 独立校验器：覆盖台账与报告的自洽性。
 * 每个用例只改一个变量，确保坏输入一定报红。
 */
import { describe, expect, test } from "bun:test"
import { WEBSEC_REQUIRED_CHECK_CATEGORY_KEYS } from "sm-shared"
import { validateWebsecArtifacts } from "../src/websec-validate"

// 用生产侧常量构造夹具：若 shared 与校验器字面量漂移，「合法产物通过」会立刻报红。
const CATEGORIES = [...WEBSEC_REQUIRED_CHECK_CATEGORY_KEYS]

function ledger() {
  return {
    sessionID: "s1",
    testMode: "normal",
    requiredCategories: [...CATEGORIES],
    evidence: ["n1"],
    surfaces: [{ id: "s1:a", method: "GET", endpoint: "/api/settings", source: "edge" }],
    coverage: CATEGORIES.map((category) => ({
      surfaceRef: "s1:a",
      category,
      status: category === "authz" ? "tested" : "not_applicable",
      evidenceRefs: category === "authz" ? ["n1"] : [],
      note: category === "authz" ? undefined : "该入口不涉及",
    })),
  }
}

function report() {
  return {
    status: "submitted",
    method: "manual",
    verdict: "issues_found",
    findings: [
      {
        id: "f-1",
        status: "confirmed",
        severity: "high",
        verifierSessionID: "s1-verifier",
        verifierDecision: "confirmed",
        evidenceRef: "n1",
      },
    ],
  }
}

describe("validateWebsecArtifacts", () => {
  test("合法产物通过", () => {
    expect(validateWebsecArtifacts(report(), ledger())).toEqual([])
  })

  test("缺少某个必检类别的覆盖记录", () => {
    const l = ledger()
    l.coverage = l.coverage.filter((item) => item.category !== "cors")
    expect(validateWebsecArtifacts(report(), l).join("\n")).toContain("缺少覆盖记录：s1:a/cors")
  })

  test("覆盖记录重复", () => {
    const l = ledger()
    l.coverage.push({ ...l.coverage[0]! })
    expect(validateWebsecArtifacts(report(), l).join("\n")).toContain("覆盖记录重复")
  })

  test("tested 缺证据引用", () => {
    const l = ledger()
    l.coverage[0] = { ...l.coverage[0]!, status: "tested", evidenceRefs: [] }
    expect(validateWebsecArtifacts(report(), l).join("\n")).toContain("没有证据引用")
  })

  test("证据引用未登记", () => {
    const l = ledger()
    l.coverage[0] = { ...l.coverage[0]!, status: "tested", evidenceRefs: ["ghost"] }
    expect(validateWebsecArtifacts(report(), l).join("\n")).toContain("未登记证据 ghost")
  })

  test("not_applicable 缺理由", () => {
    const l = ledger()
    l.coverage[0] = { ...l.coverage[0]!, status: "not_applicable", note: "" }
    expect(validateWebsecArtifacts(report(), l).join("\n")).toContain("没有理由")
  })

  test("requiredCategories 与校验器口径不一致", () => {
    const l = ledger()
    l.requiredCategories = [...CATEGORIES.filter((item) => item !== "debug")]
    expect(validateWebsecArtifacts(report(), l).join("\n")).toContain("口径不一致")
  })

  test("suspected 携带 severity", () => {
    const r = report()
    r.findings = [{ ...r.findings[0]!, status: "suspected" as never, severity: "high" as never }]
    expect(validateWebsecArtifacts(r, ledger()).join("\n")).toContain("不得携带 severity")
  })

  test("confirmed 缺少复核会话", () => {
    const r = report()
    r.findings = [{ ...r.findings[0]!, verifierSessionID: "" }]
    expect(validateWebsecArtifacts(r, ledger()).join("\n")).toContain("缺少 verifierSessionID")
  })

  test("confirmed 的 verifierDecision 非 confirmed", () => {
    const r = report()
    r.findings = [{ ...r.findings[0]!, verifierDecision: "rejected" as never }]
    expect(validateWebsecArtifacts(r, ledger()).join("\n")).toContain("verifierDecision 必须为 confirmed")
  })

  test("verdict=passed 但含 findings", () => {
    const r = report()
    r.verdict = "passed"
    expect(validateWebsecArtifacts(r, ledger()).join("\n")).toContain("verdict=passed 时不能包含 findings")
  })

  test("verdict=issues_found 但无 findings", () => {
    const r = report()
    r.findings = []
    expect(validateWebsecArtifacts(r, ledger()).join("\n")).toContain("findings 不能为空")
  })

  test("产物缺失", () => {
    expect(validateWebsecArtifacts(null, null)).toEqual(["coverage-ledger.json 缺失或不是对象"])
    expect(validateWebsecArtifacts(null, ledger())).toEqual(["report.json 缺失或不是对象"])
  })
})
