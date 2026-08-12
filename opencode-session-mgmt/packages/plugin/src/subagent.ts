/**
 * 子代理会话识别（2.4 统计纯净度）。
 * 上游子代理会话带 parentID（指向主会话），本插件据此识别并对其跳过
 * 建记录 / 打标 / 汇报 / 规则注入，避免子代理会话污染本地统计与收集服务聚合。
 * 识别结果按会话缓存，避免每个消息都调一次 session.get。
 */
import type { PluginInput } from "@opencode-ai/plugin"

/** 已判定过的会话缓存：sessionID → 是否子代理。 */
const cache = new Map<string, boolean>()

/**
 * 生成「是否子代理会话」判定器（闭包绑定 client 并共享缓存）。
 * 上游不可达时保守按主会话处理（不误跳过追踪/汇报）。
 */
export function makeSubagentChecker(client: PluginInput["client"]) {
  return async function isSubagent(sessionID: string): Promise<boolean> {
    const cached = cache.get(sessionID)
    if (cached !== undefined) return cached
    let result = false
    try {
      const res = await client.session.get({ path: { id: sessionID } })
      result = typeof res.data?.parentID === "string" && res.data.parentID !== ""
    } catch {
      // 上游瞬时不可达：保守按非子代理处理（保持现有行为）
    }
    cache.set(sessionID, result)
    return result
  }
}

/** 测试用：清空判定缓存。 */
export function resetSubagentCache(): void {
  cache.clear()
}
