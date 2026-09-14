import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Server } from "ssh2"
import { buildConnectConfig, createSshClient, type ServerConnection, type SshClient } from "../src/ssh"
import { ServerDebugError } from "../src/errors"
import { createServerDebugController } from "../src/controller"

/** 生成 RSA 私钥 PEM(用于主机密钥与客户端密钥)。 */
function rsaPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  return privateKey.export({ type: "pkcs1", format: "pem" }) as string
}

const HOST_KEY = rsaPem()
const CLIENT_KEY = rsaPem()
const PASSWORD = "secret"

interface TestServer {
  port: number
  close: () => void
}

/** 起一个真实 ssh2 Server：接受密码或任意公钥，exec 回显；命令含 boom 时退出码 1。 */
function startServer(): Promise<TestServer> {
  const server = new Server({ hostKeys: [HOST_KEY] }, (client) => {
    client
      .on("authentication", (ctx) => {
        if (ctx.method === "password" && ctx.password === PASSWORD) return ctx.accept()
        if (ctx.method === "publickey") return ctx.accept()
        ctx.reject(["password", "publickey"])
      })
      .on("ready", () => {
        client.on("session", (accept) => {
          const session = accept()
          session.once("exec", (acceptExec, _rejectExec, info) => {
            const stream = acceptExec()
            if (info.command.includes("boom")) {
              stream.stderr.write("remote exploded\n")
              stream.exit(1)
            } else {
              stream.write(`ran:${info.command}\n`)
              stream.exit(0)
            }
            stream.end()
          })
        })
      })
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      resolve({ port, close: () => server.close() })
    })
  })
}

let srv: TestServer
let keyDir: string
let clientKeyPath: string

beforeAll(async () => {
  srv = await startServer()
  keyDir = mkdtempSync(join(tmpdir(), "server-debug-ssh-"))
  clientKeyPath = join(keyDir, "id_rsa")
  await Bun.write(clientKeyPath, CLIENT_KEY)
})

afterAll(() => {
  srv.close()
  rmSync(keyDir, { recursive: true, force: true })
})

function passwordConn(): ServerConnection {
  return { host: "127.0.0.1", port: srv.port, user: "deploy", password: PASSWORD, logPaths: ["/var/log/app.log"] }
}

describe("buildConnectConfig(纯函数)", () => {
  test("密码认证：password 优先，不设 privateKey 与 hostVerifier", () => {
    const cfg = buildConnectConfig(passwordConn())
    expect(cfg.host).toBe("127.0.0.1")
    expect(cfg.username).toBe("deploy")
    expect(cfg.password).toBe(PASSWORD)
    expect(cfg.privateKey).toBeUndefined()
    expect(cfg.tryKeyboard).toBe(true)
    expect(cfg.readyTimeout).toBe(15_000)
    expect(cfg.hostVerifier).toBeUndefined()
  })

  test("密钥认证：无 password 时用 privateKey", () => {
    const cfg = buildConnectConfig({ host: "h", port: 22, user: "u", identityFile: "/k", logPaths: [] }, "PEMDATA")
    expect(cfg.password).toBeUndefined()
    expect(cfg.privateKey).toBe("PEMDATA")
  })
})

