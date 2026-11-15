/**
 * 工作流状态随交接文件一起搬。
 *
 * 状态存在 `<项目>/.opencode/session-mgmt.db`，由 opencode-session-mgmt 插件自管。
 * 这里不手抄它的 schema：运行时动态加载随包分发的 sm bundle 里的 `Store`，
 * 建库、迁移、写入全交给它自己。
 *
 * 兜底：bundle 不存在（例如在仓库里直接跑 CLI）时返回 undefined / false，
 * 交接照常完成，只是不带工作流状态。
 */
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

export type HandoffWorkflow = {
  /** WorkflowState 的 JSON（路径已归一化）。 */
  state: Record<string, unknown>
  tags?: string[]
  status?: string | null
}

type SmRow = { workflow?: unknown; tags?: unknown; status?: unknown }
type SmStore = {
  get(sessionID: string): SmRow | null
  mutateWorkflow(sessionID: string, fn: (workflow: Record<string, unknown>) => void): unknown
}
type SmModule = {
  Store: {
    openIfExists(directory: string): SmStore | null
    open(directory: string, resolveType: () => string): SmStore
  }
}

/** 缺省从载荷里的同级目录加载；开发/测试可用 TEAM_SHARE_SM_DB 指向仓库内路径。 */
const DEFAULT_MODULE = new URL("../../opencode-sm-bundle/packages/plugin/src/db/index.ts", import.meta.url)

export function smDbModulePath(): string {
  return process.env["TEAM_SHARE_SM_DB"] ?? fileURLToPath(DEFAULT_MODULE)
}

async function loadStore(): Promise<SmModule["Store"] | null> {
  const path = smDbModulePath()
  if (!existsSync(path)) return null
  try {
    const mod = (await import(path)) as SmModule
    return mod.Store ?? null
  } catch {
    return null
  }
}

/** 读源项目里的工作流状态（只读；库或行不存在时返回 undefined）。 */
export async function readWorkflowState(
  projectDir: string,
  sessionID: string,
): Promise<HandoffWorkflow | undefined> {
  const Store = await loadStore()
  if (!Store) return undefined
  const store = Store.openIfExists(projectDir)
  if (!store) return undefined
  const row = store.get(sessionID)
  if (!row || typeof row.workflow !== "object" || row.workflow === null) return undefined
  return {
    state: row.workflow as Record<string, unknown>,
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : undefined,
    status: typeof row.status === "string" ? row.status : null,
  }
}

/**
 * 写入目标项目的工作流状态（库不存在时由 Store 建库并迁移）。
 * 整体替换该会话的状态：交接是快照，不保留目标端旧状态里的残留字段。
 */
export async function writeWorkflowState(
  projectDir: string,
  sessionID: string,
  workflow: HandoffWorkflow,
): Promise<boolean> {
  const Store = await loadStore()
  if (!Store) return false
  const type = typeof workflow.state["type"] === "string" ? (workflow.state["type"] as string) : "sdlc"
  const store = Store.open(projectDir, () => type)
  store.mutateWorkflow(sessionID, (target) => {
    for (const key of Object.keys(target)) delete target[key]
    Object.assign(target, workflow.state)
  })
  return true
}
