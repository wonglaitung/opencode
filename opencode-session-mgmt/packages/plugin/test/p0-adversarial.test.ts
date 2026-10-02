/**
 * 对抗审查 P0 回归护栏（2026 全阶段对抗审查）。
 *
 * 四组缺陷曾真实存在，此文件把它们钉死——每条都是**可复现的实测失败**：
 * 1. **记忆链路未接通**：`candidates` 生产零传递 → 「少问」整段死代码
 * 2. **重组装 diff 漏行置换**：`3.1↔3.2` 内容对调后定稿放行（内容↔地址错位）
 * 3. **溯源节伪造**：整节豁免于比对 → 可写入伪造证据
 * 4. **路径穿越 / 坏 JSON 崩溃 / 词边界误命中 / 长名静默覆盖**
 */
import { describe, expect, jest, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deriveQuestions, kbGate, matchMemory, requiredSlots, writeL1Term, writeL2Fact } from "sm-shared"
import { Store } from "../src/db"
import { createReqdocKbTools } from "../src/tools/reqdoc-kb-tools"
import { createReqdocFeatureTools } from "../src/tools/reqdoc-features"
import { buildStateBar } from "../src/prompt"
import { createReqdocScanTool, materialEvidence } from "../src/tools/reqdoc-scan"
import { createReviewTools } from "../src/tools/review"

const CHECKLIST = {
  completeness: true,
  clarity: true,
  edgeCoverage: true,
  resolution: true,
} as never

/** 读仓库内源码（文本契约断言用）。 */
const read = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8")

function tempMemory(): string {
  const home = mkdtempSync(join(tmpdir(), "sm-p0-"))
  process.env.SM_MEMORY_HOME = join(home, "memory")
  return home
}

/** 业务投放材料（记忆匹配的证据来源）：往 01_背景与目标 放一个文本文件。 */
function dropMaterial(worktree: string, text: string) {
  mkdirSync(join(worktree, "01_背景与目标"), { recursive: true })
  writeFileSync(join(worktree, "01_背景与目标", "材料.md"), text, "utf8")
}

