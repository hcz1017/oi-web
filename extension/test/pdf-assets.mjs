// PDF 资产的构建断言：EmbedPDF 运行时有没有真的打进去。
//
// 这些文件缺一个，用户看到的就是"白屏 / 批注存不进去 / 中文变方框"，
// 而单元测试和类型检查都发现不了 —— 所以直接查磁盘 + 查 HTML 模板。
import { existsSync, statSync, readdirSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, "..");
const PDF = path.join(EXT, "assets", "pdf");
const EMBED = path.join(PDF, "embedpdf");

let pass = true;
const must = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) pass = false; return c; };
const sizeOf = (p) => { try { return statSync(p).size; } catch { return -1; } };

console.log("检查目录:", PDF);
must(existsSync(PDF), "assets/pdf 目录存在（先跑 npm run bundle）");

// ---------- 引擎：PDFium（和 Chrome/Edge 同一个渲染引擎） ----------
must(sizeOf(path.join(EMBED, "pdfium.wasm")) > 2_000_000,
  `pdfium.wasm 存在且像样（${Math.round(sizeOf(path.join(EMBED, "pdfium.wasm")) / 1024)}KB）`);
must(sizeOf(path.join(EMBED, "embedpdf.js")) > 100, "embedpdf.js 入口存在");
const chunks = (() => { try { return readdirSync(EMBED).filter((f) => f.endsWith(".js")); } catch { return []; } })();
must(chunks.length >= 4, `运行时分片齐全（${chunks.length} 个 js：入口 + 引擎 + worker + 主包）`);
must(chunks.some((f) => /worker-engine/.test(f)), "有 pdfium worker 分片（PDFium 跑在 worker 里，不卡 UI）");
must(chunks.some((f) => /engine/.test(f) || /browser/.test(f)), "有引擎分片");
// 不许把 demo 文件一起塞进包里（白占体积）
must(!existsSync(path.join(EMBED, "demo.pdf")) && !existsSync(path.join(EMBED, "index.html")),
  "没有把 demo.pdf / index.html 打进资产");

// ---------- 我们的 webview 薄壳 ----------
for (const f of ["client.mjs", "client.css"]) {
  must(sizeOf(path.join(PDF, "app", f)) > 100, `app/${f} 已拷贝`);
}
{
  const client = readFileSync(path.join(PDF, "app", "client.mjs"), "utf8");
  must(/from "\.\/embedpdf\/embedpdf\.js"/.test(client), "client.mjs 引用 ./embedpdf/embedpdf.js（同目录相对路径）");
  must(/EmbedPDF\.init\(/.test(client), "client.mjs 调用 EmbedPDF.init 初始化");
  must(/wasmUrl/.test(client), "client.mjs 传了 wasmUrl（离线用打包的 pdfium.wasm）");
  must(/fontFallback:\s*null/.test(client), "关掉了默认的 CDN 字体回退（离线可用）");
  must(/savePdf/.test(client), "client.mjs 通过 savePdf 把字节交回宿主");
  must(/saveAsCopy|download/.test(client), "client.mjs 走 export 插件的导出能力取字节");
  must(/patchDownloadInterception/.test(client), "截获了 <a download>（webview 里真下载会被沙箱拦）");
}

// ---------- 宿主侧 HTML 模板：CSP / 资源 ----------
{
  const provider = readFileSync(path.join(EXT, "src", "web", "pdf", "provider.js"), "utf8");
  must(/wasm-unsafe-eval/.test(provider), "CSP 允许 wasm-unsafe-eval（缺了 PDFium 直接编译失败）");
  must(/worker-src blob:/.test(provider), "CSP 允许 blob worker");
  must(/asWebviewUri/.test(provider), "资源走 asWebviewUri（网页版/桌面版都能取）");
  must(/localResourceRoots/.test(provider), "设置了 localResourceRoots（否则 webview 取不到 assets）");
  must(/pdfium\.wasm/.test(provider), "HTML 注入了 pdfium.wasm 的 URL");
  must(/client\.mjs/.test(provider) && /client\.css/.test(provider), "HTML 引用了 app/client.mjs 与 client.css");
  must(/savePdf/.test(provider) && /writeFile/.test(provider), "宿主侧处理 savePdf 并写盘");
  must(/BACKUP_SUFFIX|\.bak/.test(provider), "写回前会备份原文件（网页版没有原子替换）");
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
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  must(!!deps["@embedpdf/snippet"], "构建依赖里有 @embedpdf/snippet");
  must(!deps["pdfjs-dist"] || /fixture/i.test(JSON.stringify(pkg.scripts || {})), "pdfjs-dist 只作为测试用途（引擎已换成 PDFium）");
}

console.log(pass ? "\n全部通过" : "\n存在失败项");
process.exit(pass ? 0 : 1);
