#!/usr/bin/env node
// 给本机 vscode-web 打补丁：允许 **同源** 的 webview iframe，并同步修正 CSP 哈希。
//
// 背景（webview 全空白的原因）：
//   VS Code 的 webview 宿主页面 `out/vs/workbench/contrib/webview/browser/pre/index.html`
//   启动时校验自己的 hostname 必须是 `base32(sha256(parentOrigin))` 或其子域：
//       if (hostname === parentOriginHash || hostname.startsWith(parentOriginHash + '.')) start(...)
//       throw new Error(`Expected '${parentOriginHash}' as hostname or subdomain!`)
//   官方 vscode.dev 靠通配 DNS（<hash>.vscode-cdn.net）满足它。
//
//   本机为了绕开"没有通配 DNS"，给 @vscode/test-web 打的补丁把模板里的 `{{uuid}}.` 子域
//   **去掉了**（同源加载），于是 hostname 是 127.0.0.1，永远对不上 hash → 抛错 → 空白。
//
//   ⚠️ 这个页面把自己那段内联模块脚本的 **sha256 写进了 CSP**：
//       script-src 'sha256-29Ye…' 'self'
//   所以我们改脚本内容之后，必须把 CSP 里的哈希一起换掉，否则浏览器直接拒绝执行内联脚本
//   （表现为 `Executing inline script violates the following Content Security Policy`）。
//
// 幂等：每次启动重跑；总是按"当前脚本内容"重新计算哈希，保证一致。
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REL = "out/vs/workbench/contrib/webview/browser/pre/index.html";
const MARK = "/* oi-web: allow same-origin webview */";
const ORIGINAL = "if (hostname === parentOriginHash || hostname.startsWith(parentOriginHash + '.')) {";

function webDirs() {
  const base = path.join(ROOT, ".vscode-test-web");
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((d) => d.startsWith("vscode-web-"))
    .map((d) => path.join(base, d))
    .filter((d) => existsSync(path.join(d, REL)));
}

/** 取出页面里唯一的那个内联模块脚本的**原始文本**（浏览器算哈希就是按这段字节） */
function inlineScriptText(html) {
  const m = /<script async type="module">([\s\S]*?)<\/script>/.exec(html);
  return m ? m[1] : null;
}

function sha256b64(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("base64");
}

function patchOne(dir) {
  const file = path.join(dir, REL);
  let html = readFileSync(file, "utf8");
  let changed = false;

  // 1) 插入"同源放行"分支
  if (!html.includes(MARK)) {
    if (!html.includes(ORIGINAL)) return { file, changed: false, reason: "没找到 hostname 校验语句" };
    const patched =
      `${MARK}\n` +
      "\t\t\t\t\t// 本机开发：iframe 与父页面同源时也放行（官方靠 <hash>.vscode-cdn.net 子域满足校验）\n" +
      "\t\t\t\t\tif (parentOrigin && location.origin === parentOrigin) {\n" +
      "\t\t\t\t\t\treturn start(parentOrigin);\n" +
      "\t\t\t\t\t}\n" +
      "\t\t\t\t\t" + ORIGINAL;
    html = html.replace(ORIGINAL, patched);
    changed = true;
  }

  // 2) 按当前脚本内容重算 CSP 哈希（改了内联脚本就必须同步，否则被 CSP 拦掉）
  const script = inlineScriptText(html);
  if (script == null) return { file, changed, reason: "找不到内联模块脚本" };
  const hash = `sha256-${sha256b64(script)}`;
  const before = html;
  html = html.replace(/script-src 'sha256-[^']*'/, `script-src '${hash}'`);
  if (html !== before) changed = true;

  if (changed) writeFileSync(file, html);
  return { file, changed, hash };
}

const dirs = webDirs();
if (!dirs.length) {
  console.log("跳过：还没有下载 vscode-web（先跑一次 npm run web 的下载步骤）");
  process.exit(0);
}
for (const dir of dirs) {
  const r = patchOne(dir);
  const rel = path.relative(ROOT, r.file);
  if (r.reason) console.log(`跳过：${rel}（${r.reason}）`);
  else console.log(`${r.changed ? "已打补丁" : "已是最新"}：${rel}（CSP ${r.hash}）`);
}
