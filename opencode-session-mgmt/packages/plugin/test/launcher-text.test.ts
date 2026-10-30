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

  test("三个工作流都有短提示、入口与帮助按钮", () => {
    for (const text of [
      "输入「启动一般任务」",
      "输入「启动 SDLC 工作流」",
      "输入「启动 REQDOC 工作流」",
      "查看使用说明",
    ]) {
      expect(nsi).toContain(text)
    }
    expect(nsi).toContain("代码审核也选这里")
    expect(nsi.match(/预估 2 小时/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
    expect(nsi).not.toContain("系统自动开始计时")
  })

  test("一般任务提示完成方式，会话管理未启用时给出依赖提示", () => {
    expect(nsi).toContain("完成后说「本次任务已完成」")
    expect(nsi).toContain("身份文件缺失，工作流暂时不可选")
    expect(nsi).toContain("未启用「会话管理」，工作流选择和工时统计都不会生效")
  })

  test("工作流说明为卡片布局，帮助按当前工作流动态生成", () => {
    expect(nsi).toContain("NSD_CreateVLine} 492 356 1 94")
    expect(nsi).toContain('NSD_CreateButton} 512 380 158 32 "查看使用说明"')
    expect(nsi).toContain("Function SetHelpText")
    expect(nsi).toContain("Function ShowUsageHelp")
    expect(nsi).toContain("代码审核也选「一般任务」")
    expect(nsi).toContain("报告提交后才能完成审核任务")
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
