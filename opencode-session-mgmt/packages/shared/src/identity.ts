/**
 * 全局身份配置 identity.json 的类型与读写（设计文档 session-management.md 3.1、5.1）。
 * 位置：~/.config/opencode/session-mgmt/identity.json
 * 由 opencode-sm init 写入，每机器一份。
 *
 * 身份只需两件事：明文 api_key（本地存储，发送前哈希）与收集服务地址；
 * 账号/组/组织不再由客户端填写——收集端据 api_key 哈希解析 account/group_name/department。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { type WorkflowType, resolveWorkflowType } from "./workflow"

export interface Identity {
  /** 明文 api_key（本地存储；仅上送前经 SHA-256 转哈希，网络不传明文） */
  apiKey: string
  /** org 收集服务内网地址 */
  collector_url: string
  /** 主要工作流类型（用户级流程选择，3.1）；缺省 sdlc */
  workflowType?: WorkflowType
}

export const IDENTITY_KEYS: ReadonlyArray<keyof Identity> = ["apiKey", "collector_url"]

/** identity.json 的全局路径：~/.config/opencode/session-mgmt/identity.json */
export function identityPath(): string {
  return join(homedir(), ".config", "opencode", "session-mgmt", "identity.json")
}

/** 校验字段均为非空字符串；返回错误信息数组（空数组表示通过）。 */
export function validateIdentity(value: Partial<Identity>): string[] {
  const errors: string[] = []
  for (const key of IDENTITY_KEYS) {
    const v = value[key]
    if (typeof v !== "string" || v.trim() === "") {
      errors.push(`字段 ${key} 缺失或为空`)
    }
  }
  return errors
}

/**
 * 对明文 api_key 计算 SHA-256（hex）。本地 identity.json 存明文，仅上送前算哈希，
 * 网络链路不出现明文密钥（12 安全与隐私）。
 */
export async function hashApiKey(secret: string): Promise<string> {
  const data = new TextEncoder().encode(secret)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * 读取全局身份；文件不存在或格式非法时返回 null（插件据此退化为不打标/不汇报）。
 */
export function readIdentity(path: string = identityPath()): Identity | null {
  if (!existsSync(path)) return null
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const candidate = parsed as Partial<Identity>
  if (validateIdentity(candidate).length > 0) return null
  return {
    apiKey: candidate.apiKey!,
    collector_url: candidate.collector_url!,
    // 第五属性缺省 sdlc；未知值经 resolveWorkflowType 归一（兼容旧身份文件）
    workflowType: resolveWorkflowType(candidate.workflowType),
  }
}

/** 写入全局身份（自动创建父目录）；写入前校验字段非空；workflowType 缺省 sdlc。 */
export function writeIdentity(identity: Identity, path: string = identityPath()): void {
  const errors = validateIdentity(identity)
  if (errors.length > 0) {
    throw new Error(`身份校验失败：${errors.join("；")}`)
  }
  const normalized: Identity = {
    ...identity,
    workflowType: resolveWorkflowType(identity.workflowType),
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(normalized, null, 2) + "\n", "utf8")
}
