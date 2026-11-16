#!/usr/bin/env bun

import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

// 必须用 OpenTUI 的 Solid 转换插件，否则 JSX 会被编译成静态值：
// 信号变化时不会重绘（tick、消息列表都不更新）。
const result = await Bun.build({
  entrypoints: ["src/tui.ts"],
  outdir: "dist",
  target: "bun",
  format: "esm",
  plugins: [createSolidTransformPlugin()],
  external: ["@opentui/core", "@opentui/solid", "@opentui/solid/jsx-runtime", "solid-js", "solid-js/store"],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

for (const output of result.outputs) {
  console.log(`built ${output.path} ${(output.size / 1024).toFixed(2)} KB`)
}
