using OpenCodeLauncher;

namespace OpenCodeScheduler;

internal sealed class SchedulerForm : Form
{
    private readonly ScheduledTaskScheduler scheduler;
    private readonly DataGridView grid;
    private bool allowClose;

    public SchedulerForm(ScheduledTaskScheduler scheduler)
    {
        this.scheduler = scheduler;
        Text = "定时任务";
        StartPosition = FormStartPosition.CenterScreen;
        Width = 900;
        Height = 560;
        MinimumSize = new Size(760, 460);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        var buttons = new FlowLayoutPanel
        {
            Dock = DockStyle.Top,
            Height = 48,
            Padding = new Padding(10, 8, 10, 8),
            WrapContents = false
        };
        buttons.Controls.Add(Button("新建", (_, _) => NewTask()));
        buttons.Controls.Add(Button("编辑", (_, _) => EditSelected()));
        buttons.Controls.Add(Button("删除", (_, _) => DeleteSelected()));
        buttons.Controls.Add(Button("立即运行", (_, _) => RunSelected()));
        buttons.Controls.Add(Button("启用/暂停", (_, _) => ToggleSelected()));
        buttons.Controls.Add(Button("查看日志", (_, _) => ShowLogs()));
        buttons.Controls.Add(Button("刷新", (_, _) => RefreshTasks()));

        grid = new DataGridView
        {
            Dock = DockStyle.Fill,
            ReadOnly = true,
            AllowUserToAddRows = false,
            AllowUserToDeleteRows = false,
            AllowUserToResizeRows = false,
            AutoGenerateColumns = false,
            MultiSelect = false,
            SelectionMode = DataGridViewSelectionMode.FullRowSelect,
            RowHeadersVisible = false,
            BackgroundColor = Color.White,
            BorderStyle = BorderStyle.None
        };
        grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "名称", Width = 150 });
        grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "项目目录", Width = 240 });
        grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "计划", Width = 120 });
        grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "下次执行", Width = 130 });
        grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "状态", Width = 170 });
        grid.CellDoubleClick += (_, eventArgs) => { if (eventArgs.RowIndex >= 0) EditSelected(); };

        Controls.Add(grid);
        Controls.Add(buttons);
        FormClosing += (_, eventArgs) =>
        {
            if (!allowClose && eventArgs.CloseReason == CloseReason.UserClosing)
            {
                eventArgs.Cancel = true;
                Hide();
            }
        };
        RefreshTasks();
    }

    private static Button Button(string text, EventHandler handler)
    {
        var button = new Button { Text = text, AutoSize = true, Padding = new Padding(8, 2, 8, 2) };
        button.Click += handler;
        return button;
    }

    public void CloseForExit()
    {
        allowClose = true;
        Close();
    }

    public void RefreshTasks()
    {
        if (IsDisposed) return;
        var selected = SelectedTask()?.Id;
        grid.Rows.Clear();
        foreach (var task in scheduler.List())
        {
            var index = grid.Rows.Add(
                task.Name,
                task.Directory,
                ScheduleText(task),
                task.Enabled ? FormatTime(task.NextRunAt) : "—",
                StatusText(task)
            );
            grid.Rows[index].Tag = task.Id;
            if (task.Id == selected) grid.Rows[index].Selected = true;
        }
    }

    private ScheduledTask? SelectedTask()
    {
        if (grid.SelectedRows.Count == 0) return null;
        var id = grid.SelectedRows[0].Tag as string;
        return scheduler.List().FirstOrDefault(x => x.Id == id);
    }

    private void NewTask()
    {
        using var editor = new TaskEditorForm(null);
        if (editor.ShowDialog(this) != DialogResult.OK || editor.Task is null) return;
        TrySave(editor.Task);
    }

    private void EditSelected()
    {
        var task = SelectedTask();
        if (task is null) return;
        using var editor = new TaskEditorForm(task);
        if (editor.ShowDialog(this) != DialogResult.OK || editor.Task is null) return;
        TrySave(editor.Task);
    }

    private void TrySave(ScheduledTask task)
    {
        try
        {
            scheduler.Save(task);
            RefreshTasks();
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, ex.Message, "保存失败", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private void DeleteSelected()
    {
        var task = SelectedTask();
        if (task is null) return;
        if (MessageBox.Show(this, $"确定删除「{task.Name}」？", "删除定时任务", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
        try
        {
            scheduler.Delete(task.Id);
            RefreshTasks();
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, ex.Message, "删除失败", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private void RunSelected()
    {
        var task = SelectedTask();
        if (task is null) return;
        try
        {
            scheduler.RunNow(task.Id);
            RefreshTasks();
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, ex.Message, "运行失败", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private void ShowLogs()
    {
        var task = SelectedTask();
        if (task is null) return;
        using var form = new RunLogForm(scheduler, task);
        form.ShowDialog(this);
    }

    private void ToggleSelected()
    {
        var task = SelectedTask();
        if (task is null) return;
        try
        {
            scheduler.SetEnabled(task.Id, !task.Enabled);
            RefreshTasks();
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, ex.Message, "操作失败", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private static string ScheduleText(ScheduledTask task) => task.Schedule switch
    {
        "once" => "一次性",
        "daily" => $"每天 {task.Time}",
        "weekly" => $"每周 {string.Join("、", task.Weekdays.Select(x => WeekdayName(x)))} {task.Time}",
        _ => task.Schedule
    };

    private static string StatusText(ScheduledTask task)
    {
        if (task.Running) return "运行中（后台执行）";
        if (!task.Enabled) return "已暂停";
        return task.LastStatus switch
        {
            "completed" => "上次已完成",
            "failed" => "上次失败",
            _ => "待运行"
        };
    }

    private static string FormatTime(long? value) =>
        value is null ? "—" : DateTimeOffset.FromUnixTimeMilliseconds(value.Value).LocalDateTime.ToString("MM-dd HH:mm");

    private static string WeekdayName(int value) => value switch
    {
        0 => "周日",
        1 => "周一",
        2 => "周二",
        3 => "周三",
        4 => "周四",
        5 => "周五",
        6 => "周六",
        _ => value.ToString()
    };
}

internal sealed class RunLogForm : Form
{
    public RunLogForm(ScheduledTaskScheduler scheduler, ScheduledTask task)
    {
        Text = $"运行日志 - {task.Name}";
        StartPosition = FormStartPosition.CenterParent;
        Width = 820;
        Height = 460;
        MinimumSize = new Size(680, 360);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        var grid = new DataGridView
        {
            Dock = DockStyle.Fill,
            ReadOnly = true,
            AllowUserToAddRows = false,
            AllowUserToDeleteRows = false,
            AutoGenerateColumns = false,
            RowHeadersVisible = false,
            BackgroundColor = Color.White,
            BorderStyle = BorderStyle.None
        };
        grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "开始", Width = 140 });
        grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "结束", Width = 140 });
        grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "状态", Width = 100 });
        grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "退出码", Width = 75 });
        grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "会话", Width = 170 });
        grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "工具调用", Width = 75 });
        grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "错误", Width = 220 });
        foreach (var run in scheduler.ListRuns(task.Id))
        {
            grid.Rows.Add(
                FormatTime(run.StartedAt),
                run.FinishedAt is null ? "—" : FormatTime(run.FinishedAt.Value),
                StatusText(run.Status),
                run.ExitCode?.ToString() ?? "—",
                run.SessionID ?? "—",
                run.ToolCalls.ToString(),
                run.Error ?? ""
            );
        }
        Controls.Add(grid);
    }

    private static string FormatTime(long value) =>
        DateTimeOffset.FromUnixTimeMilliseconds(value).LocalDateTime.ToString("MM-dd HH:mm:ss");

    private static string StatusText(string status) => status switch
    {
        "completed" => "完成",
        "failed" => "失败",
        "running" => "运行中",
        _ => status
    };
}

