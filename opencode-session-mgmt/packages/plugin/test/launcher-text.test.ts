import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const buildDir = join(import.meta.dir, "../../../../portable-installer/build")
const nsi = readFileSync(join(buildDir, "OpenCode-launch.nsi"), "utf8")
const config = readFileSync(join(buildDir, "launcher-config.js"), "utf8")

describe("OpenCode-launch 工作流选项与提示", () => {
  test("一般任务排在菜单第一项", () => {
    const task = nsi.indexOf('"一般任务"')
    const sdlc = nsi.indexOf('"SDLC 开发流程"')
    const reqdoc = nsi.indexOf('"REQDOC 需求书"')
    expect(task).toBeGreaterThan(-1)
    expect(sdlc).toBeGreaterThan(task)
    expect(reqdoc).toBeGreaterThan(sdlc)
  })

  test("三个工作流都有入口与预估提示", () => {
    expect(nsi).toContain("输入「启动 SDLC 工作流」进入")
    expect(nsi).toContain("输入「启动 REQDOC 工作流」进入")
    expect(nsi).toContain("直接输入任务内容即开始")
    for (const text of ["直接输入任务内容", "启动 SDLC 工作流", "启动 REQDOC 工作流"]) {
      expect(nsi).toContain(text)
    }
    expect(nsi.match(/预估 xx 小时/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })

  test("一般任务提示完成方式，会话管理未启用时给出依赖提示", () => {
    expect(nsi).toContain("完成后请说「完成」")
    expect(nsi).toContain("未填不能完成")
    expect(nsi).toContain("未启用会话管理，工作流选择不生效，也不记录工时。")
  })

  test("切换工作流时强制重绘提示，避免旧说明残留", () => {
    expect(nsi).toContain("RedrawWindow(i $Dialog")
  })

  test("使用大窗口布局与自定义底部按钮", () => {
    expect(nsi).toContain("SetWindowPos(i $HWNDPARENT, i 0, i 0, i 0, i 760, i 660")
    expect(nsi).toContain("SetWindowPos(i $Dialog, i 0, i 0, i 0, i 720, i 580")
    expect(nsi).toContain("Function DoCancel")
    expect(nsi).toContain('${NSD_CreateButton} 552 516 138 46 "取消"')
  })

  test("launcher-config 读写 task", () => {
    expect(config).toContain('parsed.workflowType === "task"')
    expect(config).toContain('args.workflow !== "task"')
  })
})
