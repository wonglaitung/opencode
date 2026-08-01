/**
 * 会话打标（设计文档 §3.1）。
 * chat.message hook：会话首次活动时，从全局 identity.json 读 account 写入
 * workflow_session.account_id。不读上游数据库。
 */

// TODO: stampSessionAccount(sessionID) —— 幂等，仅首次写入
