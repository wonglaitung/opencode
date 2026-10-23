#!/usr/bin/env bash
set -euo pipefail

ROOT=${OPENCODE_WIN_ROOT:-/mnt/d/Tools/node-v22.23.2-win-x64}
EXPECT_VERSION=${EXPECT_VERSION:-1.19.4}
CMD=${CMD:-/mnt/c/Windows/System32/cmd.exe}
POWERSHELL=${POWERSHELL:-/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe}
CURL=${CURL:-/mnt/c/Windows/System32/curl.exe}
TASKKILL=${TASKKILL:-/mnt/c/Windows/System32/taskkill.exe}
TASKLIST=${TASKLIST:-/mnt/c/Windows/System32/tasklist.exe}
NETSTAT=${NETSTAT:-/mnt/c/Windows/System32/netstat.exe}
BUN=${BUN:-$ROOT/node_modules/bun/bin/bun.exe}

command -v wslpath >/dev/null || { echo "wslpath is required" >&2; exit 2; }

EXE="$ROOT/node_modules/opencode-ai/bin/opencode.exe"

discover() {
  local pattern="$1" fallback="$2"
  if [[ -n "$fallback" && -d "$fallback" ]]; then printf '%s\n' "$fallback"; return; fi
  find "$ROOT" -maxdepth 4 -type d -path "$pattern" 2>/dev/null | sort -V | tail -1
}

SM_PLUGIN=${SM_PLUGIN:-$(discover "*/opencode-sm-bundle-*/packages/plugin" "$ROOT/opencode-sm-bundle-0.1.0/packages/plugin")}
EDGE_PLUGIN=${EDGE_PLUGIN:-$(discover "*/opencode-edge-debug-bundle-*" "$ROOT/opencode-edge-debug-bundle-0.0.1")}
SERVER_PLUGIN=${SERVER_PLUGIN:-$(discover "*/opencode-server-debug-bundle-*" "$ROOT/opencode-server-debug-bundle-0.0.1")}

for f in "$EXE" "$SM_PLUGIN/package.json" "$EDGE_PLUGIN/package.json" "$SERVER_PLUGIN/package.json"; do
  [[ -e "$f" ]] || { echo "missing: $f" >&2; exit 2; }
done
for t in "$CMD" "$POWERSHELL" "$CURL" "$TASKKILL" "$TASKLIST" "$NETSTAT" "$BUN"; do
  [[ -x "$t" ]] || { echo "missing executable: $t" >&2; exit 2; }
done

win() { wslpath -w "$1"; }
winslash() { win "$1" | sed 's#\\#/#g'; }

port_listening() {
  "$NETSTAT" -ano 2>/dev/null | tr -d '\r' | grep -qE ":$1[[:space:]].*LISTENING"
}

if [[ -n "${PORT:-}" ]]; then
  if port_listening "$PORT"; then
    echo "port $PORT already in use; unset PORT or choose another" >&2
    exit 2
  fi
else
  for p in $(seq 4097 4199); do
    if ! port_listening "$p"; then PORT=$p; break; fi
  done
fi
[[ -n "${PORT:-}" ]] || { echo "no free port in 4097-4199" >&2; exit 2; }

TMP="$ROOT/opencode-plugin-smoke.$$"
mkdir -p "$TMP"
WIN_TMP=$(win "$TMP")
WIN_EXE=$(win "$EXE")
WIN_BUN=$(win "$BUN")

sm_spec="file:///$(winslash "$SM_PLUGIN")"
edge_spec="file:///$(winslash "$EDGE_PLUGIN")"
server_spec="file:///$(winslash "$SERVER_PLUGIN")"

cat > "$TMP/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "plugin": [
    "$(winslash "$SM_PLUGIN")",
    "$(winslash "$EDGE_PLUGIN")",
    "$(winslash "$SERVER_PLUGIN")"
  ]
}
EOF

