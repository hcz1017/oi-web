#!/usr/bin/env bash
# 打开一个「中文界面 + 不自动打开任何文件夹」的 VS Code Web 调试环境。
#
# 与 run-wasm-web.sh 的区别：
#   · 不传工作区目录 → 打开时是空工作区（不会出现 sample/测试目录）
#   · 额外加载中文语言包（.dev-zh/zh-pack，MS-CEINTL 官方语言包）
#
# 所有依赖都在本仓库目录内：node_modules/（@vscode/test-web）、
# .dev-zh/（语言包）、oi-cpp-wasm/（扩展本体 + 资产）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
EXT="$ROOT/oi-cpp-wasm"
TW="$ROOT/node_modules/@vscode/test-web/out/server/index.js"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8083}"   # 固定端口：以后都只用 8083
QUALITY="${QUALITY:-stable}"

[ -f "$TW" ] || { echo "缺少依赖: $TW（应安装在 $ROOT/node_modules 下）"; exit 1; }
# 首次运行自动补齐前置条件（扩展产物 / 中文 NLS / test-web 补丁）
if [ ! -f "$EXT/dist/web/extension.js" ]; then
  echo "== 首次运行：打包扩展 =="
  (cd "$EXT" && node esbuild.mjs) || exit 1
fi
WEB_DIR="$(ls -d "$ROOT"/.vscode-test-web/vscode-web-stable-* 2>/dev/null | sort | tail -1)"
if [ -n "$WEB_DIR" ] && [ ! -f "$WEB_DIR/out/nls.messages.zh-cn.js" ]; then
  echo "== 首次运行：生成中文 NLS =="
  node "$ROOT/scripts/build-zh-nls.mjs" >/dev/null || exit 1
fi
node "$ROOT/scripts/patch-test-web.mjs" >/dev/null 2>&1 || true

echo "扩展:     $EXT"
echo "中文:     out/nls.messages.js 已替换为中文（scripts/build-zh-nls.mjs 生成）"
echo "工作区:   （空工作区，不打开任何文件夹）"
echo "打开:     http://$HOST:$PORT/"
exec node "$TW" \
  --browser none \
  --host "$HOST" --port "$PORT" \
  --coi \
  --quality "$QUALITY" \
  --extensionDevelopmentPath "$EXT"
