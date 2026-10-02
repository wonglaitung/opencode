/**
 * 模型可见文本的模板地址护栏（阶段 C）。
 *
 * 模板结构改为从 md 解析后，编号会随机构模板变（功能点章 5→8、术语容器 4.1→2.2…）。
 * 任何**在源码里写死**的编号，出现在模型可见载体（规则文本 / 工具描述 / 参数说明）上都会
 * 在换模板后变成误导——模型会照着示例自造地址，而服务端只认「本轮该填」清单里的地址，
 * 结果是槽位被拒或填错位置。
 *
 * 实现用 **TypeScript 编译器自带的扫描器**取字符串字面量，而不是正则或手写词法分析：
 * 手写版本两次栽在字符串转义与正则字面量上（长度都对不齐，静默漏判）。
 * 只扫字符串字面量 + 模板字面量的静态部分；注释里的编号不参战（会随重构腐坏，
 * 但不会误导模型，纳入只会让护栏变成噪声源）。
 *
 * 例外：`${addrHint()...}` 这类插值表达式不算写死——它运行时才取值，换模板自动跟随。
 * 形状说明（`<容器地址>.<名称>`、`{序号}.*`）同样放行，它们描述寻址方式而非具体地址。
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"
import { getDefinition } from "sm-shared"


/** 具体模板地址字面量：至少两段全数字（`5.1`、`5.1.2.13`）或带大写后缀的容器叶子（`4.1.CRD`）。 */
const HARDCODE = /\d+\.\d+(?:\.\d+)*(?:\.[A-Z][A-Za-z]+)?/g

/** 形状记号：尖括号占位、花括号变量、`k`/`序号`/`N` 之类的泛指。 */
function isShape(hit: string, full: string): boolean {
  const at = full.indexOf(hit)
  // 占位豁免必须**命中点局部**：只有紧贴命中片段的占位记号才说明「这一段是形状」。
  // 曾经按整串判定（含占位即全串放行），漏判「必填 5.1.2.13（参考 <容器地址>）」与
  // 「{序号}.* 的 5.1」——真实地址藏在占位旁边照样放行，等于没有护栏。
  const before14 = full.slice(Math.max(0, at - 14), at)
  // 形状片段形如 `<名称>.1.2`、`{序号}.1.2`、`${x}.1.2`：占位记号紧邻左侧、其后可跟点号
  if (/[<{][^<>{}]{0,12}[>}]\s*\.?$/.test(before14)) return true
  if (/序号|占位|泛指/.test(before14.split(/\s+/).pop() ?? "")) return true
  // 运行时插值紧邻左侧：`${addrHint().fieldContainer}.1.2` 的 `1.2` 是形状
  if (/\$\{[^}]{0,40}\}\s*\.?$/.test(before14)) return true
  // **设计文档章节引用**：`设计 2.2`、`6.2.1.1 选项 B`、`（3.6.1 ①）`、
  // `录入基线预估人工工时（6.3，AI 提效对比）`、`授权（3.4 逃生口）`。
  // 判据是「命中片段**前面紧邻**设计/章节类词，或**后面紧跟**中文说明」——
  // 两者都是设计引用的语法特征；模板地址不会长这样（后面跟的是标题或正文）。
  const before = full.slice(Math.max(0, at - 16), at)
  const after = full.slice(at + hit.length, at + hit.length + 12)
  if (/设计|文档|章节|第\s*$/.test(before)) return true
  // 「文档位置引用」而非模板地址：`要点 2.3`、`对话第 4 轮`、`2.3 章`。
  // 量词字（要点/章/节/轮/页/条）出现在附近即判为文档位置，不是槽位地址。
  if (/[要点章节轮页条]\s*$/.test(before)) return true
  if (/^\s*(章|节|轮|页|条)/.test(after)) return true
  // 「数字对 + 紧邻中文」是设计引用语法（`6.3三分支`、`3.4逃生口`）。
  // **不能允许中间有空格**——`5.1.2.13 那样`（空格+中文）恰是模板地址示例。
  if (/^[一-龥、，,]/.test(after)) return true
  // **全角括号包裹的数字对**是本仓设计文档引用的统一形态（`（6.3）`、`（3.4 逃生口）`），
  //模板地址不会这样出现（小节标题跟在编号后而非括号内）。
  if (/^\s*(：[：])?/.test(after) && before.includes("（")) return true
  // SLO 数值不是地址：`可用性99.9%`、`响应<2s`、`并发≥1000`、`P99 2.5s`。
  // 判据是紧邻的百分号或比较符——模板地址永远不携带这两种语法，故不会连带放过真地址。
  if (/[%％]/.test(after) || /[<>=≤≥]\s*$/.test(before)) return true
  if (/^\s*(毫秒|秒|次|ms|s)\b/.test(after)) return true
  return false
}

