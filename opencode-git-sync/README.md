# opencode-git-sync

跨机器会话漫游插件：在多台机器之间同步 OpenCode 的会话历史，**纯插件、无外壳脚本**，用户日常仍然直接敲 `opencode` / `opencode -c`。

- 会话内容**端到端加密**：远端仓库里只有密文，passphrase 永不进仓库
- 远端用 git 分支承载，每台机器一条 `ocsync/<machine>` 分支，**历史恒定 1 条提交**（`--amend --force`）
- 增量存储：消息按 256 KB 封包（`packs/pack-<seq>.ocgs`），只重写最后一个包；加密前先 gzip 压缩
- 首屏有界同步（默认 5s）：保证 `opencode -c` 拿到远端会话；**断网时自动降级为离线，不阻塞启动**
- 导入直接写 opencode 主库的 `session/message/part` 三表（口径对齐上游 `opencode import`），**不需要改动上游代码**

## 安装

### 方式 1：安装脚本（推荐，其它机器上最快）

**打包**（在本机执行，产出一个可直接拷走的 tgz）：

```bash
./script/pack.sh        # → dist/opencode-git-sync-0.1.0.tgz
```

**在新机器上**：

```bash
tar xzf opencode-git-sync-0.1.0.tgz
cd opencode-git-sync-0.1.0

# 情况 A：这台机器是第一台 → 生成新口令
./install.sh --generate

# 情况 B：加入别人已经在用的同步仓库 → 填「现有口令」
./install.sh            # 交互式：选 1「使用现有口令」，输入另一台机器正在用的口令

./install.sh --check    # 体检 + 校验口令是否与远端一致
```

Windows 用 PowerShell：

```powershell
.\install.ps1 -Generate
.\install.ps1 -Check
```

也可以直接把本目录（或至少 `install.sh` + `dist/`）拷到新机器，然后：

```bash
./install.sh --generate      # 复制插件 + 生成强随机口令（只显示一次，抄下来）
./install.sh --check         # 体检：依赖、文件、权限、远端探测
```

### 加入已有同步仓库（换机器时）

新机器要加入**已经有人在用**的同步仓库时，口令必须填**现有那台机器正在用的口令**：

```bash
# 交互式：会问你「使用现有口令 / 生成新口令 / 取消」，选 1 后输入现有口令（不回显）
./install.sh

# 从另一台机器拷来的 key 文件直接用（推荐，最不容易出错）
scp laptop:~/.config/opencode/git-sync.key .
./install.sh --passphrase-file ./git-sync.key

# 或直接给口令（会进 shell 历史）
./install.sh --passphrase "现有口令"
```

装完立刻校验「这台机器的口令是不是和远端同一个」：

```bash
./install.sh --check
#   口令 / 远端一致性校验
#     远端 repoId: 17b23662...
#     口令: ✓ 与远端一致（可以用这个口令继续同步）
#     本地 repoId: 17b23662...
#     远端会话数: 1，消息数: 2
```

（校验需要 `bun`；没有 bun 时会跳过并提示。也可以单独跑 `bun run script/verify.ts`。）

其它用法：

```bash
./install.sh --target <dir> --key <file>   # 自定义安装位置
./install.sh --uninstall              # 卸载（远端分支需手动删）
```

脚本做的事：复制单文件插件到 `~/.config/opencode/plugin/git-sync.ts`、写口令文件（600）、
打印后续步骤。**不需要写任何 opencode.json**。

### 方式 2：手动三步

```bash
cd opencode-git-sync
bun install
bun run build                                   # 产出 dist/git-sync.ts（单文件、零依赖）
mkdir -p ~/.config/opencode/plugin
cp dist/git-sync.ts ~/.config/opencode/plugin/git-sync.ts
echo -n '一句只有你知道的话' > ~/.config/opencode/git-sync.key
chmod 600 ~/.config/opencode/git-sync.key
```

装完就能用，**不需要写任何 opencode.json**：

| 项 | 取值来源 |
|---|---|
| 远端仓库 | **自动探测项目自身的 `origin`**（`git remote get-url origin`，无 origin 时取第一个 remote） |
| 机器名 | **自动生成**（主机名 + 随机后缀，持久化在本地 `state.db`），分支为 `ocsync/<机器名>` |
| 口令 | `~/.config/opencode/git-sync.key`（也支持 `git-sync.passphrase`、环境变量、配置项） |
| 插件加载 | `~/.config/opencode/plugin/git-sync.ts` 自动发现；项目级可用 `.opencode/plugin/git-sync.ts` |

