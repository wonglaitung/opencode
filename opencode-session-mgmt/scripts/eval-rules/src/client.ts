/**
 * 打 OpenAI 兼容 /chat/completions(非流式、temperature 0)。
 * 环境变量: EVAL_BASE_URL(默认 http://localhost:8086/v1) / EVAL_API_KEY / EVAL_MODEL(默认 /models/qwen3)
 *          / EVAL_MAX_TOKENS(默认 2048,推理模型显式 4096) / EVAL_TIMEOUT_MS(默认 180000)。
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

export function modelId(): string {
  return MODEL
}

export async function chatComplete(system: string, user: string, tools: unknown[]): Promise<ModelOutput> {
  const body = JSON.stringify({
    model: MODEL,
    temperature: 0,
    max_tokens: MAX_TOKENS,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    tools,
    tool_choice: "auto",
  })
  // 弱/推理模型单请求可达 50s+,vLLM 排队时更久;带显式超时并在网络/超时错误时重试,
  // 避免评测中途崩溃(曾因偶发 TimeoutError 中断全量)。HTTP 4xx/5xx 为服务端判定,不重试。
  let last: Error | undefined
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res: Response
    try {
      res = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      last = err instanceof Error ? err : new Error(String(err))
      if (attempt < 3) {
        console.error(`   └ 请求失败(第 ${attempt}/3 次):${last.message.slice(0, 120)},重试`)
        await new Promise((r) => setTimeout(r, 2000 * attempt))
      }
      continue
    }
    if (!res.ok) {
      const errBody = await res.text()
      throw new Error(`模型请求失败 HTTP ${res.status}: ${errBody.slice(0, 300)}`)
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
    // 推理模型(reasoning_content)可能把正文放 thinking 或 content 为空(reasoning 占满 max_tokens)。
    // text 类判定需兜底:content 为空时回退 reasoning_content。tool 类判定只看 tool_calls,不受影响。
    const content = msg?.content ?? ""
    const text = content.trim() !== "" ? content : (msg?.reasoning_content ?? "")
    return { text, toolCalls }
  }
  throw last ?? new Error("模型请求失败")
}
