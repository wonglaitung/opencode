/**
 * 全局身份配置 identity.json 的类型与读写（设计文档 §3.1、§5.1）。
 * 位置：~/.config/opencode/session-mgmt/identity.json
 * 由 opencode-sm init 四问写入，每机器一份。
 */

export interface Identity {
  /** 账号邮箱——会话打标与汇报的身份键 */
  account: string
  /** 组名（名称字符串，子组用命名约定如 "前端组/基础架构组"） */
  group: string
  /** 组织名 */
  org: string
  /** org 收集服务内网地址 */
  collector_url: string
}

// TODO: readIdentity() / writeIdentity() —— 读写 ~/.config/opencode/session-mgmt/identity.json