cat > "$TMP/start.ps1" <<'PS'
param([string]$Exe, [string]$Dir, [string]$Port)
$stdout = Join-Path $Dir "stdout.log"
$stderr = Join-Path $Dir "stderr.log"
$p = Start-Process -FilePath $Exe -ArgumentList @("serve", "--port", $Port, "--print-logs", "--log-level", "DEBUG") -WorkingDirectory $Dir -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
Set-Content -Path (Join-Path $Dir "pid.txt") -Value $p.Id
PS

PID=""
cleanup() {
  local status=$?
  if [[ -n "$PID" ]]; then "$TASKKILL" /PID "$PID" /T /F >/dev/null 2>&1 || true; fi
  local pids
  pids=$("$NETSTAT" -ano 2>/dev/null | tr -d '\r' | awk -v p=":$PORT" '$2 ~ p && $4=="LISTENING" {print $5}' | sort -u || true)
  for p in $pids; do
    if "$TASKLIST" /FI "PID eq $p" 2>/dev/null | grep -qi 'opencode.exe'; then
      "$TASKKILL" /PID "$p" /T /F >/dev/null 2>&1 || true
    fi
  done
  sleep 0.5
  if [[ $status -eq 0 ]]; then
    rm -rf "$TMP"
  else
    echo "logs kept: $TMP" >&2
  fi
}
trap cleanup EXIT

"$POWERSHELL" -NoProfile -ExecutionPolicy Bypass -File "$(win "$TMP/start.ps1")" -Exe "$WIN_EXE" -Dir "$WIN_TMP" -Port "$PORT" >/dev/null 2>&1 &
launcher=$!
for _ in $(seq 1 40); do [[ -s "$TMP/pid.txt" ]] && break; sleep 0.25; done
kill "$launcher" >/dev/null 2>&1 || true
[[ -s "$TMP/pid.txt" ]] || { echo "server did not start" >&2; exit 1; }
PID=$(tr -d '\r\n' < "$TMP/pid.txt")

version=$("$EXE" --version 2>/dev/null | tr -d '\r' | tail -1 || true)
version_fail=0
if [[ "$version" != "$EXPECT_VERSION" ]]; then
  echo "FAIL version=$version expected=$EXPECT_VERSION" >&2
  version_fail=1
fi

code=000
for _ in $(seq 1 60); do
  code=$("$CURL" -sS --max-time 20 -o "$(win "$TMP/config.json")" -w '%{http_code}' "http://127.0.0.1:$PORT/config" 2>/dev/null || true)
  [[ "$code" == "200" ]] && break
  sleep 2
done
if [[ "$code" != "200" ]]; then
  echo "server did not become ready (http=$code)" >&2
  tail -40 "$TMP/stderr.log" >&2 || true
  exit 1
fi

"$CURL" -sS --max-time 30 "http://127.0.0.1:$PORT/experimental/tool/ids" -o "$(win "$TMP/toolids.json")" 2>/dev/null || true

LOG="$TMP/stderr.log"
summary=$(grep -o 'message=plugin.load.summary.*' "$LOG" | tail -1 || true)
value() { grep -o "$1=[0-9]*" <<<"$summary" | head -1 | cut -d= -f2; }
configured=$(value configured)
loaded=$(value loaded)
skipped=$(value skipped)
missing=$(value missing)
failed=$(value failed)

applied=$(grep 'message=plugin.applied' "$LOG" || true)
applied_count=$(printf '%s\n' "$applied" | grep -c 'message=plugin.applied' || true)

fail=$version_fail
check() { if [[ "$1" != "$2" ]]; then echo "FAIL $3: $1 != $2" >&2; fail=1; fi; }
[[ -n "$summary" ]] || { echo "FAIL plugin.load.summary not found" >&2; fail=1; }
check "$configured" "$loaded" "loaded/configured"
check "$skipped" "0" "skipped"
check "$missing" "0" "missing"
check "$failed" "0" "failed"
check "$applied_count" "$configured" "applied/configured"

apply_line() { printf '%s\n' "$applied" | grep -F "spec=$1" | head -1 || true; }
check_hooks() {
  local spec="$1" name="$2" line hook
  shift 2
  line=$(apply_line "$spec")
  if [[ -z "$line" ]]; then echo "FAIL no plugin.applied for $name" >&2; fail=1; return; fi
  for hook in "$@"; do
    if ! grep -qF "$hook" <<<"$line"; then echo "FAIL $name missing hook $hook" >&2; fail=1; return; fi
  done
  echo "OK $name $(sed 's/^.*message=plugin.applied //; s/ id=undefined//' <<<"$line")"
}

