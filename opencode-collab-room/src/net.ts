import os from "node:os"

export type InterfaceAddress = { address: string; family?: string | number; internal?: boolean }
export type InterfaceMap = Record<string, InterfaceAddress[] | undefined>

// 虚拟网卡/Tunnel 不能给对端用。
const EXCLUDED_NAME = /^(lo|docker|veth|br-|virbr|vmnet|vboxnet|tun|tap|wg|zt|tailscale|utun)/i

export function pickLanIp(interfaces: InterfaceMap): string | undefined {
  const candidates: Array<{ ip: string; rank: number }> = []
  for (const name of Object.keys(interfaces)) {
    if (EXCLUDED_NAME.test(name)) continue
    for (const item of interfaces[name] ?? []) {
      if (item.internal) continue
      if (item.family !== 4 && item.family !== "IPv4") continue
      const ip = item.address
      if (!isIPv4(ip)) continue
      if (ip.startsWith("169.254.") || ip.startsWith("127.")) continue
      candidates.push({ ip, rank: rankOf(ip) })
    }
  }
  candidates.sort((a, b) => a.rank - b.rank)
  return candidates[0]?.ip
}

export function lanAddress(): string | undefined {
  return pickLanIp(os.networkInterfaces())
}

function isIPv4(value: string) {
  const parts = value.split(".")
  if (parts.length !== 4) return false
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function rankOf(ip: string) {
  if (ip.startsWith("192.168.")) return 0
  if (ip.startsWith("10.")) return 1
  const match = /^172\.(\d{1,3})\./.exec(ip)
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return 2
  if (ip.startsWith("123.")) return 3
  return 4
}
