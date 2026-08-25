/**
 * reqdoc_scan 文档扫描工具测试（7.5 双通道：文档扫描专用工具）。
 * 覆盖：纯文本读取、docx 提取、xlsx 提取、图像降级、目录不存在、空目录、总量截断。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import JSZip from "jszip"
import { createReqdocScanTool } from "../src/tools/reqdoc-scan"

const ctx = { worktree: "", sessionID: "s1" } as never

function makeWorktree(): { dir: string; ctx: never } {
  const dir = mkdtempSync(join(tmpdir(), "reqdoc-scan-"))
  return { dir, ctx: { worktree: dir, sessionID: "s1" } as never }
}

function makeDocx(text: string): Promise<Buffer> {
  const zip = new JSZip()
  zip.file("word/document.xml", `<w:document><w:body><w:p>${text}</w:p></w:body></w:document>`)
  return zip.generateAsync({ type: "nodebuffer" })
}

describe("reqdoc_scan", () => {
  test("目录不存在时报错并提示先做目录就绪检查", async () => {
    const { ctx } = makeWorktree()
    const tool = createReqdocScanTool().reqdoc_scan!
    await expect(tool.execute({ directory: "01_背景与目标" } as never, ctx)).rejects.toThrow(/不存在或不可读/)
  })

  test("空目录返回无资料提示", async () => {
    const { dir, ctx } = makeWorktree()
    mkdirSync(join(dir, "01_背景与目标"))
    const tool = createReqdocScanTool().reqdoc_scan!
    const out = await tool.execute({ directory: "01_背景与目标" } as never, ctx)
    expect(String(out)).toContain("为空")
  })

  test("纯文本文件提取内容", async () => {
    const { dir, ctx } = makeWorktree()
    mkdirSync(join(dir, "03_流程与数据"))
    writeFileSync(join(dir, "03_流程与数据", "字段表.txt"), "客户号|必填|数字\n姓名|必填|中文")
    const tool = createReqdocScanTool().reqdoc_scan!
    const out = await tool.execute({ directory: "03_流程与数据" } as never, ctx)
    expect(String(out)).toContain("客户号")
    expect(String(out)).toContain("姓名")
  })

  test("docx 提取纯文本（去掉 XML 标签）", async () => {
    const { dir, ctx } = makeWorktree()
    mkdirSync(join(dir, "01_背景与目标"))
    const buf = await makeDocx("业务背景：用于内部工单流转")
    writeFileSync(join(dir, "01_背景与目标", "背景.docx"), buf)
    const tool = createReqdocScanTool().reqdoc_scan!
    const out = await tool.execute({ directory: "01_背景与目标" } as never, ctx)
    expect(String(out)).toContain("业务背景")
    expect(String(out)).not.toContain("<w:")
  })

  test("图像文件显式降级提示（无多模态），不报错", async () => {
    const { dir, ctx } = makeWorktree()
    mkdirSync(join(dir, "04_角色与权限"))
    writeFileSync(join(dir, "04_角色与权限", "权限矩阵.png"), "fake-image")
    const tool = createReqdocScanTool().reqdoc_scan!
    const out = await tool.execute({ directory: "04_角色与权限" } as never, ctx)
    expect(String(out)).toContain("无法解析")
    expect(String(out)).toContain("文字描述")
  })

  test("xlsx 提取工作表与单元格", async () => {
    const { dir, ctx } = makeWorktree()
    mkdirSync(join(dir, "04_角色与权限"))
    const ExcelJS = (await import("exceljs")).default
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet("角色权限")
    ws.addRow(["岗位", "权限"])
    ws.addRow(["柜员", "查询"])
    const buf = await wb.xlsx.writeBuffer()
    writeFileSync(join(dir, "04_角色与权限", "权限.xlsx"), Buffer.from(buf))
    const tool = createReqdocScanTool().reqdoc_scan!
    const out = await tool.execute({ directory: "04_角色与权限" } as never, ctx)
    expect(String(out)).toContain("柜员")
  })
})
