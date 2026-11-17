# 定时任务（`OpenCode-Scheduler.exe`）

托盘常驻的小工具：按「一次性 / 每天 / 每周」在后台执行一条 opencode 任务，
不需要开终端，也不阻塞用户操作。入口是启动器右上角的「定时任务」。

- **技术栈**：.NET 8 WinForms，单实例（重复启动会唤起已有窗口），托盘图标 + 任务管理窗口。
- **无插件**：直接调用 `runtime\node_modules\opencode-ai\bin\opencode.exe --pure run`，
  不加载任何外部插件，避免定时任务受工作流/收集器影响。
- **完全后台**：不创建控制台窗口，stdout/stderr 重定向后写入运行日志。

## 任务模型

| 字段 | 说明 |
|---|---|
| 名称 | 列表显示名 |
| 项目目录 | opencode 的工作目录，等价于该项目的根 |
| Prompt | 每次执行时作为 `run` 的用户输入 |
| 计划 | 一次性（指定时间）/ 每天（`HH:mm`）/ 每周（选星期 + `HH:mm`） |
| 启用 | 关闭后不排期；托盘「全部暂停/全部恢复」批量切换 |
| 权限 | 读取、修改、执行命令、访问网络、使用项目 Skill（默认全开） |
| 状态 | 下次执行、上次执行、上次结果/错误 |

## 权限与沙箱

执行时通过环境变量 `OPENCODE_PERMISSION` 下发工具权限，粒度是整个任务：

- 读取关闭时 `read`/`list`/`glob`/`grep` 全为 `deny`；开启时只允许**项目目录及其子目录**，
  其余路径显式拒绝。
- 修改、命令、网络分别对应 `edit`、`bash`、`webfetch`/`websearch`。
- Skill 只允许 `<项目目录>\.opencode\skills` 下的内容；全局、用户级与插件来源的 Skill
  始终禁用（即使勾选也只放开项目内 Skill）。

## 执行与记录

- 每次到点启动一个独立进程，同一任务不会并发执行；任务运行中不能修改或删除。
- 运行结果写入历史：开始/结束时间、状态、退出码、错误、会话 ID、工具调用次数。
- 历史上限：每个任务保留最近 20 条，总计最多 200 条。
- 一次性任务执行后自动置为不再排期。
- 电脑休眠或程序未运行时不会补跑，恢复后按「下次执行时间」继续。

## 文件位置

| 路径 | 内容 |
|---|---|
| `~/.config/opencode/scheduled-tasks.json` | 任务定义 |
| `~/.config/opencode/scheduler/scheduled-task-runs.json` | 运行历史（损坏时自动备份为 `.corrupt-<时间戳>`） |
| `~/.config/opencode/scheduler/scheduled-task-events.jsonl` | 结构化事件追加日志 |
| `~/.config/opencode/scheduler/scheduled-task.log` | 纯文本日志 |

## 窗口

- **任务列表**：名称、项目目录、计划、下次执行、状态；按钮为新建、编辑、删除、立即运行、
  启用/暂停、查看日志、刷新。
- **运行历史**：按任务查看最近执行记录与错误。
- **编辑对话框**：项目目录（可浏览）、Prompt、计划、权限勾选表，附「Skill 使用说明」。
  校验：目录必须存在、Prompt 与名称非空、每周至少选一天、一次性时间必须在未来。

托盘菜单：打开任务管理、全部暂停、全部恢复、退出。

## 开发

```
scheduler/
├── Program.cs        # 单实例、托盘、调度器宿主、进程启动与权限下发
├── Scheduler.cs      # 任务模型、排期计算、运行历史与日志
├── SchedulerForm.cs  # 任务列表 + 编辑对话框
└── SkillHelpForm.cs  # Skill 限制说明
```

安装包由 `build/OpenCode-Setup.nsi` 一并安装并创建「定时任务」快捷方式。