internal sealed class TaskEditorForm : Form
{
    private readonly TextBox name = new() { Dock = DockStyle.Fill };
    private readonly TextBox directory = new() { Dock = DockStyle.Fill };
    private readonly TextBox prompt = new() { Dock = DockStyle.Fill, Multiline = true, Height = 120, ScrollBars = ScrollBars.Vertical };
    private readonly ComboBox schedule = new() { Dock = DockStyle.Fill, DropDownStyle = ComboBoxStyle.DropDownList };
    private readonly DateTimePicker once = new() { Dock = DockStyle.Fill, Format = DateTimePickerFormat.Custom, CustomFormat = "yyyy-MM-dd HH:mm" };
    private readonly DateTimePicker time = new() { Dock = DockStyle.Fill, Format = DateTimePickerFormat.Time, ShowUpDown = true };
    private readonly FlowLayoutPanel weekdays = new() { Dock = DockStyle.Fill, AutoSize = true };
    private readonly CheckBox enabled = new() { Text = "启用任务", Checked = true, AutoSize = true };
    private readonly CheckBox allowRead = new() { Text = "读取文件（仅项目目录）", Checked = true, AutoSize = true };
    private readonly CheckBox allowEdit = new() { Text = "修改文件", Checked = true, AutoSize = true };
    private readonly CheckBox allowBash = new() { Text = "执行命令", Checked = true, AutoSize = true };
    private readonly CheckBox allowNetwork = new() { Text = "访问网络", Checked = true, AutoSize = true };
    private readonly CheckBox allowSkill = new() { Text = "使用项目 Skill", Checked = true, AutoSize = true };
    private readonly FlowLayoutPanel permissionChecks = new() { Dock = DockStyle.Fill, AutoSize = true, WrapContents = true };
    private readonly Label readScope = new() { AutoSize = true, ForeColor = SystemColors.GrayText, MaximumSize = new Size(500, 0) };
    private readonly Label skillScope = new() { AutoSize = true, ForeColor = SystemColors.GrayText, MaximumSize = new Size(500, 0) };
    private readonly Label error = new() { ForeColor = Color.Firebrick, AutoSize = true };
    private readonly ScheduledTask? existing;
    private readonly List<CheckBox> weekdayChecks = [];

