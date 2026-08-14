/**
 * 自定义错误(设计文档 5.1)。
 * 插件内所有可预期失败均抛 OpenIdeError,消息为中文并附修复路径,
 * 由工具 execute 抛出后上游会呈现为工具执行错误供 Agent 读取。
 */

export class OpenIdeError extends Error {}
