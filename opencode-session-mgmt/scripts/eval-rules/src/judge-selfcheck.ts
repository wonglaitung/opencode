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
  // 「rejected」判据：验防线而非谨慎。三条分别锁住「被拒→过」「全成功→挂」「没调用→挂」。
  // 最后一条尤其重要：没尝试就不算通过，否则场景不走防线、白测。
  {
    desc: "rejected：调用被服务端拒绝 → 通过（防线有效）",
    judge: { kind: "rejected", tool: "review_submit" },
    out: { text: "", toolCalls: [{ name: "review_submit", args: {} }], toolResults: [{ name: "review_submit", ok: false, result: "审查前须先完成 边界与异常" }] },
    want: true,
  },
  {
    desc: "rejected：调用全部成功 → 不通过（防线失效）",
    judge: { kind: "rejected", tool: "review_submit" },
    out: { text: "", toolCalls: [{ name: "review_submit", args: {} }], toolResults: [{ name: "review_submit", ok: true, result: "✅ 已定稿" }] },
    want: false,
  },
  {
    desc: "rejected：根本没调用 → 不通过（没走防线等于白测）",
    judge: { kind: "rejected", tool: "review_submit" },
    out: { text: "", toolCalls: [], toolResults: [] },
    want: false,
  },
  {
    desc: "rejected：orTools 命中（模型走了正确路径、未以身试错）→ 通过",
    judge: { kind: "rejected", tool: "workflow_advance", orTools: ["review_submit"] },
    out: { text: "", toolCalls: [{ name: "review_submit", args: {} }], toolResults: [{ name: "review_submit", ok: true, result: "✅ 已定稿" }] },
    want: true,
  },
  {
    desc: "rejected：既没试错工具也没走正路 → 不通过",
    judge: { kind: "rejected", tool: "workflow_advance", orTools: ["review_submit"] },
    out: { text: "", toolCalls: [{ name: "comprehension_add", args: {} }], toolResults: [{ name: "comprehension_add", ok: true, result: "已加" }] },
    want: false,
  },
  {
    desc: "rejected：无工具执行结果（非 EVAL_EXECUTE 模式）→ 不通过并说明原因",
    judge: { kind: "rejected", tool: "review_submit" },
    out: { text: "", toolCalls: [{ name: "review_submit", args: {} }] },
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
  // render 判据现在**只认真实产物**（artifact，由 EVAL_EXECUTE=1 执行 reqdoc_assemble 得到）：
  // PRD 由服务端投影生成、规则明令模型不得手写产物，所以「模型正文里有 PRD」不再算数。
  // 三条用例分别锁住：有产物→按产物判；无产物但正文有 PRD→**仍不通过**（不给手写留后门）；
  // 无产物且正文为空→不通过。
  {
    desc: "render：产物章节齐全则结构达标",
    judge: { kind: "render", requiredChapters: ["第一章 项目信息", "第二章 文档变更过程"], ordered: true, minFeatures: 1 },
    out: {
      text: "",
      artifact: "## 第一章 项目信息\n\n内容\n\n## 第二章 文档变更过程\n\n### 5.1 柜台转账\n\n- 功能点编号：1\n",
      toolCalls: [],
    },
    want: true,
  },
  {
    desc: "render：无产物但模型正文写了 PRD → 仍不通过（这就是第十轮的「奖励手写」）",
    judge: { kind: "render", requiredChapters: ["第一章 项目信息"], ordered: true },
    out: { text: "## 第一章 项目信息\n\n内容\n", toolCalls: [] },
    want: false,
  },
  {
    desc: "argsAbsent：全部调用都不带该字段 → 通过（只验禁令，不要求做别的动作）",
    judge: { kind: "argsAbsent", path: "restated_term" },
    out: seqOut(["reqdoc_scan", "reqdoc_answer"]),
    want: true,
  },
  {
    desc: "argsAbsent：任一调用带了该字段 → 不通过",
    judge: { kind: "argsAbsent", path: "restated_term" },
    out: { text: "", toolCalls: [{ name: "reqdoc_answer", args: { restated_term: { term: "CRD" } } }] },
    want: false,
  },
  {
    desc: "render：无产物且正文无章节 → 不通过（防恒通过）",
    judge: { kind: "render", requiredChapters: ["第一章 项目信息"], ordered: true },
    out: { text: "我认为需求已经很清楚了。", toolCalls: [] },
    want: false,
  },
  // ---- orTools / minCalls（r14：两条路都合规，但要守住「别一问一答」）----
  {
    desc: "orTools：命中 orTools 里的另一工具即通过（r14 的 answer 路）",
    judge: { kind: "tool", expectTool: "reqdoc_ingest", orTools: ["reqdoc_answer"], minCalls: 3 },
    out: {
      text: "",
      toolCalls: [
        { name: "reqdoc_answer", args: {} },
        { name: "reqdoc_answer", args: {} },
        { name: "reqdoc_answer", args: {} },
      ],
    },
    want: true,
  },
  {
    desc: "orTools + minCalls：只 answer 一次 → 不通过（防退化成一条一答）",
    judge: { kind: "tool", expectTool: "reqdoc_ingest", orTools: ["reqdoc_answer"], minCalls: 3 },
    out: { text: "", toolCalls: [{ name: "reqdoc_answer", args: {} }] },
    want: false,
  },
  {
    desc: "orTools：两个工具都没调 → 不通过（防恒通过）",
    judge: { kind: "tool", expectTool: "reqdoc_ingest", orTools: ["reqdoc_answer"], minCalls: 3 },
    out: { text: "", toolCalls: [{ name: "workflow_advance", args: {} }] },
    want: false,
  },
  {
    desc: "minCalls 按命中工具合计计（ingest+answer 混着也算批量）",
    judge: { kind: "tool", expectTool: "reqdoc_ingest", orTools: ["reqdoc_answer"], minCalls: 3 },
    out: {
      text: "",
      toolCalls: [
        { name: "reqdoc_ingest", args: {} },
        { name: "reqdoc_answer", args: {} },
        { name: "reqdoc_answer", args: {} },
      ],
    },
    want: true,
  },
]

/** 返回失灵项的描述；空数组表示全部判据行为符合预期。 */
export function judgeSelfCheck(): string[] {
  return CASES.filter((c) => judgeScenario(c.judge, c.out).pass !== c.want).map((c) => c.desc)
}
