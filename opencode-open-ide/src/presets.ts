/**
 * 内置 IDE 预设 registry(设计文档 2.2、决策记录 D1)。
 * 只保留最小集:vscode + idea。kind 决定文件定位参数的 CLI 语法:
 *   vscode —— `-g <path>:<line>[:<col>]`
 *   idea   —— `--line <n> [--column <n>] <path>`
 * candidates 按平台给出探测候选(含 PATH 名、常见绝对安装路径与版本化 glob),
 * 依序取第一个命中的;config.json 的 tools 可覆盖。候选含 `*` 时按 glob 展开。
 */

export type IdeKind = "vscode" | "idea"

export interface IdePreset {
  kind: IdeKind
  /** 按平台返回探测候选(含绝对路径与 glob),依序取第一个命中的。 */
  candidates: (platform: string) => string[]
}

export const IDE_PRESETS: Record<string, IdePreset> = {
  vscode: {
    kind: "vscode",
    candidates: () => ["code"],
  },
  idea: {
    kind: "idea",
    candidates: (platform) => {
      if (platform === "win32") {
        return [
          "idea64.exe",
          "idea.cmd",
          "idea",
          "C:\\Program Files\\JetBrains\\IntelliJ IDEA*\\bin\\idea64.exe",
          "C:\\Program Files (x86)\\JetBrains\\IntelliJ IDEA*\\bin\\idea64.exe",
          "C:\\Users\\*\\AppData\\Local\\Programs\\JetBrains\\IntelliJ IDEA*\\bin\\idea64.exe",
          "C:\\Users\\*\\AppData\\Local\\JetBrains\\Toolbox\\apps\\IDEA-U\\ch-0\\*\\bin\\idea64.exe",
        ]
      }
      if (platform === "darwin") {
        return [
          "idea",
          "idea.sh",
          "/Applications/IntelliJ IDEA.app/Contents/MacOS/idea",
          "/Applications/IntelliJ IDEA CE.app/Contents/MacOS/idea",
        ]
      }
      // linux(及其他 unix)
      return [
        "idea.sh",
        "idea",
        "/opt/idea/bin/idea.sh",
        "/opt/idea-*/bin/idea.sh",
        "/opt/intellij-*/bin/idea.sh",
        "/usr/local/idea*/bin/idea.sh",
        "/opt/JetBrains/Toolbox/apps/IDEA-U/ch-0/*/bin/idea.sh",
        "/home/*/.local/share/JetBrains/Toolbox/apps/IDEA-U/ch-0/*/bin/idea.sh",
        "/home/*/idea-*/bin/idea.sh",
      ]
    },
  },
}

/** 默认探测顺序(vscode → idea),config.json 的 order 可覆盖。 */
export const DEFAULT_ORDER = ["vscode", "idea"]
