/**
 * 安全路径收敛测试（防越界，设计文档 workflow-reqdoc.md 8 章 reqdoc_scan/check/export）。
 */
import { describe, expect, test } from "bun:test"
import { resolveWithinWorktree } from "../src/fs-safe"

describe("resolveWithinWorktree", () => {
  const wt = "/project/req"

  test("普通相对路径收敛到工作区内", () => {
    expect(resolveWithinWorktree(wt, "01_背景与目标/a.docx")).toBe("/project/req/01_背景与目标/a.docx")
  })

  test("含反斜杠的相对路径仍收敛在工作区内（Windows 风格分隔符）", () => {
    const full = resolveWithinWorktree(wt, "06_需求规格产出\\1_测试\\prd.md")
    expect(full.startsWith("/project/req/")).toBe(true)
  })

  test("`..` 越界抛错", () => {
    expect(() => resolveWithinWorktree(wt, "../secret.txt")).toThrow(/路径越界/)
    expect(() => resolveWithinWorktree(wt, "../../etc/passwd")).toThrow(/路径越界/)
  })

  test("绝对路径越界抛错", () => {
    expect(() => resolveWithinWorktree(wt, "/etc/passwd")).toThrow(/路径越界/)
    // Windows 盘符绝对路径（如 D:\secret.txt）在 Windows 运行时同样判为越界并抛「路径越界」，
    // 此处仅能在当前 OS 验证 POSIX 绝对路径；Windows 行为由同一 startsWith 判定保障。
  })

  test("恰好是工作区根本身放行", () => {
    expect(resolveWithinWorktree(wt, ".")).toBe("/project/req")
  })
})
