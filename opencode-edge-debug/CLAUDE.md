# opencode-edge-debug

OpenCode 按需 Edge 浏览器调试插件：自然语言启动/关闭带调试端口的 Edge，抓取页面 Console 与网络日志。
零重型框架（不引入 Playwright/Puppeteer）、零运行时依赖（CDP 用 bun 原生 WebSocket + fetch 实现），
对 OpenCode 上游**零修改**，以便持续同步上游更新。

## 铁律（破坏则同步上游必冲突）

- **不修改 `packages/*` 下任何上游文件**，也不改仓库根目录的 `CLAUDE.md` 等上游文件——根 CLAUDE.md 是上游的，本文件才是本工程的。
- 所有定制产出只落在定制目录内：`opencode-edge-debug/`（本工程）与 `opencode-session-mgmt/`（姊妹插件工程）。
- 本目录是独立 bun 工程，**不被上游根 workspace 收录**（上游 glob 为 `packages/*` 等，不匹配本路径）；改动后须确认上游根 `package.json` 的 workspace glob 仍不匹配本目录。
- 上游同步策略：**日常 `git pull` 只同步 `origin`（wonglaitung/opencode），不要主动同步 anomalyco/opencode**；仅当明确要求「同步上游」时才按 `../opencode-session-mgmt/docs/upstream-sync.md` 手工执行。

## 已定案，勿重议（详见 docs/design.md）

- **CDP 通信层零依赖自研**：bun 原生 WebSocket + fetch 实现极简客户端（命令 id 配对、事件订阅、超时），不引入 chrome-remote-interface 等依赖（决策记录 D1）。
- **专用 user-data-dir 是正确性必需**：用户已有 Edge 在运行时，共用默认 profile 开不出调试端口；profile 落在 `<会话项目目录>/.opencode/edge-debug/profile`（决策记录 D2）。
- **关闭走优雅路径**：先 CDP `Browser.close`，失败才杀进程树（posix 杀进程组、win32 `taskkill /T /F`）（决策记录 D3）。
- **Console 用 `Runtime.consoleAPICalled`**（`Console.messageAdded` 已被现代 Chromium 废弃）；网络 method 经 `Network.requestWillBeSent` 补全（`responseReceived` 不携带 method）。
- **网络日志降噪**：只保留 4xx/5xx 与疑似 API 请求（URL 含 `/api/` 或 MIME 含 json），每类日志环形缓冲最多 50 条。
- **v1 只监听启动时 attach 的单个 page target**，新开标签页不监听（设计文档 7）。
- **隐私**：日志仅存内存环形缓冲，进程退出即失，无任何上行/落盘。

## 结构

```
src/
├── index.ts        # 插件入口：仅 default export 插件函数；组装 controller，返回 { tool, dispose }
├── errors.ts       # EdgeDebugError：可预期失败，中文消息含修复路径
├── cdp.ts          # 极简 CDP 客户端 + HTTP 助手（probeVersion/getPageTargetWsUrl/waitForCdp）
├── browser.ts      # Edge 进程管理：三平台二进制定位、spawn（专用 profile、detached）、进程树清理
├── logs.ts         # 纯函数层：环形缓冲、网络降噪过滤、console 参数序列化
└── controller.ts   # createEdgeDebugController：launch→attach→listen→close 幂等编排
test/
├── logs.test.ts    # 纯函数全覆盖
└── cdp.test.ts     # Bun.serve 假 CDP 服务，真实 WebSocket 验证
```

每个源文件头注释注明对应 docs/design.md 章节，实现前先读该章节。

## 技术约定

- bun 直接跑 TS；TypeScript strict，新代码零 `any`。
- **零运行时依赖**：package.json 不得出现 dependencies；新增任何依赖须先论证必要性（首选原生实现）。
- `bun test` 跑测试，测试在 `test/*.test.ts`，**零 mock**（用 Bun.serve 等真实实现验证）。
- `bun run typecheck` 走 tsc（tsconfig 独立，不引 session-mgmt）。
- 插件 Hook 基于 `@opencode-ai/plugin` 的 `Hooks` 接口——**同步上游后优先核对 hook/tool 签名**；experimental hook 若将来引入，须集中于单一适配文件。
- **入口文件只允许 default export**：上游 legacy loader 遍历模块全部导出，其他命名导出会导致「Plugin export is not a function」加载失败。工具经 `tool()` + `tool.schema` 注册，key 即工具名。

## 文档与语言

- 设计文档、注释、commit message 用**中文**；conventional commit 格式（本仓库历史可参照）。
- **任何文档与注释都不要用 `§` 符号**引用章节，一律用纯文字（「3.4 节」或裸编号「见 3.4」）。
- 行为变更须同步更新 `docs/design.md`（含 mermaid 架构图）与本文件「已定案」清单。
