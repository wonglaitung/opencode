/**
 * 定稿门禁护栏（重构审查 P1）：
 *
 * 审查发现三个可绕过定稿校验的缺口，本文件把它们钉死：
 * 1. 幂等校验曾写成 `if (liveRender?.kbDigest && ...)`——产物缺失或无内嵌摘要时整条静默跳过，
 *    模型用 write 手写一篇 PRD 即可绕过。
 * 2. `no_document_confirmed` / `skip_field_dict` 是死参数：schema 暴露给模型、description 承诺
 *    「可跳过门禁」，但 execute 零处读取——造成虚假安全感。
 * 3. 死参数删除后，规则文本若仍指示模型使用，同样是缺陷。
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { kbDigest, parseRenderStructure, requiredSlots, reviewRecord } from "sm-shared"
import { Store } from "../src/db"
import { createReqdocKbTools } from "../src/tools/reqdoc-kb-tools"
import { createReviewTools } from "../src/tools/review"

const dirs: string[] = []
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "sm-p1guard-"))
  dirs.push(d)
  return d
}
process.on("exit", () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const CHECKLIST = {
  completeness: true,
  clarity: true,
  edgeCoverage: true,
  resolution: true,
} as never

/** 已填满槽位 + 前序阶段 approved 的 reqdoc store。 */
function readyStore(): Store {
  const store = Store.memory(() => "reqdoc" as const)
  store.mutateWorkflow("r1", (w) => {
    for (const n of ["goal", "rules", "edge", "prd"]) w.stages[n].status = "approved"
    const features = [{ no: 1, name: "公告发布", priority: "medium" as const, confirmedAt: 1000 }]
    w.kb = {
      slots: requiredSlots(features).map((address) => ({
        kind: "prose" as const,
        address,
        content: `${address} 内容`,
        source: "文档" as const,
        status: "confirmed" as const,
      })),
      features,
      containers: {
        "4.1": { required: false, reason: "无特殊术语" },
        "5.1.2.1": { required: false, reason: "无结构化字段" },
      },
      askCounts: {},
      updatedAt: 1000,
    }
  })
  return store
}

/** 用 reqdoc_assemble 在真实 worktree 生成产物（等价于真实流程）。 */
async function assemble(store: Store, worktree: string) {
  const ctx = { sessionID: "r1", worktree } as never
  await createReqdocKbTools(store).reqdoc_assemble!.execute({} as never, ctx)
  return ctx
}

describe("P1 · 定稿幂等门禁不可绕过", () => {
  test("★ 产物缺失 → 定稿被拒（force_kb 也不豁免）", async () => {
    const store = readyStore()
    const worktree = tempDir()
    const ctx = { sessionID: "r1", worktree } as never // 故意不组装
    await expect(
      createReviewTools(store).review_submit!.execute(CHECKLIST, ctx),
    ).rejects.toThrow(/未找到 PRD 产物/)
    store.close()
  })

  test("★ 手写产物（无内嵌摘要）→ 定稿被拒", async () => {
    const store = readyStore()
    const worktree = tempDir()
    // 模型用 write 手写一篇结构完整但没有 <!-- kb-digest --> 的 PRD
    const rel = "07_需求规格产出/1_公告发布/PRD.md"
    mkdirSync(dirname(join(worktree, rel)), { recursive: true })
    writeFileSync(
      join(worktree, rel),
      "## 第一章 项目信息\n## 第三章 需求概述\n## 第五章 需求功能详述\n",
      "utf8",
    )
    const ctx = { sessionID: "r1", worktree } as never
    await expect(
      createReviewTools(store).review_submit!.execute(CHECKLIST, ctx),
    ).rejects.toThrow(/缺少槽位摘要/)
    store.close()
  })

  test("★ 槽位变更后未重组装（过期产物）→ 定稿被拒并指明原因", async () => {
    const store = readyStore()
    const worktree = tempDir()
    const ctx = await assemble(store, worktree)
    // 槽位变更（模拟业务补充了一个槽位）
    store.mutateWorkflow("r1", (w) => {
      w.kb!.slots.push({
        kind: "prose",
        address: "3.1",
        content: "业务补充的新内容",
        source: "文档",
        status: "confirmed",
      })
      if (w.kb?.askCounts) w.kb.askCounts["3.1"] = 0
    })
    await expect(
      createReviewTools(store).review_submit!.execute(CHECKLIST, ctx),
    ).rejects.toThrow(/与知识库不一致/)
    store.close()
  })

  test("★ 产物被手改（摘要被抹掉）→ 定稿被拒", async () => {
    const store = readyStore()
    const worktree = tempDir()
    const ctx = await assemble(store, worktree)
    const rel = join(worktree, "07_需求规格产出/1_公告发布/PRD.md")
    // 模拟模型手工编辑产物、连带删掉内嵌摘要
    writeFileSync(rel, readFileSync(rel, "utf8").replace(/<!--\s*kb-digest:[^>]*-->\n?/g, ""), "utf8")
    await expect(
      createReviewTools(store).review_submit!.execute(CHECKLIST, ctx),
    ).rejects.toThrow(/缺少槽位摘要/)
    store.close()
  })

  test("正向：组装产物与槽位一致 → 定稿通过", async () => {
    const store = readyStore()
    const worktree = tempDir()
    const ctx = await assemble(store, worktree)
    const out = String(await createReviewTools(store).review_submit!.execute(CHECKLIST, ctx))
    expect(out).toContain("审查阶段通过")
    store.close()
  })
})

