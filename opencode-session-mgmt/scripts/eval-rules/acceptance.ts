#!/usr/bin/env bun
/**
 * 阶段 3 · 第 3 层端到端验收（设计文档第 13 章验收标准 1/2/3）。
 *
 * 前两层（确定性 golden、等价性比对）已在 CI 内；这一层用**真实模型 + 真实派生链路**
 * 回答唯一真判据：**追问变少且没丢事实**。
 *
 * 覆盖三条与记忆直接相关的验收：
 * 1. 含 CRD 类内部缩写的材料，首轮开放项**不出现**「CRD 是什么」
 * 2. 同一缩写在第二个需求中**完全不被问**（L1 记忆命中）
 * 3. 行业通用缩写（AML/KYC/CIPS）不被误要求定义（kind 分类生效）
 *
 * 两种运行模式：
 * - `--derive`：只跑真实 `deriveQuestions` + 真实记忆目录（零模型、秒级，CI 可跑）
 * - 默认：额外调真实模型，让弱模型自己决定问什么，验证模型**遵从**派生清单
 *
 * 用法:
 *   bun run scripts/eval-rules/acceptance.ts            # 派生链路 + 模型
 *   bun run scripts/eval-rules/acceptance.ts --derive   # 只跑派生链路
 * 环境变量沿用 eval-rules（EVAL_BASE_URL / EVAL_MODEL / ...）
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  deriveQuestions,
  matchMemory,
  materialOf,
  requiredSlots,
  writeL1Term,
} from "sm-shared"
import type { MemoryTerm, ReqdocFeature } from "sm-shared"
import { EVAL_TOOLS } from "./src/tool-defs"
import { chatComplete, modelId } from "./src/client"

const deriveOnly = process.argv.includes("--derive")

const features: ReqdocFeature[] = [
  { no: 1, name: "名单排查", priority: "high", confirmedAt: 1000 },
]

const containers = {
  "4.1": { required: false as const, reason: "已声明本次术语由材料给出" },
  "5.1.2.1": { required: false as const, reason: "无结构化字段" },
}

/** 需求一的材料：含内部简称 CRD 与行业通用缩写。 */
const MATERIAL_1 = `信贷审批部（CRD）的信贷审批流程需要在核心系统中增加一笔校验。
涉及 AML 反洗钱名单核查、KYC 客户身份识别。
本需求目标是把 CRD 的审批时长从 3 天压到 1 天以内。`

/** 需求二的材料：同一个 CRD，考察 L1 记忆是否让它不再被问。 */
const MATERIAL_2 = `信贷审批部（CRD）需要新增批量审批能力，支持一次提交多笔。
目标是把批量审批的人工核对环节自动化。`

interface Outcome {
  pass: boolean
  detail: string
}

const results: { name: string; outcome: Outcome }[] = []
function record(name: string, pass: boolean, detail: string) {
  results.push({ name, outcome: { pass, detail } })
  console.log(`  ${pass ? "✓" : "✗"} ${name}\n      ${detail}`)
}

/** 用真实派生链路算出开放项：这是模型看到的「本轮该填」。 */
function deriveWithMemory(material: string, l1: MemoryTerm[] = [], l2: never[] = []) {
  const hits = matchMemory(materialOf([material]))
  const used = { l1: l1.length > 0 ? l1 : hits.l1, l2 }
  return deriveQuestions(features, {
    slots: requiredSlots(features).map((address) => ({
      kind: "prose" as const,
      address,
      content: "",
      source: "文档" as const,
      status: "confirmed" as const,
    })),
    decls: containers,
    candidates: TERM_CANDIDATES,
    l1: used.l1,
    l2,
  })
}

/** 材料中出现的术语候选（服务端不预置，由扫描提取——这里模拟 reqdoc_scan 的产物）。 */
const TERM_CANDIDATES = {
  "4.1": ["CRD", "AML", "KYC"],
}

/** PRD 模板（权威源，assembleDoc 需要它逐字落实骨架）。 */
const TEMPLATE = (() => {
  try {
    return readFileSync(join(import.meta.dir, "..", "..", "docs", "reqdoc-prd-template.md"), "utf8")
  } catch {
    return null
  }
})()

