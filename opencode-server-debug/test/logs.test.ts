import { describe, expect, test } from "bun:test"
import {
  bucketByTime,
  buildContextCommand,
  buildErrorSearchCommand,
  buildFindLineCommand,
  buildListFilesCommand,
  buildTailCommand,
  createRingBuffer,
  detectLevel,
  extractComponent,
  extractTimestamp,
  filterEvents,
  groupErrors,
  parseLogEvents,
  parseTimestampToEpoch,
  rankRootCause,
  truncateText,
} from "../src/logs"

describe("detectLevel", () => {
  test("识别 ERROR/WARN/FATAL 并归一化 WARNING 为 WARN", () => {
    expect(detectLevel("ERROR something")).toBe("ERROR")
    expect(detectLevel("[main] WARN x")).toBe("WARN")
    expect(detectLevel("WARNING: disk")).toBe("WARN")
    expect(detectLevel("INFO ok")).toBe("INFO")
    expect(detectLevel("FATAL boom")).toBe("FATAL")
  })

  test("无级别词返回 UNKNOWN", () => {
    expect(detectLevel("just some text")).toBe("UNKNOWN")
  })
})

describe("extractTimestamp", () => {
  test("提取 log4j 默认时间戳(逗号毫秒)", () => {
    expect(extractTimestamp("2024-01-15 10:23:45,123 [main] ERROR x")).toBe("2024-01-15 10:23:45,123")
  })

  test("提取 ISO 时间戳", () => {
    expect(extractTimestamp("2024-01-15T10:23:45.123Z INFO x")).toBe("2024-01-15T10:23:45.123Z")
  })

  test("无时间戳返回 undefined", () => {
    expect(extractTimestamp("plain line")).toBeUndefined()
  })
})

describe("parseLogEvents", () => {
  test("聚合多行堆栈为单个事件", () => {
    const raw = [
      "2024-01-15 10:00:00,123 [main] ERROR com.Foo - boom",
      "java.lang.NullPointerException",
      "	at com.Foo.bar(Foo.java:10)",
      "2024-01-15 10:00:01,000 [main] INFO com.Foo - ok",
    ].join("\n")
    const events = parseLogEvents(raw)
    expect(events).toHaveLength(2)
    expect(events[0].level).toBe("ERROR")
    expect(events[0].message.split("\n")).toHaveLength(3)
    expect(events[1].level).toBe("INFO")
    expect(events[1].message).toBe("2024-01-15 10:00:01,000 [main] INFO com.Foo - ok")
  })

  test("续行不以级别词误判为新事件", () => {
    const raw = "ERROR oom\nCaused by: java.lang.OOM\n	at x.y(z.java:1)"
    const events = parseLogEvents(raw)
    expect(events).toHaveLength(1)
    expect(events[0].message).toContain("Caused by")
  })
})

describe("groupErrors", () => {
  test("按签名聚类并去重计数(变量数字被折叠)", () => {
    const raw = [
      "2024-01-15 10:00:00,000 ERROR java.lang.NullPointerException: user 123 failed",
      "2024-01-15 10:00:01,000 ERROR java.lang.NullPointerException: user 456 failed",
      "2024-01-15 10:00:02,000 INFO heartbeat ok",
    ].join("\n")
    const groups = groupErrors(parseLogEvents(raw))
    expect(groups).toHaveLength(1)
    expect(groups[0].count).toBe(2)
    expect(groups[0].signature).toContain("user # failed")
  })

  test("不同异常类型分别成组并按计数降序", () => {
    const raw = [
      "ERROR A: fail",
      "ERROR A: fail",
      "ERROR A: fail",
      "ERROR B: fail",
    ].join("\n")
    const groups = groupErrors(parseLogEvents(raw))
    expect(groups).toHaveLength(2)
    expect(groups[0].signature).toContain("A")
    expect(groups[0].count).toBe(3)
  })

  test("无错误时返回空数组", () => {
    expect(groupErrors(parseLogEvents("INFO ok\nDEBUG trace"))).toHaveLength(0)
  })
})

describe("filterEvents", () => {
  test("按级别与子串过滤", () => {
    const events = parseLogEvents("ERROR a\nWARN b\nERROR timeout c")
    expect(filterEvents(events, { level: "ERROR" })).toHaveLength(2)
    expect(filterEvents(events, { grep: "timeout" })).toHaveLength(1)
  })
})

describe("extractComponent", () => {
  test("从 log4j 前缀提取 logger 名", () => {
    expect(extractComponent("2024-01-15 10:00:00,000 [main] ERROR com.example.Foo - boom")).toBe("com.example.Foo")
  })

  test("无 logger 前缀返回 undefined", () => {
    expect(extractComponent("ERROR boom")).toBeUndefined()
  })
})

