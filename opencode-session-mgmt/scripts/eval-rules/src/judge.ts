/**
 * rule-based 判定(不用 LLM judge)。对弱模型的 tool_use 有清晰 ground truth:
 * 工具名 + 参数谓词即达标,无需强模型打分。
 * kind="score" 例外:判定对象是渲染产出的 PRD 文本,用 scorePrd 确定性评分
 * (见 score.ts)——同样是 rule-based,只是从「工具行为」换到「产出质量」。
 * kind="render"(质量飞轮 P2):对渲染文本用共享 parseRenderStructure 解析结构,
 * 与运行时 reqdoc_check 同源,只换「工具+文件」为「评测回复文本」。
 */
import type { Judge, ModelOutput } from "./types"
import {
  REQDOC_SCORE_DIMS,
  REQDOC_TEMPLATE_CHAPTERS,
  REQDOC_TEMPLATE_FIELDS,
  parseRenderStructure,
  type ReqdocScoreDimKey,
} from "sm-shared"
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
      // 数组子集断言(质量飞轮 P1):每个期望元素须出现在某次调用的该数组参数中
      if (judge.argsContains) {
        for (const [k, want] of Object.entries(judge.argsContains)) {
          const ok = matched.some((c) => {
            const actual = c.args[k]
            return Array.isArray(actual) && want.every((w) => actual.includes(w))
          })
          if (!ok) {
            return {
              pass: false,
              detail: `${judge.expectTool} 的 ${k} 未覆盖期望元素 ${JSON.stringify(want)}(实际:${matched.map((c) => JSON.stringify(c.args[k])).join("、")})`,
            }
          }
        }
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

    case "render": {
      // 渲染 diff 判定(质量飞轮 P2)：同源 parseRenderStructure 解析模型回复文本
      const struct = parseRenderStructure(out.text)
      const required = judge.requiredChapters ?? REQDOC_TEMPLATE_CHAPTERS.map((c) => c.title)
      const fails: string[] = []
      const observations: string[] = []
      // fuzzy: 用 includes 匹配（弱模型可能用「需求概述」而非「第一章 需求概述」）
      const matchChapter = (title: string, present: string[]) =>
        judge.fuzzy ? present.some((p) => p.includes(title) || title.includes(p)) : present.includes(title)
      const missing = required.filter((t) => !matchChapter(t, struct.chaptersPresent))
      if (missing.length) fails.push(`缺章节 ${missing.join("、")}`)
      if ((judge.ordered ?? true) && struct.outOfOrder.length) fails.push(`章节乱序 ${struct.outOfOrder.join("、")}`)
      if (judge.minFeatures !== undefined && struct.featureCount < judge.minFeatures) {
        fails.push(`功能点块 ${struct.featureCount}<${judge.minFeatures}`)
      }
      // soft（A3/D7 拆级）：来源标注降为观察项，记录但不计通过率——硬门禁只剩结构骨架
      const pushSource = (msg: string) => (judge.soft ? observations.push(msg) : fails.push(msg))
      if (judge.sourceAll) {
        if (struct.featureCount === 0) {
          pushSource("无功能点块(第三章须每功能点一段)")
        } else {
          const uncovered = REQDOC_TEMPLATE_FIELDS.filter((f) => struct.covered[f.key] < struct.featureCount)
          if (uncovered.length) pushSource(`映射字段未全标来源 ${uncovered.map((f) => f.key).join("、")}`)
        }
      }
      if (judge.anyDefault && !REQDOC_TEMPLATE_FIELDS.some((f) => (struct.defaults[f.key] ?? 0) > 0)) {
        pushSource("无 [缺省] 标注(缺料却硬写=杜撰风险)")
      }
      const obsNote = observations.length ? `;观察项(不计通过率):${observations.join(";")}` : ""
      return {
        pass: fails.length === 0,
        detail: fails.length
          ? `✗ ${fails.join(";")}（功能点块 ${struct.featureCount}，缺章节 ${struct.missing.join("、") || "无"}，乱序 ${struct.outOfOrder.join("、") || "无"}）${obsNote}`
          : `✓ 渲染结构达标（章节 ${struct.chaptersPresent.length}/${REQDOC_TEMPLATE_CHAPTERS.length}，功能点块 ${struct.featureCount}` +
            `${judge.sourceAll ? "，映射字段全标来源" : ""}${judge.anyDefault ? "，含 [缺省]" : ""}）${obsNote}`,
      }
    }
  }
}
