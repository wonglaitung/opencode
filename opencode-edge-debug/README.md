# opencode-edge-debug

OpenCode 按需 Edge 浏览器调试插件：用自然语言让 Agent 启动带调试端口的 Microsoft Edge、
抓取页面 Console 与网络日志、安全关闭浏览器。**零重型框架**（无 Playwright/Puppeteer）、
**零运行时依赖**（CDP 客户端由 bun 原生 WebSocket + fetch 实现）。

## 功能

| 工具 | 说明 |
|---|---|
| `start_edge_browser` | 启动 Edge 并建立 Console/Network 调试监听（可指定 URL，默认 `http://localhost:3000`） |
| `close_edge_browser` | 优雅关闭浏览器与调试监听（未运行时仅提示，不报错） |
| `get_browser_console_logs` | 获取页面 console 日志与未捕获异常（最近 50 条） |
| `get_browser_network_logs` | 获取网络请求日志：仅 4xx/5xx 错误与疑似 API 请求（最近 50 条） |

典型用法（直接在 OpenCode 会话中说）：

> 打开 Edge，地址 http://localhost:5173
> 帮我看看页面的控制台日志有没有报错
> 查一下网络请求，有没有失败的 API 调用
> 关闭 Edge

## 前置条件

- 已安装 Microsoft Edge（linux 需 `microsoft-edge` / `microsoft-edge-stable` / `microsoft-edge-dev` 在 PATH 中）。
- 端口 9222 未被占用（若已被其他调试实例占用，插件会直接复用该实例）。

## 启用

在项目的 `opencode.json` 中加入：

```json
{
  "plugin": ["./opencode-edge-debug"]
}
```

首次使用前在本目录安装开发依赖（运行期无依赖，仅 peer/dev 依赖）：

```bash
cd opencode-edge-debug
bun install
```

移除该条目即可完全卸载，不改变上游任何行为。

## 开发

```bash
bun test            # 测试（零 mock，Bun.serve 假 CDP 服务真实验证）
bun run typecheck   # tsc 类型检查
```

- 工程规约见 [CLAUDE.md](./CLAUDE.md)；架构与决策记录见 [docs/design.md](./docs/design.md)。
- 跨插件通用开发规范见 [../opencode-session-mgmt/docs/plugin-dev-guide.md](../opencode-session-mgmt/docs/plugin-dev-guide.md)。

## 隐私

日志仅存内存环形缓冲（每类最多 50 条），插件进程退出即失；无任何数据上行、无落盘。
浏览器使用专用 profile（`<项目>/.opencode/edge-debug/profile`），与日常浏览数据隔离。

## 已知限制（v1）

- 仅监听启动时打开的单个页面 target，新开标签页不监听。
- 调试端口固定 9222，网络降噪规则为内置启发式。
