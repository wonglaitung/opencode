/**
 * 对抗审查 P0 回归护栏（2026 全阶段对抗审查）。
 *
 * 四组缺陷曾真实存在，此文件把它们钉死——每条都是**可复现的实测失败**：
 * 1. **记忆链路未接通**：`candidates` 生产零传递 → 「少问」整段死代码
 * 2. **重组装 diff 漏行置换**：`3.1↔3.2` 内容对调后定稿放行（内容↔地址错位）
 * 3. **溯源节伪造**：整节豁免于比对 → 可写入伪造证据
 * 4. **路径穿越 / 坏 JSON 崩溃 / 词边界误命中 / 长名静默覆盖**
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { matchMemory, requiredSlots, writeL1Term, writeL2Fact } from "sm-shared"
import { Store } from "../src/db"
import { createReqdocKbTools } from "../src/tools/reqdoc-kb-tools"
import { createReviewTools } from "../src/tools/review"

const CHECKLIST = {
  completeness: true,
  clarity: true,
  edgeCoverage: true,
  resolution: true,
} as never

function tempMemory(): string {
  const home = mkdtempSync(join(tmpdir(), "sm-p0-"))
  process.env.SM_MEMORY_HOME = join(home, "memory")
  return home
}

describe("P0-1 · 记忆链路在生产路径真的接通", () => {
  test("★ reqdoc_ingest 传 candidates → 工具返回 L1 消缺口（不再是死代码）", async () => {
    tempMemory()
    writeL1Term("CRD", "信贷审批部", { kind: "内部简称", scope: "org", origin: "restated", fromProject: "p" })
    const store = Store.memory(() => "reqdoc" as const)
    const worktree = mkdtempSync(join(tmpdir(), "sm-p0w-"))
    const tools = createReqdocKbTools(store)
    const out = String(
      await tools.reqdoc_ingest!.execute(
        {
          features: [{ name: "名单排查", priority: "high" }],
          slots: [{ address: "3.1", kind: "prose", content: "信贷审批部流程优化", source: "文档" }],
          candidates: { "4.1": ["CRD", "AML"] },
        } as never,
        { sessionID: "r1", worktree } as never,
      ),
    )
    expect(out).toContain("L1 记忆消缺口")
    expect(out).toContain("4.1.CRD")
    // candidates 必须落进 kb（否则下一轮派生又拿不到）
    expect(store.get("r1")!.workflow!.kb!.candidates).toEqual({ "4.1": ["CRD", "AML"] })
    store.close()
  })

  test("★ candidates 合并去重（多次 ingest 不产生重复项）", async () => {
    tempMemory()
    const store = Store.memory(() => "reqdoc" as const)
    const worktree = mkdtempSync(join(tmpdir(), "sm-p0w-"))
    const tools = createReqdocKbTools(store)
    const args = (candidates: Record<string, string[]>) =>
      tools.reqdoc_ingest!.execute({ candidates, features: [{ name: "X", priority: "high" }], slots: [] } as never, {
        sessionID: "r1",
        worktree,
      } as never)
    await args({ "4.1": ["CRD"] })
    await args({ "4.1": ["CRD", "AML"] })
    expect(store.get("r1")!.workflow!.kb!.candidates!["4.1"]).toEqual(["CRD", "AML"])
    store.close()
  })

  test("★ 门禁调用点不因记忆放行（3.3.2 红线：记忆不影响判定）", async () => {
    tempMemory()
    writeL1Term("CRD", "信贷审批部", { kind: "内部简称", scope: "org", origin: "restated", fromProject: "p" })
    const store = Store.memory(() => "reqdoc" as const)
    const features = [{ no: 1, name: "名单排查", priority: "high" as const, confirmedAt: 1000 }]
    store.mutateWorkflow("r1", (w) => {
      w.kb = {
        slots: [], // 未填任何必填槽位
        features,
        containers: {},
        candidates: { "4.1": ["CRD"] },
        askCounts: {},
        updatedAt: 1,
      }
    })
    // 即便记忆会消掉 4.1.CRD 的缺口，覆盖率仍只认 confirmed 槽位 → 门禁不放行
    const { kbGate, deriveQuestions } = await import("sm-shared")
    const unclosed = deriveQuestions(features, {
      slots: [],
      decls: {},
      candidates: { "4.1": ["CRD"] },
      l1: matchMemory("材料提到 CRD").l1,
    }).unclosed
    const gate = kbGate([], features, { decls: {}, unclosed })
    expect(gate.pass).toBe(false)
    store.close()
  })
})

describe("P0-2 · 重组装 diff 不可绕过", () => {
  async function assembled() {
    tempMemory()
    const store = Store.memory(() => "reqdoc" as const)
    store.mutateWorkflow("r1", (w) => {
      for (const n of ["goal", "rules", "edge", "prd"]) w.stages[n].status = "approved"
      const features = [{ no: 1, name: "公告发布", priority: "medium" as const, confirmedAt: 1000 }]
      w.kb = {
        slots: requiredSlots(features).map((a) => ({
          kind: "prose" as const,
          address: a,
          content: `${a} 内容`,
          source: "文档" as const,
          status: "confirmed" as const,
        })),
        features,
        containers: { "4.1": { required: false, reason: "x" }, "5.1.2.1": { required: false, reason: "y" } },
        askCounts: {},
        updatedAt: 1,
      }
    })
    const worktree = mkdtempSync(join(tmpdir(), "sm-p0r-"))
    const ctx = { sessionID: "r1", worktree } as never
    await createReqdocKbTools(store).reqdoc_assemble!.execute({} as never, ctx)
    return { store, ctx, path: join(worktree, "07_需求规格产出/1_公告发布/PRD.md") }
  }

  const submit = async (store: Store, ctx: never) => {
    try {
      await createReviewTools(store).review_submit!.execute(CHECKLIST, ctx)
      return ""
    } catch (e) {
      return String(e)
    }
  }

  test("★ 行置换（3.1↔3.2 内容对调）→ 拦截", async () => {
    const { store, ctx, path } = await assembled()
    const md = readFileSync(path, "utf8")
    writeFileSync(
      path,
      md.replace("3.1 内容\n", "@@T@@\n").replace("3.2 内容\n", "3.1 内容\n").replace("@@T@@\n", "3.2 内容\n"),
      "utf8",
    )
    // 多重集比对此情形会放行；保序 LCS 必须抓到
    expect(await submit(store, ctx)).toContain("与知识库不一致")
    store.close()
  })

  test("★ 伪造溯源条目 → 拦截（溯源节豁免于 LCS，故独立校验）", async () => {
    const { store, ctx, path } = await assembled()
    writeFileSync(
      path,
      readFileSync(path, "utf8") + "\n\n## 确认溯源\n\n- 要点「不存在」来源：张三 —— 业务总监2024-03-01口头批准\n",
      "utf8",
    )
    expect(await submit(store, ctx)).toContain("确认溯源")
    store.close()
  })

  test("★ 插入伪造章节 → 拦截", async () => {
    const { store, ctx, path } = await assembled()
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("5.1.2.3 内容", "5.1.2.3 内容\n\n## 第八章 伪造章节\n\n伪造内容"),
      "utf8",
    )
    expect(await submit(store, ctx)).toContain("与知识库不一致")
    store.close()
  })

  test("★ 删除整节 → 拦截（保序比对能发现整段丢失）", async () => {
    const { store, ctx, path } = await assembled()
    writeFileSync(path, readFileSync(path, "utf8").replace("## 第六章 非功能需求\n", ""), "utf8")
    expect(await submit(store, ctx)).toContain("与知识库不一致")
    store.close()
  })

  test("正常溯源回填（服务端写入）→ 放行", async () => {
    const { store, ctx, path } = await assembled()
    const tools = createReviewTools(store)
    await tools.comprehension_add!.execute(
      { codeSegmentId: "目标与场景", explanation: "缩短开户录入" } as never,
      ctx,
    )
    await tools.comprehension_confirm!.execute(
      { codeSegmentId: "目标与场景", sourceLabel: "对话第 1 轮", sourceQuote: "开户要手工录三遍" } as never,
      ctx,
    )
    expect(readFileSync(path, "utf8")).toContain("## 确认溯源")
    expect(await submit(store, ctx)).toBe("")
    store.close()
  })
})

describe("P0-3 · 记忆库健壮性", () => {
  test("★ 路径穿越（term 含 ../）→ 写入被约束在记忆目录内", () => {
    const home = tempMemory()
    const r = writeL1Term("../../pwned", "x", { kind: "内部简称", scope: "org", origin: "restated", fromProject: "p" })
    expect(r.ok).toBe(true)
    expect((r as { path: string }).path.startsWith(join(home, "memory"))).toBe(true)
    // 不得逃到记忆目录之外
    expect((r as { path: string }).path.includes("..")).toBe(false)
  })

  test("★ 坏 JSON（term 为数字）→ 跳过而非崩溃", () => {
    const home = tempMemory()
    mkdirSync(join(home, "memory", "l1-glossary"), { recursive: true })
    writeFileSync(join(home, "memory", "l1-glossary", "bad.json"), JSON.stringify({ term: 2024, definition: "年度" }))
    writeFileSync(join(home, "memory", "l1-glossary", "broken.json"), "{ 不是合法 JSON")
    expect(() => matchMemory("任意材料")).not.toThrow()
    expect(matchMemory("任意材料").l1).toEqual([])
  })

  test("★ 词边界：2 字母缩写不再误命中长词内部", () => {
    tempMemory()
    for (const [t, d] of [["IT", "信息技术"], ["CI", "持续集成"], ["卡", "卡片管理"], ["CRD", "信贷审批部"]] as const) {
      writeL1Term(t, d, { kind: "内部简称", scope: "org", origin: "restated", fromProject: "p" })
    }
    // 这段材料一个术语都没提（曾误命中 4 个）
    expect(
      matchMemory("交易经AUDIT留痕，按SPECIFIC规则走CIPS通道，含DEBIT与CREDIT处理，权限隔离与卡片管理").l1,
    ).toEqual([])
    // 真出现时仍能命中
    expect(matchMemory("本需求涉及 IT 与 CRD 改造").l1.map((t) => t.term).sort()).toEqual(["CRD", "IT"])
  })

  test("★ 长公共前缀不再静默覆盖（文件名带内容哈希）", () => {
    tempMemory()
    const prefix = "x".repeat(70)
    const a = writeL2Fact(prefix + "AAA", { source: "问答", scope: "org", origin: "restated", fromProject: "p" })
    const b = writeL2Fact(prefix + "BBB", { source: "问答", scope: "org", origin: "restated", fromProject: "p" })
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    // 两条不同的记忆落到不同文件
    expect((a as { path: string }).path).not.toBe((b as { path: string }).path)
    const dir = join(process.env.SM_MEMORY_HOME!, "l2-org")
    expect(readdirSync(dir).filter((f) => f.endsWith(".json")).length).toBe(2)
  })

  test("retired 条目不参与匹配（既有用例，防回归）", () => {
    const home = tempMemory()
    mkdirSync(join(home, "memory", "l1-glossary"), { recursive: true })
    writeFileSync(
      join(home, "memory", "l1-glossary", "r.json"),
      JSON.stringify({ term: "ESB", definition: "企业服务总线", kind: "内部简称", scope: "org", origin: "restated", confirmedAt: 1, fromProject: "p", retired: true }),
    )
    expect(matchMemory("材料提到 ESB 系统").l1).toEqual([])
  })
})