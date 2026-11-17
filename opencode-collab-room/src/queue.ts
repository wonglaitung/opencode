export const MAX_QUEUE = 20

export type QueueItem = {
  id: string
  by: string
  text: string
  queuedAt: number
  attempts?: number
}

export type QueueState = { items: QueueItem[] }

export function createQueue(): QueueState {
  return { items: [] }
}

export function queueSize(queue: QueueState) {
  return queue.items.length
}

export function enqueue(
  queue: QueueState,
  item: QueueItem,
  now = Date.now(),
): { ok: true } | { ok: false; reason: "full" | "duplicate" } {
  if (queue.items.length >= MAX_QUEUE) return { ok: false, reason: "full" }
  if (queue.items.some((entry) => entry.id === item.id)) return { ok: false, reason: "duplicate" }
  queue.items.push({ ...item, queuedAt: item.queuedAt || now })
  return { ok: true }
}

export function cancel(queue: QueueState, id: string): QueueItem | undefined {
  const index = queue.items.findIndex((item) => item.id === id)
  if (index < 0) return
  return queue.items.splice(index, 1)[0]
}

export function peek(queue: QueueState): QueueItem | undefined {
  return queue.items[0]
}

export function shift(queue: QueueState): QueueItem | undefined {
  return queue.items.shift()
}