describe("P0-1 · 记忆链路在生产路径真的接通", () => {
  test("★ reqdoc_ingest 传 candidates → 工具返回 L1 消缺口（不再是死代码）", async () => {
    tempMemory()
    writeL1Term("CRD", "信贷审批部", { kind: "内部简称", scope: "org", origin: "restated", fromProject: "p" })
    const store = Store.memory(() => "reqdoc" as const)
    const worktree = mkdtempSync(join(tmpdir(), "sm-p0w-"))
    // 证据 = 材料原文（方案 C）：术语须出现在业务投放的材料里，而非模型转述的槽位正文
    dropMaterial(worktree, "信贷审批部（CRD）负责名单排查与流程优化。")
    const tools = createReqdocKbTools(store)
    const out = String(
      await tools.reqdoc_ingest!.execute(
        {
          features: [{ name: "名单排查", priority: "high" }],
          // 候选名不算自己的证据（对抗审查 N-5：否则臆造 candidates 即可白拿消缺口）
          slots: [{ address: "3.1", kind: "prose", content: "流程优化", source: "文档" }],
          candidates: { "4.1": ["CRD", "AML"] },
        } as never,
        { sessionID: "r1", worktree } as never,
      ),
    )
    expect(out).toContain("已采信历史记忆")
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

  test("★ 门禁不因记忆放行（打 review_submit 生产路径；复审 T-2：上一版手工调 kbGate，纯自证）", async () => {
    tempMemory()
    writeL1Term("CRD", "信贷审批部", { kind: "内部简称", scope: "org", origin: "restated", fromProject: "p" })
    const store = Store.memory(() => "reqdoc" as const)
    const features = [{ no: 1, name: "名单排查", priority: "high" as const, confirmedAt: 1000 }]
    store.mutateWorkflow("r1", (w) => {
      for (const n of ["goal", "rules", "edge", "prd"]) w.stages[n].status = "approved"
      w.kb = {
        // 只填 3.1：记忆最多消掉 4.1.CRD，覆盖率仍远低于 100% → 门禁必须拦。
        slots: [
          { kind: "prose", address: "3.1", content: "信贷审批部（CRD）流程优化", source: "文档", status: "confirmed" },
        ],
        features,
        containers: {},
        candidates: { "4.1": ["CRD"] },
        askCounts: {},
        updatedAt: 1,
      }
    })
    const worktree = mkdtempSync(join(tmpdir(), "sm-p0gate-"))
    const ctx = { sessionID: "r1", worktree } as never
    // 若 review.ts 的门禁调用点被改成「按记忆消缺口后放行」，本用例即失败
    let msg = ""
    try {
      await createReviewTools(store).review_submit!.execute(CHECKLIST, ctx)
    } catch (e) {
      msg = String(e)
    }
    expect(msg).toMatch(/知识库未就绪|未找到 PRD 产物/)
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
/**
 * P1 回归护栏（对抗审查第二批）。
 *
 * 1. 非法地址零校验 → 事实「收了却不进交付件」且零告警
 * 2. `reqdoc_answer` 先写记忆后校验 → 失败调用照样污染全局记忆
 * 3. L2 猜测是空壳 → 业务对空默认值点头（规则又规定「回同意默认即确认」）
 * 4. `reqdoc_assemble` 无路径校验 + 自定义 `source` 与定稿期望路径脱节
 * 5. `reqdoc_memory_recall` 无工作流校验 + 退役是空操作
 */
describe("P1 · 槽位地址校验", () => {
  const setup = () => {
    const store = Store.memory(() => "reqdoc" as const)
    const worktree = mkdtempSync(join(tmpdir(), "sm-p1-"))
    const ctx = { sessionID: "r1", worktree } as never
    return { store, worktree, ctx, tools: createReqdocKbTools(store) }
  }
  const ingest = (tools: ReturnType<typeof createReqdocKbTools>, ctx: never, address: string) =>
    tools.reqdoc_ingest!.execute(
      {
        features: [{ name: "名单排查", priority: "high" }],
        slots: [{ address, kind: "prose", content: "重要业务事实", source: "文档" }],
      } as never,
      ctx,
    )

  test("★ 非法地址被拒（此前收了却不进交付件且零告警）", async () => {
    const { store, ctx, tools } = setup()
    await expect(ingest(tools, ctx, "9.9.999.这不是服务端派生的地址")).rejects.toThrow(/地址非法/)
    store.close()
  })

  test("★ 越界功能点被拒（5.9.x 在只有 1 个功能点时）", async () => {
    const { store, ctx, tools } = setup()
    await expect(ingest(tools, ctx, "5.9.2.1.客户号")).rejects.toThrow(/地址非法/)
    store.close()
  })

  test("合法地址放行（必填叶子 / 容器本身 / 容器叶子）", async () => {
    const { store, ctx, tools } = setup()
    for (const addr of ["3.1", "4.1", "4.1.CRD", "5.1.2.1.客户号"]) {
      expect(await ingest(tools, ctx, addr)).toBeTruthy()
    }
    store.close()
  })

  test("★ 已存在的地址放行（改内容而非建新地址）", async () => {
    const { store, ctx, tools } = setup()
    await ingest(tools, ctx, "3.1")
    await tools.reqdoc_ingest!.execute(
      { features: [{ name: "名单排查", priority: "high" }], slots: [{ address: "3.1", kind: "prose", content: "改过的内容", source: "文档" }] } as never,
      ctx,
    )
    expect(store.get("r1")!.workflow!.kb!.slots.find((s) => s.address === "3.1")!.content).toBe("改过的内容")
    store.close()
  })

  test("reqdoc_answer 同样校验地址", async () => {
    const { store, ctx, tools } = setup()
    await expect(
      tools.reqdoc_answer!.execute({ address: "9.9.非法", content: "x", source: "文档" } as never, ctx),
    ).rejects.toThrow(/地址非法/)
    store.close()
  })
})

describe("P1 · 记忆写入必须在校验之后", () => {
  const memFiles = (): string[] => {
    const dir = join(process.env.SM_MEMORY_HOME!, "l1-glossary")
    return existsSync(dir) ? readdirSync(dir) : []
  }
  const setup = () => {
    const home = mkdtempSync(join(tmpdir(), "sm-p1m-"))
    process.env.SM_MEMORY_HOME = join(home, "memory")
    const store = Store.memory(() => "reqdoc" as const)
    const worktree = mkdtempSync(join(tmpdir(), "sm-p1w-"))
    const ctx = { sessionID: "r1", worktree } as never
    return { store, ctx, worktree, tools: createReqdocKbTools(store) }
  }
  const withTerm = (address: string, source: string, reason?: string) => ({
    address, content: "x", source, reason,
    restated_term: { term: "CRD", definition: "信贷审批部", kind: "内部简称" as const },
  })

  test("★ [缺省] 无 reason 失败后记忆库为空", async () => {
    const { store, ctx, tools } = setup()
    await tools.reqdoc_ingest!.execute({ features: [{ name: "X", priority: "high" }], slots: [] } as never, ctx)
    await expect(tools.reqdoc_answer!.execute(withTerm("3.1", "缺省") as never, ctx)).rejects.toThrow()
    expect(memFiles()).toEqual([])
    store.close()
  })

  test("★ 非法地址失败后记忆库为空", async () => {
    const { store, ctx, tools } = setup()
    await tools.reqdoc_ingest!.execute({ features: [{ name: "X", priority: "high" }], slots: [] } as never, ctx)
    await expect(tools.reqdoc_answer!.execute(withTerm("9.9.非法", "文档") as never, ctx)).rejects.toThrow()
    expect(memFiles()).toEqual([])
    store.close()
  })

  test("★ sdlc 会话失败后记忆库为空", async () => {
    const { worktree } = setup()
    const sdlc = Store.memory(() => "sdlc" as const)
    sdlc.ensure("s1")
    await expect(
      createReqdocKbTools(sdlc).reqdoc_answer!.execute(withTerm("3.1", "文档") as never, { sessionID: "s1", worktree } as never),
    ).rejects.toThrow(/仅用于 reqdoc/)
    expect(memFiles()).toEqual([])
    sdlc.close()
  })

  test("正常调用仍写入记忆（修的不是写入，是时机）", async () => {
    const { store, ctx, tools } = setup()
    await tools.reqdoc_ingest!.execute({ features: [{ name: "X", priority: "high" }], slots: [] } as never, ctx)
    const out = String(await tools.reqdoc_answer!.execute(withTerm("3.1", "文档") as never, ctx))
    expect(out).toContain("已记入 L1")
    expect(memFiles().length).toBe(1)
    store.close()
  })
})

describe("P1 · L2 猜测必须带出记忆内容", () => {
  test("★ L2 命中的猜测里含记忆原文（P1-c：原为空壳）", async () => {
    const { deriveQuestions } = await import("sm-shared")
    const features = [{ no: 1, name: "X", priority: "high" as const, confirmedAt: 1 }]
    const d = deriveQuestions(features, {
      slots: [],
      decls: { "4.1": { required: false, reason: "x" } },
      candidates: { "4.1": ["CIPS"] },
      l2: [{ content: "交易走 CIPS 通道，报文经 ESB 网关", source: "问答", scope: "org", origin: "restated", confirmedAt: 1, fromProject: "p" }],
    })
    const q = d.all.find((x) => x.address === "4.1.CIPS")!
    expect(q.from).toBe("memory-L2")
    expect(q.guess).toContain("CIPS")
    expect(q.guess!.length).toBeGreaterThan(15)
  })
})

describe("P1 · 组装路径与定稿一致", () => {
  const setup = () => {
    const store = Store.memory(() => "reqdoc" as const)
    store.mutateWorkflow("r1", (w) => {
      for (const n of ["goal", "rules", "edge", "prd"]) w.stages[n].status = "approved"
      const features = [{ no: 1, name: "公告发布", priority: "medium" as const, confirmedAt: 1000 }]
      w.kb = {
        slots: requiredSlots(features).map((a) => ({
          kind: "prose" as const, address: a, content: `${a} 内容`,
          source: "文档" as const, status: "confirmed" as const,
        })),
        features,
        containers: { "4.1": { required: false, reason: "x" }, "5.1.2.1": { required: false, reason: "y" } },
        askCounts: {}, updatedAt: 1,
      }
    })
    const worktree = mkdtempSync(join(tmpdir(), "sm-p1r-"))
    const ctx = { sessionID: "r1", worktree } as never
    return { store, worktree, ctx }
  }

  test("★ source 含斜杠被拒（路径穿越）", async () => {
    const { store, ctx } = setup()
    await expect(
      createReqdocKbTools(store).reqdoc_assemble!.execute({ source: "../../../evil.md" } as never, ctx),
    ).rejects.toThrow(/只能是文件名/)
    store.close()
  })

  test("★ 自定义 source 后定稿不再死锁（assembledFile 贯通）", async () => {
    const { store, ctx, worktree } = setup()
    await createReqdocKbTools(store).reqdoc_assemble!.execute({ source: "需求规格书V2.md" } as never, ctx)
    expect(store.get("r1")!.workflow!.kb!.assembledFile).toBe("需求规格书V2.md")
    expect(existsSync(join(worktree, "07_需求规格产出/1_公告发布/需求规格书V2.md"))).toBe(true)
    const out = String(await createReviewTools(store).review_submit!.execute(CHECKLIST, ctx))
    expect(out).toContain("审查阶段通过")
    store.close()
  })
})

describe("P1 · memory_recall 工作流校验与退役", () => {
  test("★ sdlc 会话不得写全局记忆", async () => {
    const home = mkdtempSync(join(tmpdir(), "sm-p1rc-"))
    process.env.SM_MEMORY_HOME = join(home, "memory")
    const sdlc = Store.memory(() => "sdlc" as const)
    sdlc.ensure("s1")
    await expect(
      createReqdocKbTools(sdlc).reqdoc_memory_recall!.execute({ facts: [{ content: "x" }] } as never, {
        sessionID: "s1", worktree: mkdtempSync(join(tmpdir(), "w-")),
      } as never),
    ).rejects.toThrow(/仅用于 reqdoc/)
    expect(existsSync(join(home, "memory", "l2-org"))).toBe(false)
    sdlc.close()
  })

  test("★ 退役按地址生效（P1-e：内容匹配曾是空操作）", async () => {
    const home = mkdtempSync(join(tmpdir(), "sm-p1rs-"))
    process.env.SM_MEMORY_HOME = join(home, "memory")
    const store = Store.memory(() => "reqdoc" as const)
    store.mutateWorkflow("r1", (w) => {
      const features = [{ no: 1, name: "公告发布", priority: "medium" as const, confirmedAt: 1000 }]
      w.kb = {
        slots: [
          { kind: "prose", address: "5.1.2.11", content: "交易走 CIPS 报文经 ESB", source: "问答", status: "confirmed" },
          { kind: "prose", address: "4.2", content: "本行受理跨行转账", source: "文档", status: "confirmed" },
        ],
        features, containers: {}, askCounts: {}, updatedAt: 1,
      }
    })
    await createReqdocKbTools(store).reqdoc_memory_recall!.execute(
      { facts: [{ content: "交易走 CIPS 报文经 ESB" }], retire_slots: ["5.1.2.11"] } as never,
      { sessionID: "r1", worktree: mkdtempSync(join(tmpdir(), "w-")) } as never,
    )
    const slots = store.get("r1")!.workflow!.kb!.slots
    expect(slots.find((s) => s.address === "5.1.2.11")!.status).toBe("retired")
    expect(slots.find((s) => s.address === "4.2")!.status).toBe("confirmed")
    store.close()
  })
})

/**
 * P2 回归护栏（对抗审查第三批）。
 *
 * 1. `scope` 只写不读 → 设计声称的「sdlc 记忆不影响 reqdoc 判定」无代码执行
 * 2. 退役机制复活（规则文本里重新点名已删工具/门禁）
 * 3. CLI 与插件记忆根不同源
 */
describe("P2 · scope 过滤真正生效", () => {
  test("★ scope:sdlc 的 L1 条目不得参与 reqdoc 消缺口", async () => {
    const { deriveQuestions } = await import("sm-shared")
    const features = [{ no: 1, name: "X", priority: "high" as const, confirmedAt: 1 }]
    const base = {
      slots: [],
      decls: { "4.1": { required: false, reason: "x" } },
      candidates: { "4.1": ["CRD"] },
    }
    const sdlcTerm = { term: "CRD", definition: "信贷审批部", kind: "内部简称" as const, scope: "sdlc" as const, origin: "restated" as const, confirmedAt: 1, fromProject: "p" }
    const orgTerm = { ...sdlcTerm, scope: "org" as const }

    // sdlc 作用域的记忆：在 reqdoc 里必须被忽略
    const d = deriveQuestions(features, { ...base, l1: [sdlcTerm] })
    expect(d.all.map((q) => q.address)).toContain("4.1.CRD")
    expect(d.l1Applied).toEqual([])

    // org/reqdoc 作用域：正常生效
    const d2 = deriveQuestions(features, { ...base, l1: [orgTerm] })
    expect(d2.all.map((q) => q.address)).not.toContain("4.1.CRD")
    expect(d2.l1Applied).toContain("4.1.CRD")
  })

  test("★ retired 条目同样被忽略", async () => {
    const { deriveQuestions } = await import("sm-shared")
    const features = [{ no: 1, name: "X", priority: "high" as const, confirmedAt: 1 }]
    const retired = { term: "CRD", definition: "信贷审批部", kind: "内部简称" as const, scope: "org" as const, origin: "restated" as const, confirmedAt: 1, fromProject: "p", retired: true }
    const d = deriveQuestions(features, {
      slots: [], decls: { "4.1": { required: false, reason: "x" } },
      candidates: { "4.1": ["CRD"] }, l1: [retired],
    })
    expect(d.l1Applied).toEqual([])
  })

  test("类型错乱退化为空而非崩溃（P0-3 遗留的防御）", async () => {
    const { deriveQuestions } = await import("sm-shared")
    const features = [{ no: 1, name: "X", priority: "high" as const, confirmedAt: 1 }]
    expect(() =>
      deriveQuestions(features, {
        slots: [], decls: {},
        l1: matchMemory("任意") as never, // 误传整个返回值
      }),
    ).not.toThrow()
  })
})

describe("P2 · CLI 与插件记忆根同源", () => {
  test("★ CLI 真的读到 SM_MEMORY_HOME（跑 CLI 的 runMemory，不复用 memoryRoot）", async () => {
    // 复审 T-1：上一版只断言 memoryRoot()，把 CLI 改回 homedir() 也照样绿——纯自证。
    // 现在真跑 CLI 的 runMemory：写入一条记忆后用 CLI 列出来。
    const home = mkdtempSync(join(tmpdir(), "sm-p2cli-"))
    process.env.SM_MEMORY_HOME = join(home, "memory")
    const { writeL1Term } = await import("sm-shared")
    writeL1Term("CRD", "信贷审批部", { kind: "内部简称", scope: "org", origin: "restated", fromProject: "CLI同源测试" })

    const { runMemory } = await import("../../cli/src/commands/memory")
    // CLI 用 process.stdout.write（不是 console.log），必须捕获真正的出口
    let out = ""
    const spy = jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out += String(chunk)
      return true
    })
    try {
      await runMemory({ positionals: ["list"], flags: {} })
    } finally {
      spy.mockRestore()
    }
    // CLI 必须列出我们刚写入的条目——若 CLI 用 homedir()，这里会是空
    expect(out).toContain("CRD")
    expect(out).toContain("信贷审批部")
  })

  test("CLI 层名与 shared 的 MEMORY_LAYERS 一致（消除人工约定的漂移面）", async () => {
    const { MEMORY_LAYERS } = await import("sm-shared")
    const src = readFileSync(join(import.meta.dir, "..", "..", "cli", "src", "commands", "memory.ts"), "utf8")
    // CLI 不得自带一份层名字面量——必须引用 shared 的 MEMORY_LAYERS
    expect(src).toContain("MEMORY_LAYERS")
    for (const layer of MEMORY_LAYERS) expect(src).toContain(layer)
  })
})

/**
 * 第二批复审（修复引入的新缺陷）回归护栏。
 *
 * 这些缺陷是**修复本身引入的**，比原缺陷更隐蔽——工具照样返回绿色的
 * 「🧠 L1 记忆消缺口」，而实际行为是错的：
 * - N-3 `containsTerm` 边界判定反了 → 中文术语 100% 不命中（「少问」对中文完全失效）
 * - N-4 子键可塞换行 → 伪造章节直达 Word 交付件，且绕过全部三道校验
 * - N-5 haystack 含 candidates 自身 → 模型臆造候选即白拿消缺口（自证）
 * - N-2 变更记录表行未豁免 → revisit 二次定稿被永久拦截
 * - F-1 豁免与校验两处正则不一致 → 5 种溯源伪造变体全部放行
 * - F-5 溯源整节删除放行；F-4 assembledFile 漏传致迭代副本丢失
 */
describe("N-3 · 中文术语必须命中", () => {
  const seed = (terms: [string, string, "内部简称" | "行业通用"][]) => {
    const home = tempMemory()
    for (const [t, d, k] of terms) writeL1Term(t, d, { kind: k, scope: "org", origin: "restated", fromProject: "p" })
    return home
  }

  test("★ 多字中文术语在真实中文材料里命中（汉字夹住也算）", () => {
    seed([["反洗钱", "反洗钱识别", "行业通用"], ["核心系统", "行内核心系统", "内部简称"], ["信用卡", "信用卡业务", "行业通用"]])
    const hits = matchMemory("本需求涉及反洗钱名单核查，改造核心系统，信用卡业务需要特殊处理。").l1.map((t) => t.term)
    expect(new Set(hits)).toEqual(new Set(["信用卡", "核心系统", "反洗钱"]))
  })

  test("单字中文不误命中相邻词（卡 不该命中 卡片管理）", () => {
    seed([["卡", "卡片管理", "内部简称"]])
    expect(matchMemory("涉及卡片管理流程").l1.map((t) => t.term)).toEqual([])
  })

  test("ASCII 缩写仍要求词边界（IT 不命中 AUDIT）", () => {
    seed([["IT", "信息技术", "内部简称"]])
    expect(matchMemory("经过 AUDIT 留痕").l1.map((t) => t.term)).toEqual([])
    expect(matchMemory("本需求涉及 IT 改造").l1.map((t) => t.term)).toEqual(["IT"])
  })
})

describe("N-4 · 子键不得注入 markdown 结构", () => {
  test("★ 子键含换行/结构字符一律拒绝", async () => {
    const { isValidSlotAddr } = await import("sm-shared")
    const f = [{ no: 1, name: "X", priority: "high" as const, confirmedAt: 1 }]
    for (const bad of ["4.1.CRD\n## 第九章 伪造", "4.1.a/b", "4.1.x\\y", "4.1.x|y", "4.1.`x`", "4.1.a[b]", "4.1." + "长".repeat(41)]) {
      expect(isValidSlotAddr(bad, f)).toBe(false)
    }
    // 合法子键仍放行
    for (const ok of ["4.1.CRD", "4.1.反洗钱", "5.1.2.1.客户号", "4.1"]) {
      expect(isValidSlotAddr(ok, f)).toBe(true)
    }
  })

  test("★ 伪造章节进不了交付件（打真实 assemble 链路）", async () => {
    tempMemory()
    const store = Store.memory(() => "reqdoc" as const)
    const worktree = mkdtempSync(join(tmpdir(), "sm-n4-"))
    const ctx = { sessionID: "r1", worktree } as never
    const tools = createReqdocKbTools(store)
    await tools.reqdoc_ingest!.execute(
      {
        features: [{ name: "名单排查", priority: "high" }],
        slots: [{ address: "3.1", kind: "prose", content: "信贷审批流程优化", source: "文档" }],
      } as never,
      ctx,
    )
    await expect(
      tools.reqdoc_ingest!.execute(
        {
          features: [{ name: "名单排查", priority: "high" }],
          slots: [{ address: "4.1.CRD\n## 第九章 伪造章节\n- **审批人**：业务总监", kind: "term", content: "信贷审批部", source: "文档" }],
        } as never,
        ctx,
      ),
    ).rejects.toThrow(/地址非法/)
    await tools.reqdoc_assemble!.execute({} as never, ctx)
    const md = readFileSync(join(worktree, "07_需求规格产出/1_名单排查/PRD.md"), "utf8")
    expect(md).not.toContain("第九章 伪造章节")
    store.close()
  })

  test("功能点地址禁前导零（F-2）", async () => {
    const { isValidSlotAddr } = await import("sm-shared")
    const f = [{ no: 1, name: "X", priority: "high" as const, confirmedAt: 1 }]
    expect(isValidSlotAddr("5.01.2.1.客户号", f)).toBe(false)
    expect(isValidSlotAddr("5.1.2.1.客户号", f)).toBe(true)
  })
})

describe("N-5 · 候选不得自证", () => {
  test("★ 槽位正文无该术语时，candidates 填了也不消缺口", async () => {
    tempMemory()
    writeL1Term("CRD", "信贷审批部", { kind: "内部简称", scope: "org", origin: "restated", fromProject: "p" })
    const store = Store.memory(() => "reqdoc" as const)
    const worktree = mkdtempSync(join(tmpdir(), "sm-n5-"))
    const out = String(
      await createReqdocKbTools(store).reqdoc_ingest!.execute(
        {
          features: [{ name: "X", priority: "high" }],
          slots: [{ address: "3.1", kind: "prose", content: "本需求为信贷业务改造。", source: "文档" }],
          candidates: { "4.1": ["CRD"] },
        } as never,
        { sessionID: "r1", worktree } as never,
      ),
    )
    // 模型臆造候选 → 不得白拿消缺口
    expect(out).not.toContain("已采信历史记忆")
    store.close()
  })

  test("正文含该术语时正常消缺口（正向）", async () => {
    tempMemory()
    writeL1Term("CRD", "信贷审批部", { kind: "内部简称", scope: "org", origin: "restated", fromProject: "p" })
    const store = Store.memory(() => "reqdoc" as const)
    const worktree = mkdtempSync(join(tmpdir(), "sm-n5b-"))
    dropMaterial(worktree, "信贷审批部（CRD）负责流程优化。")
    const out = String(
      await createReqdocKbTools(store).reqdoc_ingest!.execute(
        {
          features: [{ name: "X", priority: "high" }],
          slots: [{ address: "3.1", kind: "prose", content: "流程优化", source: "文档" }],
          candidates: { "4.1": ["CRD"] },
        } as never,
        { sessionID: "r1", worktree } as never,
      ),
    )
    expect(out).toContain("已采信历史记忆")
    store.close()
  })
})

describe("N-2 / F-1 / F-5 · 服务端追加区块的豁免与校验", () => {
  const ready = () => {
    const store = Store.memory(() => "reqdoc" as const)
    store.mutateWorkflow("r1", (w) => {
      for (const n of ["goal", "rules", "edge", "prd"]) w.stages[n].status = "approved"
      const features = [{ no: 1, name: "公告发布", priority: "medium" as const, confirmedAt: 1000 }]
      w.kb = {
        slots: requiredSlots(features).map((a) => ({
          kind: "prose" as const, address: a, content: `${a} 内容`,
          source: "文档" as const, status: "confirmed" as const,
        })),
        features,
        containers: { "4.1": { required: false, reason: "x" }, "5.1.2.1": { required: false, reason: "y" } },
        askCounts: {}, updatedAt: 1,
      }
    })
    const worktree = mkdtempSync(join(tmpdir(), "sm-n2-"))
    const ctx = { sessionID: "r1", worktree } as never
    return { store, worktree, ctx, tools: createReqdocKbTools(store) }
  }
  /** 定稿前提：有产物。先组装一次。 */
  async function assembled() {
    const r = ready()
    await r.tools.reqdoc_assemble!.execute({} as never, r.ctx)
    return r
  }
  const submit = async (store: Store, ctx: never) => {
    try { await createReviewTools(store).review_submit!.execute(CHECKLIST, ctx); return "" }
    catch (e) { return String(e) }
  }

  test("★ 二次定稿不被变更记录表行拦住（N-2：revisit 重做路径）", async () => {
    const { store, ctx } = await assembled()
    expect(await submit(store, ctx)).toBe("") // 首次定稿：写入变更记录
    store.mutateWorkflow("r1", (w) => { w.stages.review.status = "in_progress" })
    expect(await submit(store, ctx)).toBe("") // 二次定稿：变更记录表行已被豁免
    store.close()
  })

  test("★ 溯源条目格式变体一律拦截（F-1：此前 5 种变体全部放行）", async () => {
    for (const mutate of [
      (l: string) => l.replace(/^- /, "* "),
      (l: string) => l.replace("：", ": ").replace("——", "-"),
      (l: string) => l.replace("要点「T」", "要点「T」 "),
    ]) {
      const { store, ctx, worktree } = await assembled()
      const tools = createReviewTools(store)
      await tools.comprehension_add!.execute({ codeSegmentId: "T", explanation: "e" } as never, ctx)
      await tools.comprehension_confirm!.execute({ codeSegmentId: "T", sourceLabel: "L1", sourceQuote: "Q1" } as never, ctx)
      const p = join(worktree, "07_需求规格产出/1_公告发布/PRD.md")
      writeFileSync(p, readFileSync(p, "utf8").split("\n").map(mutate).join("\n"), "utf8")
      expect(await submit(store, ctx)).toContain("确认溯源")
      store.close()
    }
  })

  test("★ 溯源整节删除被拦（F-5：交付件静默失去全部溯源）", async () => {
    const { store, ctx, worktree } = await assembled()
    const tools = createReviewTools(store)
    await tools.comprehension_add!.execute({ codeSegmentId: "T", explanation: "e" } as never, ctx)
    await tools.comprehension_confirm!.execute({ codeSegmentId: "T", sourceLabel: "L1", sourceQuote: "Q1" } as never, ctx)
    const p = join(worktree, "07_需求规格产出/1_公告发布/PRD.md")
    writeFileSync(p, readFileSync(p, "utf8").replace(/## 确认溯源[\s\S]*$/, ""), "utf8")
    expect(await submit(store, ctx)).toMatch(/确认溯源|缺少/)
    store.close()
  })

  test("★ 自定义 source 时迭代副本不丢（F-4：漏传 assembledFile）", async () => {
    const { store, ctx, worktree, tools } = ready()
    await tools.reqdoc_assemble!.execute({ source: "需求规格书V2.md" } as never, ctx)
    expect(await submit(store, ctx)).toBe("")
    expect(existsSync(join(worktree, "00_初稿需求书"))).toBe(true)
    store.close()
  })
})

/**
 * 第三轮复审（I-2 / I-1）回归护栏。
 *
 * - **I-2** `content` 曾与子键同级地插值进 markdown：子键焊死了，值却敞开——
 *   `content` 里塞 `## 第九章 伪造章节` 即可造出新章节直达 Word 交付件，
 *   且 kbDigest / LCS / 定稿三重校验全部放行（它们只验「槽位 ↔ 产物一致」，
 *   而产物正是由这个 content 生成的——自证）。
 * - **I-1** 记忆匹配的证据源曾包含 `candidates`（候选自证），
 *   改为「只取槽位正文」后自证面只是平移——正文也是模型写的。
 */
describe("I-2 · 槽位内容不得注入 markdown 结构", () => {
  const build = (content: string) => {
    const store = Store.memory(() => "reqdoc" as const)
    const features = [{ no: 1, name: "名单排查", priority: "high" as const, confirmedAt: 1000 }]
    const slots = requiredSlots(features).map((a) => ({
      kind: "prose" as const, address: a, content: `${a} 内容`,
      source: "文档" as const, status: "confirmed" as const,
    }))
    slots[0] = { ...slots[0]!, content }
    store.mutateWorkflow("r1", (w) => {
      for (const n of ["goal", "rules", "edge", "prd"]) w.stages[n].status = "approved"
      w.kb = {
        slots, features,
        containers: { "4.1": { required: false, reason: "x" }, "5.1.2.1": { required: false, reason: "y" } },
        askCounts: {}, updatedAt: 1,
      }
    })
    const worktree = mkdtempSync(join(tmpdir(), "sm-i2-"))
    const ctx = { sessionID: "r1", worktree } as never
    return { store, worktree, ctx }
  }
  const prdOf = (worktree: string) =>
    readFileSync(join(worktree, "07_需求规格产出/1_名单排查/PRD.md"), "utf8")

  test("★ 标题行不被解析为新章节（转义但保留原文）", async () => {
    const { store, worktree, ctx } = build("信贷审批流程\n\n## 第九章 伪造章节\n\n- 审批人：业务总监")
    await createReqdocKbTools(store).reqdoc_assemble!.execute({} as never, ctx)
    const md = prdOf(worktree)
    // 不得成为真正的标题行
    expect(/^\s*#{1,6}\s+第九章/m.test(md)).toBe(false)
    // 但内容仍可读（转义为字面量，不丢信息）
    expect(md).toContain("\\## 第九章 伪造章节")
    expect(md).toContain("信贷审批流程")
    store.close()
  })

  test("★ 表格行不被解析为表格", async () => {
    const { store, worktree, ctx } = build("正文\n\n| 版本 | 说明 |\n| --- | --- |\n| 9.9 | 伪造 |")
    await createReqdocKbTools(store).reqdoc_assemble!.execute({} as never, ctx)
    const md = prdOf(worktree)
    expect(/^\s*\|\s*9\.9/m.test(md)).toBe(false)
    store.close()
  })

  test("容器子项内容同样受约束（子键与值两条路）", async () => {
    const store = Store.memory(() => "reqdoc" as const)
    const features = [{ no: 1, name: "名单排查", priority: "high" as const, confirmedAt: 1000 }]
    const slots = requiredSlots(features).map((a) => ({
      kind: "prose" as const, address: a, content: `${a} 内容`,
      source: "文档" as const, status: "confirmed" as const,
    }))
    slots.push({
      kind: "term" as never, address: "4.1.CRD",
      content: "信贷审批部\n\n## 伪造章节\n\n伪造内容",
      source: "文档" as const, status: "confirmed" as const,
    })
    store.mutateWorkflow("r1", (w) => {
      for (const n of ["goal", "rules", "edge", "prd"]) w.stages[n].status = "approved"
      w.kb = { slots, features, containers: { "5.1.2.1": { required: false, reason: "y" } }, askCounts: {}, updatedAt: 1 }
    })
    const worktree = mkdtempSync(join(tmpdir(), "sm-i2b-"))
    const ctx = { sessionID: "r1", worktree } as never
    await createReqdocKbTools(store).reqdoc_assemble!.execute({} as never, ctx)
    const md = prdOf(worktree)
    expect(/^\s*#{1,6}\s+伪造章节/m.test(md)).toBe(false)
    store.close()
  })

  test("正常需求描述（段落/列表/换行）不受影响", async () => {
    const normal = "流程分三步：\n1. 柜员发起\n2. 系统校验\n3. 通知客户\n\n补充说明：可批量提交。"
    const { store, worktree, ctx } = build(normal)
    await createReqdocKbTools(store).reqdoc_assemble!.execute({} as never, ctx)
    const md = prdOf(worktree)
    expect(md).toContain("流程分三步")
    expect(md).toContain("1. 柜员发起")
    expect(md).not.toContain("\\1.")
    store.close()
  })
})

describe("I-1 · 记忆证据源不可由模型书写", () => {
  test("★ 模型不得自行声称某条术语成立（restated_term 需业务复述语义）", () => {
    // 这条不是门禁而是契约断言：记忆消缺口的正当性来自「业务复述」，
    // 而 restated_term 的 description 已明示「业务只是点了同意默认时绝对不要填」。
    // 工具输出措辞必须体现「仍需确认」而非「已消缺口」——避免模型把它当既成事实。
    const src = readFileSync(join(import.meta.dir, "..", "src", "tools", "reqdoc-kb-tools.ts"), "utf8")
    // 消缺口的提示必须同时给出「不必再问」与「来源是业务过往复述过的记忆」两个要素
    // 两处回执都必须给出「定义来自过往需求中业务的复述」这个来源要素——否则模型会把记忆当成本项目的既成事实
    const notes = src.match(/🧠 已采信历史记忆[^`]*/g) ?? []
    expect(notes.length).toBeGreaterThanOrEqual(2)
    for (const n of notes) expect(n).toContain("业务的复述")
  })

  // 方案 C 落地后：证据是材料原文，模型写的槽位正文不再能制造命中。
  test("★ 模型写了否定句也拿不到记忆免问（材料不含该词）", async () => {
    tempMemory()
    writeL1Term("CCB", "某系统", { kind: "内部简称", scope: "org", origin: "restated", fromProject: "p" })
    const store = Store.memory(() => "reqdoc" as const)
    const worktree = mkdtempSync(join(tmpdir(), "sm-i1-"))
    // 材料里没有 CCB，模型却在槽位正文写「与 CCB 无关」——不得触发
    dropMaterial(worktree, "本需求仅涉及名单排查，不含其他系统。")
    const out = String(
      await createReqdocKbTools(store).reqdoc_ingest!.execute(
        {
          features: [{ name: "X", priority: "high" }],
          slots: [{ address: "3.1", kind: "prose", content: "本需求与 CCB 系统无关。", source: "文档" }],
          candidates: { "4.1": ["CCB"] },
        } as never,
        { sessionID: "r1", worktree } as never,
      ),
    )
    expect(out).not.toContain("已采信历史记忆")
    // 状态栏快照也无命中（两处口径一致）
    expect(store.get("r1")!.workflow!.kb!.evidence ?? "").not.toContain("CCB")
    store.close()
  })

  test("★ 材料确实含该词时照常免问（正向对照：换源没把记忆打没）", async () => {
    tempMemory()
    writeL1Term("CCB", "某系统", { kind: "内部简称", scope: "org", origin: "restated", fromProject: "p" })
    const store = Store.memory(() => "reqdoc" as const)
    const worktree = mkdtempSync(join(tmpdir(), "sm-i1b-"))
    dropMaterial(worktree, "本需求需对接 CCB 系统获取客户号。")
    const out = String(
      await createReqdocKbTools(store).reqdoc_ingest!.execute(
        {
          features: [{ name: "X", priority: "high" }],
          slots: [{ address: "3.1", kind: "prose", content: "取客户号", source: "文档" }],
          candidates: { "4.1": ["CCB"] },
        } as never,
        { sessionID: "r1", worktree } as never,
      ),
    )
    expect(out).toContain("已采信历史记忆")
    expect(store.get("r1")!.workflow!.kb!.evidence).toContain("CCB")
    store.close()
  })
})

/**
 * 第三轮复审（I-3 / I-4 / S-3）回归护栏。
 *
 * - **I-3** `CHANGE_ROW_RE` 曾匹配任意 5 列表格行 → 版本审计轨迹可伪造
 * - **I-4** `verifyTraceback` 只有「每行 → record」单向映射 → 逐条删除溯源记录放行
 * - **S-3** 我曾把 LCS 断言放宽成 `/确认溯源|内容与知识库不一致/`，导致 LCS 路径失去护栏
 */
describe("I-3 / I-4 · 服务端追加区块的完整性", () => {
  const assembled = async () => {
    tempMemory()
    const store = Store.memory(() => "reqdoc" as const)
    store.mutateWorkflow("r1", (w) => {
      for (const n of ["goal", "rules", "edge", "prd"]) w.stages[n].status = "approved"
      const features = [{ no: 1, name: "公告发布", priority: "medium" as const, confirmedAt: 1000 }]
      w.kb = {
        slots: requiredSlots(features).map((a) => ({
          kind: "prose" as const, address: a, content: `${a} 内容`,
          source: "文档" as const, status: "confirmed" as const,
        })),
        features,
        containers: { "4.1": { required: false, reason: "x" }, "5.1.2.1": { required: false, reason: "y" } },
        askCounts: {}, updatedAt: 1,
      }
    })
    const worktree = mkdtempSync(join(tmpdir(), "sm-i34-"))
    const ctx = { sessionID: "r1", worktree } as never
    await createReqdocKbTools(store).reqdoc_assemble!.execute({} as never, ctx)
    return { store, ctx, p: join(worktree, "07_需求规格产出/1_公告发布/PRD.md") }
  }
  const submit = async (store: Store, ctx: never) => {
    try { await createReviewTools(store).review_submit!.execute(CHECKLIST, ctx); return "" }
    catch (e) { return String(e) }
  }

  test("★ 伪造版本审计行被拦（I-3：任意 5 列表格行不再豁免）", async () => {
    const { store, ctx, p } = await assembled()
    writeFileSync(
      p,
      readFileSync(p, "utf8").replace(
        "## 第二章 文档变更过程",
        "## 第二章 文档变更过程\n\n| 9.9 | 【伪造】监管已出具无异议函 | 2020-01-01 | 张三 | 已通过 |",
      ),
      "utf8",
    )
    expect(await submit(store, ctx)).toMatch(/与知识库不一致|内容与知识库不一致/)
    store.close()
  })

  test("服务端自己写的变更记录行仍被豁免（正向：二次定稿不拦）", async () => {
    const { store, ctx } = await assembled()
    expect(await submit(store, ctx)).toBe("") // 首次定稿写入变更记录
    store.mutateWorkflow("r1", (w) => { w.stages.review.status = "in_progress" })
    expect(await submit(store, ctx)).toBe("") // 二次定稿：变更行豁免
    store.close()
  })

  test("★ 溯源逐条删除被拦（I-4：反向完整性）", async () => {
    const { store, ctx, p } = await assembled()
    const tools = createReviewTools(store)
    for (const [id, label, quote] of [["A", "L1", "Q1"], ["B", "L2", "Q2"]] as const) {
      await tools.comprehension_add!.execute({ codeSegmentId: id, explanation: "e" } as never, ctx)
      await tools.comprehension_confirm!.execute({ codeSegmentId: id, sourceLabel: label, sourceQuote: quote } as never, ctx)
    }
    writeFileSync(p, readFileSync(p, "utf8").replace(/^- 要点「B」.*$/m, ""), "utf8")
    expect(await submit(store, ctx)).toMatch(/确认溯源/)
    store.close()
  })
})

describe("C · 证据换源的两个失效路径", () => {
  const ingest = async (store: ReturnType<typeof Store.memory>, worktree: string) =>
    String(
      await createReqdocKbTools(store).reqdoc_ingest!.execute(
        {
          features: [{ name: "X", priority: "high" }],
          slots: [{ address: "3.1", kind: "prose", content: "取客户号", source: "文档" }],
          candidates: { "4.1": ["CCB"] },
        } as never,
        { sessionID: "r1", worktree } as never,
      ),
    )
  const withCCB = async () => {
    tempMemory()
    writeL1Term("CCB", "某系统", { kind: "内部简称", scope: "org", origin: "restated", fromProject: "p" })
    const store = Store.memory(() => "reqdoc" as const)
    const worktree = mkdtempSync(join(tmpdir(), "sm-c-"))
    return { store, worktree }
  }

  test("★ 材料被替换后旧证据不得残留（缓存按指纹失效）", async () => {
    const { store, worktree } = await withCCB()
    dropMaterial(worktree, "本需求需对接 CCB 系统。")
    expect(await ingest(store, worktree)).toContain("已采信历史记忆")
    // 业务换掉材料，CCB 不再出现 → 不得继续凭旧快照免问
    dropMaterial(worktree, "本需求仅涉及名单排查，与外部系统无关。")
    expect(await ingest(store, worktree)).not.toContain("已采信历史记忆")
    store.close()
  })

  test("★ 07 产物不作证据（否则自证面挪回原位）", async () => {
    tempMemory()
    writeL1Term("CCB", "某系统", { kind: "内部简称", scope: "org", origin: "restated", fromProject: "p" })
    const store = Store.memory(() => "reqdoc" as const)
    const worktree = mkdtempSync(join(tmpdir(), "sm-c2-"))
    // 只有组装产物含 CCB（正是由槽位正文生成的），材料目录全空
    mkdirSync(join(worktree, "07_需求规格产出/1_X"), { recursive: true })
    writeFileSync(join(worktree, "07_需求规格产出/1_X/PRD.md"), "对接 CCB 系统获取客户号。", "utf8")
    expect(await ingest(store, worktree)).not.toContain("已采信历史记忆")
    store.close()
  })
})


/**
 * L1 免问项的落定指引（实测缺口）。
 *
 * 症状：材料含 CLD + 业务以前复述过 → `4.1.CLD` 被移出「本轮该填」清单（r11 说清单是唯一依据）
 * 且仍是 draft → 容器 `4.1` 永无 confirmed 子项 → 进 prd 被 `必填容器未覆盖：4.1` 拦住，
 * 而业务从没被问过 CLD、AI 也不知道缺的是它。
 *
 * 修法（受众分层）：
 * - 动作指令放**工具描述**——model-only、每次请求都带、不分阶段、从不进时间线。放回执会被转述给业务，
 *   放 r33③ 只在 edge 注入（goal/rules/prd/review 阶段悬空，07 第 4 节也禁止引用规则编号）；
 * - 回执/状态栏只报**事实 + 一句受众安全的提示**，不铺「draft / 容器覆盖 / 进 prd 被拦」因果链；
 * - 落定来源一律 `source=问答`：定义出自业务过往口述、材料只出现该词并未给定义，标 [文档] 即不实溯源。
 */
describe("L1 免问项的落定指引（免问 ≠ 已覆盖）", () => {
  const read = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8")

  test("★ 指令载于工具描述（受众正确 + 不分阶段）", () => {
    const kbSrc = read(join("..", "src", "tools", "reqdoc-kb-tools.ts"))
    const ingestDesc = kbSrc.slice(kbSrc.indexOf("reqdoc_ingest = tool"), kbSrc.indexOf("args:"))
    expect(ingestDesc).toContain("已采信历史记忆")
    expect(ingestDesc).toContain("source 一律用「问答」")
    expect(ingestDesc).toContain("不要再问业务")
    // reqdoc_answer 的 address 参数须接受回执列出的免问地址（不在清单里）
    expect(kbSrc).toContain("或回执「已采信历史记忆」列出的地址")
    // answer 的 description 不得与之矛盾（曾写「只接受派生清单给出的地址」，把免问地址挡在外面）
    const ansIdx = kbSrc.indexOf("reqdoc_answer = tool")
    const answerDesc = kbSrc.slice(ansIdx, kbSrc.indexOf("args:", ansIdx))
    expect(answerDesc).toContain("已采信历史记忆")
    expect(answerDesc).not.toContain("只接受派生清单给出的地址")
  })

  test("★ 悬空承诺清零：不得再指引模型去找不存在的「附注」能力", () => {
    // 「用 containers 声明或另开附注」曾写进 ingest 报错文案，但全仓没有任何附注机制——
    // 模型按这句去找必然落空，然后大概率自行编一个办法把内容糊掉（PRD 只渲染槽位，糊掉=内容消失）。
    const kbSrc = read(join("..", "src", "tools", "reqdoc-kb-tools.ts"))
    expect(kbSrc).not.toContain("另开附注")
    // 给出两条真实存在的出路，并要求如实上报装不下的内容
    expect(kbSrc).toContain("只有两条合法出路")
    expect(kbSrc).toContain("如实告诉业务「这段内容模板装不下」")
    expect(kbSrc).toContain("不会出现在 PRD 里，等于悄悄丢失")
  })

  test("★ 增量红线进工具描述：功能点只能追加末尾、不得整篇重提（两处写 features 的工具都要有）", () => {
    const kbSrc = read(join("..", "src", "tools", "reqdoc-kb-tools.ts"))
    const ingestDesc = kbSrc.slice(kbSrc.indexOf("reqdoc_ingest = tool"), kbSrc.indexOf("args:"))
    // 工具描述是 model-only 且每次请求都在（不分阶段、不进时间线）——红线必须落在这里，不能只靠阶段规则
    expect(ingestDesc).toContain("只提交「本轮该填」清单里的地址")
    expect(ingestDesc).toContain("绝不整篇重提")
    expect(ingestDesc).toContain("已确认槽位静默打回草稿")
    const featSrc = read(join("..", "src", "tools", "reqdoc-features.ts"))
    const confirmDesc = featSrc.slice(featSrc.indexOf("reqdoc_confirm_features = tool"), featSrc.indexOf("args:"))
    expect(confirmDesc).toContain("整体替换")
    expect(confirmDesc).toContain("末尾追加")
    // 两处写 features 的工具语义一致，否则模型按哪个都行 → 分叉入口重现
    const ingestFeat = kbSrc.slice(kbSrc.indexOf("features: z"), kbSrc.indexOf("candidates: z"))
    expect(ingestFeat).toContain("末尾追加")
  })

  test("★ 回执/状态栏只报事实：不带门禁因果、不错位指称", () => {
    const kbSrc = read(join("..", "src", "tools", "reqdoc-kb-tools.ts"))
    const notes = kbSrc.match(/🧠 已采信历史记忆[^`]*/g) ?? []
    expect(notes.length).toBeGreaterThanOrEqual(2)
    for (const n of notes) {
      expect(n).toContain("已采信历史记忆")
      expect(n).toContain("source=问答")
      expect(n).toContain("不在本轮清单")
      expect(n).not.toContain("不要问业务")
      expect(n).not.toContain("仍是 draft")
      expect(n).not.toContain("进 prd 会被拦")
      expect(n).not.toContain("用材料原文")
    }
    const bar = read(join("..", "src", "prompt.ts"))
    const barLine = (bar.match(/已采信历史记忆[^\n]*/) ?? [])[0] ?? ""
    expect(barLine).toContain("待你落定")
    // 地址必须带上：回执一次性，状态条是唯一持久提示——跨轮只剩数量会让模型反查无门（转而反问业务）
    expect(barLine).toContain("open.l1Applied.join")
    expect(barLine).not.toContain("reqdoc_answer")
    expect(barLine).not.toContain("L1 ")
    // L2 回执与尾行同步清理（只改 L1 = 同一失败模式修一半）
    expect(kbSrc).toContain("🧠 共享知识命中")
    expect(kbSrc).not.toContain("L2 组织知识命中")
    expect(kbSrc).not.toContain("请业务点头")
    expect(kbSrc).not.toContain("逐项请业务确认")
  })

  test("★ 07 第 3 节口径：状态条面向模型，讲给业务听时按第 1 节翻译", () => {
    const conv = read(join("..", "conventions", "reqdoc", "07-业务口语.md"))
    expect(conv).toContain("**面向模型**")
    expect(conv).toContain("不要为了\"说人话\"删掉或改写状态条")
    // 旧口径「状态条一律业务语言」已废——它会逼掉模型行动所需的地址与门禁原因
    expect(conv).not.toContain("状态条中的技术信息一律用业务语言展示")
  })

  test("★ r33③ 载明 source=问答；r30 对冲「不算降级」", () => {
    const rule = read(join("..", "..", "shared", "src", "workflow.ts"))
    expect(rule).toContain("不在本轮清单里")
    expect(rule).toContain("source 一律标「问答」")
    expect(rule).toContain("不实溯源")
    expect(rule).toContain("不算来源降级")
  })

  test("★ 跟着回执走能解卡：免问 → 落定 → 容器覆盖", async () => {
    tempMemory()
    writeL1Term("CLD", "贷后分类标签", { kind: "内部简称", scope: "org", origin: "restated", fromProject: "p" })
    const store = Store.memory(() => "reqdoc" as const)
    const worktree = mkdtempSync(join(tmpdir(), "sm-l1fill-"))
    dropMaterial(worktree, "名单排查按 CLD 过滤。")
    const ctx = { sessionID: "r1", worktree } as never
    const tools = createReqdocKbTools(store)

    const out = String(
      await tools.reqdoc_ingest!.execute(
        {
          features: [{ name: "名单排查", priority: "high" }],
          slots: [{ address: "3.1", kind: "prose", content: "按 CLD 过滤名单", source: "文档" }],
          candidates: { "4.1": ["CLD"] },
        } as never,
        ctx,
      ),
    )
    expect(out).toContain("已采信历史记忆")
    expect(out).toContain("reqdoc_answer 落定")

    // 状态条是唯一持久提示（回执一次性）：跨轮必须仍带着地址，否则模型反查无门
    const liveBar = buildStateBar(store.get("r1")!.workflow!, "edge")
    expect(liveBar).toContain("已采信历史记忆 1 项待你落定")
    expect(liveBar).toContain("4.1.CLD")

    const kb = () => store.get("r1")!.workflow!.kb!
    // 免问项确实不在清单里、且没被自动落定
    const hits = matchMemory(await materialEvidence(worktree))
    const d = deriveQuestions(kb().features, {
      slots: kb().slots, askCounts: kb().askCounts, decls: kb().containers,
      candidates: kb().candidates, l1: hits.l1, l2: hits.l2,
    })
    expect(d.l1Applied).toContain("4.1.CLD")
    expect(d.all.map((q) => q.address)).not.toContain("4.1.CLD")
    expect(kb().slots.find((x) => x.address === "4.1.CLD")).toBeUndefined()
    expect(kbGate(kb().slots, kb().features, { decls: kb().containers }).coverage.uncoveredContainers).toContain("4.1")

    // 按回执指示落定（无需业务参与）——source 必须是「问答」：定义出自记忆，材料只出现该词未给定义
    const r = String(await tools.reqdoc_answer!.execute({ address: "4.1.CLD", content: "贷后分类标签", source: "问答" } as never, ctx))
    expect(r).toContain("4.1.CLD")
    expect(kbGate(kb().slots, kb().features, { decls: kb().containers }).coverage.uncoveredContainers).not.toContain("4.1")

    // 交付件不得把记忆来源的定义标成 [文档]（不实溯源：材料里没有这句话）
    await tools.reqdoc_assemble!.execute({} as never, ctx)
    const md = readFileSync(join(worktree, "07_需求规格产出/1_名单排查/PRD.md"), "utf8")
    expect(md).toContain("- **CLD**：贷后分类标签")
    expect(md).toContain("4.1 术语定义 [问答]")
    store.close()
  })
})

describe("Step 3 · 增量护栏（打回已确认 = 静默把业务逼回重述）", () => {
  const F = (name: string, priority: "high" | "medium" | "low" = "high") => ({ name, priority })

  test("★ ingest 不得把已确认槽位打回 draft：整批拒绝并指路 reqdoc_answer", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "sm-step3-"))
    const store = Store.memory(() => "reqdoc")
    const ctx = { sessionID: "r1", worktree } as never
    const tools = createReqdocKbTools(store)
    await tools.reqdoc_answer!.execute({ address: "3.1", content: "信贷审批流程优化", source: "文档" } as never, ctx)

    // 迭代时最容易犯的错：把旧稿/上一版 PRD 整篇重新 ingest
    await expect(
      tools.reqdoc_ingest!.execute(
        {
          slots: [
            { address: "3.2", kind: "prose", content: "新段落", source: "文档" },
            { address: "3.1", kind: "prose", content: "整篇重提的旧内容", source: "文档" },
          ],
        } as never,
        ctx,
      ),
    ).rejects.toThrow(/已确认的槽位：3\.1/)

    const kb = store.get("r1")!.workflow!.kb!
    // 关键：已确认内容与状态必须原样保留（静默跳过会让模型以为改成功、实际没改）
    const s31 = kb.slots.find((s) => s.address === "3.1")!
    expect(s31.status).toBe("confirmed")
    expect(s31.content).toBe("信贷审批流程优化")
    // 同批的新地址也不写入（整批拒绝，不做半截写入）
    expect(kb.slots.some((s) => s.address === "3.2")).toBe(false)
    store.close()
  })

  test("★ 合法出路：改已确认内容走 reqdoc_answer（保持 confirmed，不掉覆盖率）", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "sm-step3-"))
    const store = Store.memory(() => "reqdoc")
    const ctx = { sessionID: "r1", worktree } as never
    const tools = createReqdocKbTools(store)
    await tools.reqdoc_answer!.execute({ address: "3.1", content: "旧内容", source: "文档" } as never, ctx)
    const before = kbGate(store.get("r1")!.workflow!.kb!.slots, store.get("r1")!.workflow!.kb!.features, {}).coverage
    await tools.reqdoc_answer!.execute({ address: "3.1", content: "新内容", source: "文档" } as never, ctx)
    const kb = store.get("r1")!.workflow!.kb!
    const s31 = kb.slots.find((s) => s.address === "3.1")!
    expect(s31.content).toBe("新内容")
    expect(s31.status).toBe("confirmed")
    // 覆盖率不掉——这正是「用 answer 而不是 ingest」的意义
    expect(kbGate(kb.slots, kb.features, {}).coverage.leafFilled).toBe(before.leafFilled)
    store.close()
  })

  test("★ 两处写 features 的工具共用同一条纯追加校验（措辞与判定必须一致）", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "sm-step3-"))
    const store = Store.memory(() => "reqdoc")
    const ctx = { sessionID: "r1", worktree } as never
    const kbTools = createReqdocKbTools(store)
    await kbTools.reqdoc_ingest!.execute(
      {
        features: [F("名单排查"), F("模型打分", "low")],
        slots: [{ address: "5.1.1.1", kind: "prose", content: "输入：客户号", source: "文档" }],
      } as never,
      ctx,
    )
    // 同一违规分别走两个工具：都必须被拒，且提示指向同一件事
    await expect(
      kbTools.reqdoc_ingest!.execute({ features: [F("模型打分", "low"), F("名单排查")] } as never, ctx),
    ).rejects.toThrow(/必须纯追加/)
    await expect(
      createReqdocFeatureTools(store).reqdoc_confirm_features!.execute(
        { features: [F("模型打分", "low"), F("名单排查")] } as never,
        ctx,
      ),
    ).rejects.toThrow(/必须纯追加/)
    expect(store.get("r1")!.workflow!.kb!.features.map((f) => f.name)).toEqual(["名单排查", "模型打分"])
    store.close()
  })
})

