import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadWorkflowConventions } from "../src/conventions"

/** 建一个空的临时 projectRoot（无 conventions 子目录），避免与插件自带基线目录冲突。 */
function emptyRoot(): string {
  return mkdtempSync(join(tmpdir(), "conv-test-"))
}

describe("loadWorkflowConventions（按工作流类型 + 阶段门控）", () => {
  test("reqdoc rules 阶段：只注入 rules 规约（术语 + 状态机），不含其它阶段", () => {
    const text = loadWorkflowConventions("reqdoc", "rules", emptyRoot())
    expect(text).not.toBeNull()
    expect(text).toContain("术语须引用原文")
    expect(text).toContain("核心对象状态机")
    expect(text).not.toContain("异常须区分两类") // edge
    expect(text).not.toContain("每条需求可验证") // prd
    expect(text).not.toContain("显式 in scope") // goal
  })

  test("reqdoc edge 阶段：注入 edge 规约（异常 + 非功能），不含 rules", () => {
    const text = loadWorkflowConventions("reqdoc", "edge", emptyRoot())
    expect(text).toContain("异常须区分两类")
    expect(text).toContain("非功能须量化")
    expect(text).not.toContain("术语须引用原文")
  })

  test("reqdoc null（未开始/完成态）→ 无 global 规约，返回 null", () => {
    expect(loadWorkflowConventions("reqdoc", null, emptyRoot())).toBeNull()
  })

  test("sdlc implementation 阶段：注入 global(提交信息) + implementation，不混入 reqdoc", () => {
    const text = loadWorkflowConventions("sdlc", "implementation", emptyRoot())
    expect(text).toContain("凭证与密钥") // implementation
    expect(text).toContain("AI 编写代码须带 [AI] 标记") // global
    expect(text).not.toContain("术语须引用原文") // reqdoc 隔离
  })

  test("sdlc null（完成态）→ 仅注入 global 提交信息规约，不含 implementation", () => {
    const text = loadWorkflowConventions("sdlc", null, emptyRoot())
    expect(text).toContain("AI 编写代码须带 [AI] 标记")
    expect(text).not.toContain("凭证与密钥")
  })

  test("无该类型目录 → 返回 null", () => {
    expect(loadWorkflowConventions("nonexistent", "implementation", emptyRoot())).toBeNull()
  })

  test("项目覆盖 global 文件合并到基线之后", () => {
    const root = emptyRoot()
    const dir = join(root, "conventions", "reqdoc")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "99-机构补充.md"), "## 机构补充\n这是机构自己的规约。")
    try {
      const text = loadWorkflowConventions("reqdoc", "rules", root)
      expect(text).toContain("术语须引用原文")
      expect(text).toContain("这是机构自己的规约")
      expect(text!.indexOf("术语须引用原文")).toBeLessThan(text!.indexOf("这是机构自己的规约"))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("项目覆盖按 stage 过滤：prd 覆盖不注入 rules 阶段", () => {
    const root = emptyRoot()
    const dir = join(root, "conventions", "reqdoc")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "99-机构补充.md"), "---\nstage: prd\n---\n## 机构补充\n仅 prd。")
    try {
      expect(loadWorkflowConventions("reqdoc", "rules", root)).not.toContain("仅 prd")
      expect(loadWorkflowConventions("reqdoc", "prd", root)).toContain("仅 prd")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("点文件被跳过", () => {
    const root = emptyRoot()
    const dir = join(root, "conventions", "sdlc")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, ".hidden.md"), "## 隐藏\n不应出现。")
    try {
      expect(loadWorkflowConventions("sdlc", "implementation", root)).not.toContain("不应出现")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("命中缓存：同 type + 同 stage + 同 projectRoot 返回同一实例", () => {
    const root = emptyRoot()
    try {
      expect(loadWorkflowConventions("reqdoc", "rules", root)).toBe(loadWorkflowConventions("reqdoc", "rules", root))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})