之后照常用：

```bash
opencode          # 正常用
opencode -c       # 继续上次会话（跨机时自动接上另一台机器的会话）
```

> 插件以 **TypeScript** 交付：Bun 直接加载 `.ts`，无需编译。若想直接用源码，把 `src/` 整个目录拷到
> `~/.config/opencode/plugin/git-sync/` 并在配置里指向 `src/index.ts` 亦可（Bun 会解析相对导入）。

## 配置（只在需要调整时用）

所有配置项都是**可选覆盖**，正常情况一个都不用写。要写就写 `~/.config/opencode/opencode.json`
或 `opencode.jsonc`（支持注释），键名是 `plugin`，选项通过 `[spec, options]` 元组传入：

```jsonc
{
  "plugin": [
    ["/home/you/.config/opencode/sync/git-sync.ts", {
      // 留空 = 自动探测项目自身的 origin
      "remote": "git@github.com:you/your-private-repo.git",
      // 口令：三种写法任选其一（优先级从高到低）
      "passphrase": "一句只有你知道的话",
      // "passphraseFile": "~/.config/opencode/git-sync.key",
      // "machine": "laptop",          // 不填 = 自动生成
      "debounceMs": 3000,
      "syncTimeoutMs": 5000,
      "gitTimeoutMs": 30000
    }]
  ]
}
```

> 注意：插件**文件路径**要写绝对路径（或相对配置文件目录的 `./xxx`），`~` 不会被展开；
> 但 `passphraseFile` 里的 `~` 会展开。文件放自动发现目录时无需在配置里引用。

### 选项

| 选项 | 默认 | 说明 |
|---|---|---|
| `remote` | 自动探测 | 同步远端；默认用项目自身的 `origin` |
| `passphrase` | 见下 | 口令明文 |
| `passphraseFile` | 见下 | 口令文件路径（`~` 展开），内容取首尾去空白 |
| `machine` | 自动生成 | 机器名，决定分支 `ocsync/<machine>` |
| `debounceMs` | 3000 | 会话结束后的防抖推送间隔 |
| `syncTimeoutMs` | 5000 | 首屏同步上限，超时即离线降级（首次 fetch 含 SSH 握手，约 1~2s） |
| `gitTimeoutMs` | 30000 | 单条 git 命令硬超时（超时 kill 子进程）；推送用它的 2 倍 |
| `enabled` | true | 设为 false 可临时停用 |

## 环境变量

| 变量 | 说明 |
|---|---|
| `OPENCODE_GIT_SYNC_PASSPHRASE` | 口令（配置项 `passphrase` / `passphraseFile` 优先） |
| `OPENCODE_GIT_SYNC_REMOTE` | 覆盖同步远端（默认用项目 origin） |
| `OPENCODE_GIT_SYNC_MACHINE` | 覆盖机器名（默认自动生成） |
| `OPENCODE_GIT_SYNC_DIR` | 插件状态目录**根**（默认 `~/.local/share/opencode/git-sync`），每个项目再挂一个子目录 |
| `OPENCODE_GIT_SYNC_LOG` | `debug` / `info` / `warn` / `error`（默认 `warn`） |
| `OPENCODE_DB` | 由上游使用；插件据此定位要写入的 opencode 主库 |

## 远端布局

```
<项目仓库>            ← 就是项目自己的 origin，不需要另建仓库
└── refs/heads/
    ├── ocsync/<机器A>   ← 每台机器一条分支（历史恒定 1 条提交）
    │   ├── sync-meta.json          （明文：repoId + salt，非机密）
    │   ├── keycheck.ocgs           （加密哨兵：校验口令）
    │   └── sessions/<sessionID>/
    │       ├── meta.ocgs                     （会话元信息）
    │       └── packs/pack-000001.ocgs        （消息封包：多条消息 + parts）
    └── ocsync/<机器B>
```

- 每台机器只写自己那条分支 → **不会互相 force 覆盖**
- 提交用 `--amend --force` → 每条分支**永远只有 1 条提交**，不会堆版本
- 消息按未压缩 JSON 大小封口（256 KB/包），只重写最后一个「开口包」；已封口的包内容不再变化
- 旧消息被修改时作为覆盖项写进更新的包，拉取按包序号升序处理 → 后者覆盖前者
- 导入时按 messageID 取并集 → 同一会话两机并发编辑**不丢消息**
- 旧布局（一条消息一个文件）会在启动同步后自动合并成封包（先写包、再删旧文件）

