/**
 * rule-based 判定(不用 LLM judge)。对弱模型的 tool_use 有清晰 ground truth:
 * 工具名 + 参数谓词即达标,无需强模型打分。
 */
import type { Judge, ModelOutput } from "./types"

/** 参数子集匹配:judge.args 的每一项都须等于调用实参(实参缺键视为不匹配)。 */
function argsMatch(expect: Record<string, unknown> | undefined, actual: Record<string, unknown>): boolean {
  if (!expect) return true
  return Object.entries(expect).every(([k, v]) => actual[k] === v)
}

export function judgeScenario(judge: Judge, out: ModelOutput): { pass: boolean; detail: string } {
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
  }
}
