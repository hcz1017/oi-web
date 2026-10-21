#!/usr/bin/env bash
# 本地运行 VS Code Web（固定 8083，中文界面，空工作区）
#
# 首次运行会自动：
#   1. 打包扩展（extension/dist/web）
#   2. 下载 vscode-web 静态构建（.vscode-test-web，@vscode/test-web 的下载器）
#   3. 生成中文 NLS（把官方中文语言包编译进 vscode-web 的 nls.messages.js）
#   4. 给 test-web 页面注入中文自愈脚本（幂等）
#
# 依赖全部在仓库内：node_modules/、.vscode-test-web/、.dev-zh/zh-pack/
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
EXT="$ROOT/extension"
TW="$ROOT/node_modules/@vscode/test-web/out/server/index.js"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8083}"          # 固定端口，不再变
QUALITY="${QUALITY:-stable}"

[ -f "$TW" ] || { echo "缺少依赖: $TW（先在仓库根执行 npm install）"; exit 1; }

if [ ! -f "$EXT/dist/web/extension.js" ]; then
  echo "== [1/4] 打包扩展 =="
  (cd "$EXT" && node esbuild.mjs) || exit 1
fi

WEB_DIR="$(ls -d "$ROOT"/.vscode-test-web/vscode-web-stable-* 2>/dev/null | sort | tail -1 || true)"
if [ -z "$WEB_DIR" ]; then
  echo "== [2/4] 下载 vscode-web =="
  node "$ROOT/scripts/fetch-vscode-web.mjs" || exit 1
  WEB_DIR="$(ls -d "$ROOT"/.vscode-test-web/vscode-web-stable-* 2>/dev/null | sort | tail -1 || true)"
fi

if [ -n "$WEB_DIR" ] && [ ! -f "$WEB_DIR/out/nls.messages.zh-cn.js" ]; then
  echo "== [3/4] 生成中文 NLS =="
  node "$ROOT/scripts/build-zh-nls.mjs" >/dev/null || exit 1
fi

echo "== [4/4] 注入中文自愈脚本 + 打开文件夹补丁 =="
node "$ROOT/scripts/patch-test-web.mjs" >/dev/null 2>&1 || true
if [ -n "$WEB_DIR" ]; then
  node "$ROOT/scripts/patch-open-folder.mjs" \
    "$WEB_DIR/out/vs/workbench/workbench.web.main.internal.js" >/dev/null 2>&1 || true
fi

echo
echo "扩展:     $EXT"
echo "中文:     nls.messages.js 已中文化（scripts/build-zh-nls.mjs）"
echo "工作区:   空工作区（不打开任何文件夹）"
echo "打开:     http://$HOST:$PORT/"
echo
exec node "$TW" \
  --browser none \
  --host "$HOST" --port "$PORT" \
  --coi \
  --quality "$QUALITY" \
  --extensionDevelopmentPath "$EXT"
