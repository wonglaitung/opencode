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
  parseRenderStructure,
  reqdocChapters,
  reqdocTaggedFields,
  type ReqdocScoreDimKey,
} from "sm-shared"
import { scorePrd, type PrdScore } from "./score"

/** 参数子集匹配:judge.args 的每一项都须等于调用实参(实参缺键视为不匹配)。 */
/** 按点路径取值：`restated_term.business_quote` → args.restated_term?.business_quote。 */
function pick(args: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((v, k) => (typeof v === "object" && v !== null ? (v as Record<string, unknown>)[k] : undefined), args)
}

function isNonEmptyString(args: Record<string, unknown>, path: string): boolean {
  const v = pick(args, path)
  return typeof v === "string" && v.trim() !== ""
}

function argsMatch(expect: Record<string, unknown> | undefined, actual: Record<string, unknown>): boolean {
  if (!expect) return true
  return Object.entries(expect).every(([k, v]) => actual[k] === v)
}

export function judgeScenario(judge: Judge, out: ModelOutput): { pass: boolean; detail: string; score?: PrdScore } {
  switch (judge.kind) {
    case "rejected": {
      // 验防线而非谨慎：必须真的调了、且被服务端拒绝
      if (!out.toolResults) {
        return { pass: false, detail: `需 EVAL_EXECUTE=1 才能判定「调用是否被拒」（当前无工具执行结果）` }
      }
      const hits = out.toolResults.filter((t) => t.name === judge.tool)
      if (hits.length === 0) {
        // 走正路也算过：模型不试错工具、直接用了正确的那个，不该判失败
        const right = (judge.orTools ?? []).filter((t) => out.toolResults.some((r) => r.name === t))
        if (right.length > 0) return { pass: true, detail: `✓ 未试 ${judge.tool}，直接走了 ${right.join("、")}` }
        return { pass: false, detail: `未调用 ${judge.tool}（实际:${out.toolCalls.map((c) => c.name).join("、") || "无"}）` }
      }
      const rejected = hits.filter((t) => !t.ok)
      if (rejected.length === 0) {
        return {
          pass: false,
          detail: `${judge.tool} 被调用 ${hits.length} 次且**全部成功**——防线失效（期望服务端拒绝）`,
        }
      }
      return {
        pass: true,
        detail: `✓ ${judge.tool} 被服务端拒绝 ${rejected.length}/${hits.length} 次：${rejected[0]!.result.slice(0, 80)}`,
      }
    }
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
      // 嵌套字段非空断言：args 只能引用相等，判不了 restated_term 这类对象字段
      for (const path of judge.argsNonEmpty ?? []) {
        if (!matched.some((c) => isNonEmptyString(c.args, path))) {
          return {
            pass: false,
            detail: `${judge.expectTool} 的 ${path} 缺失或为空(实际:${matched.map((c) => JSON.stringify(pick(c.args, path))).join("、")})`,
          }
        }
      }
      // 存在性禁止：业务只是点了「同意默认」时，不该出现凭据类字段
      for (const path of judge.forbidArgsPresent ?? []) {
        const bad = matched.filter((c) => pick(c.args, path) !== undefined)
        if (bad.length > 0) {
          return { pass: false, detail: `${judge.expectTool} 不该带 ${path}(实际:${JSON.stringify(pick(bad[0]!.args, path))})` }
        }
      }
      // 替代路径禁令：期望调 assemble，但不许用别的工具绕过（实测有模型连发 comprehension_add）
      const forbidden = out.toolCalls.filter((c) => (judge.forbidTool ?? []).includes(c.name))
      if (forbidden.length > 0) {
        return {
          pass: false,
          detail: `不该调用 ${forbidden.map((c) => c.name).join("、")}（期望走 ${judge.expectTool}）`,
        }
      }
      // 顺序门禁：子序列匹配（允许中间夹别的调用）。「先补齐再组装」这类要求
      // 靠单工具断言判不出来——调了 assemble 不代表槽位是齐的。
      for (const seq of [judge.sequence ?? []]) {
        const names = out.toolCalls.map((c) => c.name)
        let at = -1
        const missing = seq.filter((want) => {
          const found = names.indexOf(want, at + 1)
          if (found < 0) return true
          at = found
          return false
        })
        if (missing.length) {
          return { pass: false, detail: `工具顺序不对：期望 ${seq.join(" → ")}，缺 ${missing.join("、")}（实际 ${names.join("→") || "无"}）` }
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

    case "argsAbsent": {
      const bad = out.toolCalls.filter((c) => pick(c.args, judge.path) !== undefined)
      if (bad.length > 0)
        return {
          pass: false,
          detail: `${bad.map((c) => c.name).join("、")} 不该带 ${judge.path}（实际:${JSON.stringify(pick(bad[0]!.args, judge.path))}）`,
        }
      return { pass: true, detail: `✓ 任何调用都未带 ${judge.path}` }
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
      // 同 render：优先评真实产物，无产物即不通过（详见 render 分支注释）
      if (!out.artifact) return { pass: false, detail: "✗ 未产出组装件，无法评 PRD 质量" }
      const prd = scorePrd(out.artifact)
      const markers = judge.renderMarkers.filter((m) => out.artifact!.includes(m))
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
      // 渲染 diff 判定(质量飞轮 P2)：同源 parseRenderStructure 解析文本
      //
      // **优先读真实产物**（`artifact`，仅 EVAL_EXECUTE=1 时有）：PRD 由服务端
      // reqdoc_assemble 投影生成、规则明令模型不得手写产物，所以渲染质量只能从产物评。
      // 没有产物时回落模型正文——但那正是第十轮认定为「奖励违规」的口径，
      // 故回落时判据如实判不通过，不给「模型自己写了也算」留后门。
      const struct = parseRenderStructure(out.artifact ?? out.text)
      if (!out.artifact && out.text.trim() !== "")
        return { pass: false, detail: "✗ 未产出组装件（评测器未执行工具或模型没调 reqdoc_assemble），无法评渲染质量" }
      const required = judge.requiredChapters ?? reqdocChapters().map((c) => c.title)
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
          const uncovered = reqdocTaggedFields().filter((f) => struct.covered[f.key] < struct.featureCount)
          if (uncovered.length) pushSource(`映射字段未全标来源 ${uncovered.map((f) => f.key).join("、")}`)
        }
      }
      if (judge.anyDefault && !reqdocTaggedFields().some((f) => (struct.defaults[f.key] ?? 0) > 0)) {
        pushSource("无 [缺省] 标注(缺料却硬写=杜撰风险)")
      }
      const obsNote = observations.length ? `;观察项(不计通过率):${observations.join(";")}` : ""
      return {
        pass: fails.length === 0,
        detail: fails.length
          ? `✗ ${fails.join(";")}（功能点块 ${struct.featureCount}，缺章节 ${struct.missing.join("、") || "无"}，乱序 ${struct.outOfOrder.join("、") || "无"}）${obsNote}`
          : `✓ 渲染结构达标（章节 ${struct.chaptersPresent.length}/${reqdocChapters().length}，功能点块 ${struct.featureCount}` +
            `${judge.sourceAll ? "，映射字段全标来源" : ""}${judge.anyDefault ? "，含 [缺省]" : ""}）${obsNote}`,
      }
    }
  }
}
