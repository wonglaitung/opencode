# 插件单元测试

覆盖范围（设计文档 13）：
- 工具校验逻辑（workflow_advance 的确认语义校验）
- 防批量确认（comprehension_confirm 单次单片段）
- 合并语义（quality 增量合并）
- 门禁拦截（未过审查的 git commit 被阻断）
- 汇报缓冲（收集服务不可用 → outbox → 恢复补推）

运行：`bun test packages/plugin/test`
