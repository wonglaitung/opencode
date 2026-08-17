#!/usr/bin/env bun
/**
 * 规则遵循度评测(设计文档 session-management.md 13.1):量化弱模型对注入规则文本的遵循度。
 * 改前跑 baseline(冻结快照)、改后跑 new(新注入格式),对比通过率。
 *
 * 用法:
 *   bun run scripts/eval-rules/run.ts --variant baseline|new [--repeat 3] [--dry]
 * 环境变量:
 *   EVAL_BASE_URL  OpenAI 兼容端点(默认 http://localhost:8086/v1,本地 vLLM)
 *   EVAL_API_KEY   可选
 *   EVAL_MODEL     评测模型(默认 /models/qwen3,本地 vLLM 的模型 id)
 *   EVAL_MAX_TOKENS 输出上限(默认 2048;推理模型如 deepseek-*-flash 显式 4096 留 thinking 空间)
 *   EVAL_TIMEOUT_MS  单请求超时(默认 180000)
 * --dry:只打印各场景注入片段与判定期望,不调模型(验证渲染用)。
 * 输出:控制台 per-scenario 表 + 聚合通过率,落 scripts/eval-rules/results/{variant}.json
 */
import { EVAL_TOOLS } from "./src/tool-defs"
import { SCENARIOS } from "./src/scenarios"
import { judgeScenario } from "./src/judge"
import { chatComplete, modelId } from "./src/client"
import { renderBaseline } from "./src/render-baseline"
import { renderNew } from "./src/render-new"
import { REQDOC_SCORE_DIMS, type ReqdocScoreDimKey } from "sm-shared"
import type { PrdScore } from "./src/score"
import type { EvalReport, GroupSummary, ScenarioResult, ScoreDimAvg, ScoreSummary } from "./src/types"

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
const workflowRaw = argValue("--workflow")
const workflow = workflowRaw === "sdlc" || workflowRaw === "reqdoc" ? workflowRaw : undefined

async function renderSystem(state: Parameters<typeof renderNew>[0]): Promise<string> {
  return variant === "baseline" ? renderBaseline(state) : renderNew(state)
}

console.log(`评测模型: ${modelId()} | variant: ${variant} | repeat: ${repeat}${dry ? " | dry(不调模型)" : ""}\n`)

const scenarios = workflow ? SCENARIOS.filter((s) => s.workflowType === workflow) : SCENARIOS
const results: ScenarioResult[] = []
for (const sc of scenarios) {
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
  // 评分场景（质量飞轮 P0，judge.kind==="score"）：累计各运行的五维实得分，汇总成该场景平均分
  const isScore = sc.judge.kind === "score"
  let scoreRuns = 0
  let scoreTotal = 0
  const scoreDims: Partial<Record<ReqdocScoreDimKey, number>> = {}
  const scores: PrdScore[] = []
  for (let i = 0; i < repeat; i++) {
    const out = await chatComplete(system, sc.userTurn, EVAL_TOOLS)
    const r = judgeScenario(sc.judge, out)
    if (r.pass) pass++
    lastDetail = r.detail
    if (r.score) {
      scores.push(r.score)
      scoreRuns++
      scoreTotal += r.score.total
      for (const d of REQDOC_SCORE_DIMS) {
        scoreDims[d.key] = (scoreDims[d.key] ?? 0) + r.score.dims[d.key].score
      }
    }
    if (!r.pass) console.log(`   └ 第 ${i + 1} 次: ${r.detail}`)
  }
  const allPass = pass === repeat
  const detail = allPass ? lastDetail : `通过 ${pass}/${repeat}${lastDetail ? `;末次:${lastDetail}` : ""}`
  const result: ScenarioResult = {
    name: sc.name,
    workflowType: sc.workflowType,
    pass: allPass,
    passCount: pass,
    runCount: repeat,
    detail,
  }
  if (isScore && scoreRuns > 0) {
    const dims = {} as Record<ReqdocScoreDimKey, number>
    const maxDims = {} as Record<ReqdocScoreDimKey, number>
    for (const d of REQDOC_SCORE_DIMS) {
      dims[d.key] = Math.round(((scoreDims[d.key] ?? 0) / scoreRuns) * 10) / 10
      maxDims[d.key] = d.max
    }
    result.scoreAvg = { total: Math.round((scoreTotal / scoreRuns) * 10) / 10, dims, maxDims }
    result.scores = scores
  }
  results.push(result)
  console.log(`${allPass ? "✅" : "❌"} ${sc.name.padEnd(18)} ${sc.workflowType.padEnd(5)} ${pass}/${repeat}  ${detail}`)
}

