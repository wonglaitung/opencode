/**
 * 插件入口（设计文档 §2.4、§8）。
 * 由 opencode config.plugin 加载，运行于 daemon 进程内。
 * 注册 5 类 hooks：
 *   - experimental.chat.system.transform  每轮注入规则 + WorkflowState（§7.1）
 *   - tool                                工作流工具集（§4.1）
 *   - tool.execute.before                 提交门禁硬拦截（§7.3）
 *   - tool.execute.after                  迭代计数
 *   - chat.message                        会话首次活动打 account_id（§3.1）+ 汇报触发
 */
import type { Plugin } from "@opencode-ai/plugin"

const SessionMgmtPlugin: Plugin = async (input) => {
  // TODO: 初始化插件库（db/）、读 identity.json（identity.ts）
  return {
    // TODO: "experimental.chat.system.transform": 见 prompt.ts
    // TODO: tool: { workflow_advance, workflow_revisit, commit_gate_check,
    //               comprehension_confirm, comprehension_ask, review_submit,
    //               quality_report }
    // TODO: "tool.execute.before": 见 gate.ts
    // TODO: "tool.execute.after": 迭代计数（见 tools/quality.ts）
    // TODO: "chat.message": 打标 + 汇报（见 identity.ts、report.ts）
  }
}

export default SessionMgmtPlugin
