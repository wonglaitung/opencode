/**
 * 审查与理解确认工具（设计文档 §4.1、§7.3）。
 * comprehension_confirm —— 单次只接受一个 codeSegmentId（防批量确认，服务端强制）
 * comprehension_ask     —— 追问片段，问答追加到 explanation
 * review_submit         —— 提交审查清单，四项全 true 且片段全部确认才可成功
 */

// TODO: ToolDefinition 实现 + 校验逻辑单元测试（test/）