/** Step 4 专用功能点夹具（与「记忆条目的 scope 作用域」无关，勿混）。 */
const feat = (name: string, priority: "high" | "medium" | "low" = "high") => ({ name, priority })

describe("Step 4b · 承认基线：业务不必把稿里已有的内容再说一遍", () => {
  const FILE = "00_初稿需求书/初稿_旧需求.md"
  async function baselineSession() {
    const worktree = mkdtempSync(join(tmpdir(), "sm-base-"))
    mkdirSync(join(worktree, "00_初稿需求书"), { recursive: true })
    writeFileSync(join(worktree, FILE), "旧需求正文", "utf8")
    const store = Store.memory(() => "reqdoc")
    const ctx = { sessionID: "r1", worktree } as never
    const tools = createReqdocKbTools(store)
    await createReqdocFeatureTools(store).reqdoc_confirm_features!.execute({ features: [feat("名单排查")] } as never, ctx)
    return { worktree, store, ctx, tools }
  }

  test("★ 预演 → 业务授权 → 执行：确认后不再问稿里已有的内容，基线没覆盖的必填项照旧要问", async () => {
    const { store, ctx, tools } = await baselineSession()
    const all = requiredSlots(store.get("r1")!.workflow!.kb!.features)
    const covered = all.slice(0, 5)
    const uncovered = all.slice(5)
    // 旧稿只覆盖一部分——好验证「承认基线不豁免必填」
    await tools.reqdoc_ingest!.execute(
      {
        slots: covered.map((address) => ({
          address,
          kind: "prose" as const,
          content: `${address} 来自旧稿`,
          source: "文档" as const,
          ref: FILE,
        })),
      } as never,
      ctx,
    )

    const dry = String(await tools.reqdoc_adopt_baseline!.execute({ file: FILE, unmapped: [] } as never, ctx))
    expect(dry).toContain("预演")
    expect(dry).toContain("第 3 章") // 按章分组，业务看的是「哪一块」
    expect(store.get("r1")!.workflow!.kb!.slots.every((x) => x.status === "draft")).toBe(true) // 预演不改状态

    // 执行必须给业务授权，否则拒绝——模型不得代填理由（照 force_kb/force_reason 先例）
    await expect(
      tools.reqdoc_adopt_baseline!.execute({ file: FILE, confirm: true, unmapped: [] } as never, ctx),
    ).rejects.toThrow(/模型不得代填/)

    await tools.reqdoc_adopt_baseline!.execute(
      { file: FILE, confirm: true, authorized_by: "张业务", confirm_note: "旧稿已对过，没问题", unmapped: [] } as never,
      ctx,
    )
    const after = store.get("r1")!.workflow!.kb!
    expect(covered.every((a) => after.slots.find((x) => x.address === a)!.status === "confirmed")).toBe(true)
    // 快照冻住 = 变更清单的基准（kb.slots 原地覆盖，系统不留历史）
    expect(after.baselineSnapshot!.file).toBe(FILE)
    expect(after.baselineSnapshot!.slots).toHaveLength(covered.length)
    const left = deriveQuestions(after.features, { slots: after.slots, decls: after.containers }).all.map((q) => q.address)
    expect(left).toEqual(expect.arrayContaining(uncovered))
    expect(left).not.toContain(covered[0])
    store.close()
  })

  test("★ 非文档来源不得冒充基线（防不实溯源：旧需求说辞被写成书面依据）", async () => {
    const { store, ctx, tools } = await baselineSession()
    // 凭记忆免问落定的那批是 [问答] 且没有 ref
    await tools.reqdoc_answer!.execute({ address: "3.1", content: "凭记忆落定的背景", source: "问答" } as never, ctx)
    await expect(
      tools.reqdoc_adopt_baseline!.execute(
        { file: FILE, addresses: ["3.1"], confirm: true, authorized_by: "张业务", confirm_note: "对过", unmapped: [] } as never,
        ctx,
      ),
    ).rejects.toThrow(/不能作为基线确认/)
    store.close()
  })

  test("★ 无归宿内容必须申报：unmapped 逐条回显，并点明不会进需求书", async () => {
    const { store, ctx, tools } = await baselineSession()
    const first = requiredSlots(store.get("r1")!.workflow!.kb!.features).slice(0, 2)
    await tools.reqdoc_ingest!.execute(
      {
        slots: first.map((address) => ({
          address,
          kind: "prose" as const,
          content: `${address} 来自旧稿`,
          source: "文档" as const,
          ref: FILE,
        })),
      } as never,
      ctx,
    )
    const r = String(
      await tools.reqdoc_adopt_baseline!.execute(
        {
          file: FILE,
          unmapped: [
            { excerpt: "附录A 数据口径说明", disposition: "本次不纳入（属于数据治理专项）" },
            { excerpt: "培训计划", disposition: "待业务决定" },
          ],
        } as never,
        ctx,
      ),
    )
    expect(r).toContain("已申报")
    expect(r).toContain("附录A 数据口径说明")
    expect(r).toContain("本次不纳入（属于数据治理专项）")
    expect(r).toContain("待业务决定")
    expect(r).toContain("不会进入需求书")
    store.close()
  })
})