    public ScheduledTask? Task { get; private set; }

    public TaskEditorForm(ScheduledTask? existing)
    {
        this.existing = existing;
        Text = existing is null ? "新建定时任务" : "编辑定时任务";
        StartPosition = FormStartPosition.CenterParent;
        Width = 640;
        Height = 720;
        MinimumSize = new Size(560, 600);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        schedule.Items.AddRange(["一次性", "每天", "每周"]);
        schedule.SelectedIndex = 0;
        schedule.SelectedIndexChanged += (_, _) => UpdateVisibility();
        directory.TextChanged += (_, _) => UpdatePermissionHints();

        foreach (var check in new[] { allowRead, allowEdit, allowBash, allowNetwork, allowSkill })
        {
            check.Margin = new Padding(0, 4, 18, 0);
            permissionChecks.Controls.Add(check);
        }

        for (var i = 0; i < 7; i++)
        {
            var check = new CheckBox { Text = WeekdayName(i), AutoSize = true, Margin = new Padding(0, 4, 12, 0) };
            weekdayChecks.Add(check);
            weekdays.Controls.Add(check);
        }

        var (basicBox, basic) = CreateSection("基本信息");
        AddRow(basic, "任务名称", name);
        AddRow(basic, "项目目录", BuildDirectoryRow());
        AddRow(basic, "Prompt", prompt);

        var (scheduleBox, scheduleTable) = CreateSection("执行计划");
        AddRow(scheduleTable, "触发方式", schedule);
        AddRow(scheduleTable, "一次性时间", once);
        AddRow(scheduleTable, "每天/每周时间", time);
        AddRow(scheduleTable, "每周星期", weekdays);
        AddRow(scheduleTable, "", enabled);

        var (permissionBox, permissionTable) = CreateSection("权限");
        AddRow(permissionTable, "允许操作", permissionChecks);
        AddRow(permissionTable, "", readScope);
        AddRow(permissionTable, "", skillScope);
        var skillHelp = new LinkLabel { Text = "查看 Skill 使用说明 ›", AutoSize = true, Margin = new Padding(0, 2, 0, 4) };
        skillHelp.LinkClicked += (_, _) =>
        {
            using var help = new SkillHelpForm(directory.Text.Trim());
            help.ShowDialog(this);
        };
        AddRow(permissionTable, "", skillHelp);

        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            AutoScroll = true,
            ColumnCount = 1,
            RowCount = 4,
            Padding = new Padding(12)
        };
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        for (var i = 0; i < 3; i++) root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.Controls.Add(basicBox, 0, 0);
        root.Controls.Add(scheduleBox, 0, 1);
        root.Controls.Add(permissionBox, 0, 2);
        root.Controls.Add(error, 0, 3);

