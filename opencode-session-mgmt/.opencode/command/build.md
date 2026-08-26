---
description: 构建 CLI 单二进制与插件
---

在项目根目录依次运行并确认产物：

- `bun run build:cli` → 单二进制 `dist/opencode-sm`
- `bun run build:plugin` → 自包含 JS `dist/plugin`

任一构建失败即修复，勿跳过。

后台收集服务为外部项目 `performance_dashboard`（https://github.com/karsonto/performance_dashboard），不在本仓库构建。
