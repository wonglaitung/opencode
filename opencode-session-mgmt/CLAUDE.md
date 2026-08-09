# opencode-session-mgmt

OpenCode 会话管理定制：标准化开发流程（五阶段门禁）、理解保障（复述确认）、效能分析（Token ROI / 返工率）。
形态为 **插件 + 独立 CLI + org 收集服务**，对 OpenCode 上游**零修改**，以便持续同步上游更新。

## 铁律（破坏则同步上游必冲突）

- **不修改 `packages/*` 下任何上游文件**，也不改仓库根目录的 `CLAUDE.md` 等上游文件——根 CLAUDE.md 是上游的，本文件才是本项目的。
- 所有定制产出只落在定制目录内：`opencode-session-mgmt/`（本工程）与 `opencode-edge-debug/`（按需 Edge 调试插件，独立工程）。
- 本目录是独立 bun workspace，**不被上游根 workspace 收录**（上游 glob 为 `packages/*` 等，不匹配本路径）；改动后须确认上游根 `package.json` 的 workspace glob 仍不匹配本目录。
- 上游同步策略：**日常 `git pull` 只同步 `origin`（wonglaitung/opencode），不要主动同步 anomalyco/opencode**；仅当明确要求「同步上游」时才按 `docs/upstream-sync.md` 手工执行（remote：`origin`=wonglaitung/opencode，`upstream`=anomalyco/opencode 且 push 已禁用）。

## 已定案，勿重议（详见 docs/session-management.md）

- **身份全手填**：`opencode-sm init` 交互四问（账号 / 组 / 组织 / 收集服务地址），写入全局 `~/.config/opencode/session-mgmt/identity.json`，每机器一次。**不读上游登录账号**，**没有 team.yaml**。
- **插件不读上游数据库**：account 打标取自 identity.json；cost/tokens 经上游 SDK 获取。依赖面仅 Hook + REST API。
- **group 是名称字符串**，无 ID、无嵌套表；子组用命名约定（`前端组/基础架构组`）。CLI 参数 `--group "组名"`。
- **收集服务每 org 部署一个**（内网 HTTP），三端点：`POST /api/report`（插件汇报，不含代码）、`POST /api/ci-quality`（CI 回写）、`GET /api/stats`（CLI 查询）。不可用时插件本地缓冲、恢复补推。
- **身份是汇报快照**：改 init 只影响之后的汇报，历史归属不追溯变更。
- **CLI 命名为 `opencode-sm`**（曾短暂叫 ocsm，已废弃，勿再用）。
- 会话不能改名：上游 `Session.Service` 无 update 方法，会话标题由上游自动生成，勿设计 rename 功能。
- 工作流推进是**完成门禁模型**（AI 主动 `workflow_advance`，AI 引导人决定），不是审批流；提交门禁经 `tool.execute.before` 拦截 `git commit` 实现；迭代上限 3 轮；`comprehension_confirm` 单次只认一段（防批量走过场）。

## 结构

```
packages/shared/     # 契约包：WorkflowState 类型、汇报 payload、identity、合并语义（三包共用，先完成）
packages/plugin/     # OpenCode 插件：system prompt 注入、工具注册、提交门禁、汇报
packages/cli/        # opencode-sm 独立 CLI：init/tag/workflow/stats/list
packages/collector/  # org 收集服务：三端点 + 聚合库
deploy/              # 部署示例：收集服务 docker-compose、opencode.json.example
docs/                # 设计文档 session-management.md、同步方案 upstream-sync.md
```

每个源文件 stub 顶部注明对应设计文档章节，实现前先读该章节。

## 技术约定

- bun workspace monorepo；bun 直接跑 TS（CLI 入口 shebang `#!/usr/bin/env bun`）。
- TypeScript strict；新代码零 `any`；`bun build --compile` 出 CLI 单二进制。
- 插件 Hook 基于 `@opencode-ai/plugin` 的 `Hooks` 接口，均为 experimental——**同步上游后优先核对 hook 签名**（尤其 `experimental.chat.system.transform`），变更只需改 `packages/plugin/src/prompt.ts` 适配层。
- **插件入口 `packages/plugin/src/index.ts` 只能 default 导出插件工厂，内部辅助函数一律不加 `export`**。opencode 的 legacy 加载器会把模块「所有函数导出」都当作插件工厂，以 `(input, options)` 逐一调用；曾因 `syncSessionTitle`/`backfillSessionTitles` 加了 `export`，被当作工厂调用时首行 `store.get(sessionID)` 抛 `store.get is not a function`，导致插件加载失败、opencode 启动报 `Unexpected server error`（见 5.2 与 `index.ts` 内注释）。
- 本地存储用 bun:sqlite。
- `bun test` 跑测试；测试文件与源码同目录 `*.test.ts`。

## 文档与语言

- 设计文档、注释、commit message 用**中文**；conventional commit 格式（本仓库历史可参照）。
- **任何文档与注释都不要用 `§` 符号**引用章节，一律用纯文字（「第 3 章」「3.4 节」或裸编号「见 3.4」）。
- 设计文档任何行为变更须同步更新对应 mermaid 流程图（共 15 个），改链路必改图。
- 发布前 TODO 见 `README.md`（npm scope、插件发布形态、收集服务镜像）。
