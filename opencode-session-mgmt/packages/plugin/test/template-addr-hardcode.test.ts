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
  // `<容器地址>.<名称>`、`{序号}.*` —— 命中片段所在字符串里含占位记号即放行
  if (/<[^>]*>|\{[^}]*\}|序号|占位/.test(full)) return true
  // 运行时插值：`${addrHint().fieldContainer}` 之类不是写死
  if (/\$\{[^}]*\}/.test(full)) return true
  // **设计文档章节引用**：`设计 2.2`、`6.2.1.1 选项 B`、`（3.6.1 ①）`、
  // `录入基线预估人工工时（6.3，AI 提效对比）`、`授权（3.4 逃生口）`。
  // 判据是「命中片段**前面紧邻**设计/章节类词，或**后面紧跟**中文说明」——
  // 两者都是设计引用的语法特征；模板地址不会长这样（后面跟的是标题或正文）。
  const at = full.indexOf(hit)
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