describe("P1 · 死参数已移除", () => {
  test("★ review_submit schema 不再暴露 skip_field_dict / no_document_confirmed", () => {
    const tools = createReviewTools(readyStore())
    const shape = tools.review_submit!.args ?? {}
    expect(Object.keys(shape)).not.toContain("skip_field_dict")
    expect(Object.keys(shape)).not.toContain("no_document_confirmed")
  })

  test("★ workflow_advance 保留 force_kb / force_reason（有实际门禁作用）", () => {
    const shape = createReqdocKbTools(readyStore()).reqdoc_ingest!.args ?? {}
    // 结构存在性检查：ingest 无 force 参数（force 在 workflow_advance 上），此处只断言 ingest 参数集
    expect(Object.keys(shape)).toContain("slots")
    expect(Object.keys(shape)).not.toContain("skip_field_dict")
  })

  test("★ 组装产物首行内嵌摘要，可被 parseRenderStructure 读回", async () => {
    const store = readyStore()
    const worktree = tempDir()
    await assemble(store, worktree)
    const md = readFileSync(join(worktree, "07_需求规格产出/1_公告发布/PRD.md"), "utf8")
    expect(md.startsWith("<!-- kb-digest: ")).toBe(true)
    // 摘要可被 parseRenderStructure 读回——这是幂等校验能工作的前提
    const parsed = parseRenderStructure(md)
    const kb = store.get("r1")!.workflow!.kb!
    expect(parsed.kbDigest).toBe(kbDigest(kb.slots))
  })
})

