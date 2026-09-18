# 部署同步指南

本文档记录如何将三个插件同步到 Windows 目标机。

## 前置条件

- WSL 或 Linux 环境
- 目标机已安装 Bun
- 目标目录存在（如 `D:\Tools\node-v22.23.2-win-x64`）

## 同步步骤

### 1. opencode-server-debug

```bash
cd /data/opencode/opencode-server-debug
BUNDLE="/mnt/d/Tools/node-v22.23.2-win-x64/opencode-server-debug-bundle-0.0.1" bash scripts/sync-bundle.sh
```

### 2. opencode-edge-debug

```bash
cd /data/opencode/opencode-edge-debug
BUNDLE="/mnt/d/Tools/node-v22.23.2-win-x64/opencode-edge-debug-bundle-0.0.1" bash scripts/sync-bundle.sh
```

### 3. opencode-session-mgmt（插件）

```bash
cd /data/opencode/opencode-session-mgmt
BUNDLE="/mnt/d/Tools/node-v22.23.2-win-x64/opencode-sm-bundle-0.1.0" bash scripts/sync-bundle.sh
```

### 4. opencode-sm CLI（可选）

如需在 Windows 上使用 `opencode-sm` 命令行工具：

```bash
cd /data/opencode/opencode-session-mgmt
# 构建 Windows 二进制
bash scripts/pack-cli.sh windows-x64

# 复制到目标机
cp dist/opencode-sm-0.1.0-windows-x64.tgz /mnt/d/Tools/node-v22.23.2-win-x64/

# 在 Windows 上安装（npm）
cd /mnt/d/Tools/node-v22.23.2-win-x64
./npm install -g ./opencode-sm-0.1.0-windows-x64.tgz
```

## 同步后操作

重启 Windows 上的 opencode 守护进程以重新加载插件。

## 注意事项

- `sync-bundle.sh` 只同步运行时必需的内容（源码、docs），不包括 `scripts/` 目录
- 如需修改同步脚本本身，需手动复制或使用 `pack-bundle.sh` 重新打包
- 符号链接会被解引用为真实文件，确保跨机器兼容
