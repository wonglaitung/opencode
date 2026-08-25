# plugin-guide/ 文档索引

本目录是**跨插件通用规范**所在——独立存放于仓库根，不隶属任一插件工程，避免被埋没于某工程 docs 下。
**新增文件进 plugin-guide/ 时，先在此登记分类**，避免「逐个增加、无规律」——见文末「维护约定」。

定位与 `opencode-session-mgmt/docs/` 不同：后者是单工程的设计文档族（通用机制 / 工作流 / 部署），
本目录是跨 `opencode-session-mgmt`、`opencode-edge-debug` 等插件工程共享的通用规范。
被消费方式：各插件工程 `opencode.json` 的 `references` 指向本目录 + README 链接（见 plugin-dev-guide.md 5.1）。

## 索引总表

| 文件 | 类别 | 作用 | 被谁消费 | 能否改名 / 移动 |
|------|------|------|----------|----------------|
| [plugin-dev-guide.md](plugin-dev-guide.md) | 通用规范（开发规约） | **插件开发规范**（总则 / 工程分层 / 骨架 / Hook / 工具 / 存储 / 健壮性 / 安全 / 测试 / 编码 / 打包 / 验证清单） | [opencode-edge-debug/opencode.json](../opencode-edge-debug/opencode.json)（`references["plugin-dev-guide"]` 指向本目录）、[opencode-edge-debug/README.md](../opencode-edge-debug/README.md)、[opencode-edge-debug/docs/deployment.md](../opencode-edge-debug/docs/deployment.md)、[eval-driven-rule-iteration.md](eval-driven-rule-iteration.md)（说明引用其位置约定） | 改名需同步 3 处引用 |
| [eval-driven-rule-iteration.md](eval-driven-rule-iteration.md) | 通用方法论 | **评测驱动规则迭代方法论**（AI 深度绑定开发：适用边界 / 六步闭环 / 场景设计 / 判定设计 / 基线纪律 / 模型适配与防过拟合；**单一事实源**） | [plugin-dev-guide.md](plugin-dev-guide.md)（说明 + 9 章 + 12 章指针）、[opencode-session-mgmt/docs/session-management.md](../opencode-session-mgmt/docs/session-management.md)（13 章引言指针） | 改名需同步 2 处引用 |
| plugin-examples/ | 通用规范（示例资源，**待建**） | 示例模板与快速检查脚本（插件骨架 / Store 内存实现 / MIGRATIONS / tool.schema / 自检脚本）——plugin-dev-guide.md 附录建议的位置 | [plugin-dev-guide.md](plugin-dev-guide.md) 附录 | 可 |

## 关键约束速览

- **本目录是跨插件通用规范的唯一存放处**：跨插件共享的约定/规范文档一律放这里，不要埋在某一个插件工程的
  docs 下——否则其它插件维护者容易忽略它。三插件引用统一指向该目录（`opencode.json` 的 `references` + README 链接）。
- **[eval-driven-rule-iteration.md](eval-driven-rule-iteration.md) 是「评测驱动规则迭代标准作法」的单一事实源**：
  [plugin-dev-guide.md](plugin-dev-guide.md) 9 章只留摘要+指针；[opencode-session-mgmt/docs/session-management.md](../opencode-session-mgmt/docs/session-management.md) 13 章为其落地实例。
  **跨文档移动内容必须只出现一次**（内容唯一性），收敛为指针时须保留可追溯的落地实例。
- **引用约定**：文中的 `opencode-session-mgmt/...` 路径均以仓库根为基准；「设计文档 X 章」指
  `opencode-session-mgmt/docs/session-management.md`（通用机制 / 评测方法论）；两个工作流的专属设计分文件存放——
  `workflow-sdlc.md`（工作流一）/ `workflow-reqdoc.md`（工作流二，含 reqdoc 专属评测与质量飞轮 10 章）。跨文件引用带文件名前缀。
- **mermaid 铁律不适用本目录**：「三个设计文档合计 19 个 mermaid」是 `opencode-session-mgmt/docs/` 设计文档族的
  约束（session-management.md 15 / workflow-reqdoc.md 4 / workflow-sdlc.md 0），plugin-guide/ 文档不受此限。

## 维护约定

1. **新增文件进 plugin-guide/，先在本表登记一行**（文件 / 类别 / 作用 / 消费方 / 约束），并更新上面的
   「关键约束速览」——「逐个增加无规律」的观感由此消除。
2. 类别判定：本目录只放**跨插件通用规范**（开发规约 / 方法论 / 示例资源）；单插件专属内容应放各工程自己的
   docs/，不要放这里。
3. 命名偏好：新增文档默认英文 kebab-case（如 `eval-driven-rule-iteration.md`）。
4. 改文件名的唯一红线：先查「被谁消费」列，消费方全部同步后再动。
5. 文件名在索引中一律包成相对链接（表首列 / 消费方 / 约束速览），新增登记时同步给新文件名加链接。
