/**
 * DeepPartial 增量合并语义（设计文档 4.3）。
 * 插件工具写本机 workflow.quality、收集服务合并 CI 回写，共用此逻辑，
 * 确保 Agent 指标与 CI 指标互不覆盖。
 *
 * 语义约定：
 * - 普通对象按字段递归合并，只覆盖 patch 中出现的键；
 * - 数组整体替换（不做元素级合并）——数组元素（如 comprehension 记录）
 *   的增删改由专用工具显式管理，不经过 deepMerge；
 * - patch 中值为 undefined 的键视为"不更新"，保持 base 原值。
 */

/** 递归可选：对象每层字段均可缺省，数组保持原类型（整体替换）。 */
export type DeepPartial<T> = T extends Array<infer U>
  ? Array<U>
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * 将 patch 深度合并进 base，返回新对象（不改动入参）。
 * base 为 null/undefined 时，以 patch 作为结果（结构完整性由调用方保证）。
 */
export function deepMerge<T>(base: T, patch: DeepPartial<T>): T {
  if (base === null || base === undefined) {
    return patch as T
  }
  if (Array.isArray(patch)) {
    return patch as unknown as T
  }
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return (patch === undefined ? base : patch) as T
  }
  const result: Record<string, unknown> = { ...base }
  for (const key of Object.keys(patch)) {
    const patchValue = (patch as Record<string, unknown>)[key]
    if (patchValue === undefined) continue
    const baseValue = (base as Record<string, unknown>)[key]
    if (isPlainObject(baseValue) && isPlainObject(patchValue)) {
      result[key] = deepMerge(baseValue, patchValue)
    } else {
      result[key] = patchValue
    }
  }
  return result as T
}
