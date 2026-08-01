/**
 * 插件 SQLite 初始化与迁移（设计文档 §3.1）。
 * 插件启动时自动建表，迁移由插件自管，与上游 schema 演进互不影响。
 */

// TODO: openDb(projectDir) —— 打开/创建 <project>/.opencode/session-mgmt.db，PRAGMA journal_mode=WAL
// TODO: migrate(db) —— 版本化迁移
