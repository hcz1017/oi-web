// 给 @vscode/test-web 生成的页面注入「中文 NLS 自愈」脚本。
//
// 逻辑（只在客户端跑，不碰扩展加载）：
//   1. 检查 globalThis._VSCODE_NLS_MESSAGES 里有没有中文
//   2. 没有 → 同步拉取 /static/build/out/nls.messages.zh-cn.js 并 eval 覆盖
//   3. 还是英文 → 带 ?oiNlsRetry=N 刷新重试，最多 3 次
//
// 用法：node scripts/patch-test-web.mjs
//       node scripts/patch-test-web.mjs --restore   # 去掉补丁
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(ROOT, "node_modules/@vscode/test-web/out/server/workbench.js");
const MARK = "OI_NLS_GUARD";

const GUARD = `<script>/* ${MARK} */
(function () {
  var RETRY_KEY = "oi.nls.retry";
  var ZH_URL = "/static/build/out/nls.messages.zh-cn.js";
  function hasChinese(arr) {
    try {
      for (var i = 0; i < arr.length; i++) {
        if (typeof arr[i] === "string" && /[\\u4e00-\\u9fa5]/.test(arr[i])) return true;
      }
    } catch (e) {}
    return false;
  }
  if (hasChinese(globalThis._VSCODE_NLS_MESSAGES || [])) {
    try { sessionStorage.removeItem(RETRY_KEY); } catch (e) {}
    return;
  }
  try {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", ZH_URL, false);
    xhr.send(null);
    if (xhr.status === 200 && xhr.responseText) {
      (0, eval)(xhr.responseText);
      console.log("[oi] 中文 NLS 已由客户端补齐");
    }
  } catch (e) {
    console.warn("[oi] 拉取中文 NLS 失败:", e);
  }
  if (hasChinese(globalThis._VSCODE_NLS_MESSAGES || [])) {
    try { sessionStorage.removeItem(RETRY_KEY); } catch (e) {}
    return;
  }
  var n = 0;
  try { n = parseInt(sessionStorage.getItem(RETRY_KEY) || "0", 10) || 0; } catch (e) {}
  if (n < 3) {
    try { sessionStorage.setItem(RETRY_KEY, String(n + 1)); } catch (e) {}
    try {
      var u = new URL(location.href);
      u.searchParams.set("oiNlsRetry", String(n + 1));
      console.warn("[oi] 仍是英文，刷新重试 " + (n + 1) + "/3");
      location.replace(u.toString());
    } catch (e) {}
  } else {
    console.warn("[oi] 已重试 3 次仍无中文，放弃（界面保持英文）");
  }
})();
</script>`;

let s = readFileSync(FILE, "utf8");
const restore = process.argv.includes("--restore");

if (restore) {
  s = s.replace(new RegExp(`\\n?\\s*lines\\.push\\(\\x60${MARK}[\\s\\S]*?\\x60\\);`, "g"), "");
  writeFileSync(FILE, s);
  console.log(`✓ 已移除 ${MARK}`);
  process.exit(0);
}
if (s.includes(MARK)) {
  console.log(`✓ ${MARK} 已存在，无需重复打补丁`);
  process.exit(0);
}

const line = "<script src=\"${this.baseUrl}/out/nls.messages.js\"></script>";
const target = "lines.push(`" + line + "`);";
const count = s.split(target).length - 1;
if (count === 0) throw new Error("找不到 nls.messages.js 注入点（test-web 版本变了？）");

const inject = "lines.push(`" + line + "`);\n            lines.push(`" + GUARD.replace(/`/g, "\\`") + "`);";
s = s.split(target).join(inject);
writeFileSync(FILE, s);
console.log(`✓ ${MARK} 已注入 ${count} 处（dev/static 两个分支）`);
