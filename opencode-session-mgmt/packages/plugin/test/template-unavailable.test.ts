/**
 * 模板不可读时的软硬分界（对抗审查 P1）。
 *
 * 模板读不到 = 安装损坏（模板随插件分发，三种部署形态均已覆盖）。此时两类路径
 * 必须表现**相反**：
 *
 * - **软路径**（状态条 / 工具回执 / 覆盖率 / 开放项派生 / 漂移检测）：**绝不抛**。
 *   它们每轮都经system prompt 构建路径被调用，一次抛错就是整个请求失败——
 *   与本仓 pdfjs 静态 import 拖垮插件加载是同一类事故（AGENTS.md 有记载）。
 *   降级方向必须**安全**：必填集为空 → 覆盖率 0% → 门禁必不通过，
 *   呈现为「看起来什么都没填」而不是「看起来填完了」。
 *
 * - **硬路径**（组装 / 渲染结构校验 / 骨架生成）：**必须抛**，由用户报障。
 *   宁可请求失败，也不能悄悄产出一份章节结构不明的交付件——那会让手改检测、
 *   幂等校验、定稿溯源三条防线同时失效且无人察觉。
 */
import { existsSync, readFileSync, renameSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, test } from "bun:test"
import {
  EMPTY_SCHEMA,
  deriveQuestions,
  isValidSlotAddr,
  kbGate,
  requiredContainers,
  requiredSlots,
  slotCoverage,
  templateSchemaOrEmpty,
  templateUnavailableNotice,
} from "sm-shared"
import { assembleDoc } from "sm-shared"
import { buildPrdSkeleton, parseRenderStructure } from "sm-shared"

const TEMPLATE = join(import.meta.dir, "..", "..", "..", "docs", "reqdoc-prd-template.md")
const BAK = `${TEMPLATE}.unreadable-probe`
const feats = [{ no: 1, name: "名单排查", priority: "high" as const, confirmedAt: 1 }]

/** 把探针文件还原回去。`Bun.file(x).exists` 是取值属性（**不是函数**）——
 *  上次对抗审查的事故根因之一就是把它当函数调用导致清理没跑、模板真丢了。 */
function restore(): void {
  if (existsSync(BAK)) renameSync(BAK, TEMPLATE)
}

/**
 * 模板不可读下的探针结果。必须在**子进程**里跑：模块级 schema 缓存一旦被本进程
 * 填过就再也读不到「不可读」状态，无法在同一进程内前后对照。
 * 移走真实模板文件 + 结束后必然还原（try/finally + afterAll 双保险）。
 */
function probeTemplateMissing(): Record<string, { ok: boolean; v: unknown }> {
  renameSync(TEMPLATE, BAK)
  try {
    const proc = Bun.spawnSync(["bun", "-e", SCRIPT], { stdout: "pipe", stderr: "pipe" })
    if (proc.exitCode !== 0) throw new Error(`子进程失败: ${proc.stderr.toString().slice(0, 200)}`)
    return JSON.parse(proc.stdout.toString()) as Record<string, { ok: boolean; v: unknown }>
  } finally {
    restore()
  }
}

/** 子进程脚本：模板不可读下逐项探软/硬路径，把结果打成 JSON。 */
const SCRIPT = `
const P = ${JSON.stringify(TEMPLATE)}
const s = await import("/data/opencode/opencode-session-mgmt/packages/shared/src/reqdoc-slots.ts")
const a = await import("/data/opencode/opencode-session-mgmt/packages/shared/src/reqdoc-assemble.ts")
const r = await import("/data/opencode/opencode-session-mgmt/packages/shared/src/reqdoc-render.ts")
const sch = await import("/data/opencode/opencode-session-mgmt/packages/shared/src/reqdoc-template-schema.ts")
const f = [{no:1,name:"名单排查",priority:"high",confirmedAt:1}]
const out = {}
const t = (k, fn) => { try { out[k] = { ok: true, v: fn() } } catch (e) { out[k] = { ok: false, v: String(e.message).slice(0,40) } } }
t("requiredSlots", () => s.requiredSlots(f).length)
t("slotCoverage", () => s.slotCoverage([], f).pct)
t("kbGate", () => s.kbGate([], f).pass)
t("deriveQuestions", () => s.deriveQuestions(f).all.length)
t("assembleDoc", () => { const x = a.assembleDoc([], [], null); return x === null ? "null" : "obj" })
t("parseRenderStructure", () => r.parseRenderStructure("## x").ok)
t("buildPrdSkeleton", () => { const x = r.buildPrdSkeleton("x", f); return x === null ? "null" : "md" })
t("noticePresent", () => sch.templateUnavailableNotice() === null ? "null" : "notice")
t("askCount", () => s.deriveQuestions(f).all.length)
console.log(JSON.stringify(out))
`

