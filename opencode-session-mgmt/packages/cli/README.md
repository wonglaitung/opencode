# `opencode-sm`（CLI）

独立的命令行入口：初始化身份、查看本机会话与项目级统计。发布为 `opencode-sm`，
开发期可用 `bun link` 后直接调用。

## 命令

```bash
opencode-sm init            # 两问：api_key / 收集服务地址（可选主要工作流）
opencode-sm list [--status <s>] [--tag <t>] [--json]
opencode-sm stats [<sessionID>] [--project <目录>] [--period 7d] [--workflow task|sdlc|reqdoc|websec]
opencode-sm memory [list | forget <关键词>]   # 管理 REQDOC 记忆条目
opencode-sm help
```

## 结构

```
src/
├── index.ts      # 参数解析与命令分发
├── api.ts        # 收集服务与本地状态读取
└── commands/     # init / list / stats / memory 实现
test/             # 命令级测试
```

契约类型与合并语义都在 [`../shared`](../shared/README.md)，改动字段时三个包要一起改。
部署、收集服务与 FAQ 见 [`../../docs/deployment.md`](../../docs/deployment.md)。
