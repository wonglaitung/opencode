#!/usr/bin/env bun
/**
 * 规则遵循度评测(设计文档 session-management.md 13.1):量化弱模型对注入规则文本的遵循度。
 * 改前跑 baseline(冻结快照)、改后跑 new(新注入格式),对比通过率。
 *
 * 用法:
 *   bun run scripts/eval-rules/run.ts --variant baseline|new [--repeat 3] [--dry] [--workflow sdlc|reqdoc] [--name 场景名子串] [--fail-on-regression]
 *   --fail-on-regression：仅 new 且库内已有 baseline.json 时生效；整体通过率回退或任一打分卡八维分数
 *     回退则 exit(1)（合入门槛，见 session-management.md 13.x）。CI 用 `bun run eval:ci` 触发。
 * 环境变量:
 *   EVAL_BASE_URL  OpenAI 兼容端点(默认 http://localhost:8086/v1,本地 vLLM)
 *   EVAL_API_KEY   可选
 *   EVAL_MODEL     评测模型(默认 /models/qwen3,本地 vLLM 的模型 id)
 *   EVAL_MAX_TOKENS 输出上限(默认 2048;推理模型如 deepseek-*-flash 显式 4096 留 thinking 空间,长 reasoning 模型如 deepseek-v4-pro-0813 须 16384)
 *   EVAL_TIMEOUT_MS  单请求超时(默认 180000;16k token 长输出渲染场景须提至 300000)
 * --dry:只打印各场景注入片段与判定期望,不调模型(验证渲染用)。
 * 输出:控制台 per-scenario 表 + 聚合通过率,落 scripts/eval-rules/results/{variant}.json
 */
import { existsSync } from "node:fs"
import { EVAL_TOOLS } from "./src/tool-defs"
import { judgeSelfCheck } from "./src/judge-selfcheck"
import { formatOptionQuality, parseOptionSets, reportDefaultLoad } from "./src/option-quality"
import { optionQualitySelfCheck } from "./src/option-quality.selfcheck"
import { executeTurns } from "./src/executor"
import { execSelfCheck } from "./src/exec-selfcheck"
import { SCENARIOS } from "./src/scenarios"
import { judgeScenario } from "./src/judge"
import { chatComplete, modelId } from "./src/client"
import { renderBaseline } from "./src/render-baseline"
import { renderNew } from "./src/render-new"
import { REQDOC_SCORE_DIMS, type ReqdocScoreDimKey } from "sm-shared"
import type { PrdScore } from "./src/score"
import type { EvalReport, GroupSummary, ModelOutput, ScenarioResult, ScoreDimAvg, ScoreSummary } from "./src/types"

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
/**
 * 执行真实工具（`EVAL_EXECUTE=1`）。渲染/五维分判据成立的前提：模型的动作真的过了
 * 服务端校验，产物真的落盘。关掉时只看模型正文与工具名——那套口径在第十轮被判定为
 * 「奖励手写产物」，故 render/score 判据在无产物时一律判不通过。
 */
const EXECUTE = process.env.EVAL_EXECUTE === "1"
const workflowRaw = argValue("--workflow")
const workflow = workflowRaw === "sdlc" || workflowRaw === "reqdoc" ? workflowRaw : undefined

async function renderSystem(state: Parameters<typeof renderNew>[0], lockedFiles: readonly string[] = []): Promise<string> {
  return variant === "baseline" ? renderBaseline(state, lockedFiles) : renderNew(state, lockedFiles)
}

console.log(`评测模型: ${modelId()} | variant: ${variant} | repeat: ${repeat}${dry ? " | dry(不调模型)" : ""}\n`)

// **冻结参照保护**：baseline.json 是入库的对照快照（SKILL.md 明确「不要重跑 baseline
// 覆盖参照，否则对比失效」）。此前只防住了子集跑覆写（子集会落带后缀的独立文件名），
// **全量跑 baseline 仍会直接覆写它**——我这次就踩了：想跑全量对照，顺手
// `--variant baseline` 没加 `--workflow`，冻结参照被覆盖，只能从 git 恢复。
// 故：全量 baseline 默认拒绝写入，须显式 `EVAL_ALLOW_BASELINE_OVERWRITE=1`。
if (variant === "baseline" && !workflow && !dry && process.env.EVAL_ALLOW_BASELINE_OVERWRITE !== "1") {
  console.error(
    "❌ 拒绝覆写冻结参照 baseline.json。\n" +
      "   它是入库的对照快照，重跑会让历史对比全部失效（SKILL.md 有此纪律）。\n" +
      "   · 只想做同口径对照 → 加 --workflow reqdoc|sdlc，落独立文件（baseline.reqdoc.json 等）\n" +
      "   · 确实要重冻结基线 → 显式 EVAL_ALLOW_BASELINE_OVERWRITE=1，并 git add -f 入库",
  )
  process.exit(1)
}