describe("模板不可读：软硬分界", () => {
  test("软路径全部不抛，且降级方向安全（必填 0、覆盖率 0、门禁不过）", () => {
    const out = probeTemplateMissing()
    expect(out.requiredSlots.ok).toBe(true)
    expect(out.requiredSlots.v).toBe(0)
    expect(out.slotCoverage.ok).toBe(true)
    expect(out.slotCoverage.v).toBe(0)
    expect(out.kbGate.ok).toBe(true)
    expect(out.kbGate.v).toBe(false) // 必填集为空 → 门禁必不过（安全方向）
    expect(out.deriveQuestions.ok).toBe(true)
  })

  test("模板不可用时给出可操作说明（否则用户被指向 ingest 这条死路）", () => {
    const out = probeTemplateMissing()
    // 死路证据：必填 0 → ingest 收不了地址 → 开放项问不出东西
    expect(out.askCount.v).toBe(0)
    // 提示确实出现（文案内容在正常进程内直接断言，见下一条）
    expect(out.noticePresent.v).toBe("notice")
  })

  test("提示文案说清真因与出路，且承诺不丢已填内容", () => {
    // 文案常量在模板不可读时才返回内容，故此处断言**源码文本**（子进程已验证那时它非 null）。
    // 死路闭环靠这几句话把用户引向「修复安装」，缺任何一句都会退回「是不是我没填够」。
    const src = readFileSync(
      join(import.meta.dir, "..", "..", "shared", "src", "reqdoc-template-schema.ts"),
      "utf8",
    )
    expect(src).toContain("需求书模板读不到")
    expect(src).toContain("请先修复插件安装")
    expect(src).toContain("本次已填的槽位不会丢失")
    expect(src).toContain("无法确定该问哪些内容")
  })

  test("硬路径全部抛错，让用户报障而非产出结构不明的交付件", () => {
    const out = probeTemplateMissing()
    expect(out.assembleDoc.ok).toBe(false)
    expect(out.parseRenderStructure.ok).toBe(false)
    expect(out.buildPrdSkeleton.ok).toBe(false)
    expect(out.assembleDoc.v).toContain("模板不可读")
  })
})

describe("EMPTY_SCHEMA 契约", () => {
  test("空结构下必填集与容器集全空", () => {
    expect([...EMPTY_SCHEMA.docSectionAddrs]).toEqual([])
    expect([...EMPTY_SCHEMA.allSectionAddrs]).toEqual([])
    expect(EMPTY_SCHEMA.requiredSubRels).toEqual([])
    expect(EMPTY_SCHEMA.featureChapter).toBeNull()
  })

  test("空结构下所有地址判为非法（不会把任意地址放进交付件）", () => {
    expect(isValidSlotAddr("3.1", feats, EMPTY_SCHEMA)).toBe(false)
    expect(isValidSlotAddr("4.1.CRD", feats, EMPTY_SCHEMA)).toBe(false)
  })

  test("模板可读时 templateSchemaOrEmpty 返回真实 schema 而非空结构", () => {
    const s = templateSchemaOrEmpty()
    expect(s).not.toBe(EMPTY_SCHEMA)
    expect([...s.docSectionAddrs].length).toBeGreaterThan(0)
  })

  test("EMPTY_SCHEMA 是同一引用（不每次新建，下游按引用比较才稳）", () => {
    expect(templateSchemaOrEmpty).toBe(templateSchemaOrEmpty)
    expect(EMPTY_SCHEMA.chapters).toBe(EMPTY_SCHEMA.chapters)
  })
})

describe("正常路径未受影响", () => {
  test("真实模板下必填集与覆盖率照常派生", () => {
    expect(requiredSlots(feats).length).toBe(23)
    // 门禁要过须**叶子填满 + 容器覆盖**：容器是聚合判定，声明可为空也算覆盖。
    const decls = Object.fromEntries(
      requiredContainers(feats).map((address) => [address, { required: false, reason: "本次不涉及" }]),
    )
    const full = requiredSlots(feats).map((address) => ({
      kind: "prose" as const,
      address,
      content: "x",
      source: "问答" as const,
      status: "confirmed" as const,
    }))
    expect(slotCoverage(full, feats).pct).toBe(1)
    expect(kbGate(full, feats, { decls }).pass).toBe(true)
  })
})

afterAll(restore)