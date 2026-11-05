using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace OpenCodeLauncher;

public sealed class ScheduledTask
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Directory { get; set; } = "";
    public string Prompt { get; set; } = "";
    public string Schedule { get; set; } = "once";
    public long? OnceAt { get; set; }
    public string Time { get; set; } = "09:00";
    public int[] Weekdays { get; set; } = [];
    public bool Enabled { get; set; } = true;
    public long? NextRunAt { get; set; }
    public long? LastRunAt { get; set; }
    public string? LastStatus { get; set; }
    public string? LastError { get; set; }
    [JsonIgnore]
    public bool Running { get; set; }
}

public sealed class ScheduledRun
{
    public string Id { get; set; } = "";
    public string TaskId { get; set; } = "";
    public string TaskName { get; set; } = "";
    public string Directory { get; set; } = "";
    public long StartedAt { get; set; }
    public long? FinishedAt { get; set; }
    public string Status { get; set; } = "running";
    public int? ExitCode { get; set; }
    public string? Error { get; set; }
    public string? SessionID { get; set; }
    public int ToolCalls { get; set; }
}

public sealed class ScheduledTaskScheduler : IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = true
    };

    private readonly object gate = new();
    private readonly object logLock = new();
    private readonly string path;
    private readonly string historyPath;
    private readonly string eventsPath;
    private readonly string textLogPath;
    private readonly Func<ScheduledTask, Process> start;
    private readonly Action changed;
    private readonly System.Threading.Timer timer;
    private readonly Dictionary<string, Process> running = new();
    private readonly Dictionary<string, string> runIds = new();
    private List<ScheduledTask> tasks;
    private List<ScheduledRun> runs;

    public ScheduledTaskScheduler(string configDir, Func<ScheduledTask, Process> start, Action changed)
    {
        Directory.CreateDirectory(configDir);
        path = Path.Combine(configDir, "scheduled-tasks.json");
        var logDir = Path.Combine(configDir, "scheduler");
        Directory.CreateDirectory(logDir);
        historyPath = Path.Combine(logDir, "scheduled-task-runs.json");
        eventsPath = Path.Combine(logDir, "scheduled-task-events.jsonl");
        textLogPath = Path.Combine(logDir, "scheduled-task.log");
        // 兼容旧版本：把历史日志从 .config/opencode 根目录迁移到 scheduler/。
        MoveLegacy(Path.Combine(configDir, "scheduled-task-runs.json"), historyPath);
        MoveLegacy(Path.Combine(configDir, "scheduled-task-events.jsonl"), eventsPath);
        MoveLegacy(Path.Combine(configDir, "scheduled-task.log"), textLogPath);
        this.start = start;
        this.changed = changed;
        tasks = Load();
        runs = LoadRuns();
        var now = DateTimeOffset.Now;
        foreach (var task in tasks)
        {
            task.NextRunAt = ComputeNext(task, now);
            if (task.NextRunAt is null) task.Enabled = false;
        }
        Save();
        timer = new System.Threading.Timer(_ => Tick(), null, 1000, 1000);
    }

    public List<ScheduledTask> List()
    {
        lock (gate)
        {
            return tasks.Select(Clone).ToList();
        }
    }

    public List<ScheduledRun> ListRuns(string taskId)
    {
        lock (gate)
        {
            return runs
                .Where(x => x.TaskId == taskId)
                .OrderByDescending(x => x.StartedAt)
                .Select(x => new ScheduledRun
                {
                    Id = x.Id,
                    TaskId = x.TaskId,
                    TaskName = x.TaskName,
                    Directory = x.Directory,
                    StartedAt = x.StartedAt,
                    FinishedAt = x.FinishedAt,
                    Status = x.Status,
                    ExitCode = x.ExitCode,
                    Error = x.Error,
                    SessionID = x.SessionID,
                    ToolCalls = x.ToolCalls
                })
                .ToList();
        }
    }

    public ScheduledTask? Save(ScheduledTask task)
    {
        lock (gate)
        {
            if (string.IsNullOrWhiteSpace(task.Name)) throw new InvalidOperationException("任务名称不能为空");
            if (string.IsNullOrWhiteSpace(task.Directory) || !Directory.Exists(task.Directory))
                throw new InvalidOperationException("项目目录不存在");
            if (string.IsNullOrWhiteSpace(task.Prompt)) throw new InvalidOperationException("Prompt 不能为空");
            if (task.Schedule is not ("once" or "daily" or "weekly"))
                throw new InvalidOperationException("不支持的调度类型");
            if (task.Schedule == "once" && task.OnceAt is null)
                throw new InvalidOperationException("一次性任务必须选择执行时间");

            task.Weekdays = (task.Weekdays ?? []).Distinct().Where(x => x is >= 0 and <= 6).OrderBy(x => x).ToArray();
            if (task.Schedule == "weekly" && task.Weekdays.Length == 0)
                throw new InvalidOperationException("每周任务至少选择一个星期");
            if (string.IsNullOrWhiteSpace(task.Id))
                task.Id = Guid.NewGuid().ToString("N");
            var index = tasks.FindIndex(x => x.Id == task.Id);
            var existing = index >= 0 ? tasks[index] : null;
            if (existing?.Running == true) throw new InvalidOperationException("任务正在运行，不能修改");
            task.Running = existing?.Running ?? false;
            task.LastRunAt = existing?.LastRunAt ?? task.LastRunAt;
            task.LastStatus = existing?.LastStatus ?? task.LastStatus;
            task.LastError = existing?.LastError ?? task.LastError;
            task.NextRunAt = ComputeNext(task, DateTimeOffset.Now);
            if (task.NextRunAt is null) task.Enabled = false;
            if (index >= 0) tasks[index] = task;
            else tasks.Add(task);
            Save();
            return Clone(task);
        }
    }

    public void Delete(string id)
    {
        lock (gate)
        {
            var task = tasks.FirstOrDefault(x => x.Id == id);
            if (task?.Running == true) throw new InvalidOperationException("任务正在运行，不能删除");
            tasks.RemoveAll(x => x.Id == id);
            Save();
        }
    }

    public void SetEnabled(string id, bool enabled)
    {
        lock (gate)
        {
            var task = tasks.FirstOrDefault(x => x.Id == id);
            if (task is null) return;
            task.Enabled = enabled;
            task.NextRunAt = enabled ? ComputeNext(task, DateTimeOffset.Now) : null;
            if (enabled && task.NextRunAt is null)
                throw new InvalidOperationException("该任务没有可用的下一次执行时间");
            Save();
        }
    }

    public void RunNow(string id)
    {
        lock (gate)
        {
            var task = tasks.FirstOrDefault(x => x.Id == id);
            if (task is null) throw new InvalidOperationException("任务不存在");
            if (task.Running) throw new InvalidOperationException("任务正在运行");
            Start(task, DateTimeOffset.Now);
        }
    }

    private void Tick()
    {
        try
        {
            lock (gate)
            {
                var now = DateTimeOffset.Now;
                var nowMs = now.ToUnixTimeMilliseconds();
                foreach (var task in tasks.Where(x => x.Enabled && !x.Running && x.NextRunAt is { } next && next <= nowMs))
                    Start(task, now);
            }
        }
        catch
        {
            // 后台调度失败不能拖垮启动器；任务状态会在下次保存/展示时体现。
        }
    }

    private void Start(ScheduledTask task, DateTimeOffset now)
    {
        task.Running = true;
        task.LastRunAt = now.ToUnixTimeMilliseconds();
        task.LastStatus = "running";
        task.LastError = null;
        task.NextRunAt = ComputeNext(task, now.AddSeconds(1));
        if (task.Schedule == "once")
        {
            task.Enabled = false;
            task.NextRunAt = null;
        }
        var run = new ScheduledRun
        {
            Id = Guid.NewGuid().ToString("N"),
            TaskId = task.Id,
            TaskName = task.Name,
            Directory = task.Directory,
            StartedAt = now.ToUnixTimeMilliseconds(),
            Status = "running"
        };
        runs.Add(run);
        runIds[task.Id] = run.Id;
        Save();
        SaveRuns();
        AppendLog($"开始 | {task.Name} | {task.Directory}");
        try
        {
            var process = start(task);
            running[task.Id] = process;
            process.EnableRaisingEvents = true;
            process.OutputDataReceived += (_, eventArgs) =>
            {
                if (eventArgs.Data is not null) HandleOutput(task.Id, task.Name, eventArgs.Data);
            };
            process.ErrorDataReceived += (_, eventArgs) =>
            {
                if (eventArgs.Data is not null) AppendLog($"[错误输出] {task.Name} | {eventArgs.Data}");
            };
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            process.Exited += (_, _) => OnExited(task.Id, process.ExitCode);
            if (process.HasExited) OnExited(task.Id, process.ExitCode);
            changed();
        }
        catch (Exception ex)
        {
            FinishRun(task, run, "failed", null, ex.Message);
        }
    }

    private void OnExited(string id, int exitCode)
    {
        try
        {
            lock (gate)
            {
                var task = tasks.FirstOrDefault(x => x.Id == id);
                if (task is null) return;
                running.Remove(id);
                var run = runIds.TryGetValue(id, out var runId)
                    ? runs.FirstOrDefault(x => x.Id == runId)
                    : null;
                FinishRun(
                    task,
                    run,
                    exitCode == 0 ? "completed" : "failed",
                    exitCode,
                    exitCode == 0 ? null : $"进程退出码 {exitCode}"
                );
            }
        }
        catch
        {
            // 进程退出回调必须吞掉异常，避免 Timer/线程池崩溃。
        }
    }

    private void FinishRun(ScheduledTask task, ScheduledRun? run, string status, int? exitCode, string? error)
    {
        task.Running = false;
        task.LastStatus = status;
        task.LastError = error;
        if (task.Schedule == "once") task.Enabled = false;
        if (run is not null)
        {
            run.Status = status;
            run.ExitCode = exitCode;
            run.Error = error;
            run.FinishedAt = DateTimeOffset.Now.ToUnixTimeMilliseconds();
        }
        runIds.Remove(task.Id);
        PruneRuns();
        Save();
        SaveRuns();
        AppendLog($"{FinishLabel(status)} | {task.Name} | {error ?? $"退出码 {exitCode}"}");
        changed();
    }

    private static string FinishLabel(string status) => status switch
    {
        "completed" => "完成",
        "failed" => "失败",
        _ => status
    };

    private static void MoveLegacy(string oldPath, string newPath)
    {
        try
        {
            if (File.Exists(oldPath) && !File.Exists(newPath)) File.Move(oldPath, newPath);
        }
        catch
        {
            // 迁移失败不阻断启动；新日志仍写入新目录。
        }
    }

    private List<ScheduledRun> LoadRuns()
    {
        try
        {
            if (!File.Exists(historyPath)) return [];
            var json = File.ReadAllText(historyPath);
            return JsonSerializer.Deserialize<List<ScheduledRun>>(json, JsonOptions) ?? [];
        }
        catch
        {
            var backup = historyPath + ".corrupt-" + DateTimeOffset.Now.ToUnixTimeSeconds();
            try { File.Move(historyPath, backup); } catch { }
            return [];
        }
    }

    private void SaveRuns()
    {
        var json = JsonSerializer.Serialize(runs, JsonOptions);
        var temp = historyPath + ".tmp";
        File.WriteAllText(temp, json);
        File.Move(temp, historyPath, true);
    }

    private void PruneRuns()
    {
        runs = runs
            .GroupBy(x => x.TaskId)
            .SelectMany(group => group.OrderByDescending(x => x.StartedAt).Take(20))
            .OrderByDescending(x => x.StartedAt)
            .Take(200)
            .ToList();
    }

    private void AppendLog(string message)
    {
        try
        {
            lock (logLock)
            {
                File.AppendAllText(textLogPath, $"{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss} {message}\n");
            }
        }
        catch
        {
            // 日志写入失败不能影响定时任务本身。
        }
    }

    private void HandleOutput(string taskId, string taskName, string line)
    {
        try
        {
            using var doc = JsonDocument.Parse(line);
            var root = doc.RootElement;
            var type = root.TryGetProperty("type", out var typeElement) ? typeElement.GetString() : null;
            var sessionID = root.TryGetProperty("sessionID", out var sessionElement) ? sessionElement.GetString() : null;
            ScheduledRun? run = null;
            lock (gate)
            {
                run = runIds.TryGetValue(taskId, out var runId) ? runs.FirstOrDefault(x => x.Id == runId) : null;
                if (run is not null && sessionID is not null) run.SessionID = sessionID;
                if (run is not null && type == "tool_use") run.ToolCalls++;
            }
            WriteEvent(taskId, taskName, line);
            if (type == "tool_use" && root.TryGetProperty("part", out var part) && part.TryGetProperty("tool", out var tool))
            {
                var status = part.TryGetProperty("state", out var state) && state.TryGetProperty("status", out var statusElement)
                    ? statusElement.GetString()
                    : "unknown";
                AppendLog($"[工具] {taskName} | {tool.GetString()} | {status}");
            }
            else if (type == "error")
            {
                AppendLog($"[事件] {taskName} | error | {line}");
            }
            else if (type == "text" && root.TryGetProperty("part", out var textPart) &&
                     textPart.TryGetProperty("text", out var textElement))
            {
                var text = textElement.GetString();
                if (!string.IsNullOrWhiteSpace(text)) AppendLog($"[文本] {taskName} | {text}");
            }
        }
        catch
        {
            // 非 JSON 输出（启动日志等）也保留在文本日志中。
            AppendLog($"[输出] {taskName} | {line}");
        }
    }

    private void WriteEvent(string taskId, string taskName, string line)
    {
        try
        {
            using var doc = JsonDocument.Parse(line);
            var wrapped = JsonSerializer.Serialize(new
            {
                timestamp = DateTimeOffset.Now.ToUnixTimeMilliseconds(),
                taskId,
                taskName,
                @event = doc.RootElement
            }, JsonOptions);
            lock (logLock)
            {
                File.AppendAllText(eventsPath, wrapped + "\n");
            }
        }
        catch
        {
            // 非 JSON 输出不写入事件流；文本日志仍保留。
        }
    }

    private static long? ComputeNext(ScheduledTask task, DateTimeOffset now)
    {
        if (!task.Enabled && task.Schedule != "once") return null;
        switch (task.Schedule)
        {
            case "once":
                return task.OnceAt is > 0 ? task.OnceAt : null;
            case "daily":
            {
                if (!TryParseTime(task.Time, out var hour, out var minute)) return null;
                var next = new DateTimeOffset(now.Year, now.Month, now.Day, hour, minute, 0, now.Offset);
                if (next <= now) next = next.AddDays(1);
                return next.ToUnixTimeMilliseconds();
            }
            case "weekly":
            {
                if (!TryParseTime(task.Time, out var hour, out var minute)) return null;
                var days = task.Weekdays.Length == 0 ? [1] : task.Weekdays;
                for (var offset = 0; offset <= 7; offset++)
                {
                    var day = now.Date.AddDays(offset);
                    if (!days.Contains((int)day.DayOfWeek)) continue;
                    var next = new DateTimeOffset(day.Year, day.Month, day.Day, hour, minute, 0, now.Offset);
                    if (next > now) return next.ToUnixTimeMilliseconds();
                }
                return null;
            }
            default:
                return null;
        }
    }

    private static bool TryParseTime(string value, out int hour, out int minute)
    {
        hour = 0;
        minute = 0;
        var parts = (value ?? "").Split(':');
        return parts.Length == 2 && int.TryParse(parts[0], out hour) && int.TryParse(parts[1], out minute) &&
               hour is >= 0 and <= 23 && minute is >= 0 and <= 59;
    }

    private List<ScheduledTask> Load()
    {
        try
        {
            if (!File.Exists(path)) return [];
            var json = File.ReadAllText(path);
            return JsonSerializer.Deserialize<List<ScheduledTask>>(json, JsonOptions) ?? [];
        }
        catch
        {
            var backup = path + ".corrupt-" + DateTimeOffset.Now.ToUnixTimeSeconds();
            try { File.Move(path, backup); } catch { }
            return [];
        }
    }

    private void Save()
    {
        var json = JsonSerializer.Serialize(tasks, JsonOptions);
        var temp = path + ".tmp";
        File.WriteAllText(temp, json);
        File.Move(temp, path, true);
    }

    private static ScheduledTask Clone(ScheduledTask task) => new()
    {
        Id = task.Id,
        Name = task.Name,
        Directory = task.Directory,
        Prompt = task.Prompt,
        Schedule = task.Schedule,
        OnceAt = task.OnceAt,
        Time = task.Time,
        Weekdays = [.. task.Weekdays],
        Enabled = task.Enabled,
        NextRunAt = task.NextRunAt,
        LastRunAt = task.LastRunAt,
        LastStatus = task.LastStatus,
        LastError = task.LastError,
        Running = task.Running
    };

    public void Dispose()
    {
        timer.Dispose();
        lock (gate)
        {
            foreach (var process in running.Values)
            {
                try
                {
                    if (!process.HasExited) process.Kill(true);
                }
                catch { }
            }
            running.Clear();
        }
    }
}
