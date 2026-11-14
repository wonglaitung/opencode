#!/usr/bin/env bun
/**
 * 离线/CI 独立校验 websec 产物（不依赖插件运行时状态）。
 *
 * 用法：
 *   bun run scripts/validate-websec.ts <报告目录> [更多目录...]
 *
 * 目录内需有 report.json 与 coverage-ledger.json（websec_report 自动写入）。
 * 退出码：0 全部通过；1 存在校验错误；2 参数错误。
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { validateWebsecArtifacts } from "../packages/plugin/src/websec-validate"

const dirs = process.argv.slice(2)
if (dirs.length === 0) {
  console.error("用法：bun run scripts/validate-websec.ts <报告目录> [更多目录...]")
  process.exit(2)
}

let failed = 0
for (const dir of dirs) {
  const read = (name: string): unknown => {
    try {
      return JSON.parse(readFileSync(join(dir, name), "utf8"))
    } catch {
      return null
    }
  }
  const errors = validateWebsecArtifacts(read("report.json"), read("coverage-ledger.json"))
  if (errors.length === 0) {
    console.log(`✅ ${dir}`)
    continue
  }
  failed++
  console.log(`❌ ${dir}（${errors.length} 项）`)
  for (const error of errors) console.log(`   - ${error}`)
}

process.exit(failed === 0 ? 0 : 1)