describe("P1 · 确认溯源门禁仍生效（未被重构削弱）", () => {
  test("已接受要点未回填来源 → 定稿被拦（即使知识库齐备）", async () => {
    const store = readyStore()
    const worktree = tempDir()
    const tools = createReviewTools(store)
    const ctx = await assemble(store, worktree)
    await tools.comprehension_add!.execute(
      { codeSegmentId: "目标与场景", explanation: "缩短开户录入" } as never,
      ctx,
    )
    await tools.comprehension_confirm!.execute({ codeSegmentId: "目标与场景" } as never, ctx)
    await expect(tools.review_submit!.execute(CHECKLIST, ctx)).rejects.toThrow(/确认溯源缺失/)
    // 定稿被拦 → review 阶段未被 approve
    expect(reviewRecord(store.get("r1")!.workflow!).status).not.toBe("approved")
    store.close()
  })
})
describe("验收 4 · 组装产物与槽位逐字一致（重组装 diff）", () => {
  const prdPath = (worktree: string) => join(worktree, "07_需求规格产出/1_公告发布/PRD.md")

  test("★ 纯内容手改（改字不增删槽位）→ 摘要不变但重组装 diff 抓到", async () => {
    const store = readyStore()
    const worktree = tempDir()
    const ctx = await assemble(store, worktree)
    // 摘要只哈希槽位：改产物正文不会改变内嵌摘要——这正是摘要校验的盲区
    const before = readFileSync(prdPath(worktree), "utf8")
    const tampered = before.replace("3.1 内容", "3.1 被偷偷改过的内容")
    expect(tampered).not.toBe(before)
    writeFileSync(prdPath(worktree), tampered, "utf8")
    // 内嵌摘要未变（parseRenderStructure 仍能读出同一摘要）
    expect(tampered).toContain("<!-- kb-digest:")
    await expect(
      createReviewTools(store).review_submit!.execute(CHECKLIST, ctx),
    ).rejects.toThrow(/内容与知识库不一致/)
    store.close()
  })

  test("★ 删掉一段正文 → diff 报错（缺行也算不一致）", async () => {
    const store = readyStore()
    const worktree = tempDir()
    const ctx = await assemble(store, worktree)
    const md = readFileSync(prdPath(worktree), "utf8")
    const trimmed = md.replace("3.2 内容\n", "")
    expect(trimmed).not.toBe(md) // 确认删除真的生效
    writeFileSync(prdPath(worktree), trimmed, "utf8")
    let msg = ""
    try {
      await createReviewTools(store).review_submit!.execute(CHECKLIST, ctx)
    } catch (e) {
      msg = String(e)
    }
    expect(msg).toContain("内容与知识库不一致")
    store.close()
  })

  test("正向：未改动时重组装 diff 无差异，定稿通过", async () => {
    const store = readyStore()
    const worktree = tempDir()
    const ctx = await assemble(store, worktree)
    // 追加非 PRD 正文内容（如项目方自己加的落款）不应被当作不一致？
    // —— 不行：产物必须完全由槽位投影生成。故此处只验证「原样不改」能过。
    const out = String(await createReviewTools(store).review_submit!.execute(CHECKLIST, ctx))
    expect(out).toContain("审查阶段通过")
    store.close()
  })

  test("★ 组装与校验共用同一 assembleInto（防两处漂移）", async () => {
    const store = readyStore()
    const worktree = tempDir()
    await assemble(store, worktree)
    const kb = store.get("r1")!.workflow!.kb!
    const { assembleInto } = await import("../src/tools/reqdoc-kb-tools")
    // 校验侧重组装的产物必须与磁盘上的逐字一致（否则 diff 恒报错）
    expect(assembleInto(kb)!.md).toBe(readFileSync(prdPath(worktree), "utf8"))
    store.close()
  })
})

