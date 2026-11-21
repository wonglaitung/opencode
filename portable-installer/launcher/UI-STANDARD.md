# 启动器 UI 规范(Launcher UI Standard)

> 用于统一 `portable-installer/launcher/index.html` 的版面、组件与新增功能方式。
> 目标:**外壳固定、组件复用、新增功能只填空位,不重画版面。**

## 0. 为什么需要它

历次加功能后版面漂移的根因:

- 界面集中在单个 `index.html`,令牌、外壳、组件、各功能样式混写,缺少"共享原语"。
- 没有"外壳冻结"约束,新功能各自发明间距/圆角/按钮/列表样式。
- 回归测试只断言文案(`launcher-text.test.ts`),不校验结构与令牌。
- 新版面无需评审/ADR,改完即发。

对策:抽取令牌与外壳、提供页面模板、用测试与评审强制复用。

## 1. 版面骨架(App Shell · 固定)

```
┌──────────────────────────┬─────────────────────────────────────────────┐
│ Sidebar 260px(≤900:220)  │ Topbar 52px                                  │
│  brand                   ├─────────────────────────────────────────────┤
│  section label           │ Content:max-width 1040, padding 28/34,scroll  │
│  nav(workflow)          │   h1 / .sub                                  │
│  nav(team)               │   .card / .grid(1.7fr,.9fr) / .panel / .tabs  │
│  last project            │   ...                                        │
│  side footer             │                                              │
└──────────────────────────┴─────────────────────────────────────────────┘
```

规则:
- 侧栏固定 `260px`(≤900px 降为 `220px`),深色。
- 顶栏固定 `52px`;内容区 `max-width:1040px` 居中、`padding:28px 34px`、可滚动。
- 一个视图一个 `h1` + 一句 `.sub`;**唯一主操作**用 `.primary`。
- 视图切换用 `hidden`;页签切换也只用 `hidden`,不重排外壳。

## 2. 设计令牌(Tokens · 唯一取值来源)

现有外观已"等值冻结"为令牌(值与改造前一致,不改视觉)。`:root` 是唯一色值/圆角/字号来源:

```css
:root{
  /* 基础色 */
  --sidebar:#0f172a; --sidebar-soft:#162033; --main:#f8fafc; --card:#ffffff;
  --ink:#0f172a; --muted:#64748b; --line:#e2e8f0;
  --blue:#2563eb; --blue-soft:#dbeafe; --green:#10b981;
  /* 扩展色(冻结) */
  --white:#fff; --ink-weak:#94a3b8; --ink-2:#334155; --ink-3:#475569;
  --line-strong:#cbd5e1; --surface-2:#f1f5f9;
  --sidebar-hover:#1e293b; --sidebar-line:#243047;
  --blue-strong:#1d4ed8; --blue-focus:#60a5fa; --blue-link:#3b82f6;
  --blue-soft-2:#bfdbfe; --blue-wash:#f0f7ff; --blue-tint:#eff6ff;
  --warn-bg:#fffbeb; --warn-line:#fde68a; --warn-ink:#92400e; --warn-strong:#b45309;
  --ok-bg:#ecfdf5; --ok-line:#a7f3d0; --ok-ink:#065f46;
  --danger-bg:#fef2f2; --danger-line:#fecaca; --danger-ink:#991b1b;
  --brand-bg:#0B1220; --brand-fg:#F8FAFC; --brand-accent:#22D3EE;
  /* 圆角 */
  --r-6:6px; --r-8:8px; --r-9:9px; --r-10:10px; --r-12:12px; --r-14:14px; --r-16:16px; --r-pill:50%;
  /* 字号 */
  --t-11:11px; --t-12:12px; --t-13:13px; --t-14:14px; --t-15:15px;
  --t-18:18px; --t-20:20px; --t-22:22px; --t-30:30px;
}
```

强制规则(测试已钉住):
- **颜色**:除 `:root` 外**禁止裸色值**(含 SVG,统一走 `var(--brand-*)`)。
- **圆角**:只用 `--r-*`;`0` 可直写。
- **字号**:只用 `--t-*`(`font:` 简写暂不强制)。
- **间距**:存量冻结(棘轮,当前 104 条);新增优先令牌或 4 的倍数,不得新增任意值。
- **布局尺寸**:侧栏/顶栏/内容宽/断点为外壳契约,允许字面量但不得改(测试钉住)。
- `1px` 描边、`0`、`50%` 等特殊值可直接写。

