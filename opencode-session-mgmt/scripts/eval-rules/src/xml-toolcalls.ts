/**
 * XML 形态工具调用解析（独立成模块，供 exec-selfcheck 直接测——client.ts 有网络副作用，
 * 不宜被自检 import）。
 *
 * 背景：端点未启用 tool-calling 时，qwen 系模板把调用写成 XML 文本塞进 content，
 * 此时 `tool_calls` 为 null。实测踩过：容器重启后 chat template 走了非 tool-calling
 * 路径，全量 50 场景里 31 个假失败，症状是「模型明明调了工具却判成无工具调用」——
 * 看起来像模型不听话，实际是评测器读不懂端点的输出形态。
 */
export interface XmlToolCall {
  name: string
  args: Record<string, unknown>
  id: string
}

/**
 * 解析 content 里的 XML 形态工具调用（qwen 系模板在 tool-calling 未启用时的输出形态）：
 *   <tool_call>
 *     <function=workflow_baseline>
 *       <parameter=estimated_hours>8</parameter>
 *     </function>
 *   <tool_call>
 * 多个调用可并列。参数按「首个标签的内容」解析（heuristic 够用：本地评测只需拿到
 * 名字与基本参数做判定）。解析不出名字则丢弃，不猜。
 */
/**
 * XML 文本里没有类型，全是字符串。判据做的是 `actual[k] === v` 的**引用相等**，
 * 故 `"8"` 匹配不上 `8`、`"true"` 匹配不上 `true`。按字面量形状转回原始类型，
 * 转不像就保持字符串（宁可显式不匹配，也不要瞎猜）。
 */
export function coerceScalar(v: string, want: "string" | "number" | "boolean" = "string"): unknown {
  // **按 schema 声明的类型转，不猜**。踩过的坑：一律把数字串转 number，结果把槽位地址
  // `"3.1"` 转成了 `3.1`，而服务端 `reqdoc_answer` 的 address 是 `z.string()` →
  // 参数校验失败、模型调不动。地址、文件名、枚举值都必须是字符串。
  if (want === "boolean") return v === "true" ? true : v === "false" ? false : v
  if (want === "number") {
    const n = Number(v)
    return Number.isFinite(n) && v.trim() !== "" ? n : v
  }
  return v
}

/**
 * @param types 可选的「工具名 → 参数名 → 期望类型」表（来自 `EVAL_TOOLS` 的 schema）。
 *   不给就**全部当字符串**——宁可类型不匹配显式失败，也不要瞎转。
 */
export function parseXmlToolCalls(
  content: string,
  types: Record<string, Record<string, "string" | "number" | "boolean">> = {},
): ToolCall[] {
  const out: ToolCall[] = []
  for (const m of content.matchAll(/<function=([A-Za-z0-9_]+)>([\s\S]*?)<\/function>/g)) {
    const name = m[1]
    const args: Record<string, string> = {}
    for (const p of m[2].matchAll(/<parameter=([A-Za-z0-9_]+)>([\s\S]*?)<\/parameter>/g)) {
      const want = types[name]?.[p[1]] ?? "string"
      args[p[1]] = coerceScalar(p[2].trim(), want)
    }
    out.push({ name, args, id: `xml-${out.length}` })
  }
  return out
}

/**
 * 打 OpenAI 兼容 /chat/completions(非流式、temperature 0)。
 * 环境变量: EVAL_BASE_URL(默认 http://localhost:8086/v1) / EVAL_API_KEY / EVAL_MODEL(默认 /models/qwen3)
 *          / EVAL_MAX_TOKENS(默认 2048,推理模型显式 4096) / EVAL_TIMEOUT_MS(默认 180000)
 *          / EVAL_DISABLE_THINKING(设 1 时带 chat_template_kwargs:{enable_thinking:false})。
 * 用 Bun 内建 fetch,零新增依赖——评测只判 tool_use,裸参数比高层 SDK 的断言 API 更可控。
 */
import type { ModelOutput, ToolCall } from "./types"

const BASE = process.env.EVAL_BASE_URL ?? "http://localhost:8086/v1"
const KEY = process.env.EVAL_API_KEY ?? ""
const MODEL = process.env.EVAL_MODEL ?? "/models/qwen3"
// 推理模型（deepseek-*-flash 等）需预留 thinking 空间,4096 防截断吞工具调用;
// 慢速弱模型（本地 qwen3.6 ~16 tok/s）默认 2048,过长输出会拖到超时。
const MAX_TOKENS = Number(process.env.EVAL_MAX_TOKENS ?? "2048")
const REQUEST_TIMEOUT_MS = Number(process.env.EVAL_TIMEOUT_MS ?? "180000")
// 思考模式开关：Qwen3 系默认开思考，会先写一大段「Let me organize…」再动手——
// 实测本地 qwen3 在长 system prompt 下必然把 max_tokens 耗在这段分析上、finish=length
// 且零工具调用（等不到工具就超时），评测根本测不出规则遵循。关掉后同一场景 53s /
// finish=stop，行为可测。**按模型开关**：deepseek 等推理模型关了会失去推理空间，
// 反而更差，故默认不开、由调用方按模型显式传。
const DISABLE_THINKING = process.env.EVAL_DISABLE_THINKING === "1"

export function modelId(): string {
  return MODEL
}

/**
 * @param prior 已发生的对话（含 assistant 工具调用与 tool 结果）。多轮续跑时由执行器累积传入——
 *   模型侧按 tool_call_id 与 tool 结果配对，所以必须原样回灌协议字段，不能只传文本。
 */
