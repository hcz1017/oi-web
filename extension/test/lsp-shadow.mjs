// 回归：lsp.js 里**不能**再声明局部的 fatal/let，否则会遮蔽模块级"clangd 已停用"标志。
// 背景：startOnce() 顶部有 `if (fatal) throw ...`（模块级 let fatal），如果函数体里
// 又写 `const fatal = ...`，那句 if 就变成访问 TDZ 里的局部变量 →
// ReferenceError: Cannot access 'fatal' before initialization → clangd 完全起不来，
// 而报错信息只有一句 "Cannot access 'R' before initialization"（打包后被压缩成单字母），
// 极难定位。这条测试用静态检查钉住这个坑。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(HERE, "..", "src", "web", "lsp.js"), "utf8");

let pass = true;
const must = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) pass = false; };

const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

must(/^let fatal = false;/m.test(code), "lsp.js 仍有模块级 `let fatal`（clangd 停用标志）");
must(!/\b(const|let|var)\s+fatal\b/.test(code.replace(/^let fatal = false;/m, "")),
  "没有局部 `fatal` 声明（否则 if (fatal) 变成 TDZ 访问）");
must(/notifyFatal/.test(code), "worker 致命错误回调改名为 notifyFatal");

// clangd.worker.js 里从来没有 cfg 这个变量（配置是 start() 的解构参数）——
// 写 `cfg.jobs` 会在启动时抛 ReferenceError: cfg is not defined（clangd 直接起不来）。
{
  const workerSrc = readFileSync(path.join(HERE, "..", "src", "web", "clangd.worker.js"), "utf8");
  const workerCode = workerSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  must(/jobs: cfg\.jobs \?\? 2/.test(workerCode), "boot() 把 cfg.jobs 传给 start()（否则 oiCpp.clangdJobs 不生效）");
  must(/async function start\(\{[^}]*jobs = 2/.test(workerCode), "start() 解构出 jobs（oiCpp.clangdJobs）");
  must(/-j=\$\{Math\.max\(1, Math\.min\(8, Number\(jobs\)/.test(workerCode), "clangd -j 使用 jobs 参数");
}

console.log(pass ? "\n全部通过" : "\n存在失败项");
if (!pass) process.exit(1);