## 3. 组件原语(Components · 只复用,不重造)

| 原语 | 类名 | 用途 |
|---|---|---|
| 主按钮 | `.primary` | 每视图唯一主动作 |
| 次按钮 | `.ghost` | 浏览/刷新/取消 |
| 文字链接 | `.link` | 帮助、切换 |
| 页签 | `.tab` / `.tab.active` | 视图内分栏 |
| 卡片 | `.card` | 内容块(说明/设置) |
| 面板 | `.panel` | 列表容器(工具栏+列表) |
| 工具栏 | `.list-toolbar` / `.list-filters` | 搜索/筛选/排序 |
| 字段 | `.field`(label+input/select+hint) | 表单 |
| 勾选行 | `.check-row` / `.resume` | 开关项 |
| 列表行 | `.sess-row` | 可选择条目 |
| 空态 | `.empty` | 无数据/加载中 |
| 提示条 | `.notice(.show)` | 警告/信息 |
| 成功条 | `.ok-strip` | 操作成功反馈 |
| 弹层 | `.modal(.open)` > `.modal-card` | 帮助/确认 |
| 徽章 | `.workflow-chip` | 状态/工作流标签 |

规则:新功能若需要表格行、表单、列表、弹层,**必须**复用上表类名;需要新原语时先加到本节并说明。

## 4. 页面模板(复制即用)

### 4.1 向导页(Wizard)

```html
<div class="view" id="xxxView">
  <h1>标题</h1>
  <p class="sub">一句话说明。</p>
  <div class="prompt-card">
    <div class="path-row"><input id="dir"><button id="browse">浏览</button></div>
    <div class="action-row">
      <button class="primary" id="go">主操作</button>
      <button class="ghost" id="cancel">取消</button>
    </div>
    <div class="footer"><span>辅助说明</span></div>
  </div>
  <div class="grid">
    <section class="card"><h2>说明</h2><p class="hint"></p></section>
    <section class="card"><h2>设置</h2>...</section>
  </div>
</div>
```

### 4.2 列表-详情页(List/Detail)

```html
<div class="view" id="xxxView" hidden>
  <div class="team-head"><button class="back-link">‹ 返回</button><h1>列表</h1></div>
  <div class="panel">
    <div class="list-toolbar"><input placeholder="搜索…"><button class="ghost">刷新</button></div>
    <div class="list-filters"><select>…</select><label class="check-row"><input type="checkbox"> 选项</label></div>
    <div class="sess-list"><div class="empty">正在读取…</div></div>
  </div>
</div>
```

### 4.3 页签(Tabs)

```html
<div class="tabs"><div class="tabs-list">
  <button class="tab active" data-xxx-tab="a">A</button>
  <button class="tab" data-xxx-tab="b">B</button>
</div></div>
<section id="xxxA">...</section>
<section id="xxxB" hidden>...</section>
```

### 4.4 表单字段 / 弹层

```html
<div class="field"><label for="f">字段</label><input id="f"><div class="field-hint">提示</div></div>
<div class="modal"><div class="modal-card"><button class="modal-close">关闭</button><h2></h2><div></div></div></div>
```

## 5. 说明与帮助(on-page explanation)

说明分四层,按信息量选择,**不要把长说明堆到主界面**。

| 层级 | 载体 | 用途 |
|---|---|---|
| 页面级 | `h1` + `.sub` | 一句话说明本页做什么 |
| 区块级 | `.card h2` + `.hint` + `.link`「查看使用说明 ›」 | 短说明 + 详细帮助入口 |
| 字段级 | `.field-hint` | 输入项补充说明(11px 灰) |
| 行内提示 | `.tip-line` / `.warn-line` | 下一步怎么做 / 风险与注意 |
| 操作反馈 | `.notice` / `.ok-strip` | 全局警告 / 成功与失败 |
| 完整帮助 | `.modal` > `.modal-card.help-card` | 步骤化长文,统一弹层 |