## 按项目隔离

**一个项目 = 一个远端 = 一份本地状态**，互不串台：

```
<状态目录根>/<项目键>/
├── repo/            ← 该项目专属的 sync 仓库工作副本（origin = 该项目自己的 origin）
├── state.db         ← 该项目专属的指纹库（已暂存过哪些消息）
└── git-sync.log     ← 该项目专属的日志

<状态目录根> = ~/.local/share/opencode/git-sync（可用 OPENCODE_GIT_SYNC_DIR 改根）
<项目键>     = 目录名 + 路径哈希，如 fortune-1f2e3d4c
```

为什么必须隔离：sync 仓库的提交是 `--amend --force`（整份目录重推），
多个项目共用一份工作副本时，后一个项目的会话会连同前一个项目的会话一起被推到前一个项目的仓库去，
指纹库与日志也会互相干扰（一个项目退出时关掉状态库，另一个项目随即报 `Cannot use a closed database`）。

隔离之后：项目 A 的会话只进 A 的仓库、只写 A 的分支；换台机器跑同一个项目，仍然从 A 的仓库拉别人的 `ocsync/*` 分支。

## 加密模型

```
passphrase ──scrypt(N=32768, salt)──▶ 32B 内容密钥
                                        │
每文件：AES-256-GCM(nonce=随机12B, AAD=repoId + 仓库相对路径)
封包先 gzip 再加密（密文不可压缩，必须先压后加密）
仓库内：sync-meta.json（明文：repoId/salt，非机密）
        keycheck.ocgs（加密哨兵，用于校验 passphrase 正确性）
        sessions/<sessionID>/meta.ocgs
        sessions/<sessionID>/packs/pack-<seq>.ocgs
```

- **口令错误会被识别**：读取 `keycheck.ocgs` 失败 → 直接中止同步，**绝不会把解不开的密文当成新数据写回远端**。
- **AAD 绑定路径**：密文换到别的会话/别的路径下会解密失败，防止「调包」。
- salt 存在仓库明文里，多机共享；口令只在各机本地。

## 跨机身份怎么对齐

| 字段 | 处理方式 |
|---|---|
| `project_id` | **不动**：上游按 git remote URL 哈希生成，同一仓库跨机天然一致 |
| `path` | 相对 worktree 的相对路径，跨机一致 |
| `directory` | 绝对路径 → 导入时改写为本机目录 |
| 消息里的绝对路径 | 写入前替换为 `${WORKSPACE_ROOT}` / `${PROJECT_DIR}` 占位符，导入时还原为本机路径 |

## 时序与降级

| 场景 | 行为 |
|---|---|
| 正常启动 | 插件工厂内做一次 ≤5s 的拉取；成功则 `opencode -c` 首屏即可见远端会话 |
| 断网 | fetch 超时 → 记录警告 → 按离线模式继续；本地会话照常可用，远端更新等下次联网 |
| 弱网/远端慢 | git 子进程硬超时并 kill，不会把 `-c` 拖成几十秒 |
| passphrase 不匹配 | 中止同步，不导入也不推送 |
| 迟到导入 | 导入后调一次 `session.update` 触发 `session.updated`，TUI 列表自动刷新 |

## 日志与排查

```
~/.local/share/opencode/git-sync/<项目键>/git-sync.log
```

```bash
OPENCODE_GIT_SYNC_LOG=debug opencode        # 打开详细日志
```

排查清单：

1. `git ls-remote $(git remote get-url origin)` 看 `refs/heads/ocsync/*` 是否存在 → 确认推送链路
   （远端默认就是项目自身的 origin，可用 `OPENCODE_GIT_SYNC_REMOTE` 覆盖）
2. `git show <remote>:sync-meta.json` 看 repoId/salt 是否两机一致 → 不一致会拒绝导入
3. `git show <remote>:sessions/<id>/meta.ocgs | xxd | head` → 确认是密文（以 `OCGS1` 开头）
4. 日志里出现「passphrase 不匹配」→ 两机口令不一致

## 已知限制（v1）

