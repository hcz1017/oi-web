// 桌面垫片的"本地文件 vs URL"判定（Windows 盘符路径回归）
// 背景：Windows d:\... 被 /^[a-z]+:/ 当成协议 "d:" → 本地资产交给真 fetch →
//       undici 抛 "TypeError: fetch failed"（clangd 在 Windows 桌面永远起不来）。
import { createRequire } from "node:module";
import { win32, posix } from "node:path";

const require = createRequire(import.meta.url);
const { isFileLike, isScheme, isWindowsDrive } = require("../src/node/url-path.cjs");

let pass = true;
const must = (cond, msg) => { if (cond) console.log("✓ " + msg); else { pass = false; console.log("✗ " + msg); } };

const winAbs = (p) => win32.isAbsolute(p);
const unixAbs = (p) => posix.isAbsolute(p);

// ---- Windows：盘符路径必须算"本地文件"（这是本次修复的核心） ----
must(isWindowsDrive("d:\\vscode\\data\\ext\\assets") === true, "识别 d:\\ 盘符路径");
must(isWindowsDrive("D:/vscode/ext/assets") === true, "识别 D:/ 盘符路径（正斜杠）");
must(isWindowsDrive("/home/u/x") === false, "不以盘符开头的不算");

must(isFileLike("d:\\vscode\\data\\ext\\assets/clangd/clangd.wasm.gz", winAbs) === true,
  "Windows 盘符路径 → 本地文件（旧实现这里是 false，导致 fetch failed）");
must(isFileLike("D:/vscode/ext/assets/a.gz", winAbs) === true, "Windows 正斜杠盘符路径 → 本地文件");
must(isFileLike("file:///d:/vscode/ext/assets/a.gz", winAbs) === true, "file:///d:/ → 本地文件");

// ---- POSIX ----
must(isFileLike("/home/u/.vscode/ext/assets/a.gz", unixAbs) === true, "POSIX 绝对路径 → 本地文件");
must(isFileLike("file:///home/u/a.gz", unixAbs) === true, "file:///home → 本地文件");
must(isFileLike("relative/path.gz", unixAbs) === false, "相对路径不当作文件（保持旧行为）");

// ---- 真正的 URL 不能被误判成文件 ----
for (const u of ["http://127.0.0.1:8083/a.gz", "https://example.com/a", "data:text/plain,x", "blob:null/abc", "vscode-file://vscode-app/x"]) {
  must(isFileLike(u, winAbs) === false, `URL 不算文件: ${u}`);
}

// ---- 协议识别：单字母盘符不是协议 ----
must(isScheme("http:") === true && isScheme("file:") === true, "识别 http:/file: 协议");
must(isScheme("d:\\x") === false, "d:\\x 不是协议（这是旧正则的 bug）");
must(isScheme("d:/x") === false, "d:/x 不是协议");

console.log(pass ? "\n全部通过" : "\n存在失败项");
if (!pass) process.exit(1);
