# AGENTS.md 依据与踩坑史

`AGENTS.md` 只写**要求**；本文件存放那些「为什么」与变更史。AGENTS.md 相应位置指向此处。

## 技术约定

**插件入口只能 default 导出。** opencode 的 legacy 加载器会把模块「所有函数导出」都当作
插件工厂，以 `(input, options)` 逐一调用。曾因 `syncSessionTitle`/`backfillSessionTitles`
加了 `export`，被当作工厂调用时首行 `store.get(sessionID)` 抛 `store.get is not a
function`，导致插件加载失败、opencode 启动报 `Unexpected server error`（见设计文档 5.2 与
`index.ts` 内注释）。

## 经验教训

**JSON 里的反斜杠是陷阱。** `\` 是转义符——`\P` 等非法转义导致解析失败（回退默认但用户不
明所以）；更隐蔽的是 `\b`/`\n`/`\t` 是**合法**转义，`"C:\bin\..."` 会被静默转成控制字符，
路径错但 JSON 解析「成功」。

本工程现状：`identity.json`（api_key 明文 / 收集服务地址；发送前转 SHA-256 哈希，网络不传
明文）不含文件路径；`deploy/opencode.json.example` 的 plugin 路径为相对/正斜杠写法；插件
`config.json`（源出已合并的 open-ide）含用户可编辑的 `tools` binary 路径，须落实正斜杠约定
（见 `packages/plugin/src/open-ide/config.ts`）。

**配置文档示例须标注字段语义。** 插件 `config.json` 的 `tools` 示例标注「cursor=新增、
idea=覆盖」（源出已合并的 open-ide）。

**pdfjs 的教训：顶层初始化会拖垮整个插件。** `pdfjs-dist` 的 pdf.mjs 初始化执行 `new
DOMMatrix()`，而 opencode 插件运行时无该全局对象（canvas polyfill 依赖 `@napi-rs/canvas`
原生绑定，打包环境缺失）→ 抛 `ReferenceError` → 插件加载失败、不建表不写库（曾致 1.18.18 下
DB 全无）。修复：静态 import 改为使用点内 `await import()`；pdf.mjs 顶层 `const SCALE_MATRIX
= new DOMMatrix()` 加 `typeof DOMMatrix !== "undefined"` 守卫后，纯文本提取完全不依赖 canvas
（见 `packages/plugin/src/tools/reqdoc-scan.ts`）。守卫补丁在 node_modules 内、不入 git。

## 对抗性审查

**拖到提交前集中审等于走过场。** 与验证同拍时上下文最热、diff 最小、归因最容易；提交前审的
已是多轮叠加的旧账，反例失败也难定位是哪一步引入的。故提交前只复核结论与护栏已随批提交。

**默认可见性不能凭感觉断言。** 插件工具回执在 TUI 默认不渲染（上游
`routes/session/index.tsx` 的 `generic_tool_output_visibility` 默认 false，且折叠只显示前 3
行）、桌面端 `GenericTool` 根本不渲染 `output`——「挂回执等于没告诉用户」。

**拿规约当判据时要审全表。** 曾援引 `07-业务口语` 打自己、却放过同一函数里更严重的同类违规。

**假护栏的三种形态**（本项目长期只要求「有断言」、从不要求「断言能失败」，代价如下）：

1. **只查字符串存在**：断言只 `toContain` 某段源码，于是把整段 `if` 删掉后字符串仍在
   **注释**里，断言照样通过（实测破坏即假通过）。
2. **不校验控制流**：只 `toContain` 源码路径，不检查它在什么分支里。
3. **边界正则方向写反**：首版按 `defaultLoad:` **之后**找 `out.`，而真正的读取在其**之前**。

写完断言**当场破坏一次**，看它报不报红——与「可见性须实证」同源：**断言本身要被观测**。

## 回答规范

**「一个概念一个名字」的反例在代码里：** `reqdoc-slots.ts` 的「容器声明。**别名 decls；
两者等价**」——两套名字并存，读的人得同时记住。已存在的别名要在文档标明等价、代码注释写清
来源；**不要新造别名**。

**不做 ASD-STE100 级中文约束**——做不到也不必做，写一条没人遵守的规则比不写更坏。

**为什么 n=1 在本项目无意义**（真实翻转记录）：

- r23 一天内 3/3 → 0/3 → 3/3（端点与夹具都未变）；
- 同一 r27 曾三次 0/3，而全量单次只 1/5；
- 兜底出口率因样本从 45 问句涨到 127 而从 5% 变 13%；
- 观测指标本身错了三轮（虚高 7 倍 → 低报 → 真值），每轮当时都「有代码、有测试、有自检」。

**表格里放管道的命令会改变命令语义。** 当前 `docs/session-management.md` 与 `AGENTS.md`
表格里没有此类违规，此条是**防未来**。
