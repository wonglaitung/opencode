# opencode-edge-debug

OpenCode 按需 Edge 浏览器调试插件：用自然语言让 Agent 启动带调试端口的 Microsoft Edge、
抓取页面 Console 与网络日志、主动读取页面信息（DOM/JS 状态/存储）、查看网络请求详情、安全关闭浏览器。
**零重型框架**（无 Playwright/Puppeteer）、**零第三方运行时依赖**（CDP 客户端由 bun 原生 WebSocket + fetch 实现，
核心逻辑抽为仓库内自研共享包 `edge-debug-core`）。

## 功能

| 工具 | 说明 |
|---|---|
| `start_edge_browser` | 启动 Edge 并建立 Console/Network 调试监听（可指定 URL，默认 `http://localhost:3000`） |
| `close_edge_browser` | 优雅关闭浏览器与调试监听（未运行时仅提示，不报错） |
| `get_browser_console_logs` | 获取页面 console 日志与未捕获异常（最近 50 条） |
| `get_browser_network_logs` | 获取网络请求日志：仅 4xx/5xx 错误与疑似 API 请求（最近 50 条，条目含 requestId） |
| `evaluate_in_page` | 在页面上下文执行任意 JS（支持 await），读取 DOM/JS 状态/localStorage、带页面凭证重放接口等；结果超 2 万字符截断 |
| `get_page_info` | 获取页面元信息：URL、标题、readyState、视口尺寸 |
| `get_page_text` | 获取页面正文可见文本（`body.innerText`，截断） |
| `get_browser_response_detail` | 按 requestId 查看单条网络请求详情：请求/响应头、请求体、响应体（二进制只给大小） |

典型用法（直接在 OpenCode 会话中说）：

> 打开 Edge，地址 http://localhost:5173
> 帮我看看页面的控制台日志有没有报错
> 看看页面现在渲染了什么内容
> 页面里 `window.__INITIAL_STATE__` 是什么
> 查一下网络请求，有没有失败的 API 调用；把那个 500 的请求头和响应体拿出来
> 关闭 Edge

## 代码结构

- `src/index.ts`：插件入口与 8 个工具定义（只保留 default export）。
- `../edge-debug-core/src/`：共享 Edge/CDP 核心（启动/关闭、日志、页面求值、请求详情），
  本插件与 `opencode-session-mgmt` 的 websec 桥接共用。

## 采集策略

默认调试模式仍只保留 4xx/5xx 与疑似 API（工具只展示最近 50 条）。通过 `edge-debug-core` 的
`NetworkCapturePolicy` 可切换为 websec 模式：

- 内部缓冲 500 条
- 保留同源 2xx `Document` / `XHR` / `Fetch`、3xx、4xx/5xx
- 脚本/样式/图片/字体只留元数据，不拉正文
- 可按 origin 白名单限制采集范围

`opencode-session-mgmt` 的 `websec_edge_capture` 会自动启用该策略。

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

> 从零到能用的完整安装、验证与排查见 [docs/deployment.md](./docs/deployment.md)。

## 开发

```bash
bun test            # 测试（零 mock，Bun.serve 假 CDP 服务真实验证）
bun run typecheck   # tsc 类型检查
bun run build:plugin  # 编译为自包含 JS → dist/plugin/index.js
bun run pack:bundle   # 打成可移植 tarball → dist/opencode-edge-debug-bundle-<版本>.tgz
```

- 工程规约见 [CLAUDE.md](./CLAUDE.md)；架构与决策记录见 [docs/design.md](./docs/design.md)。
- 跨插件通用开发规范见 [../plugin-guide/plugin-dev-guide.md](../plugin-guide/plugin-dev-guide.md)。

## 隐私

日志仅存内存环形缓冲（每类最多 50 条），插件进程退出即失；无任何数据上行、无落盘。
浏览器使用专用 profile（`<项目>/.opencode/edge-debug/profile`），与日常浏览数据隔离。

## 已知限制（v1）

- 仅监听启动时打开的单个页面 target，新开标签页不监听（`evaluate_in_page` 等主动读取同理）。
- 调试端口固定 9222，网络降噪规则为内置启发式。
- `Set-Cookie` 等响应头可能缺失（Chromium 拆分到 extraInfo，未合并）；HttpOnly Cookie 读不到。
- 无截图；WebSocket 帧不采集；部分流式/二进制请求的请求体在 CDP 事件中缺省。
