using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace OpenCodeLauncher;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new LauncherForm());
    }
}

internal sealed record ResumeResult(bool Can, string Hint);

internal sealed record ConfigState(
    string Workflow,
    string Terminal,
    bool Sm,
    bool Edge,
    bool Server,
    bool ConfigOk,
    bool IdentityOk,
    string LastProject,
    string LastWorkflow,
    string DefaultDir,
    string Home
);

internal sealed class LauncherForm : Form
{
    private readonly WebView2 web = new() { Dock = DockStyle.Fill };
    private static readonly string Home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    private static readonly string Root = Path.Combine(Home, "OpenCode");
    private static readonly string Node = Path.Combine(Root, "runtime", "node.exe");
    private static readonly string ConfigHelper = Path.Combine(AppContext.BaseDirectory, "launcher-config.js");

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public LauncherForm()
    {
        Text = "数字程序员";
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        ClientSize = new Size(1180, 760);
        MinimumSize = new Size(1180, 760);
        BackColor = Color.FromArgb(248, 250, 252);
        Controls.Add(web);
        Load += OnLoadAsync;
    }

    private async void OnLoadAsync(object? sender, EventArgs e)
    {
        try
        {
            var userData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OpenCode", "WebView2");
            var env = await CoreWebView2Environment.CreateAsync(null, userData);
            await web.EnsureCoreWebView2Async(env);
            web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            web.CoreWebView2.Settings.AreDevToolsEnabled = false;
            web.CoreWebView2.Settings.IsZoomControlEnabled = false;
            web.CoreWebView2.WebMessageReceived += OnWebMessage;
            web.CoreWebView2.NavigateToString(ReadHtml());
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "启动器需要 Microsoft Edge WebView2 Runtime。\n\n" +
                "请安装 WebView2 Runtime 后重试。\n\n" + ex.Message,
                "数字程序员",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
            Close();
        }
    }

