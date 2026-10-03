/**
 * 记忆机制测试（设计 3.6，阶段 3 接线）。
 *
 * 覆盖三条红线（3.6 + 3.3.2）：
 * 1. **L1 是唯一能消缺口的级**——L2 命中仍必须被问一次（只带默认猜测）。
 * 2. **静默接受默认不入库**（accepted_default / inferred 一律拒写）——防污染唯一入口。
 * 3. **sdlc 记忆不影响判定**——记忆不得改变 kbGate 结果。
 *
 * 写盘相关用例走 `MEMORY_HOME` 覆盖的临时目录，不污染真实记忆库。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deriveQuestions, isPollutingOrigin, matchMemory, writeL1Term, writeL2Fact, requiredSlots } from "sm-shared"
import type { MemoryFact, MemoryTerm } from "sm-shared"

const features = [{ no: 1, name: "名单排查", priority: "high" as const, confirmedAt: 1000 }]
const containers = {
  "4.1": { required: false, reason: "无特殊术语" },
  "5.1.2.1": { required: false, reason: "无结构化字段" },
}

let home: string
const originalHome = process.env.SM_MEMORY_HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sm-mem-"))
  process.env.SM_MEMORY_HOME = join(home, "memory")
})

afterEach(() => {
  process.env.SM_MEMORY_HOME = originalHome
  rmSync(home, { recursive: true, force: true })
})

function seedL1(entry: Partial<MemoryTerm> & { term: string; definition: string }) {
  const dir = join(home, "memory", "l1-glossary")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${entry.term}.json`), JSON.stringify({ kind: "内部简称", scope: "org", origin: "restated", confirmedAt: 1, fromProject: "信贷系统改造", ...entry }))
}

function seedL2(entry: Partial<MemoryFact> & { content: string }) {
  const dir = join(home, "memory", "l2-org")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${entry.content.slice(0, 20)}.json`), JSON.stringify({ source: "问答", scope: "org", origin: "restated", confirmedAt: 1, fromProject: "x", ...entry }))
}

describe("3.6 · L1 消缺口 / L2 不消缺口", () => {
  test("★ L1 命中内部简称 → 该项不再成为开放项（消缺口）", () => {
    seedL1({ term: "CRD", definition: "信贷审批部" })
    const d = deriveQuestions(features, {
      slots: [],
      decls: containers,
      candidates: { "4.1": ["CRD", "AML"] },
      l1: [{ term: "CRD", definition: "信贷审批部", kind: "内部简称", scope: "org", origin: "restated", confirmedAt: 1, fromProject: "p" }],
    })
    expect(d.all.map((q) => q.address)).not.toContain("4.1.CRD")
    expect(d.all.map((q) => q.address)).toContain("4.1.AML")
  })

  test("★ L1 消缺口必须对模型可见（l1Applied）——否则模型会重复问", () => {
    seedL1({ term: "CRD", definition: "信贷审批部" })
    const d = deriveQuestions(features, {
      slots: [],
      decls: containers,
      candidates: { "4.1": ["CRD"] },
      l1: [{ term: "CRD", definition: "信贷审批部", kind: "内部简称", scope: "org", origin: "restated", confirmedAt: 1, fromProject: "p" }],
    })
    expect(d.l1Applied).toEqual(["4.1.CRD"])
  })

  test("★ L2 命中 → 仍被问一次，但带默认猜测（不消缺口）", () => {
    const d = deriveQuestions(features, {
      slots: [],
      decls: containers,
      candidates: { "4.1": ["CIPS"] },
      l2: [{ content: "CIPS 报文走 ESB", source: "问答", scope: "org", origin: "restated", confirmedAt: 1, fromProject: "p" }],
    })
    const q = d.all.find((x) => x.address === "4.1.CIPS")
    expect(q).toBeDefined()
    // P1-c：猜测必须带出记忆内容——原实现只说「组织记忆里有相关记录（X）」，
    // 业务看不到任何实质信息却要点头（规则又规定「回同意默认即视为确认」）
    expect(q!.guess).toContain("CIPS 报文走 ESB")
    expect(q!.from).toBe("memory-L2")
  })

  test("行业通用缩写不被 L1 消缺口之外的方式误要求（AML 仍问，除非记忆里有）", () => {
    const d = deriveQuestions(features, { slots: [], decls: containers, candidates: { "4.1": ["AML"] } })
    expect(d.all.map((q) => q.address)).toContain("4.1.AML")
  })

  test("★ 验收标准 1/2：CRD 首轮被问、第二个需求被 L1 记忆消缺口", () => {
    // 这是设计第 13 章的唯一真判据（追问变少且没丢事实），此处以确定性方式锁定：
    // 模型层验证见 `bun run acceptance`（需本地 vLLM）。
    const candidates = { "4.1": ["CRD", "AML", "KYC"] }
    const full = requiredSlots(features).map((address) => ({
      kind: "prose" as const, address, content: "",
      source: "文档" as const, status: "confirmed" as const,
    }))

    // 需求一：无记忆 → CRD 必须被问（前提成立，否则「没问」不算本事）
    const first = deriveQuestions(features, { slots: full, decls: containers, candidates })
    expect(first.all.map((q) => q.address)).toContain("4.1.CRD")

    // 业务复述 → 写 L1（origin 由服务端固定为 restated）
    const w = writeL1Term("CRD", "信贷审批部", {
      kind: "内部简称", scope: "org", origin: "restated", fromProject: "信贷系统改造",
      businessQuote: "业务说：CRD 就是信贷审批部",
    })
    expect(w.ok).toBe(true)

    // 需求二：命中 L1 → CRD 消缺口、不再问；AML/KYC 未被复述，仍在清单里
    const hits = matchMemory("信贷审批部（CRD）需要新增批量审批能力")
    expect(hits.l1.map((t) => t.term)).toEqual(["CRD"])
    const second = deriveQuestions(features, {
      slots: full, decls: containers, candidates, l1: hits.l1, l2: hits.l2,
    })
    const addrs = second.all.map((q) => q.address)
    expect(addrs).not.toContain("4.1.CRD")
    expect(addrs).toContain("4.1.AML")
    expect(addrs).toContain("4.1.KYC")
    expect(second.l1Applied).toContain("4.1.CRD")
  })

  test("★ 记忆不得改变 kbGate 判定（3.3.2 红线：sdlc 记忆不影响判定）", async () => {
    seedL1({ term: "CRD", definition: "信贷审批部" })
    const { kbGate, slotCoverage } = await import("sm-shared")
    const slots = requiredSlots(features).map((address) => ({
      kind: "prose" as const, address, content: `${address} 内容`,
      source: "文档" as const, status: "confirmed" as const,
    }))
    const kb = { slots, features, containers, askCounts: {}, updatedAt: 1 }
    const noMem = kbGate(kb.slots, kb.features, { decls: kb.containers })
    const withMem = kbGate(kb.slots, kb.features, {
      decls: kb.containers,
      unclosed: [],
      // 即便有记忆命中，门禁判据不变
    })
    expect(withMem.pass).toBe(noMem.pass)
    expect(withMem.coverage.leafFilled).toBe(noMem.coverage.leafFilled)
    expect(slotCoverage(kb.slots, kb.features, kb.containers).pct).toBe(1)
  })
})

describe("3.6 · 匹配只返回命中项（封顶机制）", () => {
  test("未命中返回空，不返回全部记忆", () => {
    seedL1({ term: "CRD", definition: "信贷审批部" })
    const hits = matchMemory("本需求涉及柜台跨行转账")
    expect(hits.l1).toEqual([])
    expect(hits.l2).toEqual([])
  })

  test("命中返回该条；retired 条目不返回", () => {
    seedL1({ term: "CRD", definition: "信贷审批部" })
    seedL1({ term: "ESB", definition: "企业服务总线", retired: true })
    const hits = matchMemory("材料里提到 CRD 和 ESB 两个缩写")
    expect(hits.l1.map((t) => t.term)).toEqual(["CRD"])
  })

  test("空材料不触发读取", () => {
    seedL1({ term: "CRD", definition: "信贷审批部" })
    expect(matchMemory("   ")).toEqual({ l1: [], l2: [] })
  })
})

describe("3.6 · 防污染写入", () => {
  test("★ 静默接受默认（accepted_default）拒写 L1", () => {
    expect(writeL1Term("CRD", "信贷审批部", { kind: "内部简称", scope: "org", origin: "accepted_default", fromProject: "p" }))
      .toEqual({ ok: false, reason: "polluting_origin" })
  })

  test("★ 推测（inferred）拒写 L1 / L2", () => {
    expect(isPollutingOrigin("inferred")).toBe(true)
    expect(writeL1Term("X", "Y", { kind: "内部简称", scope: "org", origin: "inferred", fromProject: "p" }).ok).toBe(false)
    expect(writeL2Fact("X", { source: "问答", scope: "org", origin: "inferred", fromProject: "p" }).ok).toBe(false)
  })

  test("业务复述（restated）可写，且写后可被命中", () => {
    const r = writeL1Term("CRD", "信贷审批部", { kind: "内部简称", scope: "org", origin: "restated", businessQuote: "业务原话：「信贷审批部」就是 CRD", fromProject: "信贷系统改造" })
    expect(r.ok).toBe(true)
    expect(matchMemory("需求里用了 CRD").l1.map((t) => t.definition)).toEqual(["信贷审批部"])
  })

  test("★ 同名不同义不静默覆盖（交业务裁决）", () => {
    writeL1Term("CRD", "信贷审批部", { kind: "内部简称", scope: "org", origin: "restated", businessQuote: "业务原话：「信贷审批部」就是 CRD", fromProject: "p1" })
    const r = writeL1Term("CRD", "容器运行时声明", { kind: "行业通用", scope: "org", origin: "restated", businessQuote: "业务原话：「信贷审批部」就是 CRD", fromProject: "p2" })
    expect(r).toEqual({ ok: false, reason: "conflict", existing: "信贷审批部" })
  })

  test("★ restated 缺业务原话 → 拒写（凭据不可省）", () => {
    // 污染成本不对称：L1 命中即免问、免问项由模型自己落定、业务不再被问，
    // 旧格式条目里只有模型的释义、无从追查谁说的。故 restated 必须带业务原话。
    for (const businessQuote of [undefined, "", "  "]) {
      expect(
        writeL1Term("CRD", "信贷审批部", { kind: "内部简称", scope: "org", origin: "restated", businessQuote, fromProject: "p" }),
      ).toEqual({ ok: false, reason: "missing_quote" })
    }
    // 拒写后记忆里不得凭空多出条目
    expect(matchMemory("需求里用了 CRD").l1.map((t) => t.definition)).not.toContain("信贷审批部")
    // 非 restated 的 origin 本就被污染源拒写，不受凭据影响
    expect(writeL1Term("X", "Y", { kind: "内部简称", scope: "org", origin: "inferred", fromProject: "p" }).ok).toBe(false)
  })

  test("重复写入相同定义视为幂等（不算冲突）", () => {
    writeL1Term("CRD", "信贷审批部", { kind: "内部简称", scope: "org", origin: "restated", businessQuote: "业务原话：「信贷审批部」就是 CRD", fromProject: "p1" })
    expect(writeL1Term("CRD", "信贷审批部", { kind: "内部简称", scope: "org", origin: "restated", businessQuote: "业务原话：「信贷审批部」就是 CRD", fromProject: "p1" }).ok).toBe(true)
  })
})