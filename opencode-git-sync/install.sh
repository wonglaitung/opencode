#!/usr/bin/env bash
# opencode-git-sync 安装脚本
#
# 用途：在一台新机器上快速装好「跨机会话同步」插件。
#   - 复制单文件插件到 opencode 的插件目录（~/.config/opencode/plugin/）
#   - 写入口令文件（可指定 / 自动生成强随机口令）
#   - 体检：依赖、文件、权限、远端探测
#
# 用法：
#   ./install.sh --generate          # 推荐：生成强随机口令
#   ./install.sh --passphrase "..."  # 指定口令
#   ./install.sh --check             # 只体检，不改动
#   ./install.sh --uninstall         # 卸载
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TARGET_DIR="${HOME}/.config/opencode/plugin"
KEY_FILE="${HOME}/.config/opencode/git-sync.key"
FROM=""
PASSPHRASE=""
PASSPHRASE_FILE=""
GENERATE=0
NO_BUILD=0
FORCE=0
UNINSTALL=0
CHECK_ONLY=0

log()  { printf '%s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
err()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

usage() {
  cat <<'EOF'
opencode-git-sync 安装脚本

用途：在一台新机器上快速装好「跨机会话同步」插件。
  - 复制单文件插件到 opencode 的插件目录（~/.config/opencode/plugin/）
  - 写入口令文件（可指定 / 自动生成强随机口令）
  - 体检：依赖、文件、权限、远端探测

用法：
  ./install.sh --generate          # 推荐：生成强随机口令
  ./install.sh --passphrase "..."  # 指定口令
  ./install.sh --check             # 只体检，不改动
  ./install.sh --uninstall         # 卸载

选项：
  --from <path|url>   插件产物来源（默认：脚本同目录 dist/git-sync.ts；http(s) 开头则下载）
  --target <dir>      插件安装目录（默认 ~/.config/opencode/plugin）
  --key <file>        口令文件路径（默认 ~/.config/opencode/git-sync.key）
  --passphrase <s>    指定口令（明文出现在 shell 历史里，介意就用 --generate）
  --passphrase-file <f> 从文件读取口令（例如从另一台机器拷来的 git-sync.key）
  --generate          生成 32 位强随机口令并打印一次
  --no-build          不执行 bun build，直接使用现成产物
  --force             覆盖已安装的文件
  --uninstall         卸载插件与口令文件
  --check             只做体检，不做任何改动
  -h, --help          显示本帮助
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) FROM="$2"; shift 2 ;;
    --target) TARGET_DIR="$2"; shift 2 ;;
    --key) KEY_FILE="$2"; shift 2 ;;
    --passphrase) PASSPHRASE="$2"; shift 2 ;;
    --passphrase-file) PASSPHRASE_FILE="$2"; shift 2 ;;
    --generate) GENERATE=1; shift ;;
    --no-build) NO_BUILD=1; shift ;;
    --force) FORCE=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --check) CHECK_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) err "未知参数: $1"; usage; exit 1 ;;
  esac
done

PLUGIN_NAME="git-sync.ts"

# ---------------------------------------------------------------- 卸载
if [[ "$UNINSTALL" == "1" ]]; then
  log "卸载 opencode-git-sync"
  rm -f "${TARGET_DIR}/${PLUGIN_NAME}"
  ok "已移除 ${TARGET_DIR}/${PLUGIN_NAME}"
  if [[ -f "$KEY_FILE" ]]; then
    rm -f "$KEY_FILE"
    ok "已移除口令文件 ${KEY_FILE}"
  fi
  log "远端分支不会被自动删除，如需清理：git push <remote> --delete ocsync/<机器名>"
  exit 0
fi

