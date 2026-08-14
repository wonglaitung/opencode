/**
 * 打 OpenAI 兼容 /chat/completions(非流式、temperature 0)。
 * 环境变量: EVAL_BASE_URL(默认 http://localhost:8086/v1) / EVAL_API_KEY / EVAL_MODEL(默认 /models/qwen3)。
 * 用 Bun 内建 fetch,零新增依赖——评测只判 tool_use,裸参数比高层 SDK 的断言 API 更可控。
 */
import type { ModelOutput, ToolCall } from "./types"

const BASE = process.env.EVAL_BASE_URL ?? "http://localhost:8086/v1"
const KEY = process.env.EVAL_API_KEY ?? ""
const MODEL = process.env.EVAL_MODEL ?? "/models/qwen3"

export function modelId(): string {
  return MODEL
}

export async function chatComplete(system: string, user: string, tools: unknown[]): Promise<ModelOutput> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      // 推理模型(如 deepseek-*-flash)会先消耗 token 推理,预留空间避免截断吞掉工具调用
      max_tokens: 2048,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      tools,
      tool_choice: "auto",
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`模型请求失败 HTTP ${res.status}: ${body.slice(0, 300)}`)
  }
  const data: any = await res.json()
  const msg = data?.choices?.[0]?.message
  const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((c: any) => {
    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(c.function?.arguments ?? "{}")
    } catch {
      // JSON 解析容错:弱模型偶尔输出残缺 JSON,记为 {} 让判定侧显式失败
    }
    return { name: c.function?.name ?? "", args }
  })
  return { text: msg?.content ?? "", toolCalls }
}