describe("Step 4c · 变更清单：业务说「只改这两处」，他得看到「实际改了什么」", () => {
  /** 走到可定稿状态：前四阶段已通过、必填全确认、容器已声明、PRD 已组装。 */
  async function readyToSubmit() {
    tempMemory()
    const store = Store.memory(() => "reqdoc" as const)
    const worktree = mkdtempSync(join(tmpdir(), "sm-chg-"))
    mkdirSync(join(worktree, "00_初稿需求书"), { recursive: true })
    writeFileSync(join(worktree, "00_初稿需求书/初稿_旧需求.md"), "旧需求正文", "utf8")
    const FILE = "00_初稿需求书/初稿_旧需求.md"
    store.mutateWorkflow("r1", (w) => {
      for (const n of ["goal", "rules", "edge", "prd"]) w.stages[n].status = "approved"
      w.stages.review.status = "in_progress"
      const features = [{ no: 1, name: "名单排查", priority: "medium" as const, confirmedAt: 1000 }]
      w.kb = {
        // 基线 = 旧稿派生出来的全部内容（快照冻结在 baselineSnapshot）
        slots: requiredSlots(features).map((a) => ({
          kind: "prose" as const, address: a, content: `${a} 旧稿内容`,
          source: "文档" as const, status: "confirmed" as const, ref: FILE,
        })),
        features,
        containers: { "4.1": { required: false, reason: "无术语" }, "5.1.2.1": { required: false, reason: "无字段" } },
        baselineSnapshot: {
          file: FILE,
          slots: requiredSlots(features).map((a) => ({
            kind: "prose" as const, address: a, content: `${a} 旧稿内容`,
            source: "文档" as const, status: "confirmed" as const, ref: FILE,
          })),
          features,
          at: 1,
        },
        askCounts: {},
        updatedAt: 1,
      }
    })
    const ctx = { sessionID: "r1", worktree } as never
    return { store, ctx, worktree, FILE }
  }
  const prd = (worktree: string) => join(worktree, "07_需求规格产出/1_名单排查/PRD.md")

  test("★ 分支二定稿：回执给出变更清单；交付件第二章格式不变（清单只在回执里说）", async () => {
    const { store, ctx, worktree } = await readyToSubmit()
    const tools = createReqdocKbTools(store)
    // 业务说「就改 3.1」→ 直接改这一处（不再有范围声明机制）
    await tools.reqdoc_answer!.execute({ address: "3.1", content: "3.1 按新政策改写后的内容", source: "文档" } as never, ctx)
    // 顺手改了 3.2
    store.mutateWorkflow("r1", (w) => {
      w.kb!.slots = w.kb!.slots.map((x) => (x.address === "3.2" ? { ...x, content: "3.2 顺手改了" } : x))
    })
    await tools.reqdoc_assemble!.execute({} as never, ctx)

    const out = String(await createReviewTools(store).review_submit!.execute(CHECKLIST, ctx))
    expect(out).toContain("本次变更")
    expect(out).toContain("初稿_旧需求.md")
    expect(out).toContain("改写 2 项（3.1、3.2）")
    expect(out).toContain("请把上面这份清单转述给业务")
    // 交付件第二章保持模板原样：变更清单降级为只在回执里说，不再改交付件格式
    const md = readFileSync(prd(worktree), "utf8")
    expect(md).toContain("| 1.0 | 初始定稿 |")
    expect(md).not.toContain("改写 2 项")
    store.close()
  })

  test("★ 分支一（无基线快照）不给变更清单——全新需求没有「相对基线」可言", async () => {
    const { store, ctx } = await readyToSubmit()
    store.mutateWorkflow("r1", (w) => {
      delete w.kb!.baselineSnapshot
    })
    await createReqdocKbTools(store).reqdoc_assemble!.execute({} as never, ctx)
    const out = String(await createReviewTools(store).review_submit!.execute(CHECKLIST, ctx))
    expect(out).toContain("审查阶段通过")
    expect(out).not.toContain("本次变更")
    store.close()
  })

  test("★ 无实际改动时不谎报：清单明说「与基线一致」", async () => {
    const { store, ctx } = await readyToSubmit()
    await createReqdocKbTools(store).reqdoc_assemble!.execute({} as never, ctx)
    const out = String(await createReviewTools(store).review_submit!.execute(CHECKLIST, ctx))
    expect(out).toContain("内容与基线一致")
    store.close()
  })
})

