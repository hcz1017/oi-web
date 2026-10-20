// 生成可上传到 Cloudflare Pages 的静态包（dist-cf/ + zip）
//
// 内容：
//   index.html                 vscode-web 启动页（地址运行时按 location.origin 修正）
//   coi-serviceworker.js       COOP/COEP 客户端兜底（托管不支持响应头时也能跨源隔离）
//   _headers                   CF Pages 响应头配置（首选方案）
//   static/build/              vscode-web 本体（含中文 nls.messages.js）
//   static/devextensions/      我们的扩展（dist/web + assets）
//   README-deploy.md           部署说明
//
// 用法：node scripts/build-cf-dist.mjs
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "dist-cf");
const CACHE_BASE = path.join(ROOT, ".vscode-test-web");
const dirs = readdirSync(CACHE_BASE).filter((d) => d.startsWith("vscode-web-stable"));
if (!dirs.length) throw new Error("缺少 .vscode-test-web/vscode-web-stable-*");
const W = path.join(CACHE_BASE, dirs.sort().pop());
const EXT = path.join(ROOT, "oi-cpp-wasm");
const TEMPLATE = path.join(ROOT, ".dev-web/index.raw.html");
const SW = path.join(ROOT, "web-extras/coi-serviceworker.js");
for (const p of [W, EXT, TEMPLATE, SW]) if (!existsSync(p)) throw new Error("缺少输入: " + p);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(path.join(OUT, "static"), { recursive: true });

// ---------- 1) vscode-web 本体 ----------
console.log("[1/4] 复制 vscode-web …");
cpSync(W, path.join(OUT, "static/build"), { recursive: true });

// ---------- 2) 扩展（只带运行所需） ----------
console.log("[2/4] 复制扩展 …");
const extOut = path.join(OUT, "static/devextensions");
for (const item of ["package.json", "package.nls.json", "LICENSE", "README.md", "dist", "assets", "notices"]) {
  const src = path.join(EXT, item);
  if (existsSync(src)) cpSync(src, path.join(extOut, item), { recursive: true });
}

// ---------- 3) index.html（地址运行时修正 + SW 兜底） ----------
console.log("[3/4] 生成 index.html …");
let html = readFileSync(TEMPLATE, "utf8");
// 脚本/模块引用改成站内绝对路径，避免绑定构建时的 host:port
html = html.replaceAll('src="http://127.0.0.1:8099', 'src="/');
html = html.replaceAll("from 'http://127.0.0.1:8099", "from '/");
html = html.replaceAll('"authority":"127.0.0.1:8099"', '"authority":"__HOST__"');
html = html.replaceAll("http://127.0.0.1:8099", "__ORIGIN__");
// meta 属性里是 HTML 转义后的 &quot;，上面的模式匹配不到，这里兜底替换裸 host:port
html = html.replaceAll("127.0.0.1:8099", "__HOST__");

// 页面最前面挂 SW 兜底（自身会检测 crossOriginIsolated，最多刷 3 次）
html = html.replace("<head>", '<head>\n\t\t<script src="/coi-serviceworker.js"></script>');

// 配置里残留的 __ORIGIN__/__HOST__ 在 workbench 启动前替换掉；顺带移除语言包扩展条目
const FIX = `<script>
(function () {
  var origin = location.origin, host = location.host;
  var m = document.getElementById("vscode-workbench-web-configuration");
  if (!m) return;
  var raw = (m.getAttribute("data-settings") || "")
    .split("__ORIGIN__").join(origin)
    .split("__HOST__").join(host);
  try {
    var cfg = JSON.parse(raw);
    if (cfg.additionalBuiltinExtensions) cfg.additionalBuiltinExtensions = [];
    m.setAttribute("data-settings", JSON.stringify(cfg).replace(/"/g, "&quot;"));
  } catch (e) {
    m.setAttribute("data-settings", raw);
  }
})();
</script>`;
html = html.replace("</head>", FIX + "\n</head>");
writeFileSync(path.join(OUT, "index.html"), html);

cpSync(SW, path.join(OUT, "coi-serviceworker.js"));

// ---------- 4) _headers / 说明 / 打包 ----------
writeFileSync(path.join(OUT, "_headers"), `/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: cross-origin

/coi-serviceworker.js
  Service-Worker-Allowed: /
  Cache-Control: no-cache

/static/build/out/nls.messages.js
  Cache-Control: no-cache
`);

writeFileSync(path.join(OUT, "README-deploy.md"), `# 部署到 Cloudflare Pages

1. 打开 Cloudflare Dashboard → Workers & Pages → Create → Pages → Upload assets
2. 把本目录（或本目录的 zip）整体上传，部署即可
3. 打开分配的域名；首次加载若控制台出现 \`[oi] 已注册 Service Worker，刷新启用跨源隔离\`，是正常的（会自动刷新一次）

## 为什么需要 COOP/COEP

WASM 线程（clangd）与 SharedArrayBuffer 要求页面处于跨源隔离状态：

- 首选：本目录自带 \`_headers\`，CF Pages 会自动加上
  \`Cross-Origin-Opener-Policy: same-origin\` 与 \`Cross-Origin-Embedder-Policy: require-corp\`
- 兜底：\`coi-serviceworker.js\` 会在客户端注册 Service Worker 补上这两个响应头，
  最多自动刷新 3 次（适配 GitHub Pages 等不能配响应头的托管）

## 中文

\`static/build/out/nls.messages.js\` 已替换为中文（由 scripts/build-zh-nls.mjs 生成），
另有 \`nls.messages.zh-cn.js\` 作为客户端兜底。
`);

let zipPath = null;
try {
  // zip 放仓库根（不要放进 dist-cf，否则会被当成站点文件一起上传）
  execFileSync("zip", ["-qr", path.join(ROOT, "oi-web-cf.zip"), "."], { cwd: OUT });
  zipPath = path.join(ROOT, "oi-web-cf.zip");
} catch (e) {
  console.warn("⚠ 未生成 zip（缺少 zip 命令？）：" + e.message);
}

// 统计
function walk(dir) {
  let files = 0, bytes = 0, max = 0, maxFile = "";
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) { const r = walk(p); files += r.files; bytes += r.bytes; if (r.max > max) { max = r.max; maxFile = r.maxFile; } }
    else { files++; bytes += st.size; if (st.size > max) { max = st.size; maxFile = p; } }
  }
  return { files, bytes, max, maxFile };
}
const stat = walk(OUT);
console.log(`✓ 输出: ${OUT}`);
console.log(`  文件 ${stat.files} 个，${(stat.bytes / 1048576).toFixed(1)}MB（CF Pages 限制：单文件 ≤25MiB）`);
console.log(`  最大文件 ${(stat.max / 1048576).toFixed(1)}MB: ${path.relative(OUT, stat.maxFile)}`);
if (zipPath) console.log(`  zip: ${zipPath}（${(statSync(zipPath).size / 1048576).toFixed(1)}MB）`);