describe("parseTimestampToEpoch", () => {
  test("逗号毫秒与 ISO 均能解析", () => {
    expect(parseTimestampToEpoch("2024-01-15 10:00:00,123")).toBeTypeOf("number")
    expect(parseTimestampToEpoch("2024-01-15T10:00:00.123Z")).toBeTypeOf("number")
  })

  test("无法解析返回 undefined", () => {
    expect(parseTimestampToEpoch("not-a-time")).toBeUndefined()
    expect(parseTimestampToEpoch()).toBeUndefined()
  })
})

describe("bucketByTime", () => {
  test("按分钟分桶并标出计数", () => {
    const raw = [
      "2024-01-15 10:00:01,000 ERROR a",
      "2024-01-15 10:00:02,000 ERROR a",
      "2024-01-15 10:01:00,000 ERROR b",
    ].join("\n")
    const buckets = bucketByTime(parseLogEvents(raw))
    expect(buckets).toHaveLength(2)
    expect(buckets[0].bucket).toBe("2024-01-15 10:00")
    expect(buckets[0].count).toBe(2)
    expect(buckets[1].count).toBe(1)
  })

  test("无时间戳事件返回空数组", () => {
    expect(bucketByTime(parseLogEvents("ERROR a\nERROR b"))).toHaveLength(0)
  })
})

describe("rankRootCause", () => {
  test("计数高者优先", () => {
    const groups = groupErrors(
      parseLogEvents(["ERROR A: x", "ERROR A: x", "ERROR B: y"].join("\n")),
    )
    const root = rankRootCause(groups)
    expect(root?.signature).toContain("A")
  })

  test("计数相同时末次出现更新者优先", () => {
    const groups = [
      { signature: "A", level: "ERROR" as const, count: 1, firstSeen: "2024-01-15 10:00:00,000", lastSeen: "2024-01-15 10:00:00,000", sample: "", component: undefined, firstLine: "A" },
      { signature: "B", level: "ERROR" as const, count: 1, firstSeen: "2024-01-15 11:00:00,000", lastSeen: "2024-01-15 11:00:00,000", sample: "", component: undefined, firstLine: "B" },
    ]
    expect(rankRootCause(groups)?.signature).toBe("B")
  })

  test("空数组返回 null", () => {
    expect(rankRootCause([])).toBeNull()
  })
})

describe("groupErrors 增强字段", () => {
  test("写入 component 与 firstLine", () => {
    const raw = "2024-01-15 10:00:00,000 [main] ERROR com.Foo - boom\njava.lang.NullPointerException"
    const groups = groupErrors(parseLogEvents(raw))
    expect(groups[0].component).toBe("com.Foo")
    expect(groups[0].firstLine).toContain("ERROR com.Foo - boom")
  })
})

describe("createRingBuffer", () => {
  test("超出上限丢弃最旧元素", () => {
    const rb = createRingBuffer<number>(3)
    ;[1, 2, 3, 4, 5].forEach((n) => rb.push(n))
    expect(rb.snapshot()).toEqual([3, 4, 5])
    rb.clear()
    expect(rb.snapshot()).toEqual([])
  })
})

describe("truncateText", () => {
  test("超长文本截断并标注原长度", () => {
    const out = truncateText("x".repeat(50), 10)
    expect(out.length).toBeLessThanOrEqual(10 + 30)
    expect(out).toContain("已截断")
  })

  test("未超限原样返回", () => {
    expect(truncateText("hello", 10)).toBe("hello")
  })
})

describe("远端命令构造", () => {
  test("buildTailCommand 基础与过滤", () => {
    expect(buildTailCommand("/var/log/a.log", 200)).toBe('tail -n 200 "/var/log/a.log"')
    const withLevel = buildTailCommand("/var/log/a.log", 200, { level: "error" })
    expect(withLevel).toContain('grep -i -E "\\b(ERROR)\\b"')
    const withGrep = buildTailCommand("/var/log/a.log", 200, { grep: "timeout" })
    expect(withGrep).toContain('grep -i -F "timeout"')
    const withSince = buildTailCommand("/var/log/a.log", 200, { since: "2024-01-15 10:" })
    expect(withSince).toContain('grep -F "2024-01-15 10:"')
  })

  test("buildErrorSearchCommand 与 buildContextCommand", () => {
    expect(buildErrorSearchCommand("/p", 500)).toBe('tail -n 500 "/p"')
    expect(buildContextCommand("/p", 100, 5)).toBe('sed -n 95,105p "/p"')
    expect(buildContextCommand("/p", 2, 5)).toBe('sed -n 1,7p "/p"')
  })

  test("buildFindLineCommand 与 buildListFilesCommand", () => {
    expect(buildFindLineCommand("/p", "oom")).toBe('grep -n -F -- "oom" "/p" | head -5')
    const list = buildListFilesCommand(["/a", "/b"])
    expect(list).toContain('ls -l "/a"')
    expect(list).toContain('echo "缺失: /b"')
  })
})