describe("Step 6 · 分支二的说明书：AI 得知道按什么顺序调（否则能力建好也不会用）", () => {
  const wfSrc = () => read(join("..", "..", "shared", "src", "workflow.ts"))
  const convSrc = () => read(join("..", "conventions", "reqdoc", "07-业务口语.md"))

  test("★ 分支二八步调用序载明在 r8（goal 阶段），且点名「顺序反了会出事」", () => {
    const src = wfSrc()
    const from = src.indexOf('id: "reqdoc-r8"')
    const rule = src.slice(from, src.indexOf('{ id: "reqdoc-', from + 10))
    for (const step of [
      "reqdoc_import",
      "reqdoc_ingest",
      "ref 填该稿路径",
      "reqdoc_adopt_baseline",
      "先不带 confirm 预演",
      "authorized_by",
      "confirm_note",
      "unmapped",
      "只问「旧稿未覆盖的必填项 + 新增功能点」",
      "末尾追加",
      "顺序反了会出事",
    ]) {
      expect(rule).toContain(step)
    }
    // 模型不得代填授权与理由——与 force_kb/force_reason 同一先例
    expect(rule).toContain("模型不得代填")
  })

  test("★ 调用序不占 global 每轮预算；也不留悬空规则编号", () => {
    // 曾单开一条 global r36（580 字），把 global+prd 注入顶到 4362 > 4000 预算（上下文预算护栏当场报红）。
    // 分支二从 goal 阶段起步，序也只在起步时需要——折进 r8 既不超预算，注入时机还更准。
    const src = wfSrc()
    expect(src).not.toContain('id: "reqdoc-r36"')
    expect(src).toMatch(/id: "reqdoc-r8", stage: "goal"/)
  })

  test("★ 07 词汇表收了承认基线的业务语言（讲给业务听时不能出现工具名）", () => {
    const conv = convSrc()
    expect(conv).toContain("| reqdoc_adopt_baseline | 沿用已有需求书里已经写好的内容 |")
    expect(conv).toContain("| 承认基线 | 沿用旧稿已写好的内容 |")
  })

  test("★ 说明书指向的工具在运行时确实存在", () => {
    const kbSrc = read(join("..", "src", "tools", "reqdoc-kb-tools.ts"))
    expect(kbSrc).toContain("const reqdoc_adopt_baseline = tool(")
  })
})