1. **导入只覆盖 V1 形态**（`message`/`part` 表）。上游新的 `session_message`（V2 投影）不会被填充，从 V2 通道续聊时上下文可能不含导入的历史。界面显示与 V1 续聊均正常。
2. **分支会被 clone 带走**：GitHub 上没有「可写但 clone 不可见」的 ref 命名空间，所以 `git clone` 会把 `ocsync/*` 分支带走（内容是密文）。仓库建议设为 **private**。
   ⚠️ **仓库公开 + 弱口令 = 等于没有加密**：任何人都能 clone 后离线解密（scrypt 只挡暴力破解，挡不住 `123456` 这种字典口令）。正式使用请「私有仓库 + 强随机口令」。
   换口令后必须重来（旧密文解不开）：删本地 `~/.local/share/opencode/git-sync/` + `git push <remote> --delete ocsync/<机器名>`。
3. **进程退出没有钩子**：只在 `dispose`（实例销毁）时兜底冲刷；强杀进程可能丢最后一次推送（下次 idle 会补上）。
4. **同一会话并发编辑**：按 messageID 合并，不丢消息；会话标题等元信息按 `time.updated` 取新（依赖各机时钟基本准确）。
5. **首次使用需要联网**：加入同步仓库时需要能访问远端。

## 排查「另一台机器的会话没出现」

```bash
bun run script/verify.ts
```

会**逐分支**列出每台机器推了多少内容：

```
各机器分支内容：
  ocsync/HP-Laptop-4bb94a      会话   2  消息  319  meta ✓
  ocsync/IcbcaChatbot-ded734   会话   0  消息    0  meta ✗  ← 空分支：该机器没推上任何会话
```

若某台机器是**空分支**（`meta ✗` + 会话 0），说明那台机器的插件没把任何东西推上来。到那台机器上按顺序查：

```bash
# 1) 插件有没有真的跑起来（看有没有日志、有没有状态目录）
ls -la ~/.local/share/opencode/git-sync/
tail -30 ~/.local/share/opencode/git-sync/*/git-sync.log

# 2) 本地有没有暂存出文件（有文件但没推上去 = 推送环节的问题）
ls -R ~/.local/share/opencode/git-sync/*/repo/sessions 2>/dev/null | head

# 3) 本地分支状态
git -C ~/.local/share/opencode/git-sync/*/repo log --oneline -3
git -C ~/.local/share/opencode/git-sync/*/repo status --porcelain | head

# 4) 口令是否与远端一致
bun run script/verify.ts
```

常见原因：

| 现象 | 原因 | 处理 |
|---|---|---|
| 日志里「未找到 passphrase，插件不启用」 | 那台机器没放口令文件 | `./install.sh`（选「使用现有口令」） |
| 日志里「passphrase 不匹配」 | 两机口令不同 | 用 `--passphrase-file` 换成同一个口令 |
| 有 `sessions/` 文件但远端是空分支 | 推送环节失败（网络/权限） | 看日志里 `push 失败:` 的报错 |
| 日志里「已暂存会话 … N 个文件」但远端没变 | 推送被拒 | `git -C ~/.local/share/opencode/git-sync/<项目键>/repo push --force origin ocsync/<机器名>` 手动重试看报错 |

## 快速验证（装完确认能用）

```bash
# 1) 聊两句后，等 3 秒（防抖推送），看远端有没有分支
git ls-remote origin 'refs/heads/ocsync/*'

# 2) 远端内容是不是密文（应看到 OCGS1 开头）
git fetch origin 'refs/heads/ocsync/*:refs/remotes/origin/ocsync/*'
git ls-tree -r origin/ocsync/<机器名>
git show origin/ocsync/<机器名>:sessions/<sessionID>/meta.ocgs | xxd | head

# 3) 分支历史应该只有 1 条
git log --oneline origin/ocsync/<机器名> | wc -l

# 4) 口令与远端是否同一个
bun run script/verify.ts
```

## 开发

```bash
bun test          # 23 项单测：加密往返、路径归一化、git 分支、远端自动探测、两机端到端导入
bun run typecheck # tsc --noEmit（strict）
bun run build     # 单文件产物 dist/git-sync.ts
```

测试覆盖的关键行为：

- 加密往返 / 口令错误 / AAD 绑定 / keycheck 校验
- 路径归一化与还原
- `amend` 提交保持历史恒定 1 条
- 两台机器通过远端互相可见
- 机器 A 推送 → 机器 B 解密导入本地库（含 project_id/directory/path 改写）
- passphrase 不匹配时不写入任何数据
- 远端仓库里不存在明文会话内容
- 远端自动探测（origin / 第一个 remote / 非仓库三种情况）
- 零配置启用：口令放默认位置即可，无需任何配置项
