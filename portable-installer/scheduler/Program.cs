using System.Diagnostics;
using System.Text.Json;
using OpenCodeLauncher;

namespace OpenCodeScheduler;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        using var mutex = new Mutex(true, "OpenCodeSchedulerPrototype", out var created);
        if (!created)
        {
            MessageBox.Show("定时任务程序已经在运行。", "OpenCode 定时任务", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        ApplicationConfiguration.Initialize();
        Application.Run(new TrayContext());
    }
}

internal sealed class TrayContext : ApplicationContext
{
    private static readonly string Home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    private static readonly string Root = Path.Combine(Home, "OpenCode");
    private readonly ScheduledTaskScheduler scheduler;
    private readonly NotifyIcon tray;
    private SchedulerForm? manager;

    public TrayContext()
    {
        scheduler = new ScheduledTaskScheduler(
            Path.Combine(Home, ".config", "opencode"),
            StartTask,
            OnSchedulerChanged
        );
        tray = new NotifyIcon
        {
            Icon = LoadIcon(),
            Text = TrayText(),
            Visible = true,
            ContextMenuStrip = BuildMenu()
        };
        tray.DoubleClick += (_, _) => ShowManager();
    }

    private ContextMenuStrip BuildMenu()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("打开任务管理", null, (_, _) => ShowManager());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("全部暂停", null, (_, _) => SetAll(false));
        menu.Items.Add("全部恢复", null, (_, _) => SetAll(true));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出", null, (_, _) => ExitThread());
        return menu;
    }

    private void ShowManager()
    {
        if (manager is null || manager.IsDisposed)
        {
            manager = new SchedulerForm(scheduler);
            manager.FormClosed += (_, _) => manager = null;
        }
        manager.Show();
        manager.WindowState = FormWindowState.Normal;
        manager.Activate();
    }

    private void SetAll(bool enabled)
    {
        foreach (var task in scheduler.List())
        {
            try { scheduler.SetEnabled(task.Id, enabled); }
            catch (Exception ex)
            {
                tray.ShowBalloonTip(3000, "OpenCode 定时任务", ex.Message, ToolTipIcon.Warning);
            }
        }
        RefreshManager();
    }

    private void OnSchedulerChanged()
    {
        if (tray is not null) tray.Text = TrayText();
        if (manager is { IsDisposed: false, IsHandleCreated: true })
            manager.BeginInvoke(new Action(() => manager?.RefreshTasks()));
    }

    private string TrayText()
    {
        var enabled = scheduler.List().Count(x => x.Enabled);
        return enabled > 0 ? $"OpenCode 定时任务 · {enabled} 个启用" : "OpenCode 定时任务";
    }

    private void RefreshManager()
    {
        if (manager is { IsDisposed: false, IsHandleCreated: true })
            manager.BeginInvoke(new Action(() => manager?.RefreshTasks()));
    }

    protected override void ExitThreadCore()
    {
        manager?.CloseForExit();
        manager = null;
        scheduler.Dispose();
        tray.Visible = false;
        tray.Dispose();
        base.ExitThreadCore();
    }

    private static Icon LoadIcon()
    {
        try
        {
            var path = Path.Combine(AppContext.BaseDirectory, "icon.ico");
            if (File.Exists(path)) return new Icon(path);
            return Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application;
        }
        catch
        {
            return SystemIcons.Application;
        }
    }

    private static Process StartTask(ScheduledTask task)
    {
        if (!Directory.Exists(task.Directory)) throw new InvalidOperationException("项目目录不存在");
        var opencode = Path.Combine(Root, "runtime", "node_modules", "opencode-ai", "bin", "opencode.exe");
        if (!File.Exists(opencode)) throw new InvalidOperationException("未找到运行环境，请重新运行安装包");
        // 完全后台：直接执行 opencode.exe，使用 run 子命令，不加载外部插件。
        // 不使用 TUI/OpenConsole；输出重定向后由调度器写入运行日志。
        var psi = new ProcessStartInfo(opencode)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = task.Directory
        };
        psi.Environment["OPENCODE_PERMISSION"] = ScheduledPermissions(task.Directory);
        psi.ArgumentList.Add("--pure");
        psi.ArgumentList.Add("run");
        psi.ArgumentList.Add("--format");
        psi.ArgumentList.Add("json");
        psi.ArgumentList.Add(task.Prompt);
        return Process.Start(psi) ?? throw new InvalidOperationException("无法启动 OpenCode");
    }

    private static string ScheduledPermissions(string directory)
    {
        return $"{{\"read\":{ReadRule(directory)},\"edit\":\"allow\",\"list\":\"allow\",\"glob\":\"allow\",\"grep\":\"allow\",\"bash\":\"allow\",\"webfetch\":\"allow\",\"websearch\":\"allow\",\"skill\":{ProjectSkillRule(directory)}}}";
    }

    private static string ReadRule(string directory)
    {
        var worktree = Worktree(directory);
        var relative = Path.GetRelativePath(worktree, directory).Replace('\\', '/');
        var absolute = Path.GetFullPath(directory).Replace('\\', '/');
        var allow = relative == "."
            ? new[] { "**" }
            : new[] { relative, $"{relative}/**" };
        var rules = new List<string> { "\"*\":\"deny\"" };
        rules.AddRange(allow.Concat(new[] { absolute, $"{absolute}/**" })
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Select(x => $"{JsonSerializer.Serialize(x)}:\"allow\""));
        return $"{{{string.Join(",", rules)}}}";
    }

    private static string Worktree(string directory)
    {
        var current = new DirectoryInfo(Path.GetFullPath(directory));
        while (current is not null)
        {
            if (Directory.Exists(Path.Combine(current.FullName, ".git")) ||
                File.Exists(Path.Combine(current.FullName, ".git")))
                return current.FullName;
            current = current.Parent;
        }
        return Path.GetFullPath(directory);
    }

    private static string ProjectSkillRule(string directory)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var folder in new[] { "skill", "skills" })
        {
            var root = Path.Combine(directory, ".opencode", folder);
            if (!Directory.Exists(root)) continue;
            foreach (var file in Directory.EnumerateFiles(root, "SKILL.md", SearchOption.AllDirectories))
            {
                var name = ReadSkillName(file);
                if (!string.IsNullOrWhiteSpace(name) && name != "*") names.Add(name);
            }
        }
        if (names.Count == 0) return "\"deny\"";
        var rules = string.Join(",", names.OrderBy(x => x, StringComparer.Ordinal).Select(x => $"{JsonSerializer.Serialize(x)}:\"allow\""));
        return $"{{\"*\":\"deny\",{rules}}}";
    }

    private static string? ReadSkillName(string file)
    {
        using var reader = new StreamReader(file);
        if (reader.ReadLine()?.Trim() != "---") return null;
        while (reader.ReadLine() is { } line)
        {
            var value = line.Trim();
            if (value == "---") return null;
            if (!value.StartsWith("name:", StringComparison.Ordinal)) continue;
            var name = value[5..].Trim();
            if (name.Length >= 2 && ((name[0] == '"' && name[^1] == '"') || (name[0] == '\'' && name[^1] == '\'')))
                name = name[1..^1];
            return string.IsNullOrWhiteSpace(name) ? null : name;
        }
        return null;
    }
}
