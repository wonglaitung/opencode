/**
 * 生成与上游同形的 ID：`<prefix>_` + 12 位十六进制（时间戳+计数）+ 14 位 base62。
 *
 * 参考副本要换新会话/消息/part id（否则会与发送方共享主键，统计归属会串），
 * 形状对齐上游是为了让 opencode 的 UI 与 `Identifier.timestamp()` 之类逻辑照常工作。
 */
const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
const RANDOM_LENGTH = 14

let lastTimestamp = 0
let counter = 0

export type IdPrefix = "ses" | "msg" | "prt"

export function newId(prefix: IdPrefix, timestamp = Date.now()): string {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp
    counter = 0
  }
  counter++
  const current = BigInt(timestamp) * 0x1000n + BigInt(counter)
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((current >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("")
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_LENGTH))
  return `${prefix}_${time}${Array.from(bytes, (byte) => CHARS[byte % 62]).join("")}`
}
