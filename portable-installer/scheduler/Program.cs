using System.Diagnostics;
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
        var opencode = Path.Combine(Root, "runtime", "opencode.cmd");
        if (!File.Exists(opencode)) throw new InvalidOperationException("未找到运行环境，请重新运行安装包");
        var args = "--prompt " + Quote(task.Prompt);
        var openConsole = Path.Combine(Root, "terminal", "OpenConsole.exe");
        if (File.Exists(openConsole))
        {
            var title = task.Name.Replace("\"", "").Replace("&", "＆").Replace("|", "丨").Replace("<", "＜").Replace(">", "＞");
            var command = "cmd /c \"title 定时任务 - " + title + " && " + Quote(opencode) + " " + args + "\"";
            return Process.Start(new ProcessStartInfo(openConsole)
            {
                UseShellExecute = true,
                WorkingDirectory = task.Directory,
                Arguments = command
            }) ?? throw new InvalidOperationException("无法启动定时任务终端");
        }
        return Process.Start(new ProcessStartInfo(opencode)
        {
            UseShellExecute = true,
            WorkingDirectory = task.Directory,
            Arguments = args
        }) ?? throw new InvalidOperationException("无法启动 OpenCode");
    }

    private static string Quote(string value) => "\"" + value.Replace("\"", "\\\"") + "\"";
}
