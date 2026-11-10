/**
 * 只保留安全判断需要的响应头；不落 Set-Cookie 原值、请求 Cookie 或令牌。
 */
const SAFE_RESPONSE_HEADERS = new Set([
  "access-control-allow-credentials",
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-allow-origin",
  "access-control-expose-headers",
  "access-control-max-age",
  "cache-control",
  "content-security-policy",
  "content-type",
  "cross-origin-embedder-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "permissions-policy",
  "pragma",
  "referrer-policy",
  "server",
  "strict-transport-security",
  "x-content-type-options",
  "x-frame-options",
  "x-powered-by",
])

function cookieAttributes(values: string[]): string | undefined {
  const attributes = new Set<string>()
  for (const value of values) {
    for (const part of value.split(";").slice(1)) {
      const [rawKey, ...rest] = part.trim().split("=")
      const key = rawKey?.trim().toLowerCase()
      if (!key) continue
      if (key === "samesite") {
        const sameSite = rest.join("=").trim()
        attributes.add(sameSite ? `SameSite=${sameSite}` : "SameSite")
      } else if (key === "max-age" || key === "domain" || key === "path") {
        attributes.add(`${key}${rest.length ? `=${rest.join("=").trim()}` : ""}`)
      } else {
        attributes.add(key)
      }
    }
  }
  const result = [...attributes].sort().join("; ")
  return result || undefined
}

export function safeResponseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of headers) {
    const lower = key.toLowerCase()
    if (SAFE_RESPONSE_HEADERS.has(lower)) result[lower] = value
  }
  const cookieReader = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie
  const setCookies = typeof cookieReader === "function" ? cookieReader.call(headers) : []
  const attributes = cookieAttributes(setCookies)
  if (attributes) result["set-cookie-attributes"] = attributes
  return result
}

export function safeResponseHeaderRecord(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {}
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase()
    if (SAFE_RESPONSE_HEADERS.has(lower)) result[lower] = value
  }
  return result
}
