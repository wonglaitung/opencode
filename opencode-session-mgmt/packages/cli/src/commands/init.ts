/**
 * opencode-sm init —— 每台机器一次的自助配置（设计文档 session-management.md 5.1）。
 * 交互式两问 + 工作流类型：api_key / 收集服务地址 / 主要工作流类型，写入全局
 * ~/.config/opencode/session-mgmt/identity.json（sm-shared 的 writeIdentity）。
 * api_key 仅本机明文存储；插件上送前转为 SHA-256 哈希（12 安全与隐私），网络不传明文。
 * 快照语义（3.1）：重跑只影响此后的汇报归属，不追溯历史。
 */
import { createInterface } from "node:readline/promises"
import { identityPath, readIdentity, resolveWorkflowType, writeIdentity, type Identity } from "sm-shared"
import type { ParsedArgs } from "../index"

/** 展示用：明文 api_key 仅显示前缀，避免回显密钥 */
function maskApiKey(secret: string): string {
  if (secret.length <= 4) return "****"
  return `${secret.slice(0, 4)}****`
}

const QUESTIONS: Array<{ key: keyof Omit<Identity, "workflowType">; prompt: string }> = [
  { key: "apiKey", prompt: "api_key（明文仅存本机 identity.json；发送前转为 SHA-256 哈希，网络不传明文）" },
  { key: "collector_url", prompt: "收集服务地址（如 http://10.0.1.20:8787）" },
]

export async function runInit(_args: ParsedArgs): Promise<void> {
  const existing = readIdentity()
  if (existing) {
    process.stdout.write(
      `检测到已有身份配置：\n  api_key: ${maskApiKey(existing.apiKey)}\n  收集服务: ${existing.collector_url}\n  工作流类型: ${existing.workflowType ?? "sdlc"}\n重新填写将覆盖。\n\n`,
    )
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const identity = {} as Identity
  try {
    for (const q of QUESTIONS) {
      const answer = (await rl.question(`? ${q.prompt}: `)).trim()
      identity[q.key] = answer
    }
    const typeAnswer = (await rl.question("? 主要工作流类型 [sdlc 开发流程 / reqdoc 需求书] (缺省 sdlc): ")).trim()
    identity.workflowType = resolveWorkflowType(typeAnswer || "sdlc")
  } finally {
    rl.close()
  }
  writeIdentity(identity)
  process.stdout.write(`✓ 已写入 ${identityPath()}，本机即时生效。\n`)
}
