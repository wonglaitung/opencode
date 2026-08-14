---
description: 构建 CLI 单二进制、插件与收集服务
---

在项目根目录依次运行并确认产物：

- `bun run build:cli` → 单二进制 `dist/opencode-sm`
- `bun run build:plugin` → 自包含 JS `dist/plugin`
- `bun run build:collector` → `dist/collector`

任一构建失败即修复，勿跳过。