if (dry) {
  console.log(`dry 模式共 ${scenarios.length} 个场景,已打印注入片段,未调模型。`)
  process.exit(0)
}

function group(items: ScenarioResult[]): GroupSummary {
  // 按运行次数统计通过率（repeat>1 时防单次抖动掩盖趋势；pass 为通过运行数，非场景数）
  const pass = items.reduce((sum, r) => sum + r.passCount, 0)
  const total = items.reduce((sum, r) => sum + r.runCount, 0)
  return { pass, total, rate: total === 0 ? 0 : Math.round((pass / total) * 100) }
}
const sdlc = group(results.filter((r) => r.workflowType === "sdlc"))
const reqdoc = group(results.filter((r) => r.workflowType === "reqdoc"))
const overall = group(results)

/** 评分场景聚合：跨评分场景按「每场景多运行平均」求五维平均分（质量飞轮 P0 产出度量）。 */
function scoreSummary(items: ScenarioResult[]): ScoreSummary | undefined {
  const scored = items.filter((r) => r.scoreAvg)
  if (scored.length === 0) return undefined
  const dims: ScoreDimAvg[] = REQDOC_SCORE_DIMS.map((d) => {
    const avg = scored.reduce((sum, r) => sum + (r.scoreAvg?.dims[d.key] ?? 0), 0) / scored.length
    return {
      key: d.key,
      label: d.label,
      max: d.max,
      avg: Math.round(avg * 10) / 10,
      rate: d.max ? Math.round((avg / d.max) * 100) : 0,
    }
  })
  return {
    scenarios: scored.map((r) => r.name),
    totalAvg: Math.round(dims.reduce((a, d) => a + d.avg, 0) * 10) / 10,
    dims,
  }
}

const score = scoreSummary(results)

console.log(
  `\n=== 聚合 ===\n` +
    `整体   ${overall.pass}/${overall.total} (${overall.rate}%)\n` +
    `sdlc   ${sdlc.pass}/${sdlc.total} (${sdlc.rate}%)\n` +
    `reqdoc ${reqdoc.pass}/${reqdoc.total} (${reqdoc.rate}%)` +
    (score ? `\nPRD 评分 ${score.totalAvg}/100（平均，${score.scenarios.length} 个评分场景）` : ""),
)

const report: EvalReport = {
  variant,
  model: modelId(),
  dry,
  runAt: new Date().toISOString(),
  results,
  summary: score ? { overall, sdlc, reqdoc, score } : { overall, sdlc, reqdoc },
}
await Bun.write(`scripts/eval-rules/results/${variant}.json`, JSON.stringify(report, null, 2))

if (variant === "new") {
  const baseline = await Bun.file("scripts/eval-rules/results/baseline.json").exists().catch(() => false)
  if (baseline) {
    const prev: EvalReport = JSON.parse(await Bun.file("scripts/eval-rules/results/baseline.json").text())
    const lines = [
      `整体   ${prev.summary.overall.rate}% → ${overall.rate}%`,
    ]
    if (prev.summary.sdlc.total > 0) lines.push(`sdlc   ${prev.summary.sdlc.rate}% → ${sdlc.rate}%`)
    if (prev.summary.reqdoc.total > 0) lines.push(`reqdoc ${prev.summary.reqdoc.rate}% → ${reqdoc.rate}%`)
    // 质量飞轮 P0：baseline→new 的 PRD 渲染产出逐维对比（打分卡五维平均分）
    if (prev.summary.score && report.summary.score) {
      lines.push("", "PRD 评分对比（baseline → new，五维平均分）:")
      for (const d of REQDOC_SCORE_DIMS) {
        const b = prev.summary.score.dims.find((x) => x.key === d.key)
        const n = report.summary.score.dims.find((x) => x.key === d.key)
        if (!b || !n) continue
        const delta = n.avg - b.avg
        lines.push(`  ${d.label} ${b.avg} → ${n.avg}（${delta >= 0 ? "+" : ""}${delta.toFixed(1)}）`)
      }
      const bt = prev.summary.score.totalAvg
      const nt = report.summary.score.totalAvg
      lines.push(`  总分      ${bt} → ${nt}（${nt - bt >= 0 ? "+" : ""}${(nt - bt).toFixed(1)}）`)
    }
    console.log(`\n=== 对比(baseline → new) ===\n${lines.join("\n")}`)
  }
}
