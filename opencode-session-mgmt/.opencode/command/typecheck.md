---
description: 四包严格类型检查（bun run typecheck）
---

在项目根目录运行 `bun run typecheck`（对 shared/plugin/cli/collector 四个包分别 `tsc`，strict 且零 `any`）。

修复所有类型错误后再跑一遍确认全绿。
