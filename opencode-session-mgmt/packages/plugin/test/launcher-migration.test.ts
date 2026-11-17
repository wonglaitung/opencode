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

  test("apply 只把协作房间写进 tui.json，不污染 opencode.jsonc", () => {
    const home = mkdtempSync(join(tmpdir(), "launcher-room-"))
    const root = join(home, "OpenCode")
    const configDir = join(home, ".config", "opencode")
    const config = join(configDir, "opencode.jsonc")
    const tui = join(configDir, "tui.json")
    mkdirSync(configDir, { recursive: true })
    const sm = `${root.replace(/\\/g, "/")}/runtime/opencode-sm-bundle/packages/plugin`
    const room = `${root.replace(/\\/g, "/")}/runtime/opencode-collab-room`
    writeFileSync(config, JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: [sm] }, null, 2) + "\n")
    try {
      const first = Bun.spawnSync([process.execPath, script, "--apply", "--root", root, "--home", home, "--terminal", "native"])
      expect(first.exitCode).toBe(0)
      expect((JSON.parse(readFileSync(config, "utf8")) as { plugin: string[] }).plugin).toEqual([sm])
      const created = JSON.parse(readFileSync(tui, "utf8")) as { $schema: string; plugin: string[] }
      expect(created.plugin).toEqual([room])
      expect(created.$schema).toBe("https://opencode.ai/tui.json")

      const second = Bun.spawnSync([process.execPath, script, "--apply", "--root", root, "--home", home, "--terminal", "native"])
      expect(second.exitCode).toBe(0)
      expect((JSON.parse(readFileSync(tui, "utf8")) as { plugin: string[] }).plugin).toEqual([room])
      expect((JSON.parse(readFileSync(config, "utf8")) as { plugin: string[] }).plugin).toEqual([sm])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("已有 tui.jsonc 时在其中追加房间插件并保留其它字段", () => {
    const home = mkdtempSync(join(tmpdir(), "launcher-tui-"))
    const root = join(home, "OpenCode")
    const configDir = join(home, ".config", "opencode")
    const config = join(configDir, "opencode.jsonc")
    const tui = join(configDir, "tui.jsonc")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(config, JSON.stringify({ $schema: "https://opencode.ai/config.json" }) + "\n")
    writeFileSync(tui, JSON.stringify({ $schema: "https://opencode.ai/tui.json", keybinds: { leader: "ctrl+x" }, plugin: ["custom-tui"] }, null, 2) + "\n")
    const room = `${root.replace(/\\/g, "/")}/runtime/opencode-collab-room`
    try {
      const result = Bun.spawnSync([process.execPath, script, "--apply", "--root", root, "--home", home, "--terminal", "native"])
      expect(result.exitCode).toBe(0)
      const parsed = JSON.parse(readFileSync(tui, "utf8")) as { keybinds: Record<string, string>; plugin: string[] }
      expect(parsed.keybinds).toEqual({ leader: "ctrl+x" })
      expect(parsed.plugin).toEqual(["custom-tui", room])
      expect(() => readFileSync(join(configDir, "tui.json"), "utf8")).toThrow()
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
