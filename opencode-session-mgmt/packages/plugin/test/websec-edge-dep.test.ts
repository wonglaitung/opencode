/**
 * edge-debug-core 是项目外的 file: 依赖，且 websec-edge 被 toolset 在插件加载时顶层导入。
 * 约定：缺失时只允许 Edge 走查不可用，不得让整个插件加载失败。
 *
 * 两层护栏：文本契约钉住「不得静态导入值」，端到端钉住「websec 工具集仍完整注册」。
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Store } from "../src/db"
import { createLockRegistry } from "../src/open-ide/lock"
import { createToolset } from "../src/tools/toolset"

const WEBSEC_TOOLS = [
  "websec_scope",
  "websec_evidence",
  "websec_report",
  "websec_surface",
  "websec_coverage",
  "websec_regression",
  "websec_config_check",
  "websec_write_probe",
  "websec_edge_capture",
  "websec_anonymous_probe",
  "websec_authz_compare",
]

describe("websec 的 edge-debug-core 依赖降级", () => {
  test("文本契约：只允许 import type 与动态加载，不得静态导入值", () => {
    const src = readFileSync(join(import.meta.dir, "../src/tools/websec-edge.ts"), "utf8")
    const statements = src
      .split(/(?=^import )/m)
      .filter((chunk) => chunk.includes('from "edge-debug-core"'))
    expect(statements.length).toBeGreaterThan(0)
    for (const statement of statements) {
      expect(statement.startsWith("import type")).toBe(true)
    }
    // 动态加载必须且只必须发生在 loadEdgeDebug 内：
    // 顶层 await import 同样会在插件加载阶段抛错，等于把 P1 改回来。
    const dynamicImports = src.match(/await import\("edge-debug-core"\)/g) ?? []
    expect(dynamicImports).toHaveLength(1)
    const loaderIndex = src.indexOf("async function loadEdgeDebug")
    expect(loaderIndex).toBeGreaterThan(-1)
    expect(src.indexOf('await import("edge-debug-core")')).toBeGreaterThan(loaderIndex)
    // Bun 缓存失败的动态 import：提示必须要求重启进程，不能只说「重试」
    expect(src).toContain("重启 opencode")
  })

  test("websec toolset 注册全部 11 个专属工具", () => {
    const store = Store.memory(() => "websec")
    try {
      const tools = createToolset({
        store,
        workflowType: "websec",
        ideEntries: [],
        lockRegistry: createLockRegistry(process.cwd(), store),
        projectDir: process.cwd(),
      })
      for (const name of WEBSEC_TOOLS) expect(tools[name]).toBeDefined()
      expect(Object.keys(tools).filter((name) => name.startsWith("websec_"))).toHaveLength(11)
    } finally {
      store.close()
    }
  })
})
