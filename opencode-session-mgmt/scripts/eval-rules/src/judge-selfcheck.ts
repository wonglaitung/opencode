/**
 * 判定器自检：跑评测**之前**先证明新判据真的会红。
 *
 * 存在的理由是一个具体的失效模式：`forbidArgsPresent` / `argsNonEmpty` 走点路径
 * 取值，路径写错时 `pick` 返回 undefined —— 对正向断言是「恒失败」（吵闹但安全），
 * 对**禁止存在**的断言却是「恒通过」（安静且危险）：场景永远绿，给的是假 assurance，
 * 而它保护的恰恰是「静默点默认不入库」这条防污染红线。
 *
 * 所以每次跑评测（含 dry）都先自检一遍，发现判据失灵直接中止——宁可评测跑不起来，
 * 也不能让失效的判据产出一份看起来没问题的报告。
 */
import { judgeScenario } from "./judge"

const call = (args: Record<string, unknown>) => ({ toolCalls: [{ name: "reqdoc_answer", args }], text: "" })

const CASES: { desc: string; judge: Parameters<typeof judgeScenario>[0]; out: Parameters<typeof judgeScenario>[1]; want: boolean }[] = [
  {
    desc: "argsNonEmpty：带非空凭据 → 通过",
    judge: { kind: "tool", expectTool: "reqdoc_answer", argsNonEmpty: ["restated_term.business_quote"] },
    out: call({ address: "4.1.CRD", restated_term: { term: "CRD", business_quote: "业务说：CRD 就是信贷审批部" } }),
    want: true,
  },
  {
    desc: "argsNonEmpty：凭据是空白串 → 不通过（否则「留空即拒写」形同虚设）",
    judge: { kind: "tool", expectTool: "reqdoc_answer", argsNonEmpty: ["restated_term.business_quote"] },
    out: call({ address: "4.1.CRD", restated_term: { term: "CRD", business_quote: "   " } }),
    want: false,
  },
  {
    desc: "argsNonEmpty：字段缺失 → 不通过",
    judge: { kind: "tool", expectTool: "reqdoc_answer", argsNonEmpty: ["restated_term.business_quote"] },
    out: call({ address: "4.1.CRD", restated_term: { term: "CRD" } }),
    want: false,
  },
  {
    desc: "forbidArgsPresent：没带凭据字段 → 通过",
    judge: { kind: "tool", expectTool: "reqdoc_answer", forbidArgsPresent: ["restated_term"] },
    out: call({ address: "4.1.CRD", source: "问答" }),
    want: true,
  },
  {
    desc: "forbidArgsPresent：凭据字段在场 → 不通过（防「无脑全填」）",
    judge: { kind: "tool", expectTool: "reqdoc_answer", forbidArgsPresent: ["restated_term"] },
    out: call({ address: "4.1.CRD", restated_term: { term: "CRD", business_quote: "我自己想的" } }),
    want: false,
  },
]

/** 返回失灵项的描述；空数组表示全部判据行为符合预期。 */
export function judgeSelfCheck(): string[] {
  return CASES.filter((c) => judgeScenario(c.judge, c.out).pass !== c.want).map((c) => c.desc)
}