describe("createSshClient(真实 ssh2 Server，零 mock)", () => {
  test("密码认证 + verify + run", async () => {
    const client = await createSshClient()
    await client.verify(passwordConn())
    expect(await client.run(passwordConn(), "echo hi")).toContain("ran:echo hi")
    client.close()
  })

  test("密钥认证 + verify", async () => {
    const client = await createSshClient()
    const conn: ServerConnection = { host: "127.0.0.1", port: srv.port, user: "deploy", identityFile: clientKeyPath, logPaths: [] }
    await client.verify(conn)
    client.close()
  })

  test("密码错误抛 ServerDebugError", async () => {
    const client = await createSshClient()
    await expect(client.verify({ ...passwordConn(), password: "wrong" })).rejects.toBeInstanceOf(ServerDebugError)
    client.close()
  })

  test("远端命令退出码非 0 抛 ServerDebugError", async () => {
    const client = await createSshClient()
    await expect(client.run(passwordConn(), "boom")).rejects.toBeInstanceOf(ServerDebugError)
    client.close()
  })

  test("无密码且无密钥 → 直接报错，不发起连接", async () => {
    const client = await createSshClient()
    await expect(
      client.verify({ host: "127.0.0.1", port: srv.port, user: "deploy", logPaths: [] }),
    ).rejects.toThrow(/未提供密码或私钥/)
    client.close()
  })

  test("私钥文件不存在抛 ServerDebugError", async () => {
    const client = await createSshClient()
    await expect(
      client.verify({ host: "127.0.0.1", port: srv.port, user: "deploy", identityFile: "/no/such/key", logPaths: [] }),
    ).rejects.toThrow(/私钥文件不存在/)
    client.close()
  })

  test("close 幂等", async () => {
    const client = await createSshClient()
    await client.verify(passwordConn())
    client.close()
    expect(() => client.close()).not.toThrow()
  })
})

describe("controller 集成(假 SshClient 验证编排；末条走真实 SshClient 端到端)", () => {
  const SAMPLE_LOG = [
    "2024-01-15 10:00:00,000 [main] ERROR com.App - NullPointer",
    "java.lang.NullPointerException",
    "	at com.App.run(App.java:5)",
    "2024-01-15 10:00:01,000 [main] ERROR com.App - NullPointer",
    "java.lang.NullPointerException",
    "	at com.App.run(App.java:6)",
    "2024-01-15 10:00:02,000 [main] INFO heartbeat ok",
  ].join("\n")

  /** 用假 SshClient 验证控制器编排逻辑(不触网)。 */
  const fakeClient: SshClient = {
    async verify() {},
    async run(_c: ServerConnection, remoteCmd: string) {
      if (remoteCmd.startsWith("ls -l")) return "/var/log/app.log"
      if (remoteCmd.startsWith("tail -n 2000")) return SAMPLE_LOG
      if (remoteCmd.startsWith("sed -n")) return "context lines here"
      if (remoteCmd.startsWith("grep -n")) return "42:ERROR oom happened"
      return ""
    },
    close() {},
  }

  test("未连接时取日志返回引导提示", async () => {
    const controller = createServerDebugController({ createClient: async () => fakeClient })
    const out = await controller.getServerLogs({})
    expect(out).toContain("尚未连接")
  })

  test("连接→搜索→上下文→分析→断开 全链路", async () => {
    const controller = createServerDebugController({ createClient: async () => fakeClient })
    const connected = await controller.connect({
      host: "127.0.0.1",
      port: srv.port,
      user: "deploy",
      password: PASSWORD,
      logPaths: ["/var/log/app.log"],
    })
    expect(connected).toContain("/var/log/app.log")
    expect(controller.isConnected()).toBe(true)

    const groups = JSON.parse(await controller.searchErrors({}))
    expect(groups).toHaveLength(1)
    expect(groups[0].count).toBe(2)

    const ctx = await controller.getContext({ path: "/var/log/app.log", match: "oom" })
    expect(ctx).toBe("context lines here")

    const analysis = await controller.analyze({})
    expect(analysis).toContain("类错误")
    expect(analysis).toContain("建议下一步")

    expect(controller.disconnect()).toBe(true)
    expect(controller.isConnected()).toBe(false)
  })

  test("真实端到端：默认 createSshClient 连接远端并断开", async () => {
    const controller = createServerDebugController()
    const connected = await controller.connect({
      host: "127.0.0.1",
      port: srv.port,
      user: "deploy",
      password: PASSWORD,
      logPaths: ["/var/log/app.log"],
    })
    expect(connected).toContain("已通过 SSH 连接")
    expect(controller.isConnected()).toBe(true)
    expect(controller.disconnect()).toBe(true)
    expect(controller.isConnected()).toBe(false)
  })
})
