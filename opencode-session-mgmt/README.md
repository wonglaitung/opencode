# opencode-session-mgmt

OpenCode 会话管理定制：**标准化开发流程、理解保障与效能分析**。
以插件 + 独立 CLI + 外部收集服务的形态实现，对 OpenCode 上游**零修改**，便于持续同步上游更新。后台收集器为独立外部项目 [`performance_dashboard`](https://github.com/karsonto/performance_dashboard)，不随本仓库分发。

## 文档

- **文档索引**：[`docs/README.md`](docs/README.md)（docs/ 全部文件的分类、消费方、改名约束——新增文档先登记）
- **部署与使用手册**：[`docs/deployment.md`](docs/deployment.md)（从零上手：装 OpenCode、启用插件、CLI、收集服务、内网隔离部署、FAQ）——**新人先看这个**
- **设计文档族**：[`docs/session-management.md`](docs/session-management.md)（通用机制 / 架构 / CLI / 统计 / 部署 / 评测，主文档；含质量管控框架方法论，见 1.6 章）、[`docs/workflow-sdlc.md`](docs/workflow-sdlc.md)（工作流一：sdlc 定义与规则）、[`docs/workflow-reqdoc.md`](docs/workflow-reqdoc.md)（工作流二：reqdoc 定义与规则）
- **上游同步方案**：[`docs/upstream-sync.md`](docs/upstream-sync.md)（remote 布局、同步命令、冲突预案、同步记录）

## 结构

```
packages/
├── shared/      # 契约包：WorkflowState schema、汇报 payload、identity、合并语义（三包共用）
├── plugin/      # OpenCode 插件（config.plugin 加载，运行于 daemon 内）
└── cli/         # opencode-sm 独立 CLI（init/list/stats，本机会话/项目级聚合）
# 后台收集服务为外部项目：https://github.com/karsonto/performance_dashboard
deploy/          # 部署示例：团队预置 opencode.json

## 开发者上手（一次性，约 2 分钟）

```bash
npm i -g opencode-sm                          # 1. 装独立 CLI（发布后；开发期用 bun link）
# 2. opencode 配置启用插件（opencode.json，可用 deploy/opencode.json.example）
#    { "plugin": ["./opencode-session-mgmt/packages/plugin"] }
opencode-sm init                              # 3. 两问：api_key / 收集服务地址（+ 可选主要工作流类型）
```

此后照常使用 `opencode`（TUI）：工作流规则随 system prompt 自动注入，
阶段推进 / 审查 / 理解确认在对话中完成。

## 开发

```bash
bun install          # workspace 依赖
bun test             # 各包单元测试（自动发现 *.test.ts）
bun run typecheck    # 四包严格类型检查（strict，零 any）
bun run build:cli    # 构建 opencode-sm 单二进制（bun build --compile）
```

## 发布前 TODO

- [ ] 确定 npm scope（`@yourorg/...`），统一四个包的 `name`
- [x] 插件发布形态：整包便携使用 `pack:bundle`（`scripts/pack-bundle.sh`），通过 `.npmrc` 的 `node-linker=hoisted` 确保 `node_modules` 可跨机器打包搬运（解决 Windows 硬链接断裂问题）
- [ ] 外部收集服务 `performance_dashboard` 的镜像构建与内网部署（见 https://github.com/karsonto/performance_dashboard）
