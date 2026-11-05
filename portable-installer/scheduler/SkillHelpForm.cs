namespace OpenCodeScheduler;

internal sealed class SkillHelpForm : Form
{
    public SkillHelpForm(string? directory)
    {
        Text = "Skill 使用说明";
        StartPosition = FormStartPosition.CenterParent;
        Width = 720;
        Height = 640;
        MinimumSize = new Size(600, 480);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        var body = new TextBox
        {
            Dock = DockStyle.Fill,
            ReadOnly = true,
            Multiline = true,
            WordWrap = true,
            ScrollBars = ScrollBars.Vertical,
            BackColor = Color.White,
            Font = new Font("Consolas", 9F),
            Text = BuildHelpText(directory)
        };
        var close = new Button { Text = "关闭", DialogResult = DialogResult.OK, AutoSize = true };
        var actions = new FlowLayoutPanel
        {
            Dock = DockStyle.Bottom,
            Height = 52,
            FlowDirection = FlowDirection.RightToLeft,
            Padding = new Padding(10, 8, 10, 8)
        };
        actions.Controls.Add(close);
        AcceptButton = close;
        CancelButton = close;
        Controls.Add(body);
        Controls.Add(actions);
    }

    private static string BuildHelpText(string? directory)
    {
        var project = string.IsNullOrWhiteSpace(directory) ? @"<项目目录>" : directory;
        var skills = string.IsNullOrWhiteSpace(directory)
            ? @"<项目目录>\.opencode\skills"
            : Path.Combine(directory, ".opencode", "skills");
        return $$"""
Skill 使用说明

1. 放置位置
仅扫描任务项目目录本身，不扫描父目录、全局目录或插件来源。

{{skills}}\<skill-name>\SKILL.md
或
{{Path.Combine(project, ".opencode", "skill")}}\<skill-name>\SKILL.md

2. 最小 SKILL.md 示例
---
name: hello
description: 演示项目级 Skill
---

# Hello

执行步骤说明。

name 必须是唯一名称，并与调度器解析到的项目 Skill 名称一致。

3. 启用权限
在任务编辑页勾选「使用项目 Skill」。

按 Skill 的实际需要继续勾选：
- 读取文件（仅项目目录）
- 修改文件
- 执行命令
- 访问网络

注意：启用「执行命令」后，bash 不受读取范围限制。

4. 在 Prompt 中调用
建议明确写出 Skill 名称，例如：

使用项目 Skill `hello` 执行任务：
读取项目文件并生成 readme.txt。

5. 查看运行结果
{{Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".config", "opencode", "scheduler", "scheduled-task.log")}}

成功加载时会出现类似日志：

[工具] 任务名 | skill | completed

6. 当前限制
- 仅加载任务项目目录下的 .opencode\skills 或 .opencode\skill
- 全局、用户级和插件来源的 Skill 始终禁用
- 任务目录不是项目根目录时，请把任务目录改为项目根目录
- 未勾选「使用项目 Skill」时，所有 Skill 调用都会被拒绝
""";
    }
}
