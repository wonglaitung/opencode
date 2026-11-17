# `sm-shared`（契约包）

插件、CLI 与收集服务三方共用的类型与纯函数，**不含运行时会话状态**。
字段或合并语义变更必须三包同步，否则汇报会被对端判为不兼容。

## 内容

| 模块 | 作用 |
|---|---|
| `workflow.ts` | `WorkflowState`、阶段/清单/规则/门禁注册表，四种工作流定义 |
| `identity.ts` | `identity.json` 读取与工作流解析 |
| `report.ts` | 汇报载荷结构与版本 |
| `merge.ts` | 状态合并语义（幂等、后写覆盖规则） |
| `loc.ts` | 工时/代码量统计口径 |
| `reqdoc-*.ts` | 需求书渲染、模板 schema、槽位、知识库、组装、记忆 |
| `index.ts` | 统一导出 |

## 开发

```bash
bun test
bun x tsc --noEmit
```

设计依据：[`../../docs/session-management.md`](../../docs/session-management.md) 第 3 章；
需求书结构见 [`../../docs/workflow-reqdoc.md`](../../docs/workflow-reqdoc.md)。
