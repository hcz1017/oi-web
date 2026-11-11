#!/usr/bin/env bash
# 本地运行 VS Code Web（固定 8084，中文界面，空工作区）
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
PORT="${PORT:-8084}"          # 固定端口（用户要求：测试端口用 8084）
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

# 中文 NLS 是可选项：新版 vscode-web 的产物里可能没有 out/nls.messages.js
# （上游改了打包布局）。缺文件就跳过，界面退回英文，但开发服必须能起来。
if [ -n "$WEB_DIR" ] && [ ! -f "$WEB_DIR/out/nls.messages.js" ]; then
  echo "== [3/4] 跳过中文 NLS：该 vscode-web 版本没有 out/nls.messages.js（界面为英文） =="
elif [ -n "$WEB_DIR" ] && [ ! -f "$WEB_DIR/out/nls.messages.zh-cn.js" ]; then
  echo "== [3/4] 生成中文 NLS =="
  node "$ROOT/scripts/build-zh-nls.mjs" >/dev/null || echo "⚠ 中文 NLS 生成失败（继续，界面英文）"
fi

# ⚠️ 这两个补丁都是"每次启动重新打"的：
#    中文自愈脚本注入 test-web 生成的页面；打开文件夹补丁改 vscode-web 的 bundle
#    （FileDialogService 里对自己的 throw 换成页面侧 FSA 实现）。
#    都是幂等的，重复执行安全。
echo "== [4/4] 注入中文自愈脚本 + 打开文件夹补丁 =="
node "$ROOT/scripts/patch-test-web.mjs" >/dev/null 2>&1 || true
# webview 同源放行：本机没有通配 DNS，webview iframe 走同源加载，但 VS Code 的
# pre/index.html 会校验 hostname 必须是 base32(sha256(parentOrigin)) 的子域 → 不补就全空白
node "$ROOT/scripts/patch-webview-same-origin.mjs" >/dev/null 2>&1 || true
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
# ⚠️ 固定使用**已经下载好**的那个 VS Code 构建：
#    不传 --commit 时 test-web 每次都会去查"最新 stable"并重新下载 80MB，
#    网络一抖（ECONNRESET）就直接起不来。目录名里就带着 commit，取出来传进去即可。
# ⚠️ test-web 判断"装好了没"的依据是目录里的 version 文件（还要内容匹配）：
#    解压成功但缺这个文件时，它会把整个目录 rm -rf 再重下 80MB —— 网络一抖就永远起不来。
#    这里自愈：目录里有 out/ 就补写 version，之后启动直接复用。
if [ -n "${WEB_DIR:-}" ] && [ -d "$WEB_DIR/out" ] && [ ! -f "$WEB_DIR/version" ]; then
  echo "$(basename "$WEB_DIR")" > "$WEB_DIR/version"
  echo "== 补写 version 标记（避免重复下载）：$(basename "$WEB_DIR") =="
fi

COMMIT=""
if [ -n "${WEB_DIR:-}" ]; then
  COMMIT="$(basename "$WEB_DIR" | sed -E 's/^vscode-web-[a-z]+-//')"
fi

echo "构建:     ${COMMIT:-（未下载，将获取最新 stable）}"
echo

EXTRA_ARGS=()
[ -n "$COMMIT" ] && EXTRA_ARGS+=(--commit "$COMMIT")

exec node "$TW" \
  --browser none \
  --host "$HOST" --port "$PORT" \
  --coi \
  --quality "$QUALITY" \
  "${EXTRA_ARGS[@]}" \
  --testRunnerDataDir "$ROOT/.vscode-test-web" \
  --extensionDevelopmentPath "$EXT"
