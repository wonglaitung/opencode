/**
 * 质量指标工具与迭代计数（设计文档 §3.2、§4.3）。
 * quality_report —— Agent 上报 acceptanceRate，增量合并写 workflow.quality
 * 迭代计数 —— tool.execute.after 统计每阶段代码编辑轮次，达 3 轮由 system prompt 提示人工介入
 */

// TODO: ToolDefinition + afterHook 计数逻辑（复用 sm-shared 的 deepMerge）
