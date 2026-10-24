"use strict"

/**
 * OpenCode 启动器配置助手（由 OpenCode-launch.exe 内嵌并调用）
 *
 * --dump <outdir>  把当前配置写入 <outdir>/state.ini，供 NSIS 读取
 * --apply          按参数写入工作流 / 终端 / 插件开关
 *
 * 只改目标字段，其余内容原样保留；配置写入前留 .bak，写入后做 JSON 校验。
 */

const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const ORDER = ["sm", "edge", "server"]
const BUNDLES = {
  sm: "opencode-sm-bundle-0.1.0/packages/plugin",
  edge: "opencode-edge-debug-bundle-0.0.1",
  server: "opencode-server-debug-bundle-0.0.1",
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith("--")) continue
    const eq = arg.indexOf("=")
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1)
      continue
    }
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next
      i++
    } else {
      out[key] = true
    }
  }
  return out
}

function homeDir(args) {
  if (typeof args.home === "string" && args.home.trim() !== "") return args.home
  return process.env.USERPROFILE || os.homedir()
}

function configDir(args) {
  return path.join(homeDir(args), ".config", "opencode")
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return null
  }
}

function readStringToken(text, start) {
  if (text[start] !== '"') return null
  let i = start + 1
  let escaped = false
  while (i < text.length) {
    const c = text[i]
    if (escaped) {
      escaped = false
      i++
      continue
    }
    if (c === "\\") {
      escaped = true
      i++
      continue
    }
    if (c === '"') {
      const raw = text.slice(start, i + 1)
      try {
        return { end: i + 1, value: JSON.parse(raw) }
      } catch {
        return { end: i + 1, value: raw.slice(1, -1) }
      }
    }
    i++
  }
  return null
}

function skipTrivia(text, start) {
  let i = start
  while (i < text.length) {
    const c = text[i]
    const n = text[i + 1]
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i++
      continue
    }
    if (c === "/" && n === "/") {
      i += 2
      while (i < text.length && text[i] !== "\n") i++
      continue
    }
    if (c === "/" && n === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
      continue
    }
    break
  }
  return i
}

function scanArray(text, start) {
  let i = start
  let depth = 0
  while (i < text.length) {
    const c = text[i]
    const n = text[i + 1]
    if (c === '"') {
      const tok = readStringToken(text, i)
      if (!tok) return null
      i = tok.end
      continue
    }
    if (c === "/" && (n === "/" || n === "*")) {
      i = skipTrivia(text, i)
      continue
    }
    if (c === "[") {
      depth++
      i++
      continue
    }
    if (c === "]") {
      depth--
      i++
      if (depth === 0) return { start, end: i - 1, inner: text.slice(start + 1, i - 1) }
      continue
    }
    i++
  }
  return null
}

function findTopLevelKey(text, key) {
  let i = 0
  let depth = 0
  while (i < text.length) {
    const c = text[i]
    const n = text[i + 1]
    if (c === "/" && (n === "/" || n === "*")) {
      i = skipTrivia(text, i)
      continue
    }
    if (c === '"') {
      const tok = readStringToken(text, i)
      if (!tok) return -1
      i = tok.end
      if (depth === 1) {
        const colon = skipTrivia(text, i)
        if (text[colon] === ":" && tok.value === key) {
          return skipTrivia(text, colon + 1)
        }
      }
      continue
    }
    if (c === "[") {
      const arr = scanArray(text, i)
      if (!arr) return -1
      i = arr.end + 1
      continue
    }
    if (c === "{") {
      depth++
      i++
      continue
    }
    if (c === "}") {
      depth--
      i++
      continue
    }
    i++
  }
  return -1
}

function findPluginArray(text) {
  const valueStart = findTopLevelKey(text, "plugin")
  if (valueStart < 0 || text[valueStart] !== "[") return null
  return scanArray(text, valueStart)
}

