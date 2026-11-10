import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Store } from "../src/db"
import { createWebsecAnonymousTool } from "../src/tools/websec-anonymous"

const ctx = { sessionID: "s1" } as never
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const projectDir = mkdtempSync(join(tmpdir(), "sm-websec-anon-"))
  dirs.push(projectDir)
  const store = Store.memory(() => "websec")
  store.ensure("s1")
  store.mutateWorkflow("s1", (wf) => {
    wf.websec = {
      testMode: "normal",
      scope: {
        target: "http://127.0.0.1:18086",
        environment: "test",
        accounts: [{ name: "u1", role: "普通用户" }],
        stopConditions: ["异常即停"],
        confirmedAt: 1000,
      },
      edge: { started: true, finished: true },
      evidence: [
        {
          id: "edge-get",
          url: "http://127.0.0.1:18086/api/settings",
          method: "GET",
          source: "edge",
          phase: "single",
          hash: "a".repeat(64),
          bodyPresent: true,
        },
        {
          id: "edge-post",
          url: "http://127.0.0.1:18086/api/settings",
          method: "POST",
          source: "edge",
          phase: "single",
          hash: "b".repeat(64),
          bodyPresent: true,
        },
      ],
    }
  })
  return { store, projectDir }
}

describe("websec_anonymous_probe", () => {
  test("只对已捕获 GET 端点发无 Cookie 请求并写入项目内证据", async () => {
    const { store, projectDir } = setup()
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch
    try {
      const tool = createWebsecAnonymousTool(store, projectDir, fetchImpl).websec_anonymous_probe!
      await expect(tool.execute({ developer_confirmed: false } as never, ctx)).rejects.toThrow(/developer_confirmed/)
      const output = String(await tool.execute({ developer_confirmed: true } as never, ctx))
      expect(output).toContain("匿名只读探测完成")
      expect(output).toContain("1 条")
      expect(calls).toHaveLength(1)
      expect(calls[0]!.url).toContain("/api/settings")
      expect(calls[0]!.init?.method).toBe("GET")
      expect(calls[0]!.init?.headers).toBeUndefined()
      const evidence = store.get("s1")!.workflow!.websec!.evidence.find((item) => item.source === "anonymous-probe")!
      expect(evidence.phase).toBe("anonymous")
      expect(evidence.identity).toBe("anonymous")
      expect(evidence.status).toBe(200)
      expect(evidence.localPath && existsSync(evidence.localPath)).toBe(true)
      expect(readFileSync(evidence.localPath!, "utf8")).toContain('"ok":true')
    } finally {
      store.close()
    }
  })

  test("拒绝跨源或未走查的 URL", async () => {
    const { store, projectDir } = setup()
    try {
      const tool = createWebsecAnonymousTool(store, projectDir, (async () => new Response("")) as unknown as typeof fetch)
        .websec_anonymous_probe!
      await expect(
        tool.execute({ urls: ["http://evil.example/api/settings"], developer_confirmed: true } as never, ctx),
      ).rejects.toThrow(/同源/)
      await expect(
        tool.execute({ urls: ["http://127.0.0.1:18086/api/not-visited"], developer_confirmed: true } as never, ctx),
      ).rejects.toThrow(/已捕获/)
    } finally {
      store.close()
    }
  })
})
