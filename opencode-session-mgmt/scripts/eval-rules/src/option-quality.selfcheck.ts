/**
 * 选项质量解析器的自检（不调模型，随 `--dry` 跑）。
 *
 * 存在的理由是**实测教训**：这个解析器第一版要求「问号必须在行尾」，而真实输出是
 * `**问题 1：…？**`（行尾是被加粗的 `**`），于是真实场景里一个问句都解析不出、
 * 观测静默失效；而合成样例全绿——**探针在合���样例上通过，不等于在真实输出上正确**。
 * 这与 6.4 那条「探针自身要先自证」是同一条纪律，故本文件固定用**真实输出格式**做样例。
 */
import { parseOptionSets } from "./option-quality"

/** r27 实测输出格式：加粗问句 + `- A.` 列表符 + 同行多选项 + 【默认推荐项】标注 */
const REAL = `📍 阶段：目标与场景（第 1/5 步）｜ 下一步：流程与规则

在开始之前，有两件事想先跟您确认一下：

**问题 1：您这边手头有没有现成的资料？**
- A. 有，我放进对应目录里，您帮我扫描提取【默认推荐项】
- B. 没有，咱们直接口头聊，我边问边记
- C. 有一部分，我先把有的放进来，没有的咱们口述补

**问题 2：谁在用这个系统？**
- A. 只有柜员 B. 只有客户 C. 柜员和客户 D. 以上都不是

3. 数据从哪来？
- A. 现有核心系统
- B. 手工录入
- B. 手工录入`

const CASES: { desc: string; text: string; want: Record<string, unknown> }[] = [
  {
    desc: "真实格式：加粗问句、列表符选项、同行多选项都能解析",
    text: REAL,
    // 兜底只有 1 个：第 3 问的重复项「手工录入」不是兜底；
    // 「以上都不是问题所在」按新口径也不计（接了内容就不是出口了）
    want: { questions: 3, optionCountOk: 3, withFallback: 1, withDuplicate: 1 },
  },
  {
    desc: "问号不必在行尾（真实输出行尾是被加粗的 **）",
    text: "**问题 1：有没有资料？**",
    want: { questions: 1 },
  },
  {
    desc: "同行多选项要拆成多项（不是一整段文字）",
    text: "谁在用？\n- A. 柜员 B. 客户 C. 两者",
    want: { questions: 1, parsed0options: 3 },
  },
  {
    desc: "只有工具调用、几乎不说话 → 解析为空（不是错误）",
    text: "好的，我先初始化一下工作流。",
    want: { questions: 0 },
  },
  // 兜底识别：单词表会把这 9 条全判成兜底（实测误判 6/7），令兜底率虚高。
  // 故识别必须是**整项句式**，不是「含某个词」。这批用例就是防那个回退。
  ...[
    // ↓ 以下带「/ 其他角色」的两条是**真实输出原文**（r27 实测）：收紧成「严格等于」时
    // 它们会被漏掉，于是真兜底被低报。保留它们就是防那个回退。
    ["以上都不是 / 其他角色", true],
    ["以上都不是 / 其他", true],
    ["以上都不是 / 其他业务场景", true],
    ["以上都不是", true],
    ["其他", true],
    ["其他（请补充）", true],
    ["都不对", true],
    ["以上都不是。", true],
    ["都不是以上", true],
    ["没有额外要求", false],
    ["其他章节无需改动", false],
    ["以上都没有提到", false],
    ["无需额外审批", false],
    ["没有特殊要求，按常规流程", false],
    ["其他系统的问题", false],
    ["以上都不是问题所在", false],
    ["以上都不是太笼统", false],
    ["需要人工确认", false],
    ["都不是我要的（请补充）", false],
  ].map(([opt, want], i) => ({
    desc: `兜底识别 ${i + 1}：「${opt}」→ ${want ? "应算兜底" : "不应算兜底"}`,
    text: `问题？\n- A. 甲\n- B. ${opt}`,
    want: { parsed0fallback: want },
  })),
]

/** 返回失灵项描述；空数组表示解析器行为符合预期。 */
export function optionQualitySelfCheck(): string[] {
  const fails: string[] = []
  for (const c of CASES) {
    const r = parseOptionSets(c.text)
    for (const [k, want] of Object.entries(c.want)) {
      const got =
        k === "parsed0options"
          ? (r.parsed[0]?.options.length ?? 0)
          : k === "parsed0fallback"
            ? (r.parsed[0]?.hasFallback ?? false)
            : (r as unknown as Record<string, unknown>)[k]
      if (got !== want) fails.push(`${c.desc}：${k} 期望 ${String(want)}，实际 ${String(got)}`)
    }
  }
  return fails
}
