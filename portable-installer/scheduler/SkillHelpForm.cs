namespace OpenCodeScheduler;

internal sealed class SkillHelpForm : Form
{
    private readonly Font titleFont = new("Microsoft YaHei UI", 18F, FontStyle.Bold);
    private readonly Font sectionFont = new("Microsoft YaHei UI", 11.5F, FontStyle.Bold);
    private readonly Font bodyFont = new("Microsoft YaHei UI", 9.5F);
    private readonly Font codeFont = new("Consolas", 9F);

    public SkillHelpForm(string? directory)
    {
        Text = "Skill 使用说明";
        StartPosition = FormStartPosition.CenterParent;
        Width = 760;
        Height = 700;
        MinimumSize = new Size(640, 540);
        BackColor = Color.White;
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        var body = new RichTextBox
        {
            Dock = DockStyle.Fill,
            ReadOnly = true,
            BorderStyle = BorderStyle.None,
            BackColor = Color.White,
            Font = bodyFont,
            WordWrap = true,
            ScrollBars = RichTextBoxScrollBars.Vertical,
            DetectUrls = false
        };
        var host = new Panel { Dock = DockStyle.Fill, Padding = new Padding(22, 14, 22, 8), BackColor = Color.White };
        host.Controls.Add(body);

        var close = new Button { Text = "关闭", AutoSize = true, MinimumSize = new Size(88, 32), Padding = new Padding(12, 3, 12, 3), DialogResult = DialogResult.OK };
        var actions = new FlowLayoutPanel
        {
            Dock = DockStyle.Bottom,
            Height = 60,
            FlowDirection = FlowDirection.RightToLeft,
            Padding = new Padding(16, 10, 16, 10),
            BackColor = Color.White
        };
        actions.Controls.Add(close);
        AcceptButton = close;
        CancelButton = close;
        Controls.Add(host);
        Controls.Add(actions);

        Render(body, directory);
    }

    private void Render(RichTextBox box, string? directory)
    {
        var skills = string.IsNullOrWhiteSpace(directory)
            ? @"<项目目录>\.opencode\skills"
            : Path.Combine(directory, ".opencode", "skills");

        Append(box, "Skill 使用说明\n", titleFont, Color.FromArgb(15, 23, 42));
        Append(box, "定时任务只加载任务项目目录下的项目级 Skill。\n", bodyFont, Color.FromArgb(71, 85, 105));

        Section(box, "1. 目录结构");
        Body(box, "一个完整的项目 Skill 可以包含说明文件和脚本：");
        Code(box, $"{skills}\\hello\\SKILL.md\n{skills}\\hello\\scripts\\inspect.ps1");
        Body(box, "调度器只扫描任务项目目录本身，不扫描父目录、全局目录或插件来源。");

        Section(box, "2. SKILL.md 示例");
        Body(box, "SKILL.md 负责告诉模型何时使用、按什么步骤执行：");
        Code(box, """
---
name: hello
description: 读取项目文件并输出字符统计
---

# Hello Skill

## 何时使用
需要快速查看一个文本文件的行数和字符数时使用。

## 执行步骤
1. 确认目标文件位于项目目录内。
2. 通过 bash 运行脚本：
   powershell -NoProfile -ExecutionPolicy Bypass -File "<skill-dir>\scripts\inspect.ps1" -Path "<project>\README.md"
3. 将脚本输出的 JSON 汇总给用户。
4. 不修改目标文件。

## 注意
- 不读取项目目录外的文件。
- 需要执行命令权限。
""");

        Section(box, "3. 脚本示例");
        Body(box, "scripts\\inspect.ps1：");
        Code(box, """
param(
    [Parameter(Mandatory = $true)]
    [string]$Path
)

$full = [IO.Path]::GetFullPath($Path)
if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
    throw "文件不存在：$full"
}

$text = [IO.File]::ReadAllText($full)
$lines = ([regex]::Matches($text, "`n")).Count + 1

[pscustomobject]@{
    Path  = $full
    Chars = $text.Length
    Lines = $lines
} | ConvertTo-Json -Compress
""");

        Section(box, "4. 启用权限");
        Body(box, "在任务编辑页的「权限」区域勾选「使用项目 Skill」。权限控制整个任务的工具，不是单个 Skill 的权限。");
        Bullet(box, "读取文件（仅项目目录）：用于 Skill 读取项目文件。");
        Bullet(box, "修改文件：Skill 需要写文件时勾选。");
        Bullet(box, "执行命令：Skill 需要运行脚本，或脚本需要联网时勾选。");
        Bullet(box, "访问网络（Web 工具）：仅用于 WebFetch / WebSearch，不控制 curl、Invoke-WebRequest 等脚本联网。");
        Body(box, "注意：启用「执行命令」后，bash 不受读取范围限制。", Color.FromArgb(180, 83, 9));

        Section(box, "5. 在 Prompt 中调用");
        Body(box, "建议明确指定 Skill 名称，例如：");
        Code(box, "使用项目 Skill `hello`，统计 README.md 的行数和字符数。");

        Section(box, "6. 查看运行结果");
        Code(box, @"%USERPROFILE%\.config\opencode\scheduler\scheduled-task.log");
        Body(box, "实际路径按当前 Windows 用户自动展开，其他机器也使用 %USERPROFILE%，不会固定为某个人的目录。");
        Body(box, "成功加载时会出现类似日志：");
        Code(box, "[工具] 任务名 | skill | completed");

        Section(box, "7. 当前限制");
        Bullet(box, "只加载任务项目目录下的 .opencode\\skills。");
        Bullet(box, "全局、用户级和插件来源的 Skill 始终禁用。");
        Bullet(box, "任务目录不是项目根目录时，请把任务目录改为项目根目录。");
        Bullet(box, "未勾选「使用项目 Skill」时，所有 Skill 调用都会被拒绝。");

        box.SelectionStart = 0;
        box.SelectionLength = 0;
    }

    private void Section(RichTextBox box, string text)
    {
        Append(box, $"\n{text}\n", bodyFont, Color.FromArgb(37, 99, 235), true);
    }

    private void Body(RichTextBox box, string text, Color? color = null)
    {
        Append(box, $"{text}\n", bodyFont, color ?? Color.FromArgb(30, 41, 59));
    }

    private void Bullet(RichTextBox box, string text)
    {
        Append(box, $"  • {text}\n", bodyFont, Color.FromArgb(51, 65, 85));
    }

    private void Code(RichTextBox box, string text)
    {
        Append(box, "\n", bodyFont, Color.FromArgb(30, 41, 59));
        Append(box, $"{text}\n", codeFont, Color.FromArgb(30, 41, 59), Color.FromArgb(241, 245, 249));
    }

    private void Append(RichTextBox box, string text, Font font, Color color, bool section = false)
    {
        box.SelectionStart = box.TextLength;
        box.SelectionLength = 0;
        box.SelectionFont = section ? sectionFont : font;
        box.SelectionColor = color;
        box.SelectionBackColor = Color.White;
        box.AppendText(text);
    }

    private void Append(RichTextBox box, string text, Font font, Color color, Color background)
    {
        box.SelectionStart = box.TextLength;
        box.SelectionLength = 0;
        box.SelectionFont = font;
        box.SelectionColor = color;
        box.SelectionBackColor = background;
        box.AppendText(text);
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (!disposing) return;
        titleFont.Dispose();
        sectionFont.Dispose();
        bodyFont.Dispose();
        codeFont.Dispose();
    }
}
