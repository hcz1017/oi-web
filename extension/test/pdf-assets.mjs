// PDF 资产的构建断言：vendoring 有没有真的把东西复制全。
//
// 这些文件缺一个，用户看到的就是"能打开但白屏 / 中文显示成方块 / 图片丢失"，
// 而单元测试和类型检查都发现不了 —— 所以这里直接在磁盘上查。
import { existsSync, statSync, readdirSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, "..");
const PDF = path.join(EXT, "assets", "pdf");

let pass = true;
const must = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) pass = false; return c; };
const sizeOf = (p) => { try { return statSync(p).size; } catch { return -1; } };
const countOf = (dir, filter) => {
  try { return readdirSync(dir).filter((f) => !filter || filter.test(f)).length; } catch { return -1; }
};

console.log("检查目录:", PDF);
must(existsSync(PDF), "assets/pdf 目录存在（先跑 npm run bundle）");

// ---------- pdf.js 本体 ----------
const lib = path.join(PDF, "build", "pdf.min.mjs");
const worker = path.join(PDF, "build", "pdf.worker.min.mjs");
must(sizeOf(lib) > 200_000, `pdf.min.mjs 存在且像样（${Math.round(sizeOf(lib) / 1024)}KB）`);
must(sizeOf(worker) > 500_000, `pdf.worker.min.mjs 存在且像样（${Math.round(sizeOf(worker) / 1024)}KB）`);
{
  const code = existsSync(lib) ? readFileSync(lib, "utf8") : "";
  must(/getDocument/.test(code), "pdf.min.mjs 里能找到 getDocument");
  must(/export\s*\{/.test(code) && /(^|[,{}])getDocument([,}]|$)/.test(code.slice(code.lastIndexOf("export{"))), "pdf.min.mjs 是 ESM 并导出了 getDocument");
  must(/TextLayer/.test(code), "pdf.min.mjs 带 TextLayer（文本选择要用）");
  must(!existsSync(lib + ".map") && !existsSync(worker + ".map"), "没有把 .map 一起拷进来（白占体积）");
}

// ---------- 资源目录（缺了对应功能会退化） ----------
must(countOf(path.join(PDF, "cmaps"), /\.bcmap$/) >= 150, `cmaps 至少 150 个（实际 ${countOf(path.join(PDF, "cmaps"), /\.bcmap$/)})——中文 PDF 靠它`);
must(countOf(path.join(PDF, "standard_fonts")) >= 10, `standard_fonts 至少 10 个（实际 ${countOf(path.join(PDF, "standard_fonts"))}）`);
must(countOf(path.join(PDF, "wasm")) >= 5, `wasm 至少 5 个（实际 ${countOf(path.join(PDF, "wasm"))}）——JPEG2000/ICC 靠它`);
must(countOf(path.join(PDF, "iccs")) >= 1, "iccs 至少 1 个");

// ---------- 我们自己的 webview 端 ----------
for (const f of ["client.mjs", "client.css", "helpers.mjs", "annot.mjs", "ocr.mjs", "codicon.css", "codicon.ttf"]) {
  must(sizeOf(path.join(PDF, "app", f)) > 100, `app/${f} 已拷贝`);
}
{
  const client = readFileSync(path.join(PDF, "app", "client.mjs"), "utf8");
  must(/from "\.\/helpers\.mjs"/.test(client), "client.mjs 引用了 helpers.mjs（同目录，复制后能解析）");
  must(/from "\.\/annot\.mjs"/.test(client), "client.mjs 引用了 annot.mjs");
  must(/from "\.\/ocr\.mjs"/.test(client), "client.mjs 引用了 ocr.mjs（OCR 接口预留）");
  must(/getDocument/.test(client) && /TextLayer/.test(client), "client.mjs 用 pdf.js 渲染 + 文本层");
  // pdfjs v6 去掉了 getNumPages()：只写旧 API 会导致"打开就报错"，这里钉一下
  must(/state\.doc\.numPages/.test(client), "client.mjs 用了 numPages 属性（v6 兼容）");
  must(/updatePassword/.test(client), "client.mjs 处理加密 PDF 的密码回调");
  // OCR 预留：接口 + 按钮 + sidecar 字段三处都要在
  must(/available/.test(readFileSync(path.join(PDF, "app", "ocr.mjs"), "utf8")), "ocr.mjs 暴露 available 开关（预留接口）");
  must(/sidecar\.ocr|state\.ocr/.test(client), "client.mjs 把 OCR 结果带着一起存（预留）");
}

// ---------- 宿主侧 HTML 模板里的 CSP / 资源 ----------
{
  const provider = readFileSync(path.join(EXT, "src", "web", "pdf", "provider.js"), "utf8");
  must(/wasm-unsafe-eval/.test(provider), "CSP 允许 wasm-unsafe-eval（缺了 pdf.js 直接编译失败）");
  must(/worker-src blob:/.test(provider), "CSP 允许 blob worker");
  must(/asWebviewUri/.test(provider), "资源走 asWebviewUri（网页版/桌面版都能取）");
  must(/codicon\.css/.test(provider) && /codicon codicon-/.test(provider), "工具栏用 VS Code 官方 codicon 图标");
  must(/localResourceRoots/.test(provider), "设置了 localResourceRoots（否则 webview 取不到 assets）");
  must(/cmaps\//.test(provider) && /standard_fonts\//.test(provider) && /wasm\//.test(provider),
    "HTML 里把 cmaps/standard_fonts/wasm 的 URL 都注入了");
  must(/client\.mjs/.test(provider) && /client\.css/.test(provider), "HTML 引用了 app/client.mjs 与 client.css");
}

// ---------- package.json 贡献点 ----------
{
  const pkg = JSON.parse(readFileSync(path.join(EXT, "package.json"), "utf8"));
  const ce = (pkg.contributes && pkg.contributes.customEditors) || [];
  const pdf = ce.find((x) => x.viewType === "webcpp.pdf");
  must(!!pdf, "package.json 注册了 webcpp.pdf 自定义编辑器");
  must(!!pdf && pdf.selector.some((s) => s.filenamePattern === "*.pdf"), "选择器覆盖 *.pdf");
  must((pkg.activationEvents || []).includes("onCustomEditor:webcpp.pdf"), "激活事件包含 onCustomEditor");
  const cmd = ((pkg.contributes && pkg.contributes.commands) || []).find((c) => c.command === "oiCpp.openPdf");
  must(!!cmd, "有 oiCpp.openPdf 命令（被别的扩展抢默认时兜底）");
}

console.log(pass ? "\n全部通过" : "\n存在失败项");
process.exit(pass ? 0 : 1);
