/**
 * 纯只读扫描核心：规则加载/覆盖、regex 命中、路径越界、git 改动文件读取。
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadReviewRules, readChangedFiles, runGitReadOnly, scanFiles } from "../src/review-scan"

function temp(prefix = "sm-scan-"): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function write(root: string, rel: string, text: string): void {
  const path = join(root, rel)
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, text)
}

async function git(root: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`)
  return stdout
}

async function initGit(root: string): Promise<void> {
  await git(root, ["init"])
  await git(root, ["config", "user.email", "review@example.com"])
  await git(root, ["config", "user.name", "Review"])
}

describe("review-scan", () => {
  test("内置规则命中私钥、硬编码凭据和 TODO，并带行号", () => {
    const root = temp()
    try {
      write(
        root,
        "src/auth.ts",
        [
          'const apiKey = "sk_live_1234567890"',
          "export function login() {}",
          "// TODO: remove legacy path",
          "-----BEGIN RSA PRIVATE KEY-----",
        ].join("\n"),
      )
      const report = scanFiles(root, { scope: ["src/auth.ts"], files: ["src/auth.ts"] })
      expect(report.status).toBe("completed")
      expect(report.scannedFiles).toBe(1)
      expect(report.findings.map((f) => f.ruleId)).toEqual(
        expect.arrayContaining(["SEC-002", "DES-001", "SEC-001"]),
      )
      expect(report.findings.find((f) => f.ruleId === "SEC-001")?.line).toBe(4)
      expect(report.bySeverity.blocker).toBe(1)
      expect(report.bySeverity.critical).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("项目规则目录可禁用内置规则并追加自定义规则", () => {
    const root = temp()
    try {
      write(
        root,
        ".opencode/review-rules/catalog.json",
        JSON.stringify({
          rules: [
            { id: "SEC-001", enabled: false },
            {
              id: "PRJ-001",
              title: "禁止 MAGIC",
              severity: "major",
              dimension: "design",
              globs: ["src/**/*.ts"],
              pattern: "MAGIC",
              message: "自定义规则命中",
            },
          ],
        }),
      )
      write(root, "src/a.ts", "const x = 'MAGIC'\n-----BEGIN RSA PRIVATE KEY-----")
      const loaded = loadReviewRules(root)
      expect(loaded.rules.some((rule) => rule.id === "SEC-001")).toBe(false)
      expect(loaded.rules.some((rule) => rule.id === "PRJ-001")).toBe(true)
      const report = scanFiles(root, { scope: ["src/a.ts"], files: ["src/a.ts"] })
      expect(report.findings.map((f) => f.ruleId)).toContain("PRJ-001")
      expect(report.findings.map((f) => f.ruleId)).not.toContain("SEC-001")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("越界路径与二进制文件不会读取", () => {
    const root = temp()
    const outside = temp("sm-outside-")
    try {
      write(outside, "secret.ts", "const apiKey = 'sk_live_1234567890'")
      write(root, "bin.dat", "abc\u0000def")
      const report = scanFiles(root, {
        scope: ["../outside/secret.ts", "bin.dat"],
        files: ["../outside/secret.ts", "bin.dat"],
      })
      expect(report.scannedFiles).toBe(0)
      expect(report.findings).toHaveLength(0)
      expect(report.warnings.some((warning) => warning.includes("越界"))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("git 改动文件包含 staged/unstaged/untracked 并统计 numstat", async () => {
    const root = temp()
    try {
      await initGit(root)
      write(root, "src/base.ts", "export const base = 1\n")
      await git(root, ["add", "."])
      await git(root, ["commit", "-m", "base"])
      write(root, "src/base.ts", "export const base = 2\n")
      write(root, "src/new.ts", "export const added = 1\n")
      write(root, "src/staged.ts", "export const staged = 1\n")
      await git(root, ["add", "src/staged.ts"])

      const changed = await readChangedFiles(root)
      expect(changed).not.toBeNull()
      expect(changed!.files).toEqual(expect.arrayContaining(["src/base.ts", "src/new.ts", "src/staged.ts"]))
      expect(changed!.diffStats.files).toBe(3)
      expect(changed!.diffStats.insertions).toBeGreaterThan(0)
      expect((await runGitReadOnly(root, ["status", "--porcelain"])).ok).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("非 Git 项目返回 null", async () => {
    const root = temp()
    try {
      expect(await readChangedFiles(root)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
