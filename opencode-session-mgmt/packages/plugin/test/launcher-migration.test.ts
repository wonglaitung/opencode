import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const script = join(import.meta.dir, "../../../../portable-installer/build/launcher-config.js")

describe("launcher-config 旧 bundle 目录迁移", () => {
  test("版本化旧路径被替换为稳定路径，未知插件保留且不重复", () => {
    const home = mkdtempSync(join(tmpdir(), "launcher-migrate-"))
    const root = join(home, "OpenCode")
    const configDir = join(home, ".config", "opencode")
    const config = join(configDir, "opencode.jsonc")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      config,
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          plugin: [
            "D:/old/opencode-sm-bundle-0.1.0/packages/plugin",
            "D:/old/opencode-edge-debug-bundle-0.0.1",
            "D:/old/opencode-server-debug-bundle-0.0.1",
            "custom-plugin",
          ],
        },
        null,
        2,
      ) + "\n",
    )
    try {
      const result = Bun.spawnSync([
        process.execPath,
        script,
        "--apply",
        "--plugins",
        "sm,edge,server",
        "--root",
        root,
        "--home",
        home,
      ])
      expect(result.exitCode).toBe(0)
      const text = readFileSync(config, "utf8")
      const parsed = JSON.parse(text) as { plugin: string[] }
      expect(parsed.plugin).toEqual([
        "custom-plugin",
        `${root.replace(/\\/g, "/")}/runtime/opencode-sm-bundle/packages/plugin`,
        `${root.replace(/\\/g, "/")}/runtime/opencode-edge-debug-bundle`,
        `${root.replace(/\\/g, "/")}/runtime/opencode-server-debug-bundle`,
      ])
      expect(parsed.plugin.some((item) => /-bundle-\d/.test(item))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("没有 plugin 字段时默认只启用工作流插件", () => {
    const home = mkdtempSync(join(tmpdir(), "launcher-default-"))
    const configDir = join(home, ".config", "opencode")
    const config = join(configDir, "opencode.jsonc")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(config, JSON.stringify({ $schema: "https://opencode.ai/config.json" }) + "\n")
    try {
      const result = Bun.spawnSync([process.execPath, script, "--dump", home, "--home", home])
      expect(result.exitCode).toBe(0)
      const state = readFileSync(join(home, "state.ini"), "utf8")
      expect(state).toContain("sm=1")
      expect(state).toContain("edge=0")
      expect(state).toContain("server=0")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
