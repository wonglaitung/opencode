/**
 * 工作流状态随交接文件搬运。
 *
 * 这里刻意用**仓库里真实的** session-mgmt Store（通过 TEAM_SHARE_SM_DB 指过去），
 * 而不是自己造一个假库：状态 schema 由它自管，测试要证明的正是「用它的 Store
 * 能读出来、也能写回去」。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { readWorkflowState, smDbModulePath, writeWorkflowState } from "../src/workflow-state"

const smModule = fileURLToPath(
  new URL("../../opencode-session-mgmt/packages/plugin/src/db/index.ts", import.meta.url),
)

type SmStore = {
  get(id: string): { workflow?: Record<string, unknown>; tags?: string[]; status?: string | null } | null
  mutateWorkflow(id: string, fn: (workflow: Record<string, unknown>) => void): unknown
}

async function openSmStore(dir: string): Promise<SmStore> {
  const mod = (await import(smModule)) as { Store: { open(d: string, resolve: () => string): SmStore } }
  return mod.Store.open(dir, () => "sdlc")
}

const dirs: string[] = []
const prev = process.env["TEAM_SHARE_SM_DB"]

beforeEach(() => {
  process.env["TEAM_SHARE_SM_DB"] = smModule
})

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (prev === undefined) delete process.env["TEAM_SHARE_SM_DB"]
  else process.env["TEAM_SHARE_SM_DB"] = prev
})

function projectDir() {
  const dir = mkdtempSync(join(tmpdir(), "team-share-wf-"))
  dirs.push(dir)
  return dir
}

describe("工作流状态搬运", () => {
  test("模块路径可被环境变量覆盖", () => {
    expect(smDbModulePath()).toBe(smModule)
  })

  test("读出源会话的工作流状态", async () => {
    const dir = projectDir()
    const store = await openSmStore(dir)
    store.mutateWorkflow("ses_wf", (wf) => {
      const stages = wf["stages"] as Record<string, { status: string }>
      stages["requirements"]!.status = "approved"
      stages["design"]!.status = "in_progress"
      wf["baseline"] = { hours: 8, messageID: "m1", at: 1000 }
    })

    const state = await readWorkflowState(dir, "ses_wf")
    expect(state).toBeDefined()
    const stages = state!.state["stages"] as Record<string, { status: string }>
    expect(stages["requirements"]!.status).toBe("approved")
    expect(stages["design"]!.status).toBe("in_progress")
    expect((state!.state["baseline"] as { hours: number }).hours).toBe(8)
  })

  test("写回目标项目后，用同一个 Store 能读到相同阶段", async () => {
    const source = projectDir()
    const srcStore = await openSmStore(source)
    srcStore.mutateWorkflow("ses_wf", (wf) => {
      const stages = wf["stages"] as Record<string, { status: string }>
      stages["requirements"]!.status = "approved"
      stages["design"]!.status = "approved"
      stages["implementation"]!.status = "in_progress"
    })
    const state = await readWorkflowState(source, "ses_wf")
    expect(state).toBeDefined()

    const target = projectDir()
    const written = await writeWorkflowState(target, "ses_wf", state!)
    expect(written).toBe(true)

    const targetStore = await openSmStore(target)
    const row = targetStore.get("ses_wf")
    const stages = (row?.workflow?.["stages"] ?? {}) as Record<string, { status: string }>
    expect(stages["requirements"]!.status).toBe("approved")
    expect(stages["implementation"]!.status).toBe("in_progress")
  })

  test("目标项目没有状态库时会自动建库并迁移", async () => {
    const source = projectDir()
    const srcStore = await openSmStore(source)
    srcStore.mutateWorkflow("ses_new", (wf) => {
      ;(wf["stages"] as Record<string, { status: string }>)["requirements"]!.status = "approved"
    })
    const state = await readWorkflowState(source, "ses_new")
    const target = projectDir() // 全新目录，没有 .opencode
    expect(await writeWorkflowState(target, "ses_new", state!)).toBe(true)
    const row = (await openSmStore(target)).get("ses_new")
    expect((row?.workflow?.["type"] as string) ?? "").toBe("sdlc")
  })

  test("会话没有工作流行时返回 undefined", async () => {
    const dir = projectDir()
    await openSmStore(dir) // 建库但不建行
    expect(await readWorkflowState(dir, "ses_none")).toBeUndefined()
  })

  test("状态库不存在时返回 undefined", async () => {
    expect(await readWorkflowState(projectDir(), "ses_none")).toBeUndefined()
  })

  test("sm bundle 不可用时安全降级（不抛错）", async () => {
    process.env["TEAM_SHARE_SM_DB"] = "/tmp/opencode/definitely-missing/db/index.ts"
    expect(await readWorkflowState(projectDir(), "ses_x")).toBeUndefined()
    expect(await writeWorkflowState(projectDir(), "ses_x", { state: { type: "sdlc" } })).toBe(false)
  })
})
