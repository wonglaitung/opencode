import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const buildDir = join(import.meta.dir, "../../../../portable-installer/build")
const nsi = readFileSync(join(buildDir, "OpenCode-launch.nsi"), "utf8")
const setup = readFileSync(join(buildDir, "OpenCode-Setup.nsi"), "utf8")
const config = readFileSync(join(buildDir, "launcher-config.js"), "utf8")
const webview = readFileSync(join(buildDir, "../launcher/index.html"), "utf8")
const program = readFileSync(join(buildDir, "../launcher/Program.cs"), "utf8")

describe("OpenCode-launch 工作流选项与提示", () => {
  test("一般任务排在菜单第一项", () => {
    const task = nsi.indexOf('"一般任务"')
    const sdlc = nsi.indexOf('"SDLC 开发流程"')
    const reqdoc = nsi.indexOf('"REQDOC 需求书"')
    const websec = nsi.indexOf('"WEB 安全自测"')
    expect(task).toBeGreaterThan(-1)
    expect(sdlc).toBeGreaterThan(task)
    expect(reqdoc).toBeGreaterThan(sdlc)
    expect(websec).toBeGreaterThan(reqdoc)
  })

  test("四个工作流都有短提示、入口与帮助链接", () => {
    for (const text of [
      "新会话自动发送「启动一般任务」",
      "新会话自动发送「启动 SDLC 工作流」",
      "新会话自动发送「启动 REQDOC 工作流」",
      "新会话自动发送「启动 WEB 安全测试工作流」",
      "查看使用说明",
    ]) {
      expect(nsi).toContain(text)
    }
    expect(nsi).toContain("代码审核也选这里")
    expect(nsi).toContain("启动后说明审核范围")
    expect(nsi).not.toContain("直接说「帮我审核")
    expect(nsi.match(/预估 2 小时/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
    expect(nsi).not.toContain("系统自动开始计时")
  })

  test("一般任务提示完成方式，会话管理未启用时给出依赖提示", () => {
    expect(nsi).toContain("完成后说「本次任务已完成」")
    expect(nsi).toContain("身份文件缺失，工作流暂时不可选")
    expect(nsi).toContain("未启用「会话管理」，工作流选择和工时统计都不会生效")
  })

  test("工作流说明为卡片布局，帮助按当前工作流动态生成", () => {
    expect(nsi).toContain('NSD_CreateGroupBox} 320 292 660 160 "工作流说明"')
    expect(nsi).toContain('NSD_CreateLink} 770 316 190 20 "查看使用说明 ›"')
    expect(nsi).toContain("Function SyncWorkflowLabels")
    expect(nsi).toContain("Function SelectTaskWorkflow")
    expect(nsi).toContain("Function SelectWebsecWorkflow")
    expect(nsi).toContain("Function SetHelpText")
    expect(nsi).toContain("Function ShowUsageHelp")
    expect(nsi).toContain("代码审核也选「一般任务」")
    expect(nsi).toContain("新会话自动发送「启动一般任务」后，说明审核范围，例如")
    expect(nsi).toContain("报告提交后才能完成审核任务")
    expect(nsi).toContain("EnableWindow $hHelp 1")
    expect(nsi).toContain("EnableWindow $hHelp 0")
    expect(nsi).toContain("SetCtlColors $hHelp 0x9CA3AF")
  })

  test("切换工作流时强制重绘提示，避免旧说明残留", () => {
    expect(nsi).toContain("RedrawWindow(i $Dialog")
  })

  test("使用大窗口布局与自定义底部按钮", () => {
    expect(nsi).toContain("SetWindowPos(i $HWNDPARENT, i 0, i 0, i 0, i 1120, i 720")
    expect(nsi).toContain("SetWindowPos(i $Dialog, i 0, i 0, i 0, i 1080, i 680")
    expect(nsi).toContain("Function DoCancel")
    expect(nsi).toContain('${NSD_CreateButton} 980 236 80 28 "取消"')
    expect(nsi).toContain('${NSD_CreateButton} 320 228 650 44 "打开数字程序员"')
    expect(nsi).toContain('${NSD_CreateDirRequest} 320 180 560 28')
    expect(nsi).toContain('${NSD_CreateButton} 890 180 100 28 "浏览…"')
    expect(nsi).toContain('--prompt=启动一般任务')
    expect(nsi).toContain('--prompt=启动SDLC工作流')
    expect(nsi).toContain('--prompt=启动REQDOC工作流')
    expect(nsi).toContain('--prompt=启动WEB安全测试工作流')
    expect(nsi).toContain('$ResumeFlag$PromptFlag')
    expect(nsi).toContain('$ResumeFlag != " -c"')
  })

  test("launcher-config 读写 task/websec", () => {
    expect(config).toContain('parsed.workflowType === "task"')
    expect(config).toContain('parsed.workflowType === "websec"')
    expect(config).toContain('args.workflow !== "task"')
    expect(config).toContain('args.workflow !== "websec"')
  })

  test("WebView 启动器内置 WEB 安全自测使用说明", () => {
    expect(webview).toContain('label: "WEB 安全自测"')
    expect(webview).toContain("applyWorkflowDefaults")
    expect(webview).toContain('state.plugins = state.plugins.filter(key => key !== "edge")')
    expect(webview).toContain("启动 WEB 安全测试工作流")
    expect(webview).toContain("普通测试")
    expect(webview).toContain("越权测试")
    expect(webview).toContain("websec-evidence")
    expect(webview).toContain(".gitignore")
    expect(webview).toContain("预估工时")
    expect(webview).toContain("本次录入已完成")
    expect(webview).toContain("当前是普通账号还是高权账号")
    expect(webview).toContain("自动清除登录态")
    expect(webview).toContain("切换到高权账号阶段")
    expect(webview).toContain("范围与边界 → 资产与接口 → 安全检查 → 验证与定级 → 报告与修复")
    expect(nsi).toContain("系统内部固定五阶段")
    expect(nsi).toContain("本次录入已完成")
    expect(nsi).toContain("当前是普通账号还是高权账号")
    expect(nsi).toContain("自动清除登录态")
    expect(nsi).toContain("切换到高权账号阶段")
    expect(nsi).toContain("未录入不能定稿")
    expect(program).toContain('"websec" => "启动 WEB 安全测试工作流"')
    // 缺陷（2026-11-16）：在「团队协作」页点左侧工作流，只改了选中项、界面停在协作页，
    // 用户以为点击没反应。点工作流必须切回向导页。
    expect(webview).toContain('if (!$("teamView").hidden) showView("wizard")')
    // 翻页期间排序键变化会让同一会话再次出现在后续页；「加载更多」必须按 id 去重。
    expect(webview).toContain("!team.seen.has(item.id)")
    expect(nsi).toContain("WEB 安全自测使用会话管理内置的 Edge 桥接")
    expect(nsi).toContain("${NSD_Uncheck} $hEdge")
  })
})

describe("协作房间入口", () => {
  test("团队协作页有第三个 tab 与开协作房间/加入协作房间表单", () => {
    expect(webview).toContain('data-team-tab="room"')
    expect(webview).toContain('id="teamRoom"')
    expect(webview).toContain('id="roomDir"')
    expect(webview).toContain('id="roomResume"')
    expect(webview).toContain('id="roomStartBtn"')
    expect(webview).toContain('id="roomInvite"')
    expect(webview).toContain('id="roomName"')
    expect(webview).toContain('id="roomJoinDir"')
    expect(webview).toContain('id="roomJoinBtn">加入协作房间<')
    expect(webview).toContain('id="roomStartBtn">开协作房间<')
    expect(webview).toContain('prefillRoom')
    expect(webview).toContain('state.browseTarget')
  })

  test("Program.cs 写意图文件且开协作房间/加入协作房间不注入启动短语", () => {
    expect(program).toContain('case "roomStart"')
    expect(program).toContain('case "roomJoin"')
    expect(program).toContain('collab-room.json')
    expect(program).toContain("InvitePattern")
    expect(program).toContain("noPrompt: true")
    expect(program).toContain("else if (!noPrompt)")
    expect(program).toContain("访客零 token")
  })

  test("协作房间使用说明遵守帮助排版约定并覆盖快捷键", () => {
    expect(webview).toContain('id="roomHelp"')
    expect(webview).toContain("ROOM_HELP")
    expect(webview).toContain("第一步：开协作房间（主持人）")
    expect(webview).toContain("第二步：加入协作房间（访客）")
    expect(webview).toContain("点「开协作房间」")
    expect(webview).toContain("点「加入协作房间」")
    expect(webview).toContain("卡片会直接显示邀请码")
    expect(webview).toContain("Ctrl+X 再按 B")
    expect(webview).toContain("房间内操作：")
    expect(webview).toContain("审批与断线：")
    expect(webview).toContain("Alt+M 或 F3")
    expect(webview).toContain("中文输入法")
    expect(webview).toContain("Ctrl+P")
    expect(webview).toContain("提示：访客不会消耗本机模型额度")
    // 帮助渲染靠这两个小节标题出 h3；漏加会退化成正文段落。
    expect(webview).toContain("|房间内操作：|审批与断线：")
  })

  test("TUI 插件只写 tui.json，不污染安装器生成的 opencode.jsonc", () => {
    expect(setup).not.toContain("opencode-collab-room")
    expect(config).toContain("function buildTuiPluginText")
    expect(config).toContain("https://opencode.ai/tui.json")
    expect(config).toContain('path.join(configDir(args), "tui.json")')
  })

  test("launcher-config 把协作房间写进 tui 配置并清理 opencode.jsonc 残留", () => {
    expect(config).toContain("ROOM_BUNDLE")
    expect(config).toContain("opencode-collab-room")
    expect(config).toContain("function roomPath")
    expect(config).toContain('normalize(item).includes(ROOM_BUNDLE)')
  })
})

describe("恢复会话：插件与工作流以数据库为准", () => {
  test("启动器所有恢复入口都走同一套查询", () => {
    expect(program).toContain('"session-info"')
    expect(program).toContain("LookupSession")
    expect(program).toContain("CheckResumeFor")
    expect(program).toContain("WorkflowLabel")
    expect(program).toContain('case "roomResume"')
    // 恢复/交接自动补齐 sm，避免工作流进度丢失
    expect(program).toContain('plugins.Append("sm")')
    // 恢复按会话 id 打开，不再依赖 -c 的排序
    expect(program).toContain("common.Add(session)")
  })

  test("工作流顶栏跟随实际：恢复时显示会话工作流", () => {
    expect(webview).toContain("function roomResuming")
    expect(webview).toContain('activeTeamTab() === "room" && roomResuming()')
    expect(webview).toContain("（沿用上次会话）")
    expect(webview).toContain("取消勾选则按")
    expect(webview).toContain("沿用该会话的工作流")
    expect(webview).not.toContain("roomWorkflowHint")
  })

  test("工作流只有向导页一个选择入口，团队页统一只读展示", () => {
    expect(webview).not.toContain('id="roomWorkflow"')
    expect(webview).not.toContain("roomWorkflowHint")
    expect(webview).not.toContain("roomWorkflowSwitch")
    expect(webview).toContain('id="teamWorkflowLine"')
    expect(webview).toContain("function renderTeamWorkflow")
    expect(webview).toContain('id="teamWorkflowSwitch"')
    expect(webview).toContain("在向导页切换")
    expect(webview).toContain("当前工作流：")
    expect(webview).toContain("导出/导入会话交给同事")
    expect(webview).toContain("开协作房间让同事实时旁观")
    expect(webview).toContain("协作房间把当前会话实时分享给同事")
    expect(webview).toContain("将沿用上次会话")
    expect(webview).toContain('workflow: state.workflow,')
    expect(webview).toContain('id="roomResumeHint"')
    expect(webview).toContain("checkRoomResume")
    expect(webview).toContain('post("roomResume"')
    expect(webview).not.toContain('resume: $("roomResume").checked,\n    noPrompt: true')
  })

  test("继续上次会话时同步工作流，目录输入防抖", () => {
    expect(webview).toContain("resumeTimer")
    expect(webview).toContain("clearTimeout(resumeTimer)")
    expect(webview).toContain("state.workflow = result.workflow")
  })
})
