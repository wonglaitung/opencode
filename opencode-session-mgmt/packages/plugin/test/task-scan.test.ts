/**
 * task_scan / task_check：code_review 任务的只读扫描与 git 读取。
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Store } from "../src/db"
import { createTaskCheckTool } from "../src/tools/task-check"
import { createTaskScanTool } from "../src/tools/task-scan"
import { applyTransition } from "../src/workflow-ops"

function temp(): string {
  return mkdtempSync(join(tmpdir(), "sm-task-scan-"))
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

function setup(root: string, category: "code_review" | "coding" = "code_review") {
  const store = Store.memory(() => "task")
  store.mutateWorkflow("s1", (workflow) => {
    applyTransition(workflow, "execute", "enter", 1)
    workflow.task = { category, source: "model", setAt: 1 }
  })
  return {
    store,
    scan: createTaskScanTool(store).task_scan!,
    check: createTaskCheckTool(store).task_check!,
    ctx: { sessionID: "s1", directory: root, worktree: root } as never,
  }
}

describe("task_scan / task_check", () => {
  test("task_scan diff 扫描改动文件并写入 taskScan", async () => {
    const root = temp()
    const { store, scan, ctx } = setup(root)
    try {
      await initGit(root)
      write(root, "src/base.ts", "export const base = 1\n")
      await git(root, ["add", "."])
      await git(root, ["commit", "-m", "base"])
      write(root, "src/base.ts", 'const apiKey = "sk_live_1234567890"\nexport const base = 2\n')

      const result = await scan.execute({ scope: "diff" } as never, ctx)
      expect(result).toContain("代码扫描完成")
      const report = store.get("s1")!.workflow!.taskScan
      expect(report?.status).toBe("completed")
      expect(report?.scope).toEqual(["diff"])
      expect(report?.findings.map((finding) => finding.ruleId)).toContain("SEC-002")
      expect(report?.diffStats?.files).toBe(1)
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("非 Git 项目 task_scan 返回跳过而不是报错", async () => {
    const root = temp()
    const { store, scan, ctx } = setup(root)
    try {
      const result = await scan.execute({ scope: "diff" } as never, ctx)
      expect(result).toContain("跳过")
      expect(store.get("s1")!.workflow!.taskScan?.status).toBe("skipped")
      const all = await scan.execute({ scope: "all" } as never, ctx)
      expect(all).toContain("跳过")
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("task_scan scope=files 必须给文件，且仅 code_review 可用", async () => {
    const root = temp()
    const { store, scan, ctx } = setup(root)
    try {
      await expect(scan.execute({ scope: "files" } as never, ctx)).rejects.toThrow(/files/)
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
    const coding = setup(root, "coding")
    try {
      await expect(coding.scan.execute({ scope: "diff" } as never, coding.ctx)).rejects.toThrow(
        /code_review/,
      )
    } finally {
      coding.store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("task_check 五个只读动作在 Git 仓库可用，非 Git 返回跳过", async () => {
    const root = temp()
    const { store, check, ctx } = setup(root)
    try {
      await initGit(root)
      write(root, "src/base.ts", "export const base = 1\n")
      await git(root, ["add", "."])
      await git(root, ["commit", "-m", "base"])
      write(root, "src/base.ts", "export const base = 2\n")

      expect(await check.execute({ action: "status" } as never, ctx)).toContain("src/base.ts")
      expect(await check.execute({ action: "diff" } as never, ctx)).toContain("base = 2")
      expect(await check.execute({ action: "log" } as never, ctx)).toContain("base")
      expect(await check.execute({ action: "show" } as never, ctx)).toContain("base")
      expect(await check.execute({ action: "ls-files" } as never, ctx)).toContain("src/base.ts")
      await expect(
        check.execute({ action: "show", target: "--help" } as never, ctx),
      ).rejects.toThrow(/target/)
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }

    const nonGit = temp()
    const other = setup(nonGit)
    try {
      expect(await other.check.execute({ action: "status" } as never, other.ctx)).toContain("跳过")
    } finally {
      other.store.close()
      rmSync(nonGit, { recursive: true, force: true })
    }
  })

  test("task_check 仅 code_review 可用", async () => {
    const root = temp()
    const { store, check, ctx } = setup(root, "coding")
    try {
      await expect(check.execute({ action: "status" } as never, ctx)).rejects.toThrow(
        /code_review/,
      )
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
