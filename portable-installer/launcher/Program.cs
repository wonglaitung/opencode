using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

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

internal sealed record ResumeResult(bool Can, string Hint, string? Workflow = null, string? SessionID = null, string? Title = null);

internal sealed record SessionInfo(string SessionID, string Title, string Directory, long Updated, string? Workflow);

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
    string Home,
    string? ConfigProblem = null
);

internal sealed class LauncherForm : Form
{
    private readonly WebView2 web = new() { Dock = DockStyle.Fill };
    private static readonly string Home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    private static readonly string Root = Path.Combine(Home, "OpenCode");
    private static readonly string Node = Path.Combine(Root, "runtime", "node.exe");
    private static readonly string ConfigHelper = Path.Combine(AppContext.BaseDirectory, "launcher-config.js");
    private static readonly string Bun = Path.Combine(Root, "runtime", "node_modules", "bun", "bin", "bun.exe");
    private static readonly string TeamShareCli = Path.Combine(Root, "runtime", "opencode-team-share", "cli.ts");
    private const string SmartHubUrl = "http://123.33.13.9:9090";

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public LauncherForm()
    {
        Text = "数字程序员";
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.Sizable;
        MaximizeBox = true;
        ClientSize = new Size(1180, 760);
        MinimumSize = new Size(900, 600);
        BackColor = Color.FromArgb(248, 250, 252);
        ApplyWindowIcon();
        Controls.Add(web);
        Load += OnLoadAsync;
    }

