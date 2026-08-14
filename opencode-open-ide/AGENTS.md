# opencode-open-ide

OpenCode 打开 IDE 插件：自然语言拉起 VS Code / IntelliJ IDEA，可打开项目目录或定位到指定文件的指定行，便于开发者手工查看/修改 AI 生成的代码。
零运行时依赖、跨平台（win32 / darwin / linux），对 OpenCode 上游**零修改**，以便持续同步上游更新。

## 铁律（破坏则同步上游必冲突）

- **不修改 `packages/*` 下任何上游文件**，也不改仓库根目录的 `CLAUDE.md` 等上游文件——根 CLAUDE.md 是上游的，本文件才是本工程的。
- 所有定制产出只落在定制目录内：`opencode-open-ide/`（本工程）、`opencode-edge-debug/`、`opencode-session-mgmt/`（姊妹插件工程）。
- 本目录是独立 bun 工程，**不被上游根 workspace 收录**（上游 glob 为 `packages/*` 等，不匹配本路径）；改动后须确认上游根 `package.json` 的 workspace glob 仍不匹配本目录。
- 上游同步策略：**日常 `git pull` 只同步 `origin`（wonglaitung/opencode），不要主动同步 anomalyco/opencode**；仅当明确要求「同步上游」时才按 `../opencode-session-mgmt/docs/upstream-sync.md` 手工执行。

## 已定案，勿重议（详见 docs/design.md）

- **配置在插件目录内**：`config.json` 放插件根（用户直接编辑），`order` 定探测次序、`tools` 覆盖/新增工具；插件加载时经 `import.meta.dir` 上溯读取一次。**不是** opencode.json 的插件 options。
- **内置预设最小集**：`vscode`（binary `code`）与 `idea`（binary 按平台 `idea`/`idea.sh`/`idea64.exe`）；默认 `order: ["vscode", "idea"]`。cursor/code-insiders/pycharm 等按需在 config.json 自配，不内置。
- **kind 决定定位语法**：`vscode` 用 `-g <path>:<line>[:<col>]`；`idea` 用 `--line <n> [--column <n>] <path>`（官方 CLI 文档已核实）。
- **探测失败即报错**：全部候选不可用抛中文错误（含安装指引），不静默降级。
- **启动即忘**：`spawn` 带 `detached + stdio:ignore + unref()`，daemon 不挂起；**dispose 不杀 IDE**（IDE 由用户自主关闭，区别于 Edge 调试实例）。
- **兜底**：config.json 缺失/字段缺失 → 内置预设；无效 JSON 记 warning 回退默认，不崩溃。

## 结构

```
src/
├── index.ts        # 插件入口：仅 default export；读 config.json 注册 open_ide 工具
├── errors.ts       # OpenIdeError：可预期失败，中文消息含修复路径
├── presets.ts      # 内置 registry（vscode + idea，kind 与跨平台候选）
├── config.ts       # 读取/合并 config.json（覆盖预设、兜底默认，只读一次）
└── ide.ts          # 纯函数：二进制定位（which/where 可注入）、CLI 参数构造、spawn
test/
└── ide.test.ts     # config 合并 / 参数构造 / 探测顺序（注入假探针，零 mock）
docs/
├── design.md       # 设计文档（架构图 + 决策记录）
└── deployment.md   # 部署手册
```

## 技术约定

- bun 直接跑 TS；TypeScript strict，新代码零 `any`。
- **零运行时依赖**：package.json 不得出现 dependencies；新增任何依赖须先论证必要性（首选原生实现）。
- `bun test` 跑测试，测试在 `test/*.test.ts`，**零 mock**（探测函数注入轻量假探针，不触发真实 which/where）。
- `bun run typecheck` 走 tsc（tsconfig 独立，不引 session-mgmt）。
- 插件 Hook 基于 `@opencode-ai/plugin` 的 `Hooks` 接口——**同步上游后优先核对 hook/tool 签名**；experimental hook 若将来引入，须集中于单一适配文件。
- **入口文件只允许 default export**：上游 legacy loader 遍历模块全部导出，其他命名导出会导致「Plugin export is not a function」加载失败。

## 经验教训（通用约定）

- **config.json 是用户手写的 JSON，Windows 路径单反斜杠是陷阱**（三工程通用约定，本工程为触发源）：JSON 里 `\` 是转义符——`\P` 等非法转义导致解析失败（回退预设但用户不明所以）；更隐蔽的是 `\b`/`\n`/`\t` 是**合法**转义，`"C:\bin\..."` 会被静默转成控制字符，路径错但 JSON 解析"成功"。凡用户可编辑的 JSON 配置含路径时，文档必须明确要求**用正斜杠 `/`（Windows 原生接受）或双反斜杠 `\\`**；代码侧解析失败时警告信息要直接点出这个诱因（见 `src/config.ts` 与 docs/design.md、docs/deployment.md）。同理，`tools` 里写二进制路径的示例文档（含打包生成的 README）都要带上这条。
- **手写 JSON 的语义注释**：`tools` 只放「覆盖」或「新增」，内置预设不写即用默认。文档示例应显式标注哪个 id 是新增（如 cursor）、哪个是覆盖（如 idea），避免用户误以为内置项都要写进 tools 才生效。

## 文档与语言

- 设计文档、注释、commit message 用**中文**；conventional commit 格式（本仓库历史可参照）。
- **任何文档与注释都不要用 `§` 符号**引用章节，一律用纯文字（「3.4 节」或裸编号「见 3.4」）。
- 行为变更须同步更新 `docs/design.md`（含 mermaid 架构图）与本文件「已定案」清单。
