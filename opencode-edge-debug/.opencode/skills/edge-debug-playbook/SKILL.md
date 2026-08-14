---
name: edge-debug-playbook
description: Use when developing, debugging, or troubleshooting the Edge browser debugging plugin (edge-debug, CDP, start_edge_browser, console logs, network logs) in the opencode-edge-debug project — runtime behavior, common failure modes, and how to test against real Edge.
---

# Edge 调试插件开发手册

关键运行时事实与踩坑点，开发/排障时使用。

## 运行时模型

- 插件用 bun 原生 WebSocket + fetch 实现极简 CDP 客户端（命令 id 配对、事件订阅、超时），零运行时依赖。
- 调试端口固定 `9222`：启动前先 `probeVersion(9222)`，已有实例直接复用（幂等），否则才拉起新实例。
- **专用 user-data-dir 是正确性必需**（决策记录 D2）：用户日常 Edge 已运行时，共用默认 profile 开不出调试端口（Chromium 单实例机制）。profile 落在 `<会话项目目录>/.opencode/edge-debug/profile`。
- Edge 二进制按平台定位：linux 按 `microsoft-edge` / `microsoft-edge-stable` / `microsoft-edge-dev` 顺序查 PATH；找不到抛带安装指引的中文 `EdgeDebugError`。
- 日志仅在内存环形缓冲（每类最多 50 条），进程退出即失；无任何上行/落盘。

## 关键协议细节

- Console 用 `Runtime.consoleAPICalled`（`Console.messageAdded` 已被现代 Chromium 废弃）。
- 网络 method 经 `Network.requestWillBeSent` 补全（`responseReceived` 不携带 method）。
- 网络日志降噪：只保留 4xx/5xx 与疑似 API 请求（URL 含 `/api/` 或 MIME 含 json）。

## 常见故障模式

| 现象 | 原因 / 排查 |
|---|---|
| 开不出调试端口 | 端口被占用则复用；共用默认 profile 被单实例机制挡住 → 用专用 profile |
| 浏览器没起来 / 抛安装指引错误 | 二进制不在 PATH → 检查 `microsoft-edge*` 是否安装且入 PATH |
| 关闭不彻底 | 先 CDP `Browser.close`，失败才杀进程树（posix 杀进程组、win32 `taskkill /T /F`） |
| 新标签页无日志 | v1 只监听启动时 attach 的单个 page target，属已知限制 |
| 插件加载失败 | `src/index.ts` 有命名导出被 legacy loader 当插件工厂 → 只保留 default export |

## 开发验证

- 测试零 mock：`test/cdp.test.ts` 用 `Bun.serve` 假 CDP 服务 + 真实 WebSocket 验证。
- 真机验证：`bun test`、`bun run typecheck` 后，在会话里让 Agent 依次「打开 Edge → 查 console → 查网络 → 关闭」。
- 清理残留：profile 与日志均在 `<项目>/.opencode/edge-debug/`，可整体删除。

## 打包

`bun run build:plugin` 编自包含 JS；`bun run pack:bundle` 出可移植 tarball（含 hoisted 依赖与离线 seed）。
