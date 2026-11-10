using System.Diagnostics;
using System.Text.Json;
using OpenCodeLauncher;

namespace OpenCodeScheduler;

internal static class Program
{
    private const string ShowEventName = @"Local\OpenCodeSchedulerShow";

    [STAThread]
    private static void Main()
    {
        using var mutex = new Mutex(true, "OpenCodeSchedulerPrototype", out var created);
        if (!created)
        {
            for (var attempt = 0; attempt < 5; attempt++)
            {
                try
                {
                    using var show = EventWaitHandle.OpenExisting(ShowEventName);
                    show.Set();
                    return;
                }
                catch (WaitHandleCannotBeOpenedException)
                {
                    Thread.Sleep(100);
                }
                catch (UnauthorizedAccessException)
                {
                    break;
                }
            }
            MessageBox.Show("定时任务程序正在启动，请稍后重试。", "OpenCode 定时任务", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        using var showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEventName);
        ApplicationConfiguration.Initialize();
        Application.Run(new TrayContext(showEvent));
    }
}

internal sealed class TrayContext : ApplicationContext
{
    private static readonly string Home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    private static readonly string Root = Path.Combine(Home, "OpenCode");
    private readonly ScheduledTaskScheduler scheduler;
    private readonly NotifyIcon tray;
    private readonly RegisteredWaitHandle showRegistration;
    private SynchronizationContext? sync;
    private SchedulerForm? manager;
    private bool exiting;

    public TrayContext(EventWaitHandle showEvent)
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
        showRegistration = ThreadPool.RegisterWaitForSingleObject(
            showEvent,
            (_, timedOut) =>
            {
                if (!timedOut) RequestShow();
            },
            null,
            Timeout.Infinite,
            false
        );
        Application.Idle += OnIdle;
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

    private void OnIdle(object? sender, EventArgs e)
    {
        if (exiting) return;
        Application.Idle -= OnIdle;
        sync = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
        ShowManager();
    }

    private void RequestShow()
    {
        if (exiting) return;
        if (sync is null)
        {
            return;
        }
        sync.Post(_ => ShowManager(), null);
    }

    private void ShowManager()
    {
        if (exiting) return;
        if (manager is null || manager.IsDisposed)
        {
            manager = new SchedulerForm(scheduler);
            manager.FormClosed += (_, _) => manager = null;
        }
        manager.Show();
        manager.WindowState = FormWindowState.Normal;
        manager.Activate();
        manager.BringToFront();
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
        exiting = true;
        Application.Idle -= OnIdle;
        showRegistration.Unregister(null);
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
        // 不启动 TUI/终端；输出重定向后由调度器写入运行日志。
        var psi = new ProcessStartInfo(opencode)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = task.Directory
        };
        psi.Environment["OPENCODE_PERMISSION"] = ScheduledPermissions(task);
        psi.ArgumentList.Add("--pure");
        psi.ArgumentList.Add("run");
        psi.ArgumentList.Add("--format");
        psi.ArgumentList.Add("json");
        psi.ArgumentList.Add(task.Prompt);
        return Process.Start(psi) ?? throw new InvalidOperationException("无法启动 OpenCode");
    }

    private static string ScheduledPermissions(ScheduledTask task)
    {
        var permissions = task.Permissions ?? new ScheduledTaskPermissions();
        var read = permissions.Read ? ReadRule(task.Directory) : "\"deny\"";
        var readTool = permissions.Read ? "\"allow\"" : "\"deny\"";
        var edit = permissions.Edit ? "\"allow\"" : "\"deny\"";
        var bash = permissions.Bash ? "\"allow\"" : "\"deny\"";
        var network = permissions.Network ? "\"allow\"" : "\"deny\"";
        var skill = permissions.Skill ? ProjectSkillRule(task.Directory) : "\"deny\"";
        return $"{{\"read\":{read},\"edit\":{edit},\"list\":{readTool},\"glob\":{readTool},\"grep\":{readTool},\"bash\":{bash},\"webfetch\":{network},\"websearch\":{network},\"skill\":{skill}}}";
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
        var root = Path.Combine(directory, ".opencode", "skills");
        if (Directory.Exists(root))
        {
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
