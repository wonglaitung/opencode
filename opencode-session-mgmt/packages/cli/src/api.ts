/**
 * 数据源封装（设计文档 §4.2、§5.2）。
 * 1. 上游 opencode SDK：session.list/get/active...（cost/tokens）
 * 2. 收集服务查询客户端：GET {collector_url}/api/stats（组/组织级统计）
 * 3. 本机插件库只读访问
 */

// TODO: createOpencodeClient() 封装
// TODO: collectorQuery(identity, params)