规则:
- 主界面只放"一句话 + 关键提示";步骤化长文进帮助弹层。
- 每个功能区块提供**一个**「查看使用说明 ›」入口(`.link`),复用同一个 `#modal` / `#helpTitle` / `#helpBody`,不新建弹层。
- 帮助文案存为常量(`WORKFLOWS[].help`、`ROOM_HELP`、`EXPORT_HELP`、`IMPORT_HELP` 或新增 `XXX_HELP`),不内联长 HTML。
- 文案面向用户操作顺序;按钮名必须与界面一致;不写内部术语,也不写给模型的指令。
- 警告统一 `.warn-line`(黄),成功/失败统一 `.ok-strip`(绿/红),不使用裸色文本。

**帮助内容 DSL(纯文本按行渲染)**

帮助正文是纯文本,由 `renderHelp` 按行标记渲染:

- 小节标题:以"第 N 步"或"xxx："(命中 `HELP_SECTION`)开头 → `<h3 class="help-section">`
- 列表项:以 `·` 开头 → `div.help-bullet`
- 命令/按键/会话短语:以 `「`、`或`、`/new` 开头 → `div.help-code`
- 警告:以 `提示：` 开头 → `p.help-warn`
- 其余 → `<p>`

**新增小节标题必须同步加入 `HELP_SECTION` 正则**,否则会退化成正文段落(已有测试钉住)。

模板:

```js
const XXX_HELP = `功能名
第一步：...
· 要点一
「按钮名」
提示：注意事项`

$("xxxHelp").onclick = () => {
  $("helpTitle").textContent = "功能名 · 使用说明"
  renderHelp($("helpBody"), XXX_HELP)
  $("modal").classList.add("open")
}
```

回归:新增帮助入口/小节时,补 `launcher-text.test.ts` 断言(标题、小节、按钮、关键文案)。

## 6. 状态与文案

- 四态齐全:加载中(`.empty` "正在读取…")、空态、错误(红/`.notice`)、成功(`.ok-strip`)。
- 按钮用动词(CJK):「打开」「导出」「导入」「刷新」「取消」;不用"确定/好的"等含糊词。
- 危险/不可逆操作二次确认。

## 7. 响应式与可访问性

- 断点:≤1000px 插件三列→单列;≤900px 双栏→单栏、侧栏 220px。
- 键盘可达:所有可点击元素可聚焦;焦点有可见描边。
- 对比度:正文用 `--ink`/`--muted`,不使用低对比浅灰做正文。

## 8. 新增功能的固定流程

1. **选模板**:从第 4 节四种页面模板中选一种,不新造版式。
2. **定说明层级**:按第 5 节选页面级/区块级/行内提示/帮助弹层,不把长文堆到主界面。
3. **填位**:用第 3 节原语拼装;需要新原语先登记。
4. **只用令牌**:不写裸色值/任意间距。
5. **不碰外壳**:侧栏/顶栏/内容宽度不改;确需改 → 走 ADR(第 9 节)。
6. **补回归**:结构断言 + 文案断言(`launcher-text.test.ts`)。
7. **截图对比**:PR 附改动前后截图。

## 9. 约束与治理(防漂移的关键)

- **外壳冻结**:`260/52/1040/28-34` 为契约值;修改需 ADR 记录(背景/选项/后果)。
- **令牌单一来源**:新增颜色/间距先加到 `:root`,禁止就地硬编码。
- **结构回归测试**:在 `launcher-text.test.ts` 增加:外壳尺寸存在、`:root` 外无裸 hex、每个视图有 `h1`、列表用 `.panel` 等。
- **评审清单**:PR 模板勾选"复用原语 / 未改外壳 / 已加回归 / 有前后截图"。
- **变更记录**:本文件末尾追加改动条目与日期。
- **可选进阶**:拆 `tokens.css`/`shell.css`/`components.css`(需同步 `Launcher.csproj` 嵌入与 `index.html` 引用);WebView2 下用 Playwright 做截图回归。

## 10. 变更记录

| 日期 | 变更 | 备注 |
|---|---|---|
| 初始 | 从现有 `index.html` 抽取外壳、令牌、原语与模板 | 作为标准化基线 |
| 追加 | 增加"说明与帮助"章节与帮助内容 DSL | 统一页面说明的添加方式 |
| 落地 | 现有 `index.html` 等值令牌化(颜色/圆角/字号),测试零裸值与间距棘轮 | 外观不变,来源收敛 |
