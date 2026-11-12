/**
 * 插件运行时可用的最小类型声明。
 *
 * 刻意不 import @opencode-ai/plugin：本插件以「单文件本地插件」方式部署到
 * ~/.config/opencode/plugin/，保持零运行时依赖、零安装步骤。
 * 上游真实契约见 packages/plugin/src/index.ts（Plugin = (input, options) => Promise<Hooks>）。
 */

/** 会话信息（服务端返回的字段可能多于 SDK 类型声明，故用宽松结构）。 */
export type SessionInfo = Record<string, unknown> & {
  id: string
  title: string
  directory?: string
  parentID?: string
  time?: { created?: number; updated?: number }
}

/** 单条消息（v1 形态：user / assistant）。 */
export type MessageInfo = Record<string, unknown> & {
  id: string
  sessionID: string
  role: string
  time?: { created?: number; completed?: number }
}

/** 消息附带的 part（文本、工具调用、文件、patch 等）。 */
export type PartInfo = Record<string, unknown> & {
  id: string
  messageID: string
  sessionID: string
  type: string
}

export type MessageWithParts = {
  info: MessageInfo
  parts: PartInfo[]
}

export interface SessionClient {
  get(options: { path: { id: string } }): Promise<{ data?: SessionInfo }>
  messages(options: { path: { id: string } }): Promise<{ data?: MessageWithParts[] }>
  update(options: { path: { id: string }; body: { title?: string } }): Promise<{ data?: SessionInfo }>
}

export interface OpencodeClient {
  session: SessionClient
}

export interface PluginInput {
  client: OpencodeClient
  project: { id: string }
  directory: string
  worktree: string
}

export interface PluginEvent {
  id?: string
  type: string
  properties?: Record<string, unknown>
}
