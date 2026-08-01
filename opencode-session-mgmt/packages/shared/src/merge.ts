/**
 * DeepPartial 增量合并语义（设计文档 §4.3）。
 * 插件工具写本机 workflow.quality、收集服务合并 CI 回写，共用此逻辑，
 * 确保 Agent 指标与 CI 指标互不覆盖。
 */

// TODO: deepMerge<T>(base: T, patch: DeepPartial<T>): T