    private void ApplyWindowIcon()
    {
        try
        {
            var iconPath = Path.Combine(AppContext.BaseDirectory, "icon.ico");
            Icon = File.Exists(iconPath)
                ? new Icon(iconPath)
                : Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        }
        catch
        {
            // 图标缺失不应阻止启动器打开。
        }
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
                case "openHub":
                    Process.Start(new ProcessStartInfo(SmartHubUrl) { UseShellExecute = true });
                    break;
                case "openScheduler":
                {
                    var scheduler = Path.Combine(Root, "OpenCode-Scheduler.exe");
                    if (!File.Exists(scheduler))
                    {
                        Post("error", "未找到定时任务程序，请重新运行安装包");
                        break;
                    }
                    Process.Start(new ProcessStartInfo(scheduler) { UseShellExecute = true });
                    break;
                }
                case "browse":
                    Post("browse", Browse(root.GetProperty("payload").GetProperty("dir").GetString() ?? ""));
                    break;
                case "resume":
                    Post("resume", CheckResume(root.GetProperty("payload")));
                    break;
                case "launch":
                    Post("launch", await LaunchAsync(root.GetProperty("payload")));
                    break;
                case "teamListSessions":
                {
                    // 筛选与分页下推到 SQL：本机可能有几千条会话，全量拉取 + 全量渲染会让
                    // 输入和点选都卡（本机 230 条时全量 JSON 66KB、43% 还是子代理会话）。
                    var args = new List<string> { "list-sessions" };
                    foreach (var (flag, key) in new[]
                    {
                        ("--search", "search"),
                        ("--project", "project"),
                        ("--since", "since"),
                        ("--sort", "sort"),
                        ("--limit", "limit"),
                        ("--cursor", "cursor"),
                    })
                    {
                        var value = PayloadString(root, key);
                        if (value.Length > 0) { args.Add(flag); args.Add(value); }
                    }
                    if (PayloadFlag(root, "includeChildren")) { args.Add("--include-children"); args.Add("true"); }
                    PostTeamJson("teamSessions", RunTeamShare(args), "读取会话失败");
                    break;
                }
                case "teamListProjects":
                    PostTeamJson("teamProjects", RunTeamShare(new[] { "list-projects" }), "读取项目失败");
                    break;
                case "teamBrowseFile":
                {
                    var picked = ChooseOpenPath();
                    if (picked.Length > 0) Post("teamFilePath", new { path = picked });
                    break;
                }
                case "teamSaveFile":
                {
                    var saved = ChooseSavePath(PayloadString(root, "defaultName"));
                    if (saved.Length > 0) Post("teamSavePath", new { path = saved });
                    break;
                }
                case "teamExport":
                {
                    var args = new List<string>
                    {
                        "export",
                        "--session", PayloadString(root, "sessionId"),
                        "--out", PayloadString(root, "out"),
                        "--note", PayloadString(root, "note")
                    };
                    AppendDb(args, PayloadString(root, "db"));
                    PostTeamJson("teamExported", RunTeamShare(args), "导出失败");
                    break;
                }
                case "teamInspect":
                    PostTeamJson("teamInspected", RunTeamShare(new[] { "inspect", "--file", PayloadString(root, "path") }), "读取交接文件失败");
                    break;
                case "teamImport":
                {
                    if (IsOpencodeRunning())
                    {
                        Post("error", "请先退出 opencode 再导入（避免与运行中的进程同时写库）");
                        break;
                    }
                    var args = new List<string> { "import", "--file", PayloadString(root, "path"), "--project", PayloadString(root, "projectId") };
                    var mode = PayloadString(root, "mode");
                    if (mode == "reference" || mode == "handoff")
                    {
                        args.Add("--mode");
                        args.Add(mode);
                    }
                    AppendDb(args, PayloadString(root, "db"));
                    PostTeamJson("teamImported", RunTeamShare(args), "导入失败");
                    break;
                }
                case "teamOpenSession":
                {
                    var sessionId = PayloadString(root, "sessionId");
                    if (sessionId.Length == 0)
                    {
                        Post("error", "缺少会话 id");
                        break;
                    }
                    Post("launch", await LaunchAsync(root.GetProperty("payload"), sessionId));
                    break;
                }
                case "teamOpenFolder":
                {
                    var target = PayloadString(root, "path");
                    if (target.Length > 0 && File.Exists(target))
                        Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{target}\"") { UseShellExecute = true });
                    break;
                }
                case "roomResume":
                    Post("roomResume", CheckResumeFor(PayloadString(root, "dir")));
                    break;
                case "roomStart":
                {
                    var dir = PayloadString(root, "dir");
                    if (dir.Length == 0 || !Directory.Exists(dir))
                    {
                        Post("roomStart", new { ok = false, error = "请先选择有效的项目目录" });
                        break;
                    }
                    if (!WriteRoomIntent(dir, "{\"mode\":\"host\"}"))
                    {
                        Post("roomStart", new { ok = false, error = "写入房间意图失败，请检查目录权限" });
                        break;
                    }
                    Post("roomStart", await LaunchAsync(root.GetProperty("payload"), null, noPrompt: false));
                    break;
                }
                case "roomJoin":
                {
                    var dir = PayloadString(root, "dir");
                    var invite = PayloadString(root, "invite");
                    var name = PayloadString(root, "name");
                    if (dir.Length == 0 || !Directory.Exists(dir))
                    {
                        Post("roomJoin", new { ok = false, error = "请选择有效的工作目录" });
                        break;
                    }
                    if (!InvitePattern.IsMatch(invite))
                    {
                        Post("roomJoin", new { ok = false, error = "邀请码格式不正确" });
                        break;
                    }
                    if (name.Length == 0)
                    {
                        Post("roomJoin", new { ok = false, error = "请填写昵称" });
                        break;
                    }
                    var intent = JsonSerializer.Serialize(new { mode = "join", invite, name });
                    if (!WriteRoomIntent(dir, intent))
                    {
                        Post("roomJoin", new { ok = false, error = "写入房间意图失败，请检查目录权限" });
                        break;
                    }
                    Post("roomJoin", await LaunchAsync(root.GetProperty("payload"), null, noPrompt: true));
                    break;
                }
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

    // ---------------------------------------------------------------- 团队协作

    private static string PayloadString(JsonElement root, string name)
    {
        if (!root.TryGetProperty("payload", out var payload)) return "";
        if (!payload.TryGetProperty(name, out var value)) return "";
        return value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";
    }

    /// <summary>布尔参数（缺省 false）；界面传 JSON true 才为真，避免字符串 "false" 被当真。</summary>
    private static bool PayloadFlag(JsonElement root, string name)
    {
        if (!root.TryGetProperty("payload", out var payload)) return false;
        if (!payload.TryGetProperty(name, out var value)) return false;
        return value.ValueKind == JsonValueKind.True;
    }

    private static readonly Regex InvitePattern = new(@"^wss?://\S+[?&]token=[^&\s]+", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>协作房间的启动意图：插件读取后立即删除，60 秒后自动失效。</summary>
    private static bool WriteRoomIntent(string dir, string json)
    {
        try
        {
            var folder = Path.Combine(dir, ".opencode");
            Directory.CreateDirectory(folder);
            File.WriteAllText(Path.Combine(folder, "collab-room.json"), json);
            return true;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>把界面里选定的数据库路径透传给 CLI，避免导出与导入分两次探测时选到不同的库。</summary>
    private static void AppendDb(List<string> args, string db)
    {
        if (db.Length == 0) return;
        args.Add("--db");
        args.Add(db);
    }

    private void PostTeamJson(string type, (int ExitCode, string Stdout, string Stderr) run, string fallback)
    {
        if (run.ExitCode != 0)
        {
            var message = run.Stderr.Trim();
            Post("error", message.Length > 0 ? message : fallback);
            return;
        }
        try
        {
            Post(type, JsonSerializer.Deserialize<JsonElement>(run.Stdout.Trim()));
        }
        catch
        {
            Post("error", fallback);
        }
    }

    /// <summary>调用随包分发的团队协作 CLI（bun 直接跑 TypeScript，无需编译）。</summary>
    private static (int ExitCode, string Stdout, string Stderr) RunTeamShare(IEnumerable<string> args, int timeoutMs = 120000)
    {
        if (!File.Exists(Bun)) return (-1, "", "未找到运行时 bun.exe，请重新运行安装包");
        if (!File.Exists(TeamShareCli)) return (-1, "", "未找到团队协作组件，请重新运行安装包");
        var psi = new ProcessStartInfo(Bun)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            // bun 输出 UTF-8；不显式指定会按系统代码页解码，中文会变乱码。
            StandardOutputEncoding = System.Text.Encoding.UTF8,
            StandardErrorEncoding = System.Text.Encoding.UTF8,
            WorkingDirectory = Path.GetDirectoryName(TeamShareCli)!
        };
        psi.ArgumentList.Add("run");
        psi.ArgumentList.Add(TeamShareCli);
        foreach (var arg in args) psi.ArgumentList.Add(arg);
        using var process = Process.Start(psi) ?? throw new InvalidOperationException("无法启动团队协作组件");
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        if (!process.WaitForExit(timeoutMs))
        {
            try { process.Kill(true); } catch { }
            return (-1, stdout, "团队协作组件超时");
        }
        return (process.ExitCode, stdout, stderr);
    }

    /// <summary>opencode 是否在运行（导入要写库，必须独占）。</summary>
    private static bool IsOpencodeRunning()
    {
        try
        {
            var psi = new ProcessStartInfo("tasklist")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true
            };
            psi.ArgumentList.Add("/FI");
            psi.ArgumentList.Add("IMAGENAME eq opencode.exe");
            using var process = Process.Start(psi);
            if (process is null) return false;
            var output = process.StandardOutput.ReadToEnd();
            process.WaitForExit(5000);
            return output.Contains("opencode.exe", StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private static string ChooseSavePath(string defaultName)
    {
        using var dialog = new SaveFileDialog
        {
            Title = "导出交接文件",
            Filter = "会话交接 (*.ocsave)|*.ocsave|所有文件 (*.*)|*.*",
            FileName = defaultName.Length > 0 ? defaultName : "会话交接.ocsave",
            InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
            OverwritePrompt = true
        };
        return dialog.ShowDialog() == DialogResult.OK ? dialog.FileName : "";
    }

    private static string ChooseOpenPath()
    {
        using var dialog = new OpenFileDialog
        {
            Title = "选择交接文件",
            Filter = "会话交接 (*.ocsave)|*.ocsave|所有文件 (*.*)|*.*",
            CheckFileExists = true
        };
        return dialog.ShowDialog() == DialogResult.OK ? dialog.FileName : "";
    }

    private static ConfigState LoadState()
    {
        var fallback = new ConfigState(
            "sdlc", "native", true, false, false, false, false,
            ReadLast("last_project.txt"), ReadLast("last_workflow.txt"), Home, Home
        );
        if (!File.Exists(ConfigHelper))
            return fallback with { ConfigProblem = "launcher-config-missing" };
        if (!File.Exists(Node))
            return fallback with { ConfigProblem = "runtime-missing" };
        var temp = Path.Combine(Path.GetTempPath(), "opencode-launcher-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temp);
        try
        {
            var run = RunNode(new[] { ConfigHelper, "--dump", temp, "--home", Home }, 10000);
            if (run.ExitCode != 0) return fallback with { ConfigProblem = "config-read-failed" };
            var ini = File.ReadAllLines(Path.Combine(temp, "state.ini"))
                .Select(line => line.Split('=', 2))
                .Where(parts => parts.Length == 2)
                .ToDictionary(parts => parts[0].Trim(), parts => parts[1].Trim());
            string Get(string key, string value) => ini.TryGetValue(key, out var found) ? found : value;
            bool Flag(string key) => Get(key, "0") == "1";
            var configOk = Flag("config_ok");
            return new ConfigState(
                Get("workflow", "sdlc"),
                Get("terminal", "native"),
                Flag("sm"), Flag("edge"), Flag("server"),
                configOk, Flag("identity_ok"),
                ReadLast("last_project.txt"), ReadLast("last_workflow.txt"),
                Directory.Exists(ReadLast("last_project.txt")) ? ReadLast("last_project.txt") : Home,
                Home,
                configOk ? null : "config-invalid"
            );
        }
        catch
        {
            return fallback with { ConfigProblem = "config-read-failed" };
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
        var dir = payload.TryGetProperty("dir", out var dirValue) ? dirValue.GetString() ?? "" : "";
        return CheckResumeFor(dir);
    }

    /// <summary>恢复条件以数据库里的真实会话为准，不再依赖 last_project/last_workflow 文本。</summary>
    private static ResumeResult CheckResumeFor(string dir)
    {
        var state = LoadState();
        if (dir.Length == 0) return new ResumeResult(false, "请先选择项目目录");
        var info = LookupSession(dir, null);
        var can = state.ConfigOk && state.IdentityOk && info != null;
        var hint = info == null
            ? "该项目暂无历史会话，将新建"
            : $"可继续：{WorkflowLabel(info.Workflow)} · {info.Title}";
        return new ResumeResult(can, hint, info?.Workflow, info?.SessionID, info?.Title);
    }

    private static readonly object SessionInfoLock = new();
    private static readonly Dictionary<string, (DateTime At, SessionInfo? Info)> SessionInfoCache = new();

    /// <summary>按目录取最近主会话，或按 id 取指定会话；失败返回 null（调用方回退为新建）。</summary>
    private static SessionInfo? LookupSession(string? dir, string? sessionId)
    {
        var key = (sessionId is { Length: > 0 } ? sessionId : dir ?? "").Trim().ToLowerInvariant();
        if (key.Length == 0) return null;
        lock (SessionInfoLock)
        {
            if (SessionInfoCache.TryGetValue(key, out var hit) && (DateTime.UtcNow - hit.At).TotalSeconds < 30)
                return hit.Info;
        }

        var args = new List<string> { "session-info" };
        if (sessionId is { Length: > 0 }) { args.Add("--session"); args.Add(sessionId); }
        else { args.Add("--dir"); args.Add(dir!); }

        SessionInfo? info = null;
        var run = RunTeamShare(args, 15000);
        if (run.ExitCode == 0)
        {
            try
            {
                using var doc = JsonDocument.Parse(run.Stdout.Trim());
                var root = doc.RootElement;
                if (root.TryGetProperty("sessionID", out var id) && id.ValueKind == JsonValueKind.String &&
                    (id.GetString() ?? "") is { Length: > 0 } sessionID)
                {
                    var title = root.TryGetProperty("title", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() ?? "" : "";
                    var directory = root.TryGetProperty("directory", out var d) && d.ValueKind == JsonValueKind.String ? d.GetString() ?? "" : "";
                    var updated = root.TryGetProperty("updated", out var u) && u.ValueKind == JsonValueKind.Number ? u.GetInt64() : 0;
                    var workflow = root.TryGetProperty("workflow", out var w) && w.ValueKind == JsonValueKind.String ? w.GetString() : null;
                    info = new SessionInfo(sessionID, title, directory, updated, workflow);
                }
            }
            catch
            {
                info = null;
            }
        }

        lock (SessionInfoLock) SessionInfoCache[key] = (DateTime.UtcNow, info);
        return info;
    }

    private static string WorkflowLabel(string? workflow) => workflow switch
    {
        "task" => "一般任务",
        "sdlc" => "SDLC",
        "reqdoc" => "REQDOC",
        "websec" => "WEB 安全自测",
        _ => "上次工作流",
    };

    private async Task<object> LaunchAsync(JsonElement payload, string? sessionId = null, bool noPrompt = false)
    {
        var state = LoadState();
        var dir = payload.TryGetProperty("dir", out var dirValue) ? dirValue.GetString() ?? "" : "";
        var workflow = payload.TryGetProperty("workflow", out var workflowValue) ? workflowValue.GetString() ?? "sdlc" : "sdlc";
        var terminal = payload.TryGetProperty("terminal", out var terminalValue) ? terminalValue.GetString() ?? "native" : "native";
        var resume = payload.TryGetProperty("resume", out var resumeValue) && resumeValue.ValueKind == JsonValueKind.True;
        var plugins = payload.TryGetProperty("plugins", out var pluginValue) && pluginValue.ValueKind == JsonValueKind.Array
            ? pluginValue.EnumerateArray().Select(x => x.GetString() ?? "").Where(x => x.Length > 0).ToArray()
            : Array.Empty<string>();
        if (dir.Length == 0 || !Directory.Exists(dir))
            return new { ok = false, error = "请先选择有效的项目目录" };

        // 恢复：会话与工作流都以数据库为准；缺 sm 会丢掉工作流进度，因此自动补齐。
        var info = sessionId is { Length: > 0 } ? LookupSession(null, sessionId) : (resume ? LookupSession(dir, null) : null);
        var session = sessionId is { Length: > 0 } ? sessionId : (resume ? info?.SessionID : null);
        if (info?.Workflow is { Length: > 0 } derived) workflow = derived;
        if (session is { Length: > 0 } && !plugins.Contains("sm")) plugins = plugins.Append("sm").ToArray();

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
            "websec" => "启动 WEB 安全测试工作流",
            _ => "启动SDLC工作流"
        };
        var common = new List<string>();
        if (session is { Length: > 0 })
        {
            // 数据库定位到的会话（继续/交接）直接按 id 打开，比 -c 的排序更确定。
            common.Add("--session");
            common.Add(session);
        }
        else if (resume && canResume) common.Add("-c");
        else if (!noPrompt)
        {
            // 协作房间不能注入启动短语：访客端会把自己的模型跑起来，违反“访客零 token”。
            common.Add("--prompt");
            common.Add(prompt);
        }

        try
        {
            var opencode = Path.Combine(Root, "runtime", "opencode.cmd");
            if (!File.Exists(opencode)) return new { ok = false, error = "未找到运行环境，请重新运行安装包" };
            if (terminal == "dedicated")
            {
                const string commandPromptProfile = "{0caa0dad-35be-5f56-a8ff-afceeeaa6101}";
                var windowsTerminal = Path.Combine(Root, "terminal", "WindowsTerminal.exe");
                if (!File.Exists(windowsTerminal)) return new { ok = false, error = "未找到专用终端 WindowsTerminal.exe" };
                // 直接交给 Windows Terminal 执行；用 cmd /c 包裹会丢失提示词引号，带空格的提示词会被拆成多个参数。
                var command = Quote(opencode) + " " + string.Join(" ", common.Select(Quote));
                var arguments = "-p \"" + commandPromptProfile + "\" -d " + Quote(dir) + " --title \"数字程序员\" " + command;
                Process.Start(new ProcessStartInfo(windowsTerminal) { UseShellExecute = true, WorkingDirectory = dir, Arguments = arguments });
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
            SaveLast(state, dir, workflow, plugins.Contains("sm"));
            BeginInvoke(new Action(Close));
            return new { ok = true };
        }
        catch (Exception ex)
        {
            return new { ok = false, error = ex.Message };
        }
    }

    private static void SaveLast(ConfigState state, string dir, string workflow, bool sm)
    {
        try
        {
            var configDir = Path.Combine(Home, ".config", "opencode");
            Directory.CreateDirectory(configDir);
            File.WriteAllText(Path.Combine(configDir, "last_project.txt"), dir);
            if (state.ConfigOk && state.IdentityOk && sm)
                File.WriteAllText(Path.Combine(configDir, "last_workflow.txt"), workflow);
            else
                File.Delete(Path.Combine(configDir, "last_workflow.txt"));
        }
        catch
        {
            // 最近项目写入失败不应阻止启动。
        }
    }

    private static string Quote(string value)
    {
        var sb = new System.Text.StringBuilder(value.Length + 2);
        sb.Append('"');
        var backslashes = 0;
        foreach (var c in value)
        {
            if (c == '\\')
            {
                backslashes++;
                continue;
            }
            if (c == '"')
            {
                sb.Append('\\', backslashes * 2 + 1);
                sb.Append('"');
                backslashes = 0;
                continue;
            }
            sb.Append('\\', backslashes);
            backslashes = 0;
            sb.Append(c);
        }
        sb.Append('\\', backslashes * 2);
        sb.Append('"');
        return sb.ToString();
    }

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