/** 取文件里所有字符串字面量的静态文本部分（插值表达式剔除）。 */
function stringLiterals(file: string): string[] {
  const src = readFileSync(file, "utf8")
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push(node.text)
    } else if (ts.isTemplateExpression(node)) {
      // 只取静态片段；插值部分（TemplateSpan）单独剔除
      out.push(node.head.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

function scan(file: string): { file: string; hit: string }[] {
  const out: { file: string; hit: string }[] = []
  for (const lit of stringLiterals(file)) {
    for (const m of lit.matchAll(HARDCODE)) {
      if (m[0].length < 3) continue // 单段数字不是地址
      if (isShape(m[0], lit)) continue
      out.push({ file: file.split("/").pop()!, hit: m[0] })
    }
  }
  return out
}

/** 取一个字符串字面量里**未被豁免**的硬编码命中（正向对照用）。 */
function caught(literal: string): string[] {
  return [...literal.matchAll(HARDCODE)].filter((m) => !isShape(m[0], literal)).map((m) => m[0])
}

/** Markdown 规约扫描：反引号包裹的算占位示意（合规），括号包裹的算设计文档章节引用。 */
function scanMarkdown(file: string): { file: string; hit: string }[] {
  const src = readFileSync(file, "utf8")
  const out: { file: string; hit: string }[] = []
  for (const m of src.matchAll(HARDCODE)) {
    if (m[0].length < 3) continue
    // 前文窗口取 12 字符：判据要跨过引号（`"P0.1 前置条件"` 的 P 落在命中点前 2 字符）
    const before = src.slice(Math.max(0, m.index - 12), m.index)
    if (before.endsWith("`") && src[m.index + m[0].length] === "`") continue
    if (/[（(]\s*$/.test(before)) continue
    // `P0.1 前置条件` 里的 P+数字是项目/阶段编号（AGENTS.md 分级约定），非模板地址。
    // 命中点紧跟在 `P` 之后，故判据形如 `/P$/`（before 以 P 结尾）。
    if (/P$/.test(before)) continue
    // 形如「6.3 分支」「2.11 接口与数据源」出现在引号/反引号内时，多半是设计引用或示意
    if (/[「『"']/.test(before) && /\s$/.test(before)) continue
    // SLO 数值不是地址：`可用性99.9%`、`响应<2s`、`并发≥1000`——紧邻量词/百分号即放行
    const after = src.slice(m.index + m[0].length, m.index + m[0].length + 2)
    if (/[%％]/.test(after) || /[%％]$/.test(before)) continue
    if (/^\s*(毫秒|秒|次|万|%)/.test(after)) continue
    out.push({ file: file.split("/").pop()!, hit: m[0] })
  }
  return out
}

const PLUGIN_SRC = join(import.meta.dir, "..", "src")
const SHARED_SRC = join(import.meta.dir, "..", "..", "shared", "src")

describe("模型可见文本不得写死模板地址", () => {
  test("reqdoc 规则文本（运行时数据，规则文本本身即模型可见内容）", () => {
    const bad = getDefinition("reqdoc")
      .rules.map((r) => ({ id: r.id, hit: [...r.text.matchAll(HARDCODE)].map((m) => m[0]).filter((h) => !isShape(h, r.text)) }))
      .filter((x) => x.hit.length > 0)
    expect(bad).toEqual([])
  })

  test("工具描述、参数说明与阶段前置条件（reqdoc 工具文件）", () => {
    // workflow.ts 的「下一阶段前置条件」是**模型可见文案**（每次 advance 后打印），
    // 此前漏扫导致里面写死了 `4.1 / 5.k.2.1` 而无人发现——换模板后即失效指引。
    // 宁可多扫几个文件，也不要靠白名单维护「哪些文件模型可见」。
    const out = [
      ...scan(join(PLUGIN_SRC, "tools/reqdoc-kb-tools.ts")),
      ...scan(join(PLUGIN_SRC, "tools/reqdoc-features.ts")),
      ...scan(join(PLUGIN_SRC, "tools/review.ts")),
      ...scan(join(PLUGIN_SRC, "tools/workflow.ts")),
      ...scan(join(PLUGIN_SRC, "prompt.ts")),
    ]
    expect(out).toEqual([])
  })

  test("规约文件（conventions）不得写死模板地址", () => {
    // 规约随工作流注入 system prompt，是**模型可见文本**。此前 07-业务口语 第 3 节
    // 用 `4.1` / `5.1.2.1` 示范状态条长什么样——换模板后这些编号不存在了，
    // 而模型可能照抄。已改为占位示意 + 显式「以清单为准」。
    const dir = join(import.meta.dir, "..", "conventions")
    const out = Array.from(new Bun.Glob("**/*.md").scanSync({ cwd: dir, absolute: false })).flatMap((f) =>
      scanMarkdown(join(dir, f)),
    )
    expect(out).toEqual([])
  })

  test("注入文本（渲染后）零模板地址残留——规约与规则一起验", async () => {
    // 最终防线：把渲染器真正吐给模型的那段文本拿来扫。
    // 规则与规约任一处漏改，这里都会红——它们都是模型可见面。
    // 动态 import：scenarios.ts 自身有既存类型告警（status:"pending" 非 ReqdocSlot），
    // 静态引入会把那份告警带进本包的 typecheck。动态加载让运行时可用而不污染类型检查。
    const { SCENARIOS } = await import("../../../scripts/eval-rules/src/scenarios")
    const { renderNew } = await import("../../../scripts/eval-rules/src/render-new")
    const sc = (SCENARIOS as unknown as { workflowType: string; state: unknown }[]).find((x) => x.workflowType === "reqdoc")!
    const injected = String(renderNew(sc.state as never))
    const leaked = injected.match(/(?<![\w.$\{`<])\b[45]\.\d+(\.\d+)*\b(?!`)/g) ?? []
    expect([...new Set(leaked)]).toEqual([])
  })

  test("正向对照：占位只豁免紧邻片段，不豁免同串别处的写死地址", () => {
    // 回归：曾按「整串含占位即全串放行」判定，于是「必填 5.1.2.13（参考 <容器地址>）」
    // 里的真实地址被放过——护栏看着在跑，实际对最危险的混写完全失明。
    const leaks = ["必填容器未覆盖：5.1.2.13（参考 <容器地址>）", "顺序形如 {序号}.* 的 5.1 也一样"]
    for (const lit of leaks) expect(caught(lit)).not.toEqual([])
    // 同串里占位与地址并存时，**地址必须仍被抓到**
    expect(caught(leaks[0])).toContain("5.1.2.13")
    expect(caught(leaks[1])).toContain("5.1")
  })

  test("反向对照：真正的形状记号与设计引用仍放行（豁免不得过宽）", () => {
    // 豁免收紧的代价必须可控：形状记号、设计章节引用、SLO 数值仍不应报警
    for (const lit of [
      "<容器地址>.<名称>",
      "{序号}.1.2",
      "顺序形如 {序号}.* ",
      "详见设计 2.2 与 3.4 逃生口",
      "对应第 2.3 节",
      "可用性99.9%，响应<2s",
    ])
      expect(caught(lit)).toEqual([])
  })

  test("扫描覆盖所有插件源文件（防新增文件漏扫）", () => {
    // 白名单式扫描必然漏：新增一个含模型可见文案的工具文件就会逃过。
    // 改为「扫全部 src/**/*.ts」，靠 isShape 排除注释与设计文档编号。
    const files = Array.from(new Bun.Glob("**/*.ts").scanSync({ cwd: PLUGIN_SRC, absolute: false })).sort()
    expect(files.length).toBeGreaterThan(10)
    const out = files.flatMap((f) => scan(join(PLUGIN_SRC, f)))
    expect(out).toEqual([])
  })

  test("派生与模板层（shared 的 slots / render / assemble / schema）", () => {
    const out = ["reqdoc-slots.ts", "reqdoc-render.ts", "reqdoc-assemble.ts", "reqdoc-template-schema.ts"].flatMap((f) =>
      scan(join(SHARED_SRC, f)),
    )
    expect(out).toEqual([])
  })

  test("护栏自身有效：能抓出写死的地址（正向对照）", () => {
    // 防止护栏因正则/解析改动而恒真。
    // 不落临时文件：`Bun.write` 是异步的，await 前的 rm 会与写竞态，
    // 实测在 test/ 目录留下过孤儿文件。改为对**内存中的源码文本**跑词法扫描。
    const src = 'export const bad = "如 5.1.2.13 那样"\nexport const ok = "如 <容器地址>.<名称> 那样"\n'
    const sf = ts.createSourceFile("probe.ts", src, ts.ScriptTarget.Latest, true)
    const hits: string[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        for (const m of node.text.matchAll(HARDCODE)) {
          if (m[0].length >= 3 && !isShape(m[0], node.text)) hits.push(m[0])
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    expect(hits).toContain("5.1.2.13")
    // 尖括号占位形状必须放行，否则真实模板里的容器叶子写法会被误判
    expect(hits).toHaveLength(1)
  })
})