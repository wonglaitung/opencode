import { cancel, createQueue, enqueue, shift, type QueueItem, type QueueState } from "./queue"
import type { WireState } from "./protocol"

export type RoomStatus = "idle" | "busy" | "waiting_approval"

export const POISON_TIMEOUT_MS = 90_000
export const POISON_RETRY_LIMIT = 1

export type ActivePrompt = { item: QueueItem; submittedAt: number; attempts: number }

export type Approval = { id: string; tool?: string; requestedAt: number }

export type RoomState = {
  status: RoomStatus
  queue: QueueState
  active?: ActivePrompt
  approval?: Approval
}

export function createRoom(): RoomState {
  return { status: "idle", queue: createQueue() }
}

export function request(state: RoomState, item: QueueItem, now = Date.now()) {
  return enqueue(state.queue, item, now)
}

export function cancelRequest(state: RoomState, id: string) {
  return cancel(state.queue, id)
}

// 只有空闲且没有待审批请求时才推进队首，保证主机的 AI 行为与单机一致。
export function takeNext(state: RoomState, now = Date.now()): QueueItem | undefined {
  if (state.status !== "idle" || state.approval) return
  const item = shift(state.queue)
  if (!item) return
  state.status = "busy"
  state.active = { item, submittedAt: now, attempts: item.attempts ?? 0 }
  return item
}

export function markIdle(state: RoomState) {
  state.status = "idle"
  state.active = undefined
}

export function awaitApproval(state: RoomState, approval: Approval) {
  state.status = "waiting_approval"
  state.approval = approval
}

export function resolveApproval(state: RoomState) {
  state.approval = undefined
  state.status = state.active ? "busy" : "idle"
}

export type WatchdogAction =
  | { kind: "none" }
  | { kind: "requeue"; item: QueueItem }
  | { kind: "drop"; item: QueueItem }

// 毒丸看门狗：提交后长时间没有任何输出，最多重排一次，之后丢弃。
export function watchdog(state: RoomState, now = Date.now(), timeoutMs = POISON_TIMEOUT_MS): WatchdogAction {
  const active = state.active
  if (!active || state.status !== "busy") return { kind: "none" }
  if (now - active.submittedAt < timeoutMs) return { kind: "none" }
  markIdle(state)
  if (active.attempts >= POISON_RETRY_LIMIT) return { kind: "drop", item: active.item }
  const item: QueueItem = { ...active.item, attempts: active.attempts + 1, queuedAt: now }
  state.queue.items.unshift(item)
  return { kind: "requeue", item }
}

export function toWireState(state: RoomState, peers: number): WireState {
  return {
    status: state.status,
    peers,
    queue: state.queue.items.map((item) => ({ id: item.id, by: item.by, text: item.text })),
    pendingApproval: state.approval
      ? { id: state.approval.id, tool: state.approval.tool }
      : undefined,
  }
}