// 判据自检先行：路径写错会让「禁止存在」类断言恒通过，产出一份全绿但无意义的报告
const broken = judgeSelfCheck()
if (broken.length > 0) {
  console.error(`❌ 判定器自检失败（${broken.length} 项）：\n${broken.map((b) => `  - ${b}`).join("\n")}`)
  process.exit(1)
}

// 选项质量解析器自检：探针在合成样例上绿 ≠ 在真实输出上对（第一版就栽在这——
// 要求问号在行尾，而真实输出行尾是被加粗的 **，真实场景里一个问句都解析不出）
const oqBroken = optionQualitySelfCheck()
if (oqBroken.length > 0) {
  console.error(`❌ 选项质量解析器自检失败（${oqBroken.length} 项）：\n${oqBroken.map((b) => `  - ${b}`).join("\n")}`)
  process.exit(1)
}

// 执行链路自检（不调模型）：渲染/五维分判据接的是 reqdoc_assemble 的真实产物，
// 链路坏掉时症状是「渲染场景一律判未产出组装件」——那时该怀疑执行器，不是模型
if (EXECUTE) {
  const execFails = await execSelfCheck()
  if (execFails.length > 0) {
    console.error(`❌ 执行链路自检失败（${execFails.length} 项）：\n${execFails.map((b) => `  - ${b}`).join("\n")}`)
    process.exit(1)
  }
}

