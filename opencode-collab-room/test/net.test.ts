import { describe, expect, test } from "bun:test"
import { pickLanIp, type InterfaceMap } from "../src/net"

describe("pickLanIp", () => {
  test("优先 192.168 段", () => {
    const interfaces: InterfaceMap = {
      eth0: [{ address: "10.1.2.3", family: "IPv4" }],
      wlan0: [{ address: "192.168.1.5", family: "IPv4" }],
    }
    expect(pickLanIp(interfaces)).toBe("192.168.1.5")
  })

  test("跳过内部、虚拟与链路本地地址", () => {
    const interfaces: InterfaceMap = {
      lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      docker0: [{ address: "172.17.0.1", family: "IPv4" }],
      vEthernet: [{ address: "192.168.50.1", family: "IPv4" }],
      eth0: [{ address: "169.254.10.20", family: "IPv4" }],
      wlan0: [{ address: "10.0.0.7", family: 4 }],
    }
    expect(pickLanIp(interfaces)).toBe("10.0.0.7")
  })

  test("123 段优先于其它公网地址", () => {
    const interfaces: InterfaceMap = {
      eth0: [{ address: "203.0.113.9", family: "IPv4" }],
      wlan0: [{ address: "123.45.6.7", family: "IPv4" }],
    }
    expect(pickLanIp(interfaces)).toBe("123.45.6.7")
  })

  test("私网段仍优先于 123 段", () => {
    const interfaces: InterfaceMap = {
      eth0: [{ address: "123.45.6.7", family: "IPv4" }],
      wlan0: [{ address: "172.20.1.2", family: "IPv4" }],
    }
    expect(pickLanIp(interfaces)).toBe("172.20.1.2")
  })

  test("忽略 IPv6 与非法地址", () => {
    const interfaces: InterfaceMap = {
      eth0: [
        { address: "fe80::1", family: "IPv6" },
        { address: "999.1.1.1", family: "IPv4" },
      ],
    }
    expect(pickLanIp(interfaces)).toBeUndefined()
  })

  test("没有可用网卡返回空", () => {
    expect(pickLanIp({})).toBeUndefined()
  })
})
