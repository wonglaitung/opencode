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
/** 任意工具序列的模型输出（sequence / forbidTool 判据用）。 */
const seqOut = (names: string[]) => ({ toolCalls: names.map((name) => ({ name, args: {} })), text: "" })

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
  {
    desc: "sequence：先 ingest 后 assemble → 通过",
    judge: { kind: "tool", expectTool: "reqdoc_assemble", sequence: ["reqdoc_ingest", "reqdoc_assemble"] },
    out: seqOut(["reqdoc_ingest", "reqdoc_answer", "reqdoc_assemble"]),
    want: true,
  },
  {
    desc: "sequence：assemble 在 ingest 之前 → 不通过（产物是过期快照）",
    judge: { kind: "tool", expectTool: "reqdoc_assemble", sequence: ["reqdoc_ingest", "reqdoc_assemble"] },
    out: seqOut(["reqdoc_assemble", "reqdoc_ingest"]),
    want: false,
  },
  {
    desc: "sequence：缺前一步 → 不通过",
    judge: { kind: "tool", expectTool: "reqdoc_assemble", sequence: ["reqdoc_ingest", "reqdoc_assemble"] },
    out: seqOut(["reqdoc_assemble"]),
    want: false,
  },
  {
    desc: "forbidTool：没调被禁工具 → 通过",
    judge: { kind: "tool", expectTool: "reqdoc_assemble", forbidTool: ["comprehension_add"] },
    out: seqOut(["reqdoc_assemble"]),
    want: true,
  },
  {
    desc: "forbidTool：调了被禁工具 → 不通过（用理解条目绕过槽位）",
    judge: { kind: "tool", expectTool: "reqdoc_assemble", forbidTool: ["comprehension_add"] },
    out: seqOut(["comprehension_add", "reqdoc_assemble"]),
    want: false,
  },
  // 休眠路径防腐：render / score 判据自第十轮起无场景产出（渲染质量要等评测器学会执行
  // reqdoc_assemble、拿到真实产物才能测），但代码还在。留两条最小用例，免得将来重新
  // 启用时静默腐坏——这类「没场景覆盖的判据」正是最容易烂在没人看见的地方。
  {
    desc: "render（休眠路径）：正文有要求章节则结构达标",
    judge: { kind: "render", requiredChapters: ["第一章 项目信息", "第二章 文档变更过程"], ordered: true, minFeatures: 1 },
    out: { text: "## 第一章 项目信息\n\n内容\n\n## 第二章 文档变更过程\n\n### 5.1 柜台转账\n\n- 功能点编号：1\n", toolCalls: [] },
    want: true,
  },
  {
    desc: "render（休眠路径）：正文无章节则不通过（防恒通过）",
    judge: { kind: "render", requiredChapters: ["第一章 项目信息"], ordered: true },
    out: { text: "我认为需求已经很清楚了。", toolCalls: [] },
    want: false,
  },
]

/** 返回失灵项的描述；空数组表示全部判据行为符合预期。 */
export function judgeSelfCheck(): string[] {
  return CASES.filter((c) => judgeScenario(c.judge, c.out).pass !== c.want).map((c) => c.desc)
}
