/**
 * 提交门禁硬拦截（设计文档 §3.4、§7.3）。
 * tool.execute.before hook：识别 bash 工具中的 git commit，
 * 未通过 commit_gate_check（有未 approved 阶段）时抛错阻断。
 */

// TODO: isCommitCommand(tool, args): boolean
// TODO: gateHandler(input, output) —— 未过审查则 throw
