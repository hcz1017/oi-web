#!/usr/bin/env bash
# ============================================================================
# 启动「OI C++ (WASM)」扩展的开发环境：@vscode/test-web + 真 VS Code Web
#
#   ./run-wasm-web.sh              # http://127.0.0.1:8083
#   PORT=9000 ./run-wasm-web.sh
#   SAMPLE=/path/to/dir ./run-wasm-web.sh   # 用别的目录当工作区（默认 oi-cpp-wasm/sample）
#
# 为什么必须 --coi：
#   clangd 是多线程 wasm（pthreads），交互 stdin 用 SharedArrayBuffer，
#   两者都要求页面处于「跨源隔离」（COOP: same-origin + COEP: require-corp）。
#
# 不需要构建 vscode 源码：@vscode/test-web 会下载官方预构建的 web 版，
# 并把 oi-cpp-wasm 目录当作开发扩展扫描进去（扩展的 assets/ 与 dist/ 也由它静态托管）。
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

ROOT="$(pwd)"
EXT="$ROOT/oi-cpp-wasm"
PORT="${PORT:-8083}"
HOST="${HOST:-127.0.0.1}"
SAMPLE="${SAMPLE:-$EXT/sample}"
QUALITY="${QUALITY:-stable}"

echo "== 1/3 打包扩展 =="
( cd "$EXT" && node esbuild.mjs )

echo "== 2/3 检查工具链资产 =="
python3 - "$EXT" <<'PY'
import os, sys
A = os.path.join(sys.argv[1], "assets")
need = [
    "clang.wasm.gz", "lld.wasm.gz", "sysroot.tar.gz", "compat/bits/stdc++.h",
    "clangd/clangd.js", "clangd/clangd.wasm.gz", "clangd/headers.json.gz",
]
missing = [n for n in need if not os.path.exists(os.path.join(A, n))]
if missing:
    print("   !! 缺少资产:", missing)
    print("   这些来自 C++ Studio Web 的工具链（见 oi-cpp-wasm/notices/THIRD-PARTY-NOTICES.md）")
    sys.exit(1)
total = sum(os.path.getsize(os.path.join(A, n)) for n in need)
print("   资产齐全 ✓  %.1fMB" % (total / 1048576))
PY

echo "== 3/3 启动 VS Code for the Web =="
# 依赖可能装在仓库根，也可能装在扩展目录（在 oi-cpp-wasm 里 npm install 时）
TW=""
for d in "$ROOT/node_modules" "$EXT/node_modules"; do
  [ -f "$d/@vscode/test-web/out/server/index.js" ] && TW="$d/@vscode/test-web" && break
done
[ -n "$TW" ] || { echo "   先装依赖: npm install   （需要 @vscode/test-web）"; exit 1; }
echo "   扩展:   $EXT"
echo "   工作区: $SAMPLE"
echo "   打开:   http://$HOST:$PORT/   （Ctrl+Shift+B 编译运行）"
exec node "$TW/out/server/index.js" \
  --browser none \
  --host "$HOST" --port "$PORT" \
  --coi \
  --quality "$QUALITY" \
  --extensionDevelopmentPath "$EXT" \
  "$SAMPLE"
