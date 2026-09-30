/**
 * 评测契约镜像护栏（P2）：
 *
 * `scripts/eval-rules/src/tool-defs.ts` 是发给评测模型的工具 schema 镜像。
 * 重构中它曾两次与运行时脱节：2a 加新工具未同步、2c 删旧工具未同步——
 * 评测因此一直在用不存在的工具 schema，看起来通过实则无效。
 *
 * 本文件从运行时工具定义**反射出真实工具名**，与镜像逐一比对，防止再次漂移。
 */
import { describe, expect, test } from "bun:test"
import { Store } from "../src/db"
import { createWorkflowTools } from "../src/tools/workflow"
import { createReviewTools } from "../src/tools/review"
import { createReqdocScanTool } from "../src/tools/reqdoc-scan"
import { createReqdocInitTool } from "../src/tools/reqdoc-dirs"
import { createReqdocFeatureTools } from "../src/tools/reqdoc-features"
import { createReqdocExportTool } from "../src/tools/reqdoc-export"
import { createReqdocKbTools } from "../src/tools/reqdoc-kb-tools"
import { createReqdocImportTool } from "../src/tools/reqdoc-import"
import { createReqdocConventionReviewTool } from "../src/tools/reqdoc-review-conventions"
import { EVAL_TOOLS } from "../../../scripts/eval-rules/src/tool-defs"

/** 运行时实际注册的全部工具名。 */
function runtimeToolNames(): Set<string> {
  const store = Store.memory()
  const groups: Record<string, ToolDefinition>[] = [
    createWorkflowTools(store),
    createReviewTools(store),
    createReqdocScanTool(),
    createReqdocInitTool(),
    createReqdocFeatureTools(store),
    createReqdocKbTools(store),
    createReqdocExportTool(),
    createReqdocImportTool(),
    createReqdocConventionReviewTool(),
  ]
  store.close()
  return new Set(groups.flatMap((g) => Object.keys(g)))
}

/** 判定是否进入评测的工具（与 eval 的沙箱约束一致：只判 tool_use，不执行）。 */
const SKIP = new Set(["open_ide", "commit_force_unlock"])

describe("评测契约镜像 · 与运行时对齐（P2）", () => {
  const runtime = runtimeToolNames()
  const mirror = new Set(EVAL_TOOLS.map((t) => t.function.name))

  test("★ 运行时每个工具（除 SKIP）都在镜像中——防止 2a/2c 那类漏同步", () => {
    const missing = [...runtime].filter((n) => !SKIP.has(n) && !mirror.has(n)).sort()
    expect(missing).toEqual([])
  })

  test("★ 镜像不含运行时已删除的工具——防止评测用幽灵 schema", () => {
    const deleted = [
      "reqdoc_score",
      "reqdoc_probe",
      "reqdoc_check",
      "reqdoc_patch",
      "reqdoc_render_skeleton",
      "reqdoc_field_dict",
    ]
    const ghosts = deleted.filter((n) => mirror.has(n))
    expect(ghosts).toEqual([])
  })

  test("reqdoc 三工具契约完整（ingest/answer/assemble 是唯一渲染路径）", () => {
    for (const n of ["reqdoc_ingest", "reqdoc_answer", "reqdoc_assemble"]) {
      expect(mirror.has(n)).toBe(true)
    }
    // 组装工具的描述必须明确「服务端投影、不要手写」——这是幂等门禁的前提
    const assemble = EVAL_TOOLS.find((t) => t.function.name === "reqdoc_assemble")!
    expect(assemble.function.description).toContain("服务端")
    expect(assemble.function.description).toMatch(/不应手工编辑|不要手写|不要手工编辑/)
  })

  test("force_kb / force_reason 在 workflow_advance 与 review_submit 契约中", () => {
    for (const n of ["workflow_advance", "review_submit"]) {
      const props = Object.keys(
        EVAL_TOOLS.find((t) => t.function.name === n)!.function.parameters
          .properties as Record<string, unknown>,
      )
      expect(props).toContain("force_kb")
      expect(props).toContain("force_reason")
    }
  })

  test("★ 镜像里不再有死参数（2c 已删）", () => {
    for (const n of ["workflow_advance", "review_submit"]) {
      const props = Object.keys(
        EVAL_TOOLS.find((t) => t.function.name === n)!.function.parameters
          .properties as Record<string, unknown>,
      )
      expect(props).not.toContain("skip_field_dict")
      expect(props).not.toContain("no_document_confirmed")
    }
  })

  test("★ 镜像描述不点名任何已删除的工具", () => {
    const dead = /reqdoc_(score|probe|patch|check|field_dict|render_skeleton)\b/
    const offenders = EVAL_TOOLS.filter((t) => dead.test(t.function.description)).map(
      (t) => t.function.name,
    )
    expect(offenders).toEqual([])
  })
})

import type { ToolDefinition } from "@opencode-ai/plugin"