# ---------------------------------------------------------------- 体检
check_env() {
  log "体检"
  if command -v git >/dev/null 2>&1; then ok "git: $(git --version)"; else err "缺少 git"; fi
  if command -v bun >/dev/null 2>&1; then ok "bun: $(bun --version)"; else warn "没有 bun（仅在需要重新构建时必需）"; fi
  if command -v opencode >/dev/null 2>&1; then ok "opencode: $(opencode --version 2>/dev/null | head -1)"; else warn "PATH 里没有 opencode"; fi

  if [[ -f "${TARGET_DIR}/${PLUGIN_NAME}" ]]; then
    ok "插件已安装: ${TARGET_DIR}/${PLUGIN_NAME}"
  else
    warn "插件未安装: ${TARGET_DIR}/${PLUGIN_NAME}"
  fi

  if [[ -f "$KEY_FILE" ]]; then
    local mode
    mode="$(stat -c '%a' "$KEY_FILE" 2>/dev/null || stat -f '%Lp' "$KEY_FILE" 2>/dev/null || echo '?')"
    if [[ "$mode" == "600" || "$mode" == "400" ]]; then
      ok "口令文件已存在且权限安全 (${mode}): ${KEY_FILE}"
    else
      warn "口令文件权限过宽 (${mode}): ${KEY_FILE}  →  chmod 600 \"$KEY_FILE\""
    fi
  else
    warn "口令文件不存在: ${KEY_FILE}"
  fi

  # 远端探测：取当前目录的 git origin
  local remote=""
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    remote="$(git remote get-url origin 2>/dev/null || true)"
    if [[ -z "$remote" ]]; then remote="$(git remote 2>/dev/null | head -1 || true)"; fi
    if [[ -n "$remote" ]]; then ok "同步远端（项目 origin）: ${remote}"; else warn "当前目录不是 git 仓库或没有远端"; fi
  else
    warn "当前目录不是 git 仓库（插件会在打开项目时再探测远端）"
  fi

  # 口令与远端一致性（需要 bun 才能解密校验）
  if command -v bun >/dev/null 2>&1 && [[ -f "${SCRIPT_DIR}/script/verify.ts" ]]; then
    log ""
    log "口令 / 远端一致性校验"
    local args=(--key-file "$KEY_FILE")
    if [[ -n "$remote" ]]; then args+=(--remote "$remote"); fi
    bun run "${SCRIPT_DIR}/script/verify.ts" "${args[@]}" 2>&1 | sed 's/^/  /' || true
  else
    warn "跳过口令校验（需要 bun 才能验证口令是否与远端一致）"
  fi
}

if [[ "$CHECK_ONLY" == "1" ]]; then
  check_env
  exit 0
fi

