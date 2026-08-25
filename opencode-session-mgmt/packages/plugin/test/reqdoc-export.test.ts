/**
 * reqdoc_export Word 导出工具测试（实施方案「标准 PRD (Markdown/Word)」）。
 * 覆盖：md→docx 转换生成合法 OOXML zip（含 document.xml 与标题/表格内容）、
 * 工具写 .docx 与源同目录、非 md 源拒绝、源不存在报错。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import JSZip from "jszip"
import { createReqdocExportTool, mdToDocx } from "../src/tools/reqdoc-export"

const dirs: string[] = []

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sm-export-"))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 校验 buf 是合法 docx：PK 头 + word/document.xml 存在且含指定片段。 */
async function assertDocx(buf: Buffer, expectContains: string[]) {
  expect(buf.subarray(0, 2).toString()).toBe("PK")
  const zip = await JSZip.loadAsync(buf)
  const doc = zip.file("word/document.xml")
  expect(doc).not.toBeNull()
  const xml = await doc!.async("text")
  for (const frag of expectContains) expect(xml).toContain(frag)
}

const SAMPLE_MD = `# 业务需求说明书

## 一、项目信息

| 项目信息 | 内容 |
|------|------|
| 标题 | 内部工单系统 |
| 优先级 | ● 高　○ 中　○ 低 |

## 第三章 需求功能详述

- 功能点编号：1
- 功能名称：**名单排查**

> 来源标注：文档提取 [文档]

### 1.1 简要概述

业务人员在排查名单时…`

describe("reqdoc_export", () => {
  test("mdToDocx 生成合法 docx（标题/表格/列表/加粗/引用内容均在 document.xml）", async () => {
    const buf = await mdToDocx(SAMPLE_MD)
    expect(buf.length).toBeGreaterThan(1000)
    await assertDocx(buf, [
      "业务需求说明书", // H1
      "一、项目信息", // H2
      "内部工单系统", // 表格单元格
      "功能点编号：1", // 列表
      "名单排查", // 加粗段
      "来源标注：文档提取", // 引用
      "业务人员在排查名单时", // 段落
    ])
  })

  test("工具把 .docx 写到源 md 同目录并返回路径", async () => {
    const worktree = tempDir()
    const rel = "06_需求规格产出/1_名单排查/需求规格书.md"
    mkdirSync(dirname(join(worktree, rel)), { recursive: true })
    writeFileSync(join(worktree, rel), SAMPLE_MD, "utf8")
    const tools = createReqdocExportTool()
    const out = String(
      await tools.reqdoc_export!.execute({ source: rel } as never, { worktree } as never),
    )
    expect(out).toContain("已导出 Word 版交付件：需求规格书.docx")
    const outPath = join(worktree, "06_需求规格产出/1_名单排查/需求规格书.docx")
    expect(existsSync(outPath)).toBe(true)
    await assertDocx(Buffer.from(await Bun.file(outPath).arrayBuffer()), ["内部工单系统"])
  })

  test("非 .md 源被拒", async () => {
    const worktree = tempDir()
    const tools = createReqdocExportTool()
    await expect(
      tools.reqdoc_export!.execute({ source: "06_需求规格产出/需求规格书.docx" } as never, { worktree } as never),
    ).rejects.toThrow(/必须指向 .md/)
  })

  test("源文件不存在报错（提示先完成 PRD 渲染）", async () => {
    const worktree = tempDir()
    const tools = createReqdocExportTool()
    await expect(
      tools.reqdoc_export!.execute({ source: "06_需求规格产出/不存在/需求规格书.md" } as never, { worktree } as never),
    ).rejects.toThrow(/源文件不存在或不可读/)
  })
})