    private static string ReadHtml()
    {
        using var stream = typeof(LauncherForm).Assembly.GetManifestResourceStream("index.html");
        if (stream is null) throw new InvalidOperationException("缺少启动器页面资源 index.html");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    private void Post(string type, object? payload = null)
    {
        if (web.CoreWebView2 is null) return;
        var message = JsonSerializer.Serialize(new { type, payload }, JsonOptions);
        web.CoreWebView2.PostWebMessageAsJson(message);
    }

    private async void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var root = doc.RootElement;
            var type = root.TryGetProperty("type", out var t) ? t.GetString() : null;
            switch (type)
            {
                case "init":
                    Post("state", LoadState());
                    break;
                case "browse":
                    Post("browse", Browse(root.GetProperty("payload").GetProperty("dir").GetString() ?? ""));
                    break;
                case "resume":
                    Post("resume", CheckResume(root.GetProperty("payload")));
                    break;
                case "launch":
                    Post("launch", await LaunchAsync(root.GetProperty("payload")));
                    break;
                case "cancel":
                    Close();
                    break;
            }
        }
        catch (Exception ex)
        {
            Post("error", ex.Message);
        }
    }

    private static string Browse(string current)
    {
        using var dialog = new FolderBrowserDialog
        {
            Description = "选择项目目录",
            UseDescriptionForTitle = true,
            SelectedPath = Directory.Exists(current) ? current : Home
        };
        return dialog.ShowDialog() == DialogResult.OK ? dialog.SelectedPath : "";
    }

    private static ConfigState LoadState()
    {
        var fallback = new ConfigState(
            "sdlc", "native", true, false, false, false, false,
            ReadLast("last_project.txt"), ReadLast("last_workflow.txt"), Home, Home
        );
        if (!File.Exists(Node) || !File.Exists(ConfigHelper)) return fallback;
        var temp = Path.Combine(Path.GetTempPath(), "opencode-launcher-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temp);
        try
        {
            var run = RunNode(new[] { ConfigHelper, "--dump", temp, "--home", Home }, 10000);
            if (run.ExitCode != 0) return fallback;
            var ini = File.ReadAllLines(Path.Combine(temp, "state.ini"))
                .Select(line => line.Split('=', 2))
                .Where(parts => parts.Length == 2)
                .ToDictionary(parts => parts[0].Trim(), parts => parts[1].Trim());
            string Get(string key, string value) => ini.TryGetValue(key, out var found) ? found : value;
            bool Flag(string key) => Get(key, "0") == "1";
            return new ConfigState(
                Get("workflow", "sdlc"),
                Get("terminal", "native"),
                Flag("sm"), Flag("edge"), Flag("server"),
                Flag("config_ok"), Flag("identity_ok"),
                ReadLast("last_project.txt"), ReadLast("last_workflow.txt"),
                Directory.Exists(ReadLast("last_project.txt")) ? ReadLast("last_project.txt") : Home,
                Home
            );
        }
        catch
        {
            return fallback;
        }
        finally
        {
            try { Directory.Delete(temp, true); } catch { }
        }
    }

    private static string ReadLast(string name)
    {
        try
        {
            var path = Path.Combine(Home, ".config", "opencode", name);
            return File.Exists(path) ? File.ReadAllText(path).Trim() : "";
        }
        catch { return ""; }
    }

    private static ResumeResult CheckResume(JsonElement payload)
    {
        var state = LoadState();
        var dir = payload.GetProperty("dir").GetString() ?? "";
        var workflow = payload.GetProperty("workflow").GetString() ?? "sdlc";
        var normalized = dir.TrimEnd('\\', '/');
        var last = state.LastProject.TrimEnd('\\', '/');
        var can = state.ConfigOk && state.IdentityOk && state.Sm &&
                  dir.Length > 0 && last.Length > 0 && normalized.Equals(last, StringComparison.OrdinalIgnoreCase) &&
                  workflow == state.LastWorkflow;
        return new ResumeResult(can, can ? "可回到上次进度" : "项目或工作流变化后需新建会话");
    }

    private async Task<object> LaunchAsync(JsonElement payload)
    {
        var state = LoadState();
        var dir = payload.GetProperty("dir").GetString() ?? "";
        var workflow = payload.GetProperty("workflow").GetString() ?? "sdlc";
        var terminal = payload.GetProperty("terminal").GetString() ?? "native";
        var resume = payload.GetProperty("resume").GetBoolean();
        var plugins = payload.GetProperty("plugins").EnumerateArray().Select(x => x.GetString() ?? "").Where(x => x.Length > 0).ToArray();
        if (dir.Length == 0 || !Directory.Exists(dir))
            return new { ok = false, error = "请先选择有效的项目目录" };

        if (state.ConfigOk)
        {
            var args = new List<string> { ConfigHelper, "--apply", "--home", Home, "--root", Root, "--terminal", terminal };
            args.Add("--plugins"); args.Add(string.Join(",", plugins));
            if (state.IdentityOk && plugins.Contains("sm"))
            {
                args.Add("--workflow"); args.Add(workflow);
            }
            var apply = RunNode(args, 15000);
            if (apply.ExitCode != 0)
                return new { ok = false, error = apply.Stderr.Trim() is { Length: > 0 } error ? error : "配置写入失败" };
        }

        var canResume = CheckResume(payload).Can;
        var prompt = workflow switch
        {
            "task" => "启动一般任务",
            "reqdoc" => "启动REQDOC工作流",
            _ => "启动SDLC工作流"
        };
        var common = new List<string>();
        if (resume && canResume) common.Add("-c");
        common.Add("--prompt");
        common.Add(prompt);

        try
        {
            var opencode = Path.Combine(Root, "runtime", "opencode.cmd");
            if (!File.Exists(opencode)) return new { ok = false, error = "未找到 OpenCode 运行时，请重新运行安装包" };
            if (terminal == "dedicated")
            {
                var openConsole = Path.Combine(Root, "terminal", "OpenConsole.exe");
                if (!File.Exists(openConsole)) return new { ok = false, error = "未找到专用终端 OpenConsole.exe" };
                var command = "cmd /c \"title 数字程序员 && " + Quote(opencode) + " " + string.Join(" ", common.Select(Quote)) + "\"";
                Process.Start(new ProcessStartInfo(openConsole) { UseShellExecute = true, WorkingDirectory = dir, Arguments = command });
            }
            else
            {
                var psi = new ProcessStartInfo(opencode)
                {
                    UseShellExecute = true,
                    WorkingDirectory = dir,
                    Arguments = string.Join(" ", common.Select(Quote))
                };
                Process.Start(psi);
            }
            BeginInvoke(new Action(Close));
            return new { ok = true };
        }
        catch (Exception ex)
        {
            return new { ok = false, error = ex.Message };
        }
    }

    private static string Quote(string value) => "\"" + value.Replace("\"", "\\\"") + "\"";

    private static (int ExitCode, string Stdout, string Stderr) RunNode(IEnumerable<string> args, int timeoutMs)
    {
        var psi = new ProcessStartInfo(Node)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        foreach (var arg in args) psi.ArgumentList.Add(arg);
        using var process = Process.Start(psi) ?? throw new InvalidOperationException("无法启动配置助手");
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        if (!process.WaitForExit(timeoutMs))
        {
            try { process.Kill(true); } catch { }
            return (-1, stdout, "配置助手超时");
        }
        return (process.ExitCode, stdout, stderr);
    }
}
