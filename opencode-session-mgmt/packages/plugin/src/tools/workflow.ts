/**
 * 工作流工具（设计文档 §4.1）。
 * workflow_advance   —— 进入下一阶段 / 标记 approved（校验开发者确认语义）
 * workflow_revisit   —— 回退阶段（revision++）
 * commit_gate_check  —— 提交门禁检查，返回未完成阶段列表
 */

// TODO: ToolDefinition 实现（@opencode-ai/plugin 的 tool() 辅助函数）