function collectStrings(text) {
  const out = []
  let i = 0
  while (i < text.length) {
    const c = text[i]
    const n = text[i + 1]
    if (c === "/" && (n === "/" || n === "*")) {
      i = skipTrivia(text, i)
      continue
    }
    if (c === '"') {
      const tok = readStringToken(text, i)
      if (!tok) break
      out.push(tok.value)
      i = tok.end
      continue
    }
    i++
  }
  return out
}

function findRootClose(text) {
  let i = 0
  let depth = 0
  while (i < text.length) {
    const c = text[i]
    const n = text[i + 1]
    if (c === "/" && (n === "/" || n === "*")) {
      i = skipTrivia(text, i)
      continue
    }
    if (c === '"') {
      const tok = readStringToken(text, i)
      if (!tok) return -1
      i = tok.end
      continue
    }
    if (c === "{") {
      depth++
      i++
      continue
    }
    if (c === "}") {
      depth--
      if (depth === 0) return i
      i++
      continue
    }
    i++
  }
  return -1
}

function stripComments(text) {
  let out = ""
  let i = 0
  let inString = false
  let escaped = false
  while (i < text.length) {
    const c = text[i]
    const n = text[i + 1]
    if (inString) {
      out += c
      if (escaped) escaped = false
      else if (c === "\\") escaped = true
      else if (c === '"') inString = false
      i++
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      i++
      continue
    }
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++
      continue
    }
    if (c === "/" && n === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

function removeTrailingCommas(text) {
  let out = ""
  let i = 0
  let inString = false
  let escaped = false
  while (i < text.length) {
    const c = text[i]
    if (inString) {
      out += c
      if (escaped) escaped = false
      else if (c === "\\") escaped = true
      else if (c === '"') inString = false
      i++
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      i++
      continue
    }
    if (c === ",") {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      if (text[j] === "]" || text[j] === "}") {
        i++
        continue
      }
    }
    out += c
    i++
  }
  return out
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function validateJsonc(text) {
  try {
    JSON.parse(removeTrailingCommas(stripComments(stripBom(text))))
    return true
  } catch {
    return false
  }
}

function normalize(value) {
  return String(value).replace(/\\/g, "/").toLowerCase()
}

function canonicalPath(root, key) {
  return String(root).replace(/\\/g, "/") + "/runtime/" + BUNDLES[key]
}

function formatArray(values) {
  if (values.length === 0) return "[]"
  return "[\n" + values.map((v) => "    " + JSON.stringify(v)).join(",\n") + "\n  ]"
}

function pluginState(text) {
  const enabled = new Set()
  const arr = findPluginArray(text)
  if (!arr) return enabled
  for (const item of collectStrings(arr.inner)) {
    const normalized = normalize(item)
    for (const key of ORDER) {
      if (normalized.includes(BUNDLES[key])) enabled.add(key)
    }
  }
  return enabled
}

function buildPluginText(text, enabled, root) {
  const pluginValue = findTopLevelKey(text, "plugin")
  if (pluginValue >= 0 && text[pluginValue] !== "[") {
    throw fail("CONFIG_PARSE", "opencode.jsonc 的 plugin 字段不是数组，未做修改")
  }
  const arr = findPluginArray(text)
  const desired = []
  const known = {}
  const unknown = []

  if (arr) {
    for (const item of collectStrings(arr.inner)) {
      const normalized = normalize(item)
      const key = ORDER.find((k) => normalized.includes(BUNDLES[k]))
      if (key) known[key] = item
      else unknown.push(item)
    }
    for (const item of unknown) desired.push(item)
    for (const key of ORDER) {
      if (enabled.has(key)) desired.push(known[key] || canonicalPath(root, key))
    }
    const replacement = formatArray(desired)
    return text.slice(0, arr.start) + replacement + text.slice(arr.end + 1)
  }

  const close = findRootClose(text)
  if (close < 0) throw fail("CONFIG_PARSE", "opencode.jsonc 结构无法识别，未做修改")

  for (const key of ORDER) {
    if (enabled.has(key)) desired.push(canonicalPath(root, key))
  }
  const before = text.slice(0, close)
  const after = text.slice(close)
  const trimmed = before.replace(/\s+$/, "")
  const needsComma = !trimmed.endsWith("{") && !trimmed.endsWith(",")
  const block = (needsComma ? "," : "") + '\n  "plugin": ' + formatArray(desired) + "\n"
  return trimmed + block + after
}

function writeAtomic(file, text) {
  const tmp = file + ".tmp-" + process.pid
  fs.writeFileSync(tmp, text, "utf8")
  fs.renameSync(tmp, file)
}

function fail(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function readWorkflow(identityPath) {
  const text = readText(identityPath)
  if (text === null) return { workflow: "sdlc", ok: false }
  try {
    const parsed = JSON.parse(stripBom(text))
    if (typeof parsed !== "object" || parsed === null) return { workflow: "sdlc", ok: false }
    const ok =
      typeof parsed.apiKey === "string" &&
      parsed.apiKey.trim() !== "" &&
      typeof parsed.collector_url === "string" &&
      parsed.collector_url.trim() !== ""
    const workflow = parsed.workflowType === "reqdoc" ? "reqdoc" : "sdlc"
    return { workflow, ok }
  } catch {
    return { workflow: "sdlc", ok: false }
  }
}

function readTerminal(terminalPath) {
  const text = readText(terminalPath)
  if (text === null) return "native"
  const first = text.split(/\r?\n/, 1)[0].trim()
  return first === "dedicated" ? "dedicated" : "native"
}

function dump(args) {
  const outDir = args.dump
  if (typeof outDir !== "string" || outDir === "") throw fail("USAGE", "--dump 缺少输出目录")
  ensureDir(outDir)

  const identity = path.join(configDir(args), "session-mgmt", "identity.json")
  const terminal = path.join(configDir(args), "terminal_mode.ini")
  const opencodeConfig = path.join(configDir(args), "opencode.jsonc")

  const workflow = readWorkflow(identity)
  const terminalMode = readTerminal(terminal)

  const configText = readText(opencodeConfig)
  let configOk = false
  let enabled = new Set()
  if (configText !== null && validateJsonc(configText)) {
    const pluginValue = findTopLevelKey(configText, "plugin")
    if (pluginValue < 0 || configText[pluginValue] === "[") {
      configOk = true
      enabled = pluginState(configText)
    }
  }

  const lines = [
    "[state]",
    "workflow=" + workflow.workflow,
    "terminal=" + terminalMode,
    "sm=" + (enabled.has("sm") ? "1" : "0"),
    "edge=" + (enabled.has("edge") ? "1" : "0"),
    "server=" + (enabled.has("server") ? "1" : "0"),
    "identity_ok=" + (workflow.ok ? "1" : "0"),
    "config_ok=" + (configOk ? "1" : "0"),
    "",
  ]
  writeAtomic(path.join(outDir, "state.ini"), lines.join("\r\n"))
}

function apply(args) {
  const identity = path.join(configDir(args), "session-mgmt", "identity.json")
  const terminal = path.join(configDir(args), "terminal_mode.ini")
  const opencodeConfig = path.join(configDir(args), "opencode.jsonc")
  const root = typeof args.root === "string" && args.root !== "" ? args.root : path.join(homeDir(args), "OpenCode")

  const plans = []

  if (args.plugins !== undefined) {
    if (typeof args.plugins !== "string") throw fail("PLUGIN_UNKNOWN", "--plugins 需要逗号分隔的插件名")
    const names = args.plugins.split(",").map((s) => s.trim()).filter(Boolean)
    for (const name of names) {
      if (!ORDER.includes(name)) throw fail("PLUGIN_UNKNOWN", "未知插件：" + name)
    }
    const text = readText(opencodeConfig)
    if (text === null) throw fail("CONFIG_MISSING", "未找到 opencode.jsonc，请重新运行安装包")
    if (!validateJsonc(text)) throw fail("CONFIG_PARSE", "opencode.jsonc 无法解析，未做修改")
    const next = buildPluginText(text, new Set(names), root)
    if (!validateJsonc(next)) throw fail("CONFIG_WRITE_BAD", "改写后的 opencode.jsonc 校验失败，未写入")
    if (next !== text) plans.push({ file: opencodeConfig, oldText: text, text: next, label: "opencode.jsonc" })
  }

  if (args.workflow !== undefined) {
    if (args.workflow !== "sdlc" && args.workflow !== "reqdoc") throw fail("WORKFLOW_UNKNOWN", "未知工作流：" + args.workflow)
    const text = readText(identity)
    if (text === null) throw fail("IDENTITY_MISSING", "未找到 identity.json，请先运行 opencode-sm init 或重新运行安装包")
    let parsed
    try {
      parsed = JSON.parse(stripBom(text))
    } catch {
      throw fail("IDENTITY_PARSE", "identity.json 无法解析，未做修改")
    }
    if (typeof parsed !== "object" || parsed === null) throw fail("IDENTITY_INVALID", "identity.json 结构不正确")
    if (typeof parsed.apiKey !== "string" || parsed.apiKey.trim() === "") {
      throw fail("IDENTITY_INVALID", "identity.json 缺少 apiKey，请先运行 opencode-sm init")
    }
    if (typeof parsed.collector_url !== "string" || parsed.collector_url.trim() === "") {
      throw fail("IDENTITY_INVALID", "identity.json 缺少 collector_url，请先运行 opencode-sm init")
    }
    const next = { ...parsed, workflowType: args.workflow }
    const nextText = JSON.stringify(next, null, 2) + "\n"
    if (nextText !== text) plans.push({ file: identity, oldText: text, text: nextText, label: "identity.json" })
  }

  if (args.terminal !== undefined) {
    if (args.terminal !== "native" && args.terminal !== "dedicated") {
      throw fail("TERMINAL_UNKNOWN", "未知终端类型：" + args.terminal)
    }
    const text = readText(terminal)
    const next =
      args.terminal + "\n; mode: native | dedicated (edit this file to switch terminal)\n"
    if (text !== next) plans.push({ file: terminal, oldText: text, text: next, label: "terminal_mode.ini" })
  }

  const written = []
  try {
    for (const plan of plans) {
      ensureDir(path.dirname(plan.file))
      if (plan.oldText !== null) {
        try {
          fs.copyFileSync(plan.file, plan.file + ".bak")
        } catch {
          // 备份失败不阻断，保留原文件仍可回滚
        }
      }
      writeAtomic(plan.file, plan.text)
      written.push(plan)
    }
  } catch (err) {
    for (const plan of written.reverse()) {
      try {
        if (plan.oldText === null) fs.unlinkSync(plan.file)
        else writeAtomic(plan.file, plan.oldText)
      } catch {
        // 回滚失败时保留现场，错误信息里给出文件路径
      }
    }
    throw err
  }

  return plans.map((p) => p.label)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const errorFile = typeof args["error-file"] === "string" ? args["error-file"] : null

  try {
    if (typeof args.dump === "string") {
      dump(args)
    } else if (args.apply) {
      const changed = apply(args)
      if (errorFile) {
        try {
          fs.unlinkSync(errorFile)
        } catch {
          // 没有旧错误文件
        }
      }
      process.stdout.write(changed.length === 0 ? "配置无变化\n" : "已更新：" + changed.join("、") + "\n")
    } else {
      throw fail("USAGE", "用法：launcher-config.js --dump <dir> | --apply ...")
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err)
    if (errorFile) {
      try {
        ensureDir(path.dirname(errorFile))
        fs.writeFileSync(errorFile, (err && err.code ? err.code : "UNKNOWN") + "\r\n", "utf8")
      } catch {
        // 错误文件写不了时仍通过退出码告知
      }
    }
    process.stderr.write(message + "\n")
    process.exit(2)
  }
}

main()