const nameFilter = argValue("--name")
const scenarios = (workflow ? SCENARIOS.filter((s) => s.workflowType === workflow) : SCENARIOS).filter((s) =>
  nameFilter ? s.name.includes(nameFilter) : true,
)
const results: ScenarioResult[] = []
// 每场景最后一次运行的正文，供报告末尾的选项质量聚合复查（optionQuality 里只有汇总行）
const textsByScenario = new Map<string, string>()
for (const sc of scenarios) {
  const system = await renderSystem(sc.state, sc.lockedFiles)

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
  // 每场景**累计**各轮正文，不只留最后一次：观测要的是问句总体，而 `--repeat N` 下
  // 只留最后一轮等于白丢 (N-1)/N 的样本（实测 r27 三次兜底 3/5/4，单看某一次会
  // 把真实水平看成 1/5）。判据仍用最后一次（单次判更稳），观测用累计。
  const textChunks: string[] = []
  // 动作预算超支取**最后一次**运行的结果（与 lastDetail 同口径）
  let lastChurn: { tool: string; calls: number }[] | undefined
  // 渲染/评分场景（质量飞轮 A4 归因）：留各次运行的模型输出原文——只看判定 detail 无法区分
  // 「纯文本渲染」「错层级标题」「tool_call 占位」，须落原文才能归因（本机留痕，汇报不上行）
  const outputs: string[] = []
  // 评分场景（质量飞轮 P0，judge.kind==="score"）：累计各运行的八维实得分，汇总成该场景平均分
  const isScore = sc.judge.kind === "score"
  const captureOutput = sc.judge.kind === "render" || sc.judge.kind === "score"
  let scoreRuns = 0
  let scoreTotal = 0
  const scoreDims: Partial<Record<ReqdocScoreDimKey, number>> = {}
  const scores: PrdScore[] = []
  for (let i = 0; i < repeat; i++) {
    let out: ModelOutput
    try {
      if (!EXECUTE) {
        out = await chatComplete(system, sc.userTurn, EVAL_TOOLS)
      } else {
        // 多轮：模型出调用 → 真实工具跑 → 结果回灌 → 续跑，直至无调用或达轮数上限
        const turn = await chatComplete(
          system,
          sc.userTurn,
          EVAL_TOOLS,
        ).then((first) =>
          executeTurns(
            sc.state,
            async (prior) => (prior.length === 0 ? first : chatComplete(system, sc.userTurn, EVAL_TOOLS, prior)),
            { lockedFiles: sc.lockedFiles },
          ),
        )
        // 判据看全部轮次（见 executor 的 allCalls 注释：只看最后一轮会把「已完成」判成未调用）
        out = {
          text: turn.allTexts.join("\n"),
          lastTurnText: turn.allTexts.at(-1),
          toolCalls: turn.allCalls,
          artifact: turn.artifact,
          toolResults: turn.toolResults,
          churn: turn.churn,
        }
      }
    } catch (err) {
      // 单次请求彻底失败（重试耗尽）不中断整轮评测：记为失败并继续下一场景
      console.error(`   └ 第 ${i + 1} 次请求失败(重试耗尽):${err instanceof Error ? err.message.slice(0, 120) : String(err)}`)
      lastDetail = `请求失败:${err instanceof Error ? err.message.slice(0, 120) : String(err)}`
      continue
    }
    lastChurn = out.churn
    if (out.text.trim() !== "") textChunks.push(out.text)
    const lastText = textChunks.at(-1) ?? ""
    if (captureOutput) outputs.push(out.artifact ?? out.text)
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
  // 单轮动作预算超支要显式喊出来：否则「该场景失败」看不出是模型卡住还是判据要求了
  // 单轮做不到的事——两者在报告里长得一样（6.4 第 5 条）。
  const churnNote = lastChurn?.length
    ? `；⚠动作预算超支 ${lastChurn.map((c) => `${c.tool}×${c.calls}`).join("、")}（该场景结论不可信，先查判据是否要求单轮做不到的事）`
    : ""
  const detail = (allPass ? lastDetail : `通过 ${pass}/${repeat}${lastDetail ? `;末次:${lastDetail}` : ""}`) + churnNote
  const result: ScenarioResult = {
    name: sc.name,
    workflowType: sc.workflowType,
    pass: allPass,
    // 选项质量：**只观测**。不进通过率、不改判据——先拿基线数据，
    // 再决定要不要改提示词或加约束（语义质量服务端判不了，贸然设门禁会重演
    // 「判据与规则反向」那类问题，本次已栽过四次）。
    ...(textChunks.length > 0
      ? { optionQuality: formatOptionQuality(parseOptionSets(textChunks.join("\n"))) }
      : {}),
    // 默认推荐限流（阶段 3）：只报「这一轮还带不带默认推荐」这一个机械事实。
    // 带 = r27 的转开放式没生效；不带 = 生效了。**不判对错**——「该不该转」有语义成分。
    ...(textChunks.length > 0
      ? (() => {
          const dl = reportDefaultLoad(textChunks.join("\n"))
          return {
            defaultLoad: `默认推荐限流（观察项·仅最后一轮）：${dl.hasDefault ? "仍带" : "未带"}默认推荐${
              dl.markers.length ? `（命中 ${dl.markers.join("、")}）` : ""
            }`,
          }
        })()
      : {}),
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
  if (outputs.length > 0) result.outputs = outputs
  textsByScenario.set(sc.name, textChunks.join("\n"))
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

/** 评分场景聚合：跨评分场景按「每场景多运行平均」求八维平均分（质量飞轮 P0 产出度量）。 */
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

// 选项质量聚合（阶段 1）：把散在 per-scenario 的观测汇总成一行，便于跨场景看基线。
// 只统计「解析出问句」的场景——纯工具调用的场景没有选项可言，计入只会稀释分母。
const oqTotals = { scenarios: 0, questions: 0, optionCountOk: 0, withFallback: 0, withDuplicate: 0 }
for (const r of results) {
  if (!r.optionQuality || r.optionQuality.includes("未解析出问句")) continue
  oqTotals.scenarios++
  const q = parseOptionSets(textsByScenario.get(r.name) ?? "")
  oqTotals.questions += q.questions
  oqTotals.optionCountOk += q.optionCountOk
  oqTotals.withFallback += q.withFallback
  oqTotals.withDuplicate += q.withDuplicate
}
if (oqTotals.scenarios > 0) {
  const pct = (n: number): string => `${Math.round((n / Math.max(1, oqTotals.questions)) * 100)}%`
  console.log(
    `\n选项质量（观察项，不计通过率）：${oqTotals.scenarios} 个场景 / ${oqTotals.questions} 个问句｜` +
      `选项数 3~4 ${pct(oqTotals.optionCountOk)}｜带兜底出口 ${pct(oqTotals.withFallback)}｜` +
      `有机械重复 ${pct(oqTotals.withDuplicate)}`,
  )
}

const report: EvalReport = {
  variant,
  model: modelId(),
  dry,
  runAt: new Date().toISOString(),
  /** 本次是否只跑了子集（--name/--workflow 会收窄场景集）——子集结果不可与全量对比 */
  partial: scenarios.length < SCENARIOS.length ? { ran: scenarios.length, total: SCENARIOS.length, name: nameFilter, workflow } : undefined,
  results,
  summary: score ? { overall, sdlc, reqdoc, score } : { overall, sdlc, reqdoc },
}
// 子集运行写独立文件：否则「单独跑一个场景复现」会把上一轮全量结果截断且无任何提示
// 文件名只拼真实存在的过滤条件（无 workflow 过滤就不写 "all"，避免歧义）
const suffix = report.partial ? `.${[workflow, nameFilter].filter(Boolean).join("-")}` : ""
const outFile = `scripts/eval-rules/results/${variant}${suffix}.json`
await Bun.write(outFile, JSON.stringify(report, null, 2))
console.log(`\n结果已写入 ${outFile}${report.partial ? `（子集运行 ${report.partial.ran}/${report.partial.total}，不覆盖全量结果）` : ""}`)

if (variant === "new") {
  // 口径对齐：部分运行优先对比同过滤条件的 baseline；否则会拿「跑 1 个场景」与
  // 「baseline 全量」算通过率，得出 reqdoc 75% → 0% 这类毫无意义的数字。
  const basePath = suffix
    ? [`scripts/eval-rules/results/baseline${suffix}.json`, "scripts/eval-rules/results/baseline.json"].find((f) =>
        existsSync(f),
      )
    : "scripts/eval-rules/results/baseline.json"
  if (basePath) {
    const prev: EvalReport = JSON.parse(await Bun.file(basePath).text())
    // 口径错位时不打 delta——「跑 1 个场景 0%」与「全量 75%」并排只会误导，即使附警告也照样被误读
    const scopeMismatch = Boolean(report.partial) && !basePath.includes(suffix)
    const lines = scopeMismatch
      ? [
          `⚠ 子集运行（${report.partial?.ran}/${report.partial?.total} 场景），无同口径 baseline，本次只报绝对值：`,
          `  本次 reqdoc ${reqdoc.rate}%（${reqdoc.pass}/${reqdoc.total}）`,
          `  参照 baseline.json（全量）reqdoc ${prev.summary.reqdoc.rate}%（${prev.summary.reqdoc.pass}/${prev.summary.reqdoc.total}）`,
        ]
      : [
          `整体   ${prev.summary.overall.rate}% → ${overall.rate}%`,
          ...(prev.summary.sdlc.total > 0 ? [`sdlc   ${prev.summary.sdlc.rate}% → ${sdlc.rate}%`] : []),
          ...(prev.summary.reqdoc.total > 0 ? [`reqdoc ${prev.summary.reqdoc.rate}% → ${reqdoc.rate}%`] : []),
        ]
    // 质量飞轮 P0：baseline→new 的 PRD 渲染产出逐维对比（打分卡八维平均分）
    let scoreRegressed = false
    if (prev.summary.score && report.summary.score) {
      lines.push("", "PRD 评分对比（baseline → new，八维平均分）:")
      for (const d of REQDOC_SCORE_DIMS) {
        const b = prev.summary.score.dims.find((x) => x.key === d.key)
        const n = report.summary.score.dims.find((x) => x.key === d.key)
        if (!b || !n) continue
        const delta = n.avg - b.avg
        if (delta < 0) scoreRegressed = true
        lines.push(`  ${d.label} ${b.avg} → ${n.avg}（${delta >= 0 ? "+" : ""}${delta.toFixed(1)}）`)
      }
      const bt = prev.summary.score.totalAvg
      const nt = report.summary.score.totalAvg
      lines.push(`  总分      ${bt} → ${nt}（${nt - bt >= 0 ? "+" : ""}${(nt - bt).toFixed(1)}）`)
    }
    console.log(`\n=== 对比(baseline → new) ===\n${lines.join("\n")}`)
    // 回归判定（合入门槛，见 session-management.md 13.x）：整体通过率回退 或 任一打分卡维度回退即不合格。
    // 子集运行口径错位，判定无意义——直接拒绝判定，避免用噪声当合入门槛。
    if (scopeMismatch && process.argv.includes("--fail-on-regression")) {
      console.error("\n⚠ 子集运行不做回归判定（口径与 baseline 不可比）。请跑全量后再判定。")
      process.exit(1)
    }
    const rateRegressed = overall.rate < prev.summary.overall.rate
    if (process.argv.includes("--fail-on-regression") && (rateRegressed || scoreRegressed)) {
      console.error("\n❌ 评测回归：通过率或打分卡八维分数相对 baseline 出现回退，不合入。")
      process.exit(1)
    }
  }
}