check_hooks "$sm_spec" "sm-plugin" "experimental.chat.system.transform" "dispose"
check_hooks "$edge_spec" "edge-debug" "tool" "dispose"
check_hooks "$server_spec" "server-debug" "tool" "dispose"

if [[ ! -s "$TMP/toolids.json" ]]; then
  echo "FAIL /experimental/tool/ids returned no data" >&2
  fail=1
fi

cat > "$TMP/tools.ts" <<'TS'
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const bundles = JSON.parse(readFileSync("bundles.json", "utf8"))

const client = new Proxy({}, {
  get: () => () => Promise.resolve({ data: [] }),
})

for (const [name, dir] of bundles) {
  try {
    const pkg = JSON.parse(readFileSync(`${dir}/package.json`, "utf8"))
    const mod = await import(pathToFileURL(`${dir}/${pkg.main}`).href)
    const hook = await mod.default({
      directory: process.cwd(),
      worktree: process.cwd(),
      project: {},
      client,
      serverUrl: new URL("http://127.0.0.1:4096"),
    })
    const tools = Object.keys(hook.tool ?? {})
    console.log(`TOOLS\t${name}\t${tools.length}\t${tools.join(",")}`)
    try {
      await hook.dispose?.()
    } catch {}
  } catch (error) {
    console.log(`TOOLS_ERROR\t${name}\t${String(error)}`)
  }
}
TS

cat > "$TMP/bundles.json" <<EOF
[
  ["sm-plugin", "$(winslash "$SM_PLUGIN")"],
  ["edge-debug", "$(winslash "$EDGE_PLUGIN")"],
  ["server-debug", "$(winslash "$SERVER_PLUGIN")"]
]
EOF

"$CMD" /c "cd /d $WIN_TMP && $WIN_BUN tools.ts" > "$TMP/tools.tsv" 2> "$TMP/tools.err" || true

tool_reports=0
tools_total=0
while IFS=$'\t' read -r kind name count names; do
  if [[ "$kind" == "TOOLS_ERROR" ]]; then
    echo "FAIL $name tool counting: $count" >&2
    fail=1
    tool_reports=$((tool_reports + 1))
    continue
  fi
  [[ "$kind" == "TOOLS" ]] || continue
  tool_reports=$((tool_reports + 1))
  if [[ -z "$count" || "$count" -lt 1 ]]; then
    echo "FAIL $name tools=$count" >&2
    fail=1
    continue
  fi
  tools_total=$((tools_total + count))
  missing=""
  if [[ -s "$TMP/toolids.json" ]]; then
    IFS=',' read -ra tool_names <<< "$names"
    for t in "${tool_names[@]}"; do
      if [[ -n "$t" ]] && ! grep -qF "\"$t\"" "$TMP/toolids.json"; then
        missing+="$t,"
      fi
    done
  fi
  if [[ -n "$missing" ]]; then
    echo "FAIL $name tools missing from registry: ${missing%,}" >&2
    fail=1
  elif [[ -s "$TMP/toolids.json" ]]; then
    echo "OK $name tools=$count registered=$count"
    if [[ "${VERBOSE:-0}" == "1" && -n "$names" ]]; then echo "  $names"; fi
  else
    echo "FAIL $name tools=$count registry unavailable" >&2
    fail=1
  fi
done < "$TMP/tools.tsv"

if [[ $tool_reports -ne 3 ]]; then
  echo "FAIL expected 3 tool reports, got $tool_reports" >&2
  tail -20 "$TMP/tools.err" >&2 || true
  fail=1
fi

if [[ $fail -ne 0 ]]; then
  echo "FAILED binary=$version configured=$configured loaded=$loaded applied=$applied_count" >&2
  exit 1
fi
echo "OK binary=$version configured=$configured loaded=$loaded tools=$tools_total failed=$failed"
