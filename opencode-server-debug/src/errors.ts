/**
 * 可预期失败错误(设计文档 6)。
 * 中文消息 + 修复路径;工具 execute 抛出后经上游呈现为工具执行错误,供 Agent 读取并自行决策。
 */
export class ServerDebugError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ServerDebugError"
  }
}
