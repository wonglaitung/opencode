#!/usr/bin/env bun
/**
 * 规则遵循度评测(设计文档 §12):量化弱模型对注入规则文本的遵循度。
 * 改前跑 baseline(冻结快照)、改后跑 new(新注入格式),对比通过率。
 *
 * 用法:
 *   bun run scripts/eval-rules/run.ts --variant baseline|new [--repeat 3] [--dry]
 * 环境变量:
 *   EVAL_BASE_URL  OpenAI 兼容端点(默认 http://localhost:8000/v1)
 *   EVAL_API_KEY   可选
 *   EVAL_MODEL     评测模型(默认 qwen3.6-27b)
 * --dry:只打印各场景注入片段与判定期望,不调模型(验证渲染用)。
 * 输出:控制台 per-scenario 表 + 聚合通过率,落 scripts/eval-rules/results/{variant}.json
 */
import { EVAL_TOOLS } from "./src/tool-defs"
import { SCENARIOS } from "./src/scenarios"
import { judgeScenario } from "./src/judge"
import { chatComplete, modelId } from "./src/client"
import { renderBaseline } from "./src/render-baseline"
import { renderNew } from "./src/render-new"
import type { EvalReport, GroupSummary, ScenarioResult } from "./src/types"

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const variantRaw = argValue("--variant") ?? "new"
if (variantRaw !== "baseline" && variantRaw !== "new") {
  console.error(`未知 variant: ${variantRaw}(应为 baseline 或 new)`)
  process.exit(1)
}
const variant = variantRaw as "baseline" | "new"
const repeat = Math.max(1, Number(argValue("--repeat") ?? "1") || 1)
const dry = process.argv.includes("--dry")

async function renderSystem(state: Parameters<typeof renderNew>[0]): Promise<string> {
  return variant === "baseline" ? renderBaseline(state) : renderNew(state)
}

console.log(`评测模型: ${modelId()} | variant: ${variant} | repeat: ${repeat}${dry ? " | dry(不调模型)" : ""}\n`)

const results: ScenarioResult[] = []
for (const sc of SCENARIOS) {
  const system = await renderSystem(sc.state)

  if (dry) {
    console.log(`===== ${sc.name} (${sc.workflowType}) =====`)
    console.log("--- userTurn ---")
    console.log(sc.userTurn)
    console.log("--- system 注入片段 ---")
    console.log(system)
    console.log("--- 判定期望 ---")
    console.log(JSON.stringify(sc.judge, null, 2))
    console.log()
    continue
  }

  let pass = 0
  let lastDetail = ""
  for (let i = 0; i < repeat; i++) {
    const out = await chatComplete(system, sc.userTurn, EVAL_TOOLS)
    const r = judgeScenario(sc.judge, out)
    if (r.pass) pass++
    lastDetail = r.detail
    if (!r.pass) console.log(`   └ 第 ${i + 1} 次: ${r.detail}`)
  }
  const allPass = pass === repeat
  const detail = allPass ? lastDetail : `通过 ${pass}/${repeat}${lastDetail ? `;末次:${lastDetail}` : ""}`
  results.push({ name: sc.name, workflowType: sc.workflowType, pass: allPass, detail })
  console.log(`${allPass ? "✅" : "❌"} ${sc.name.padEnd(18)} ${sc.workflowType.padEnd(5)} ${pass}/${repeat}  ${detail}`)
}

if (dry) {
  console.log(`dry 模式共 ${SCENARIOS.length} 个场景,已打印注入片段,未调模型。`)
  process.exit(0)
}

function group(items: ScenarioResult[]): GroupSummary {
  const pass = items.filter((r) => r.pass).length
  return { pass, total: items.length, rate: Math.round((pass / items.length) * 100) }
}
const sdlc = group(results.filter((r) => r.workflowType === "sdlc"))
const reqdoc = group(results.filter((r) => r.workflowType === "reqdoc"))
const overall = group(results)

console.log(
  `\n=== 聚合 ===\n` +
    `整体   ${overall.pass}/${overall.total} (${overall.rate}%)\n` +
    `sdlc   ${sdlc.pass}/${sdlc.total} (${sdlc.rate}%)\n` +
    `reqdoc ${reqdoc.pass}/${reqdoc.total} (${reqdoc.rate}%)`,
)

const report: EvalReport = {
  variant,
  model: modelId(),
  dry,
  runAt: new Date().toISOString(),
  results,
  summary: { overall, sdlc, reqdoc },
}
await Bun.write(`scripts/eval-rules/results/${variant}.json`, JSON.stringify(report, null, 2))

if (variant === "new") {
  const baseline = await Bun.file("scripts/eval-rules/results/baseline.json").exists().catch(() => false)
  if (baseline) {
    const prev: EvalReport = JSON.parse(await Bun.file("scripts/eval-rules/results/baseline.json").text())
    console.log(
      `\n=== 对比(baseline → new) ===\n` +
        `整体   ${prev.summary.overall.rate}% → ${overall.rate}%\n` +
        `sdlc   ${prev.summary.sdlc.rate}% → ${sdlc.rate}%\n` +
        `reqdoc ${prev.summary.reqdoc.rate}% → ${reqdoc.rate}%`,
    )
  }
}
