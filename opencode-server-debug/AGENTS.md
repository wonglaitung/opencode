# opencode-server-debug

OpenCode 按需远程服务器日志调试插件：自然语言经 SSH 拉取/分析远端 Linux 日志文件，零运行时依赖、对上游零修改，以便持续同步上游更新。

## 铁律（破坏则同步上游必冲突）

- **不修改 `packages/*` 下任何上游文件**，也不改仓库根目录的 `CLAUDE.md` 等上游文件——根 CLAUDE.md 是上游的，本文件才是本工程的。
- 所有定制产出只落在定制目录内：`opencode-server-debug/`（本工程）。
- 本目录是独立 bun 工程，**不被上游根 workspace 收录**（上游 glob 为 `packages/*` 等，不匹配本路径）；改动后须确认上游根 `package.json` 的 workspace glob 仍不匹配本目录。

## 已定案，勿重议（详见 docs/design.md）

- **零依赖 SSH 执行层**（决策记录 D1）：直接 `Bun.spawn` 调系统 OpenSSH 客户端，不引入 `ssh2`/`node-ssh`；密码经 stdin 喂入（不进进程参数）。
- **跨平台二进制定位**（plugin-guide 7）：win32 用 `where` 多行结果按扩展名优先级选 `.exe`（`.cmd`/`.bat` 兜底），跳过无后缀行；spawn 用 args 数组（不用 `shell:true`）规避 cmd 引号陷阱。
- **连接信息仅存内存、退出即失**（设计文档 6）：地址/用户/密码由 `connect_server` 入参传入、存于闭包；`disconnect_server`/`dispose` 清空；**绝不落盘、绝不上行**。对应无 `config.json`、无 sqlite store。
- **日志解析为纯函数层**（设计文档 3.2/3.3）：`parseLogEvents` 聚合多行堆栈、`detectLevel` 识别级别、`groupErrors` 按签名聚类、`truncateText` 统一截断（2 万字符）。复杂正则与边界逻辑均注释设计取舍。
- **错误搜索在本地聚类**：远端仅 `tail` 拉取最近窗口（`ERROR_SEARCH_WINDOW=2000`），聚类/过滤在本地完成（设计文档 3.3）。
- **外部进程静默化**（plugin-guide 7）：capture stdout 入缓冲，stderr 捕获后仅本地日志、不泄到上游 TUI；ssh 卡死兜底用 win32 `taskkill /T /F`(stdio:"ignore") + posix 杀进程组。
- **D4 分析增强(阶段 2)**：analyze 增加时间分桶(标尖峰)、根因排序、模块维度、get_log_context 建议，全部 logs.ts 纯函数。
- **D5 打包分发(阶段 2)**：pack:bundle 镜像 edge-debug，hoisted 打可移植 tarball，setup 校验 ssh(而非 Edge)；以 AGENTS.md 为权威文档。

## 结构

```
src/
├── index.ts        # 插件入口：仅 default export 插件函数；组装 controller，返回 { tool, dispose }
├── errors.ts       # ServerDebugError：可预期失败，中文消息含修复路径
├── ssh.ts          # SSH 执行器：resolveSshBinary(纯函数)/buildSshArgs/createBunRunner/可注入 CommandRunner
├── logs.ts         # 纯函数层：log4j 解析、级别识别、事件聚合、错误聚类、环形缓冲、截断、远端命令构造
└── controller.ts   # createServerDebugController：connect→verify→活动会话;闭包持有连接与缓冲;dispose 兜底清空
test/
├── logs.test.ts    # 纯函数全覆盖（中文用例名）
└── ssh.test.ts     # 注入假 CommandRunner + 假 SshClient 零 mock 契约测试
```

## 技术约定

- bun 直接跑 TS；TypeScript strict，新代码零 `any`。
- **零运行时依赖**：package.json 不得出现 dependencies；新增任何依赖须先论证必要性（首选原生实现）。
- `bun test` 跑测试，测试在 `test/*.test.ts`，**零 mock**（ssh 用注入 runner、controller 用假 SshClient 验证真实逻辑）。
- `bun run typecheck` 走 `tsc -p .`（独立 tsconfig，不引上游）。
- 插件 Hook 基于 `@opencode-ai/plugin` 的 `Hooks` 接口——**同步上游后优先核对 tool/参数签名**；experimental hook 若将来引入，须集中于单一适配文件。
- **入口文件只允许 default export**：上游 legacy loader 遍历模块全部导出，其他命名导出会导致「Plugin export is not a function」加载失败。工具经 `tool()` + `tool.schema`(zod) 注册，key 即工具名。

## 文档与语言

- 设计文档、注释、commit message 用**中文**；conventional commit 格式（本仓库历史可参照）。
- **任何文档与注释都不要用 `§` 符号**引用章节，一律用纯文字（「3.4 节」或裸编号「见 3.4」）。
- 行为变更须同步更新 `docs/design.md`（含 mermaid 架构图）与本文件「已定案」清单。