        var actions = new FlowLayoutPanel
        {
            Dock = DockStyle.Bottom,
            Height = 52,
            FlowDirection = FlowDirection.RightToLeft,
            Padding = new Padding(10, 8, 10, 8)
        };
        var save = new Button { Text = "保存", AutoSize = true, DialogResult = DialogResult.None };
        var cancel = new Button { Text = "取消", AutoSize = true, DialogResult = DialogResult.Cancel };
        save.Click += (_, _) => Save();
        actions.Controls.Add(save);
        actions.Controls.Add(cancel);
        Controls.Add(root);
        Controls.Add(actions);

        if (existing is not null)
        {
            name.Text = existing.Name;
            directory.Text = existing.Directory;
            prompt.Text = existing.Prompt;
            schedule.SelectedIndex = existing.Schedule switch { "daily" => 1, "weekly" => 2, _ => 0 };
            var onceValue = existing.OnceAt is null ? DateTime.Now.AddHours(1) : DateTimeOffset.FromUnixTimeMilliseconds(existing.OnceAt.Value).LocalDateTime;
            once.Value = onceValue;
            if (TimeSpan.TryParse(existing.Time, out var parsed)) time.Value = DateTime.Today.Add(parsed);
            foreach (var day in existing.Weekdays)
                if (day is >= 0 and < 7) weekdayChecks[day].Checked = true;
            enabled.Checked = existing.Enabled;
            var permissions = existing.Permissions ?? new ScheduledTaskPermissions();
            allowRead.Checked = permissions.Read;
            allowEdit.Checked = permissions.Edit;
            allowBash.Checked = permissions.Bash;
            allowNetwork.Checked = permissions.Network;
            allowSkill.Checked = permissions.Skill;
        }
        else
        {
            schedule.SelectedIndex = 0;
            once.Value = DateTime.Now.AddHours(1);
            time.Value = DateTime.Today.AddHours(9);
            directory.Text = "";
        }
        UpdateVisibility();
        UpdatePermissionHints();
    }

    private static (GroupBox Box, TableLayoutPanel Table) CreateSection(string title)
    {
        var table = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            ColumnCount = 2,
            Padding = new Padding(10, 8, 10, 10)
        };
        table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 110));
        table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        var box = new GroupBox
        {
            Text = title,
            Dock = DockStyle.Top,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            Padding = new Padding(8, 4, 8, 8)
        };
        box.Controls.Add(table);
        return (box, table);
    }

    private Control BuildDirectoryRow()
    {
        var row = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, AutoSize = true };
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 88));
        var browse = new Button { Text = "浏览", Dock = DockStyle.Fill };
        browse.Click += (_, _) =>
        {
            using var dialog = new FolderBrowserDialog
            {
                Description = "选择项目目录",
                SelectedPath = Directory.Exists(directory.Text) ? directory.Text : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)
            };
            if (dialog.ShowDialog(this) == DialogResult.OK) directory.Text = dialog.SelectedPath;
        };
        row.Controls.Add(directory, 0, 0);
        row.Controls.Add(browse, 1, 0);
        return row;
    }

    private static void AddRow(TableLayoutPanel layout, string label, Control control)
    {
        var row = layout.RowCount++;
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        if (label != "")
        {
            layout.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(0, 8, 8, 8) }, 0, row);
        }
        control.Margin = new Padding(0, 4, 0, 4);
        layout.Controls.Add(control, 1, row);
    }

    private void UpdateVisibility()
    {
        var onceSelected = schedule.SelectedIndex == 0;
        once.Visible = onceSelected;
        time.Visible = !onceSelected;
        weekdays.Visible = schedule.SelectedIndex == 2;
    }

    private void UpdatePermissionHints()
    {
        var dir = directory.Text.Trim();
        readScope.Text = string.IsNullOrWhiteSpace(dir)
            ? "读取工具限制：仅允许任务项目目录内的文件；项目外读取始终拒绝。注意：启用「执行命令」后，bash 不受此读取范围限制。"
            : $"读取工具限制：仅允许 {dir} 及其子目录内的文件；项目外读取始终拒绝。注意：启用「执行命令」后，bash 不受此读取范围限制。";
        skillScope.Text = string.IsNullOrWhiteSpace(dir)
            ? "Skill 限制：仅加载项目内 .opencode\\skills 或 .opencode\\skill；全局、用户级和插件来源的 Skill 始终禁用。"
            : $"Skill 限制：仅加载 {Path.Combine(dir, ".opencode")} 下的 skills 或 skill；全局、用户级和插件来源的 Skill 始终禁用。";
    }

    private void Save()
    {
        error.Text = "";
        if (string.IsNullOrWhiteSpace(name.Text)) { error.Text = "请填写任务名称"; return; }
        if (string.IsNullOrWhiteSpace(directory.Text) || !Directory.Exists(directory.Text)) { error.Text = "项目目录不存在"; return; }
        if (string.IsNullOrWhiteSpace(prompt.Text)) { error.Text = "请填写 Prompt"; return; }
        var selectedWeekdays = weekdayChecks.Select((check, index) => (check, index)).Where(x => x.check.Checked).Select(x => x.index).ToArray();
        if (schedule.SelectedIndex == 2 && selectedWeekdays.Length == 0) { error.Text = "每周任务至少选择一个星期"; return; }
        var onceAt = schedule.SelectedIndex == 0 ? new DateTimeOffset(once.Value).ToUnixTimeMilliseconds() : (long?)null;
        if (onceAt is not null && onceAt <= DateTimeOffset.Now.ToUnixTimeMilliseconds()) { error.Text = "一次性任务必须选择未来时间"; return; }
        Task = new ScheduledTask
        {
            Id = existing?.Id ?? "",
            Name = name.Text.Trim(),
            Directory = directory.Text.Trim(),
            Prompt = prompt.Text.Trim(),
            Schedule = schedule.SelectedIndex switch { 0 => "once", 1 => "daily", _ => "weekly" },
            OnceAt = onceAt,
            Time = time.Value.ToString("HH:mm"),
            Weekdays = selectedWeekdays,
            Enabled = enabled.Checked,
            Permissions = new ScheduledTaskPermissions
            {
                Read = allowRead.Checked,
                Edit = allowEdit.Checked,
                Bash = allowBash.Checked,
                Network = allowNetwork.Checked,
                Skill = allowSkill.Checked
            }
        };
        DialogResult = DialogResult.OK;
        Close();
    }

    private static string WeekdayName(int value) => value switch
    {
        0 => "周日",
        1 => "周一",
        2 => "周二",
        3 => "周三",
        4 => "周四",
        5 => "周五",
        6 => "周六",
        _ => value.ToString()
    };
}