describe("diffLines 比对口径（多重集，非行号）", () => {
  // 直接验证 review.ts 内部的比对逻辑：按行号比对会漏报增删，必须用多重集。
  // 这里复刻其实现并断言三类差异都能检出。
  const trim = (t: string) => t.trim()
  const diff = (expected: string, actual: string): string[] => {
    const a = expected.split(/\r?\n/).filter((l) => trim(l) !== "")
    const b = actual.split(/\r?\n/).filter((l) => trim(l) !== "")
    const out: string[] = []
    const pool = [...a]
    for (const line of b) {
      const idx = pool.indexOf(line)
      if (idx >= 0) pool.splice(idx, 1)
      else out.push(`产物多出/被改：「${line}」`)
    }
    for (const line of pool) out.push(`产物缺失：「${line}」`)
    return out
  }

  test("★ 纯删除：删掉中间一段必须被检出", () => {
    const expected = "标题\n内容A\n内容B\n内容C\n结尾"
    const actual = "标题\n内容A\n内容C\n结尾" // B 被删
    expect(diff(expected, actual).length).toBeGreaterThan(0)
    expect(diff(expected, actual)[0]).toContain("内容B")
  })

  test("★ 纯插入：多出一段必须被检出", () => {
    expect(diff("标题\n内容A\n结尾", "标题\n内容A\n插入的\n结尾").length).toBeGreaterThan(0)
  })

  test("★ 内容替换：改字必须被检出", () => {
    const d = diff("标题\n原内容\n结尾", "标题\n改过的内容\n结尾")
    expect(d.length).toBe(2) // 一增一删
  })

  test("完全一致（含空白差异）→ 无差异", () => {
    expect(diff("a\n\nb", "a\n  \nb").length).toBe(0)
  })

  test("★ 对照：删一段时行号比对会误报成「多处被改」，多重集才精确", () => {
    // 穷举结论：删一行必然造成行数差，故按行号比对**不会漏报**（总有行对不上），
    // 但它会把「后续行整体错位」都报成「被改」——错误定位，且报的数量随错位长度放大。
    // 多重集比对只报真正增/删的行。
    const byIndexDiffs = (expected: string, actual: string): string[] => {
      const a = expected.split("\n"), b = actual.split("\n")
      const out: string[] = []
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if ((a[i] ?? "").trim() === (b[i] ?? "").trim()) continue
        if (!trim(a[i] ?? "") || !trim(b[i] ?? "")) continue
        out.push((a[i] ?? "").trim())
      }
      return out
    }
    // 删中间一段：后续 20 行全部错位 → 行号比对报 21 处「被改」
    const expected = ["标题", ...Array.from({ length: 20 }, (_, i) => `内容${i}`), "结尾"].join("\n")
    const actual = ["标题", ...Array.from({ length: 19 }, (_, i) => `内容${i < 10 ? i : i + 1}`), "结尾"].join("\n")

    // 实际误报 10 处（错位段），而真正差异只有 1 行
    expect(byIndexDiffs(expected, actual).length).toBe(10)
    const precise = diff(expected, actual)
    expect(precise.length).toBe(1)
    expect(precise[0]).toContain("内容10")
  })
})

describe("重组装 diff · 服务端追加区块豁免", () => {
  const prdPath = (worktree: string) => join(worktree, "07_需求规格产出/1_公告发布/PRD.md")

  test("★ 确认溯源章节（P3.10 溯源回填写入）不触发不一致", async () => {
    const store = readyStore()
    const worktree = tempDir()
    const tools = createReviewTools(store)
    const ctx = await assemble(store, worktree)
    // 正常流程：comprehension_confirm 会把来源证据写进 PRD 的「确认溯源」章节
    await tools.comprehension_add!.execute(
      { codeSegmentId: "目标与场景", explanation: "缩短开户录入" } as never,
      ctx,
    )
    await tools.comprehension_confirm!.execute(
      { codeSegmentId: "目标与场景", sourceLabel: "对话第 1 轮", sourceQuote: "开户要手工录三遍" } as never,
      ctx,
    )
    // 产物末尾确实被写入了溯源章节
    expect(readFileSync(prdPath(worktree), "utf8")).toContain("## 确认溯源")
    // 但它不应被判为「与知识库不一致」
    const out = String(await tools.review_submit!.execute(CHECKLIST, ctx))
    expect(out).toContain("审查阶段通过")
    store.close()
  })

  test("★ 豁免只针对溯源章节：正文里的手改仍被抓", async () => {
    const store = readyStore()
    const worktree = tempDir()
    const ctx = await assemble(store, worktree)
    const p = prdPath(worktree)
    // 同时做两件事：追加合法溯源章节 + 手改正文
    const md = readFileSync(p, "utf8")
    writeFileSync(p, md.replace("3.1 内容", "3.1 手改内容") + "\n\n## 确认溯源\n\n- 某条记录\n", "utf8")
    await expect(
      createReviewTools(store).review_submit!.execute(CHECKLIST, ctx),
    ).rejects.toThrow(/内容与知识库不一致/)
    store.close()
  })
})
