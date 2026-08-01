/**
 * 会话摘要汇报（设计文档 §2.4、§4.3、§12）。
 * 推送至 identity.collector_url：阶段事件触发 + 每日定时，增量汇报。
 * 收集服务不可用时写本地缓冲（插件库 outbox 表），恢复后补推。
 * 仅流程摘要，不含代码内容。
 */

// TODO: enqueueReport(sessionID)
// TODO: flushOutbox() —— 启动时与定时执行
