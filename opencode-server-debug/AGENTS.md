# opencode-server-debug

OpenCode 按需远程服务器日志调试插件：自然语言经 SSH 拉取/分析远端 Linux 日志文件，对上游零修改，以便持续同步上游更新。SSH 由 `ssh2` 库在进程内完成（运行时依赖仅 `ssh2`）。

## 铁律（破坏则同步上游必冲突）

- **不修改 `packages/*` 下任何上游文件**，也不改仓库根目录的 `CLAUDE.md` 等上游文件——根 CLAUDE.md 是上游的，本文件才是本工程的。
- 所有定制产出只落在定制目录内：`opencode-server-debug/`（本工程）。
- 本目录是独立 bun 工程，**不被上游根 workspace 收录**（上游 glob 为 `packages/*` 等，不匹配本路径）；改动后须确认上游根 `package.json` 的 workspace glob 仍不匹配本目录。

## 已定案，勿重议（详见 docs/design.md）

- **进程内 SSH 执行层**（决策记录 D1，修订）：用 `ssh2` 库在进程内完成 SSH，不 spawn 系统 ssh。原因：Win32-OpenSSH 只读控制台、忽略管道 stdin，旧「spawn + 管道喂密码」在 Windows 上会弹密码提示并永久挂起。**安装必须 `--omit=optional`（或 `bunfig.toml: optional=false`）跳过 ssh2 的原生可选依赖 `cpu-features`**——其在 Bun 下会崩溃；纯 JS 路径即可正常工作。
- **连接信息仅存内存、退出即失**（设计文档 6）：地址/用户/密码/私钥由 `connect_server` 入参传入、存于闭包；`disconnect_server`/`dispose` 清空并 `close()` 断开；**绝不落盘、绝不上行**。对应无 `config.json`、无 sqlite store。
- **日志解析为纯函数层**（设计文档 3.2/3.3）：`parseLogEvents` 聚合多行堆栈、`detectLevel` 识别级别、`groupErrors` 按签名聚类、`truncateText` 统一截断（2 万字符）。复杂正则与边界逻辑均注释设计取舍。
- **错误搜索在本地聚类**：远端仅 `tail` 拉取最近窗口（`ERROR_SEARCH_WINDOW=2000`），聚类/过滤在本地完成（设计文档 3.3）。
- **无外部进程**：SSH 在进程内完成（ssh2），不再 spawn ssh、无控制台交互提示风险；命令 stderr 截断后仅随错误消息本地呈现，不泄到上游 TUI。
- **D4 分析增强(阶段 2)**：analyze 增加时间分桶(标尖峰)、根因排序、模块维度、get_log_context 建议，全部 logs.ts 纯函数。
- **D5 打包分发(阶段 2)**：pack:bundle 镜像 edge-debug，hoisted 打可移植 tarball，setup 校验 `node_modules/ssh2`(而非系统 ssh)；以 AGENTS.md 为权威文档。

## 结构

```
src/
├── index.ts        # 插件入口：仅 default export 插件函数；组装 controller，返回 { tool, dispose }
├── errors.ts       # ServerDebugError：可预期失败，中文消息含修复路径
├── ssh.ts          # SSH 执行器（ssh2 库）：buildConnectConfig(纯函数)/createSshClient(持久连接/握手+命令超时/键盘交互)/close
├── logs.ts         # 纯函数层：log4j 解析、级别识别、事件聚合、错误聚类、环形缓冲、截断、远端命令构造
└── controller.ts   # createServerDebugController：connect→verify→活动会话;闭包持有连接与缓冲;dispose 兜底清空并 close
test/
├── logs.test.ts    # 纯函数全覆盖（中文用例名）
└── ssh.test.ts     # 真实 ssh2.Server 集成（密码/密钥/错误密码/退出码/缺凭证/超时）+ buildConnectConfig 纯函数
```

## 技术约定

- bun 直接跑 TS；TypeScript strict，新代码零 `any`。
- **运行时依赖仅 `ssh2`**：在进程内完成 SSH（见 D1）。安装须 `--omit=optional`（或 `bunfig.toml: optional=false`）跳过会崩 Bun 的原生可选依赖 `cpu-features`。新增其它依赖须先论证必要性。
- `bun test` 跑测试，测试在 `test/*.test.ts`，**零 mock**：ssh 层用 ssh2 自带 `Server` 起真实进程内 SSH 服务验证，controller 用假 SshClient 验证编排。
- `bun run typecheck` 走 `tsc -p .`（独立 tsconfig，不引上游）。
- 插件 Hook 基于 `@opencode-ai/plugin` 的 `Hooks` 接口——**同步上游后优先核对 tool/参数签名**；experimental hook 若将来引入，须集中于单一适配文件。
- **入口文件只允许 default export**：上游 legacy loader 遍历模块全部导出，其他命名导出会导致「Plugin export is not a function」加载失败。工具经 `tool()` + `tool.schema`(zod) 注册，key 即工具名。

## 文档与语言

- 设计文档、注释、commit message 用**中文**；conventional commit 格式（本仓库历史可参照）。
- **任何文档与注释都不要用 `§` 符号**引用章节，一律用纯文字（「3.4 节」或裸编号「见 3.4」）。
- 行为变更须同步更新 `docs/design.md`（含 mermaid 架构图）与本文件「已定案」清单。