# ---------------------------------------------------------------- 取插件产物
resolve_source() {
  local candidate="$FROM"
  if [[ -z "$candidate" ]]; then
    for c in "${SCRIPT_DIR}/dist/git-sync.ts" "${SCRIPT_DIR}/../dist/git-sync.ts" "${SCRIPT_DIR}/git-sync.ts"; do
      if [[ -f "$c" ]]; then candidate="$c"; break; fi
    done
  fi
  if [[ -z "$candidate" ]]; then
    die "找不到插件产物（dist/git-sync.ts）。请先 bun run build，或用 --from 指定路径/URL"
  fi
  if [[ "$candidate" == http://* || "$candidate" == https://* ]]; then
    command -v curl >/dev/null 2>&1 || die "需要 curl 才能下载"
    local tmp
    tmp="$(mktemp)"
    curl -fsSL "$candidate" -o "$tmp" || die "下载失败: $candidate"
    candidate="$tmp"
  fi
  [[ -f "$candidate" ]] || die "插件产物不存在: $candidate"
  echo "$candidate"
}

log "安装 opencode-git-sync"
SOURCE="$(resolve_source)"

if [[ "$NO_BUILD" != "1" && -f "${SCRIPT_DIR}/src/index.ts" ]] && command -v bun >/dev/null 2>&1; then
  log "构建插件（bun build）"
  (cd "${SCRIPT_DIR}" && bun run build >/dev/null) || warn "构建失败，改用现成产物"
  if [[ -f "${SCRIPT_DIR}/dist/git-sync.ts" ]]; then SOURCE="${SCRIPT_DIR}/dist/git-sync.ts"; fi
fi

# ---------------------------------------------------------------- 安装插件文件
mkdir -p "$TARGET_DIR"
DEST="${TARGET_DIR}/${PLUGIN_NAME}"
if [[ -f "$DEST" && "$FORCE" != "1" ]]; then
  warn "已存在 ${DEST}（加 --force 覆盖）"
else
  cp "$SOURCE" "$DEST"
  ok "插件已安装: ${DEST}"
fi

# ---------------------------------------------------------------- 口令
mkdir -p "$(dirname "$KEY_FILE")"
if [[ -f "$KEY_FILE" && "$FORCE" != "1" && -z "$PASSPHRASE" && "$GENERATE" != "1" ]]; then
  ok "口令文件已存在，保持不变: ${KEY_FILE}"
else
  if [[ "$GENERATE" == "1" ]]; then
    if command -v openssl >/dev/null 2>&1; then
      PASSPHRASE="$(openssl rand -base64 32 | tr -d '\n/+=' | cut -c1-40)"
    else
      PASSPHRASE="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    fi
  elif [[ -n "$PASSPHRASE_FILE" ]]; then
    [[ -f "$PASSPHRASE_FILE" ]] || die "口令文件不存在: $PASSPHRASE_FILE"
    PASSPHRASE="$(tr -d '\r\n' < "$PASSPHRASE_FILE" | sed -e 's/[[:space:]]*$//')"
    [[ -n "$PASSPHRASE" ]] || die "口令文件为空: $PASSPHRASE_FILE"
    ok "口令已从 ${PASSPHRASE_FILE} 读取"
  elif [[ -z "$PASSPHRASE" ]]; then
    if [[ -t 0 ]]; then
      printf '\n这台机器要加入已有的同步仓库吗？\n'
      printf '  1) 使用现有口令（另一台机器正在用的那个）\n'
      printf '  2) 生成新口令（仅当这台机器是第一台）\n'
      printf '  3) 取消\n'
      printf '选择 [1-3]: '
      read -r choice
      case "$choice" in
        1)
          printf '请输入现有口令（不会回显）: '
          read -r -s PASSPHRASE
          printf '\n'
          ;;
        2)
          GENERATE=1
          if command -v openssl >/dev/null 2>&1; then
            PASSPHRASE="$(openssl rand -base64 32 | tr -d '\n/+=' | cut -c1-40)"
          else
            PASSPHRASE="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
          fi
          ;;
        *) die "已取消" ;;
      esac
    else
      die "非交互环境：请用 --passphrase / --passphrase-file / --generate 指定口令"
    fi
  fi
  if [[ -z "$PASSPHRASE" ]]; then die "口令不能为空"; fi
  printf '%s' "$PASSPHRASE" > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
  ok "口令已写入 ${KEY_FILE}（权限 600）"
  if [[ "$GENERATE" == "1" ]]; then
    printf '\n\033[33m⚠ 请立刻抄下这个口令（只显示这一次），其他机器要用同一个：\033[0m\n\n    %s\n\n' "$PASSPHRASE"
  fi
fi

log ""
log "安装完成。下一步："
log "  1) 打开项目目录，确认远端：git remote get-url origin"
log "  2) 启动：opencode        （正常使用）"
log "  3) 跨机接力：opencode -c"
log "  4) 体检：$0 --check"
log ""
log "若这台机器是加入已有同步仓库：请用「现有口令」或 --passphrase-file（从另一台机器拷来的 git-sync.key）。"
log "公开仓库请注意：分支 ocsync/<机器名> 会被 clone 带走（内容已加密，但分支名会暴露主机名）。"
