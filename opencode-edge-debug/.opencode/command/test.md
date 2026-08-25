---
description: 运行测试（bun test，零 mock）
---

在项目根目录运行 `bun test`（`test/*.test.ts`，零 mock：CDP 用 Bun.serve 假服务、真实 WebSocket 验证）。

失败则定位修复后重跑至全绿。测试须在包目录内运行，勿在仓库根目录运行。
