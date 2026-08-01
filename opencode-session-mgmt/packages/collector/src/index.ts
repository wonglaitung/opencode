/**
 * org 级收集服务（设计文档 §2.4、§4.3、§10.1）。每组织部署一个，仅内网可达。
 * 三个端点：
 *   POST /api/report       —— 插件汇报会话摘要（sm-shared 的 SessionReport）
 *   POST /api/ci-quality   —— CI 按 sessionID 回写 reworkRate/testCoverage
 *   GET  /api/stats        —— opencode-sm 组/组织级统计查询（scope=group&group=组名 / scope=org）
 */

// TODO: Hono 服务 + 端点实现；聚合库见 db.ts；合并语义复用 sm-shared 的 deepMerge
