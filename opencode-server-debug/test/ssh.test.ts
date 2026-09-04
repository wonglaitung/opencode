import { describe, expect, test } from "bun:test"
import { createSshClient, pickWindowsExecutable, resolveSshBinary, type CommandRunner, type ServerConnection } from "../src/ssh"
import { ServerDebugError } from "../src/errors"
import { createServerDebugController } from "../src/controller"

const conn: ServerConnection = {
  host: "10.0.0.5",
  port: 22,
  user: "deploy",
  password: "secret",
  logPaths: ["/var/log/app.log"],
}

describe("pickWindowsExecutable", () => {
  test("win32 where 多行结果按扩展名优先级选 .exe", () => {
    expect(pickWindowsExecutable(["C:\\a\\ssh.exe", "C:\\b\\ssh.cmd"])).toBe("C:\\a\\ssh.exe")
    expect(pickWindowsExecutable(["ssh.cmd", "ssh.exe"])).toBe("ssh.exe")
  })

  test("无扩展名时兜底首行", () => {
    expect(pickWindowsExecutable(["ssh"])).toBe("ssh")
  })

  test("空列表返回 null", () => {
    expect(pickWindowsExecutable([])).toBeNull()
  })
})

describe("resolveSshBinary", () => {
  test("which 返回首行路径", async () => {
    const runner: CommandRunner = async (cmd) =>
      cmd[0] === "which" ? { stdout: "/usr/bin/ssh\n", stderr: "", exitCode: 0 } : { stdout: "", stderr: "", exitCode: 1 }
    expect(await resolveSshBinary(runner)).toBe("/usr/bin/ssh")
  })

  test("找不到客户端抛 ServerDebugError", async () => {
    const runner: CommandRunner = async () => ({ stdout: "", stderr: "", exitCode: 0 })
    await expect(resolveSshBinary(runner)).rejects.toBeInstanceOf(ServerDebugError)
  })
})

describe("createSshClient", () => {
  function sshFakeRunner(handler: (cmd: string[], opts: { stdin?: string }) => { stdout: string; stderr: string; exitCode: number }): CommandRunner {
    return async (cmd, options) => {
      if (cmd[0] === "which" || cmd[0] === "where") return { stdout: "/usr/bin/ssh", stderr: "", exitCode: 0 }
      return handler(cmd, options)
    }
  }

  test("run 返回远端 stdout", async () => {
    const client = await createSshClient(sshFakeRunner(() => ({ stdout: "hello", stderr: "", exitCode: 0 })))
    expect(await client.run(conn, "cat /x")).toBe("hello")
  })

  test("密码经 stdin 传入且禁用公钥认证", async () => {
    let capturedStdin: string | undefined
    let capturedCmd: string[] = []
    const client = await createSshClient(
      sshFakeRunner((cmd, opts) => {
        capturedCmd = cmd
        capturedStdin = opts.stdin
        return { stdout: "__server_debug_ok__", stderr: "", exitCode: 0 }
      }),
    )
    await client.verify({ ...conn, password: "secret" })
    expect(capturedStdin).toBe("secret")
    expect(capturedCmd).toContain("PreferredAuthentications=password")
    expect(capturedCmd).toContain("PubkeyAuthentication=no")
  })

  test("退出码非 0 抛 ServerDebugError", async () => {
    const client = await createSshClient(sshFakeRunner(() => ({ stdout: "", stderr: "perm denied", exitCode: 255 })))
    await expect(client.run(conn, "x")).rejects.toBeInstanceOf(ServerDebugError)
  })

  test("verify 探针不符预期抛错", async () => {
    const client = await createSshClient(sshFakeRunner(() => ({ stdout: "unexpected", stderr: "", exitCode: 0 })))
    await expect(client.verify(conn)).rejects.toBeInstanceOf(ServerDebugError)
  })
})

describe("controller 集成(零 mock,假 SshClient)", () => {
  const SAMPLE_LOG = [
    "2024-01-15 10:00:00,000 [main] ERROR com.App - NullPointer",
    "java.lang.NullPointerException",
    "	at com.App.run(App.java:5)",
    "2024-01-15 10:00:01,000 [main] ERROR com.App - NullPointer",
    "java.lang.NullPointerException",
    "	at com.App.run(App.java:6)",
    "2024-01-15 10:00:02,000 [main] INFO heartbeat ok",
  ].join("\n")

  const fakeClient = {
    async verify() {},
    async run(_c: ServerConnection, remoteCmd: string) {
      if (remoteCmd.startsWith("ls -l")) return "/var/log/app.log"
      if (remoteCmd.startsWith("tail -n 2000")) return SAMPLE_LOG
      if (remoteCmd.startsWith("sed -n")) return "context lines here"
      if (remoteCmd.startsWith("grep -n")) return "42:ERROR oom happened"
      return ""
    },
  }

  test("未连接时取日志返回引导提示", async () => {
    const controller = createServerDebugController({ createClient: async () => fakeClient as any })
    const out = await controller.getServerLogs({})
    expect(out).toContain("尚未连接")
  })

  test("连接→搜索→上下文→分析→断开 全链路", async () => {
    const controller = createServerDebugController({ createClient: async () => fakeClient as any })
    const connected = await controller.connect(conn)
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
})
