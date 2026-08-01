/**
 * 聚合库（设计文档 §3.1）。
 * reports 表按 session_id 主键：接收各机器汇报快照（account/group/org +
 * 阶段时间戳 + cost/tokens + 会话内质量），与 CI 回写指标按 session 合并。
 * 组/组织结构由各人汇报自然形成，GROUP BY group_name / org_name 即得。
 */

// TODO: CREATE TABLE reports / 合并写入 / 聚合查询