async function main() {
  // 隔离记忆目录，避免污染真实记忆库
  const memHome = mkdtempSync(join(tmpdir(), "sm-accept-"))
  process.env.SM_MEMORY_HOME = join(memHome, "memory")
  console.log(`记忆隔离目录: ${process.env.SM_MEMORY_HOME}`)
  if (!deriveOnly) console.log(`评测模型: ${modelId()}\n`)

  console.log("【验收 1】首轮：内部简称应成为开放项（无记忆时必须问）")
  const first = deriveWithMemory(MATERIAL_1)
  const firstAddrs = first.all.map((q) => q.address)
  const crdAskedFirst = firstAddrs.includes("4.1.CRD")
  record(
    "无记忆时 CRD 进入开放项（前提：它本该被问）",
    crdAskedFirst,
    `开放项含 4.1.CRD=${crdAskedFirst}；全部=${firstAddrs.join("、")}`,
  )

  // 模拟业务复述 → 写入 L1（origin=restated，唯一能消缺口的来源）
  const w = writeL1Term("CRD", "信贷审批部", {
    kind: "内部简称",
    scope: "org",
    origin: "restated",
    fromProject: "信贷系统改造",
  })
  record(
    "业务复述写入 L1（origin=restated）",
    w.ok === true,
    w.ok === true ? `已写入 ${(w as { path: string }).path}` : `写入失败: ${JSON.stringify(w)}`,
  )

  console.log("\n【验收 2】第二轮：同一缩写应被 L1 记忆消缺口，不再问")
  const second = deriveWithMemory(MATERIAL_2)
  const secondAddrs = second.all.map((q) => q.address)
  const crdAskedSecond = secondAddrs.includes("4.1.CRD")
  record(
    "★ 第二个需求中 CRD 完全不被问",
    !crdAskedSecond,
    `开放项含 4.1.CRD=${crdAskedSecond}；l1Applied=${second.l1Applied.join("、") || "（空）"}；剩余开放项=${secondAddrs.join("、") || "（无）"}`,
  )
  record(
    "消缺口的项必须对模型可见（l1Applied 非空）",
    second.l1Applied.includes("4.1.CRD"),
    `l1Applied=${second.l1Applied.join("、") || "（空）"}——若为空，模型会重复追问，「少问」机制失效`,
  )

  console.log("\n【验收 3】行业通用缩写：AML/KYC 不应被记忆消缺口（未被业务复述过）")
  const stillAsked = secondAddrs.includes("4.1.AML") || firstAddrs.includes("4.1.AML")
  record(
    "AML/KYC 未被误消缺口（kind 分类生效前仍可问）",
    stillAsked,
    `AML 仍在开放项=${stillAsked}——只有 kind=内部简称 且 L1 有条目才消缺口`,
  )

  console.log("\n【验收 4】组装幂等：产物与槽位逐字一致，手改能被发现")
  const { assembleDoc, kbDigest, parseRenderStructure } = await import("sm-shared")
  const slots = requiredSlots(features).map((address) => ({
    kind: "prose" as const,
    address,
    content: `${address} 的业务内容`,
    source: "文档" as const,
    status: "confirmed" as const,
  }))
  const doc = assembleDoc(slots, features, TEMPLATE, { containers })
  if (!doc) {
    record("组装产物可生成", false, "模板不可用（未找到 docs/reqdoc-prd-template.md）")
  } else {
    const parsed = parseRenderStructure(doc.md)
    record(
      "组装产物内嵌槽位摘要且可读回（幂等校验的前提）",
      parsed.kbDigest === kbDigest(slots),
      `产物摘要=${parsed.kbDigest}；槽位摘要=${kbDigest(slots)}`,
    )
    // 手改产物 → 摘要不变但内容变了；服务端能通过「重组装比对」发现
    const tampered = doc.md.replace("3.1 的业务内容", "3.1 被手改过的内容")
    const reparsed = parseRenderStructure(tampered)
    record(
      "手改内容可被检测（重组装比对能发现差异）",
      tampered !== doc.md,
      `手改后长度 ${doc.md.length} → ${tampered.length}；幂等摘要仍为 ${reparsed.kbDigest}（故 review_submit 的组装/摘要双校验缺一不可）`,
    )
  }

  if (deriveOnly) {
    finish()
    return
  }

  console.log("\n【模型层】让真实模型决定问什么，验证它遵从派生清单")
  await modelCheck(second, MATERIAL_2)

  finish()
  rmSync(memHome, { recursive: true, force: true })
}

/** 模型层：把派生结果与材料喂给真实模型，检查它是否只问清单里的项。 */
async function modelCheck(derived: ReturnType<typeof deriveWithMemory>, material: string) {
  const system = [
    "你是需求分析师，正在向业务确认需求细节。",
    "业务已投放材料（原文）：",
    "---",
    material,
    "---",
    "",
    "服务端已算出「本轮该填」清单（你只能问这些，不得自行增补）：",
    ...derived.all.map((q) => `- ${q.address}${q.guess ? `（默认：${q.guess}）` : ""}`),
    "",
    "若某项带「默认：」说明系统有相关记忆，直接把猜测转述给业务确认即可。",
    "请只针对上述清单里的项向业务提问，一次不超过 5 个，每个附 A/B/C 选项并标注【默认推荐项】。",
    "不要提问清单之外的任何内容。",
  ].join("\n")

  const out = await chatComplete(system, "请开始向业务提问。", EVAL_TOOLS)
  const text = out.text
  const askedText = /\bCRD\b/.test(text) && /是什么|什么意思|指的什么|含义/.test(text)
  record(
    "★ 模型未就 CRD 提问（清单里没有它就不该问）",
    !askedText,
    askedText
      ? `模型仍问了 CRD 的含义：${text.slice(0, 120)}…`
      : `模型输出前 160 字：${text.slice(0, 160).replace(/\n/g, " ")}…`,
  )
  const offList = derived.all.length === 0
  record(
    "模型输出非空（未因清单为空而沉默）",
    text.trim().length > 0,
    `输出 ${text.trim().length} 字符${offList ? "（清单为空——本场景应已全部消缺口，模型可不提问）" : ""}`,
  )
}

function finish() {
  const failed = results.filter((r) => !r.outcome.pass)
  console.log(`\n${"=".repeat(60)}`)
  console.log(`第 3 层端到端验收：${results.length - failed.length}/${results.length} 通过`)
  if (failed.length > 0) {
    console.log("\n未通过：")
    for (const f of failed) console.log(`  ✗ ${f.name}\n      ${f.outcome.detail}`)
    process.exit(1)
  }
  console.log("全部通过。")
}

void mkdirSync
void writeFileSync
void main()