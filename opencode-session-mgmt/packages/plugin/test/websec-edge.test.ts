/**
 * websec ↔ edge-debug-core 薄桥接：模式、阶段、身份切换、完成校验、越权对比。
 * 用假 controller，不启动真实 Edge。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NetworkDetail, NetworkEntry } from "edge-debug-core"
import { Store } from "../src/db"
import { createWebsecEdgeTools } from "../src/tools/websec-edge"

const ctx = { sessionID: "s1" } as never
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeEntry(requestId: string, url: string, status = 200): NetworkEntry {
  return {
    time: "12:00:00",
    requestId,
    method: "GET",
    url,
    status,
    mimeType: "application/json",
    resourceType: "XHR",
  }
}

function setup() {
  const projectDir = mkdtempSync(join(tmpdir(), "sm-websec-edge-"))
  dirs.push(projectDir)
  const store = Store.memory(() => "websec")
  store.ensure("s1")
  store.mutateWorkflow("s1", (wf) => {
    wf.stages.scope.status = "in_progress"
    wf.websec = {
      evidence: [],
      scope: {
        target: "http://127.0.0.1:18086",
        environment: "test",
        accounts: [
          { name: "u1", role: "user" },
          { name: "admin", role: "admin" },
        ],
        stopConditions: ["需要写操作"],
        confirmedAt: 1000,
      },
    }
  })

  let logs: NetworkEntry[] = []
  const details = new Map<string, NetworkDetail>()
  const policies: unknown[] = []
  let cleared = 0
  let clearedNetworkLogs = 0
  const fake = {
    isRunning: () => true,
    start: async () => "started",
    stop: async () => true,
    networkLogs: () => logs,
    responseDetailData: async (requestId: string) => {
      const detail = details.get(requestId)
      if (!detail) throw new Error("no detail")
      return detail
    },
    setCapturePolicy: (policy: unknown) => {
      policies.push(policy)
    },
    clearSession: async () => {
      cleared += 1
      return "已清除当前浏览器登录态"
    },
    clearNetworkLogs: () => {
      clearedNetworkLogs += 1
    },
  }
  const tools = createWebsecEdgeTools(store, projectDir, () => fake)
  return {
    projectDir,
    store,
    tools,
    policies,
    getCleared: () => cleared,
    getClearedNetworkLogs: () => clearedNetworkLogs,
    setLogs(next: NetworkEntry[]) {
      logs = next
    },
    setDetail(entry: NetworkEntry, body: string) {
      details.set(entry.requestId, {
        time: entry.time,
        method: entry.method,
        url: entry.url,
        status: entry.status,
        requestHeaders: {},
        responseHeaders: {},
        body,
        base64Encoded: false,
      })
    },
  }
}

describe("websec_edge_capture", () => {
  test("普通测试：start 必须选模式，capture 为 single，finish 后才能报告", async () => {
    const { store, tools, setLogs, setDetail } = setup()
    try {
      await expect(
        tools.websec_edge_capture!.execute({ action: "start" } as never, ctx),
      ).rejects.toThrow(/普通测试.*越权测试/)

      const started = String(
        await tools.websec_edge_capture!.execute({ action: "start", mode: "normal" } as never, ctx),
      )
      expect(started).toContain("普通测试")
      expect(store.get("s1")!.workflow!.websec?.testMode).toBe("normal")
      expect(store.get("s1")!.workflow!.websec?.edge?.started).toBe(true)

      const entry = makeEntry("n1", "http://127.0.0.1:18086/api/users/1")
      const body = '{"id":1,"name":"alice"}'
      setLogs([entry])
      setDetail(entry, body)
      const out = String(
        await tools.websec_edge_capture!.execute({ action: "capture", identity: "u1/user" } as never, ctx),
      )
      expect(out).toContain("single")
      const ev = store.get("s1")!.workflow!.websec!.evidence[0]!
      expect(ev.id).toBe("edge-single-n1")
      expect(ev.phase).toBe("single")
      expect(ev.bodyPresent).toBe(true)
      expect(ev.status).toBe(200)
      expect(ev.hash).toBe(createHash("sha256").update(body, "utf8").digest("hex"))
      expect(ev.localPath && existsSync(ev.localPath)).toBe(true)
      expect(readFileSync(ev.localPath!, "utf8")).toBe(body)

      const finished = String(await tools.websec_edge_capture!.execute({ action: "finish" } as never, ctx))
      expect(finished).toContain("采集完成")
      expect(store.get("s1")!.workflow!.websec?.edge?.finished).toBe(true)
    } finally {
      store.close()
    }
  })

  test("越权测试：需要两个账号；baseline → 清登录态 → privileged → 对比 → finish", async () => {
    const { store, tools, setLogs, setDetail, getCleared, getClearedNetworkLogs } = setup()
    try {
      store.mutateWorkflow("s1", (wf) => {
        wf.websec!.scope!.accounts = [{ name: "u1", role: "user" }]
      })
      await expect(
        tools.websec_edge_capture!.execute({ action: "start", mode: "authz" } as never, ctx),
      ).rejects.toThrow(/至少两个不同角色/)

      store.mutateWorkflow("s1", (wf) => {
        wf.websec!.scope!.accounts.push({ name: "admin", role: "admin" })
      })
      const started = String(
        await tools.websec_edge_capture!.execute({ action: "start", mode: "authz" } as never, ctx),
      )
      expect(started).toContain("越权测试")
      expect(store.get("s1")!.workflow!.websec?.testMode).toBe("authz")

      await expect(
        tools.websec_edge_capture!.execute({ action: "capture", identity: "u1" } as never, ctx),
      ).rejects.toThrow(/phase=baseline/)

      setLogs([makeEntry("early", "http://127.0.0.1:18086/api/users/0")])
      await expect(
        tools.websec_edge_capture!.execute({ action: "switch_identity" } as never, ctx),
      ).rejects.toThrow(/baseline 网络日志未采集/)

      const baseEntry = makeEntry("b1", "http://127.0.0.1:18086/api/users/1")
      const baseBody = '{"id":1,"name":"alice"}'
      setLogs([baseEntry])
      setDetail(baseEntry, baseBody)
      await expect(
        tools.websec_edge_capture!.execute(
          { action: "capture", phase: "baseline", identity: "u1/user" } as never,
          ctx,
        ),
      ).resolves.toContain("baseline")

      await expect(
        tools.websec_edge_capture!.execute({ action: "switch_identity" } as never, ctx),
      ).resolves.toContain("高权账号")
      expect(getCleared()).toBe(1)
      expect(getClearedNetworkLogs()).toBe(1)

      const privEntry = makeEntry("p1", "http://127.0.0.1:18086/api/users/2")
      const privBody = '{"id":2,"name":"bob"}'
      setLogs([privEntry])
      setDetail(privEntry, privBody)
      await expect(
        tools.websec_edge_capture!.execute(
          { action: "capture", phase: "privileged", identity: "admin/admin" } as never,
          ctx,
        ),
      ).resolves.toContain("privileged")

      const compared = String(await tools.websec_authz_compare!.execute({} as never, ctx))
      expect(compared).toContain("/api/users/:id")
      expect(compared).toContain("baseline 200")
      expect(compared).toContain("privileged 200")
      expect(compared).toContain("hash 不同")

      const finished = String(await tools.websec_edge_capture!.execute({ action: "finish" } as never, ctx))
      expect(finished).toContain("baseline 1 条 / privileged 1 条")
      const evidence = store.get("s1")!.workflow!.websec!.evidence
      expect(evidence.map((item) => item.phase)).toEqual(["baseline", "privileged"])
    } finally {
      store.close()
    }
  })
})
