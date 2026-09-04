# opencode-server-debug

OpenCode 按需远程服务器日志调试插件：用自然语言让 Agent 经 SSH 连接远端 Linux 服务器、拉取日志文件、聚类错误、查看错误上下文并汇总分析。
**零运行时依赖**（SSH 走系统 OpenSSH 客户端 + bun 原生 spawn）、**对 OpenCode 上游零修改**（比照 opencode-edge-debug）。

## 功能

| 工具 | 说明 |
|---|---|
| `connect_server` | 经 SSH（密码或密钥）连接远端 Linux 并建立日志调试会话（可指定日志文件路径列表） |
| `disconnect_server` | 断开会话、清空内存连接与日志缓冲（未连接时仅提示，不报错） |
| `get_server_logs` | 获取日志文件最近内容，可按级别/子串/时间前缀过滤（最近 2 万字符截断） |
| `search_server_errors` | 在最近窗口内搜索 ERROR/FATAL 与异常堆栈，按错误签名聚类（去重计数、首末出现、样例） |
| `get_log_context` | 按行号或子串定位一条日志，返回其前后若干行上下文（对标 get_browser_response_detail） |
| `analyze_server_errors` | 汇总分析：按类型归类计数、时间分桶标出突增尖峰、根因排序（含模块与 `get_log_context` 建议）、各类型样例堆栈 |

典型用法（直接在 OpenCode 会话中说）：

> 连上 10.0.0.5，用户 deploy，密码 xxx，日志在 /var/log/app/app.log
> 看一下最近的错误日志有没有报错
> 把 NullPointerException 那条的上下文前后 20 行拉出来
> 分析一下最近一小时的错误，按类型归类

## 前置条件

- 本地已安装 OpenSSH 客户端：Linux/macOS 通常自带；Windows 需「设置 → 可选功能 → OpenSSH 客户端」（Win10 1809+）。
- 远端为 Linux，日志为文件（log4j 等带时间戳与级别的文本格式最佳）。

## 启用

在项目 `opencode.json` 中加入：

```json
{
  "plugin": ["./opencode-server-debug"]
}
```

首次使用前在本目录安装开发依赖（运行期无依赖，仅 dev 依赖）：

```bash
cd opencode-server-debug
bun install
```

移除该条目即可完全卸载，不改变上游任何行为。

## 隐私与安全

- **连接信息（地址/用户/密码）仅存内存**：由 `connect_server` 传入，存于插件闭包；`disconnect_server` 与插件卸载（`dispose`）即清空，**退出 OpenCode 即失，绝不落盘、绝不上行**。
- 密码经 SSH stdin 喂入，不进进程参数、不被记录；密钥路径同理不打印。
- 日志按需拉取，v1 不在本地持久化。

## 已知限制（v1）

- 远端过滤依赖系统命令（`tail`/`grep`/`sed`/`ls`），假设为常见 GNU 工具链。
- 错误聚类为启发式（按异常类型/首消息签名去重，折叠数字与十六进制），不解析完整调用链。
- `since` 为时间前缀子串过滤（如 `2024-01-15 10:`），非精确时间窗。
- 单次错误搜索拉取最近 `2000` 行（见 `logs.ts` 的 `ERROR_SEARCH_WINDOW`）在本地聚类。

## 开发

```bash
bun test            # 测试（零 mock；ssh 用注入 runner，logs 用纯函数）
bun run typecheck   # tsc 类型检查（strict）
bun run build:plugin  # 编译为自包含 JS → dist/plugin
bun run pack:bundle  # 打成可移植 tarball（含 node_modules，内网/离线分发）
```

> `pack:bundle` 生成的 `setup.sh` / `setup.ps1` 仅是**可选的环境自检脚本**——只打印 bun / `@opencode-ai/plugin` / `ssh` 是否就绪的检查项，**不安装任何东西**。内网/离线机解压后，直接把 `opencode.json` 的 `plugin` 指向解压目录即可使用，**无需运行** `setup.sh`；只有想预先确认环境时才跑它。
```

- 工程规约见 [AGENTS.md](./AGENTS.md)；架构与决策记录见 [docs/design.md](./docs/design.md)。
- 跨插件通用开发规范见 [../plugin-guide/plugin-dev-guide.md](../plugin-guide/plugin-dev-guide.md)。
