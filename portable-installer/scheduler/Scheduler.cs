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

public sealed class ScheduledTaskScheduler : IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = true
    };

    private readonly object gate = new();
    private readonly string path;
    private readonly Func<ScheduledTask, Process> start;
    private readonly Action changed;
    private readonly System.Threading.Timer timer;
    private readonly Dictionary<string, Process> running = new();
    private List<ScheduledTask> tasks;

    public ScheduledTaskScheduler(string configDir, Func<ScheduledTask, Process> start, Action changed)
    {
        Directory.CreateDirectory(configDir);
        path = Path.Combine(configDir, "scheduled-tasks.json");
        this.start = start;
        this.changed = changed;
        tasks = Load();
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
        try
        {
            var process = start(task);
            running[task.Id] = process;
            process.EnableRaisingEvents = true;
            process.Exited += (_, _) => OnExited(task.Id, process.ExitCode);
            Save();
            changed();
        }
        catch (Exception ex)
        {
            task.Running = false;
            task.LastStatus = "failed";
            task.LastError = ex.Message;
            if (task.Schedule == "once") task.Enabled = false;
            Save();
            changed();
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
                task.Running = false;
                task.LastStatus = exitCode == 0 ? "completed" : "failed";
                task.LastError = exitCode == 0 ? null : $"进程退出码 {exitCode}";
                if (task.Schedule == "once") task.Enabled = false;
                Save();
                changed();
            }
        }
        catch
        {
            // 进程退出回调必须吞掉异常，避免 Timer/线程池崩溃。
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
