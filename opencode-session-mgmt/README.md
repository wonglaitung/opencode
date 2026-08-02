# opencode-session-mgmt

OpenCode 会话管理定制：**标准化开发流程、理解保障与效能分析**。
以插件 + 独立 CLI + 组织收集服务的形态实现，对 OpenCode 上游**零修改**，便于持续同步上游更新。

## 文档

- **部署与使用手册**：[`docs/deployment.md`](docs/deployment.md)（从零上手：装 OpenCode、启用插件、CLI、收集服务、内网隔离部署、FAQ）——**新人先看这个**
- **设计文档**：[`docs/session-management.md`](docs/session-management.md)
- **上游同步方案**：[`docs/upstream-sync.md`](docs/upstream-sync.md)（remote 布局、同步命令、冲突预案、同步记录）

## 结构

```
packages/
├── shared/      # 契约包：WorkflowState schema、汇报 payload、identity、合并语义（三包共用）
├── plugin/      # OpenCode 插件（config.plugin 加载，运行于 daemon 内）
├── cli/         # opencode-sm 独立 CLI（init/tag/workflow/stats/list）
└── collector/   # org 级收集服务（每组织部署一个：汇报 + CI 回写 + 统计查询）
deploy/          # 部署示例：收集服务 docker-compose、团队预置 opencode.json
```

## 开发者上手（一次性，约 2 分钟）

```bash
npm i -g opencode-sm                          # 1. 装独立 CLI（发布后；开发期用 bun link）
# 2. opencode 配置启用插件（opencode.json，可用 deploy/opencode.json.example）
#    { "plugin": ["./opencode-session-mgmt/packages/plugin"] }
opencode-sm init                              # 3. 四问：账号 / 组 / 组织 / 收集服务地址
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
- [ ] 插件发布形态：建议编译为 JS 发布（`build:plugin`），屏蔽目标机 bun 版本差异
- [ ] 收集服务镜像构建与内网部署流程
