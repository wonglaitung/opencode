/**
 * rule-based 判定(不用 LLM judge)。对弱模型的 tool_use 有清晰 ground truth:
 * 工具名 + 参数谓词即达标,无需强模型打分。
 * kind="score" 例外:判定对象是渲染产出的 PRD 文本,用 scorePrd 确定性评分
 * (见 score.ts)——同样是 rule-based,只是从「工具行为」换到「产出质量」。
 */
import type { Judge, ModelOutput } from "./types"
import { REQDOC_SCORE_DIMS, type ReqdocScoreDimKey } from "sm-shared"
import { scorePrd, type PrdScore } from "./score"

/** 参数子集匹配:judge.args 的每一项都须等于调用实参(实参缺键视为不匹配)。 */
function argsMatch(expect: Record<string, unknown> | undefined, actual: Record<string, unknown>): boolean {
  if (!expect) return true
  return Object.entries(expect).every(([k, v]) => actual[k] === v)
}

export function judgeScenario(judge: Judge, out: ModelOutput): { pass: boolean; detail: string; score?: PrdScore } {
  switch (judge.kind) {
    case "tool": {
      const matched = out.toolCalls.filter((c) => c.name === judge.expectTool)
      if (matched.length === 0) {
        const actual = out.toolCalls.map((c) => c.name).join("、") || "无工具调用"
        return { pass: false, detail: `未调用 ${judge.expectTool}(实际:${actual})` }
      }
      if (!matched.some((c) => argsMatch(judge.args, c.args))) {
        return { pass: false, detail: `${judge.expectTool} 参数不匹配,期望 ${JSON.stringify(judge.args)}` }
      }
      if (judge.exactCount !== undefined && matched.length !== judge.exactCount) {
        return { pass: false, detail: `${judge.expectTool} 应恰好调用 ${judge.exactCount} 次,实际 ${matched.length} 次` }
      }
      if (judge.distinctArg) {
        const vals = matched.map((c) => c.args[judge.distinctArg])
        if (new Set(vals).size !== vals.length) {
          return { pass: false, detail: `${judge.expectTool} 的 ${judge.distinctArg} 有重复(批量/重复确认):${vals.join("、")}` }
        }
      }
      const countNote = judge.exactCount !== undefined ? `(恰好${judge.exactCount}次)` : ""
      return { pass: true, detail: `✓ ${judge.expectTool} ${JSON.stringify(judge.args ?? {})}${countNote}` }
    }

    case "no_tool": {
      const forbids = Array.isArray(judge.forbidTool) ? judge.forbidTool : [judge.forbidTool]
      const bad = out.toolCalls.filter(
        (c) => forbids.includes(c.name) && argsMatch(judge.args, c.args),
      )
      if (bad.length > 0) {
        return {
          pass: false,
          detail: `不应调用 ${forbids.join("、")}(约束 ${JSON.stringify(judge.args ?? {})}),实际调用了 ${bad.map((c) => c.name).join("、")} ${bad.length} 次`,
        }
      }
      return { pass: true, detail: `✓ 未调用 ${forbids.join("、")}` }
    }

    case "text": {
      if (judge.type === "maxQuestions") {
        const n = (out.text.match(/[?？]/g) ?? []).length
        return n <= (judge.max ?? 0)
          ? { pass: true, detail: `✓ 问句 ${n} 个(≤${judge.max})` }
          : { pass: false, detail: `问句 ${n} 个,超过上限 ${judge.max}` }
      }
      if (judge.type === "optionsABC") {
        const n = (out.text.match(/[?？]/g) ?? []).length
        const hasDefault = out.text.includes("默认")
        const markers = (out.text.match(/[A-C][.、:：)）]/g) ?? []).length
        const minOptions = judge.minOptions ?? 2
        const ok = n <= (judge.max ?? 3) && hasDefault && markers >= minOptions
        return ok
          ? { pass: true, detail: `✓ 问句 ${n} 个(≤${judge.max}) 且含「默认推荐」+ A/B/C 选项标记 ${markers} 个` }
          : {
              pass: false,
              detail: `问句 ${n}/${judge.max},含「默认」:${hasDefault},A/B/C 标记:${markers}(需≥${minOptions});全文:${out.text.slice(0, 200)}`,
            }
      }
      if (judge.type === "categoryKeywords") {
        const categories = judge.categories ?? []
        const hit = categories.filter((kws) => kws.some((k) => out.text.includes(k)))
        const pass = hit.length >= (judge.minCategories ?? 2)
        return pass
          ? { pass: true, detail: `✓ 命中 ${hit.length}/${categories.length} 类探针` }
          : { pass: false, detail: `探针命中 ${hit.length}/${categories.length} 类,需 ≥${judge.minCategories};全文:${out.text.slice(0, 200)}` }
      }
      if (judge.type === "keyword") {
        const kw = judge.keyword ?? ""
        return out.text.includes(kw)
          ? { pass: true, detail: `✓ 回复包含「${kw}」` }
          : { pass: false, detail: `回复未包含「${kw}」;全文:${out.text.slice(0, 200)}` }
      }
      return { pass: false, detail: `未知 text 判定类型 ${(judge as any).type}` }
    }

    case "score": {
      const prd = scorePrd(out.text)
      const markers = judge.renderMarkers.filter((m) => out.text.includes(m))
      const noMarker = markers.length === 0
      const okTotal = prd.total >= judge.minTotal
      const okMax = Object.entries(judge.dimMax ?? {}).every(
        ([k, v]) => prd.dims[k as ReqdocScoreDimKey].score <= (v ?? 0),
      )
      const okMin = Object.entries(judge.dimMin ?? {}).every(
        ([k, v]) => prd.dims[k as ReqdocScoreDimKey].score >= (v ?? 0),
      )
      const pass = !noMarker && okTotal && okMax && okMin
      const dimLine = REQDOC_SCORE_DIMS.map(
        (d) => `${d.key}:${prd.dims[d.key].score}/${d.max}`,
      ).join(" ")
      if (noMarker) {
        return {
          pass: false,
          score: prd,
          detail: `未渲染出 PRD(命中标记 0/${judge.renderMarkers.length} 个,标记:${judge.renderMarkers.join("、")});总分 ${prd.total}`,
        }
      }
      const fails: string[] = []
      if (!okTotal) fails.push(`总分 ${prd.total}<${judge.minTotal}`)
      for (const [k, v] of Object.entries(judge.dimMax ?? {})) {
        if (prd.dims[k as ReqdocScoreDimKey].score > (v ?? 0)) fails.push(`${k} ${prd.dims[k as ReqdocScoreDimKey].score}>${v}`)
      }
      for (const [k, v] of Object.entries(judge.dimMin ?? {})) {
        if (prd.dims[k as ReqdocScoreDimKey].score < (v ?? 0)) fails.push(`${k} ${prd.dims[k as ReqdocScoreDimKey].score}<${v}`)
      }
      return {
        pass,
        score: prd,
        detail: `${pass ? "✓" : "✗"} 渲染命中 ${markers.length} 标记;总分 ${prd.total}(需≥${judge.minTotal})` +
          `${fails.length ? `;未达标:${fails.join("、")}` : ""} [${dimLine}]`,
      }
    }
  }
}
