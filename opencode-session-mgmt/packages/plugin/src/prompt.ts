/**
 * system prompt 注入（设计文档 §7.1、§7.4）。
 * experimental.chat.system.transform hook 的实现：
 * 从插件库读当前会话 WorkflowState，将规则全文 + 状态压缩 JSON 追加到 output.system。
 */

// TODO: buildSystemFragment(workflow: WorkflowState): string
// TODO: systemTransformHandler(input, output) —— 按 sessionID 取状态、追加片段
