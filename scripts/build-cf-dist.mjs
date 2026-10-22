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
const EXT = path.join(ROOT, "extension");
const TEMPLATE = path.join(ROOT, "web/index.template.html");
const SW = path.join(ROOT, "web/coi-serviceworker.js");
for (const p of [W, EXT, TEMPLATE, SW]) if (!existsSync(p)) throw new Error("缺少输入: " + p);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(path.join(OUT, "static"), { recursive: true });

// ---------- 1) vscode-web 本体 ----------
console.log("[1/4] 复制 vscode-web …");
cpSync(W, path.join(OUT, "static/build"), { recursive: true });

// ⚠️ 踩坑：CF Pages / wrangler 上传静态资产时会**跳过 node_modules 目录**，
//    而 vscode-web 的 tas-client / vscode-oniguruma / vscode-textmate 都在里面，
//    线上 404 会被 SPA 兜底成 index.html（MIME text/html）→ 代码高亮整体失效。
// → 打包时改名为 vendor，并把产物 JS 里的引用一并重写
const nmSrc = path.join(OUT, "static/build/node_modules");
const nmDst = path.join(OUT, "static/build/vendor");
if (existsSync(nmSrc)) {
  cpSync(nmSrc, nmDst, { recursive: true });
  rmSync(nmSrc, { recursive: true, force: true });
  const outDir = path.join(OUT, "static/build/out");
  const rewrite = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = path.join(dir, f);
      if (statSync(p).isDirectory()) { rewrite(p); continue; }
      if (!f.endsWith(".js")) continue;
      const text = readFileSync(p, "utf8");
      if (text.includes("node_modules")) {
        writeFileSync(p, text.split("node_modules").join("vendor"));
        console.log("    重写引用: " + path.relative(OUT, p));
      }
    }
  };
  rewrite(outDir);

  // vscode-web 的 pickFolder() 把 showDirectoryPicker 的异常整个吞掉，
  // 只在上一层抛 "Can't open folders..."，看不出真实原因 → 这里改成把原始异常打到控制台
  const pickFile = path.join(OUT, "static/build/out/vs/workbench/workbench.web.main.internal.js");
  let pickText = readFileSync(pickFile, "utf8");
  const swallow = "registerDirectoryHandle(r)}}catch{}return i?[i]:void 0}";
  if (pickText.includes(swallow)) {
    pickText = pickText.replace(
      swallow,
      'registerDirectoryHandle(r)}}catch(e){console.error("[oi pickFolder]",e&&e.name,e&&e.message||e)}return i?[i]:void 0}',
    );
    writeFileSync(pickFile, pickText);
    console.log("    pickFolder 错误透传 ✓");
  }

  // 让 vscode-web 自带的「打开文件夹」按钮/菜单可用：把硬编码 throw 换成
  // 调用扩展注册的 globalThis.__oiOpenFolder（File System Access API 流程）
  try {
    execFileSync("node", [path.join(ROOT, "scripts/patch-open-folder.mjs"), pickFile], { stdio: "inherit" });
  } catch (e) {
    console.warn("⚠ 自带打开文件夹补丁失败：" + (e && e.message));
  }
}

// ---------- 2) 扩展（只带运行所需） ----------
console.log("[2/4] 复制扩展 …");
const extOut = path.join(OUT, "static/devextensions");
for (const item of ["package.json", "package.nls.json", "LICENSE", "README.md", "dist", "assets", "notices"]) {
  const src = path.join(EXT, item);
  if (existsSync(src)) cpSync(src, path.join(extOut, item), { recursive: true });
}

// ---------- 2.5) 文件名保持原样（不做内容哈希） ----------
// 曾经给 extension/各 worker 做过内容哈希，目的是绕 CF 的 4h 缓存。实测代价大于收益：
//   - 只要 worker 内容变了而宿主代码没变，两次构建的 extension 文件名可能一样、内容不同，
//     缓存里那份旧 bundle 就会去加载已不存在的旧 worker 名（importScripts failed to load）；
//   - 部署后旧哈希文件全部 404，出问题难排查。
// 现在统一用固定文件名，靠 _headers 里的 Cache-Control: no-cache 强制每次校验。
// ⚠️ 改这里之前先确认 _headers 里 /static/devextensions/dist/web/* 仍是 no-cache。

// ---------- 3) index.html（地址运行时修正 + SW 兜底） ----------
console.log("[3/4] 生成 index.html …");
let html = readFileSync(TEMPLATE, "utf8");
// 1) 先把 host:port 从 "scheme://host:port" 里去掉 → 变成根相对路径 /static/...
//    （注意不能替换成 "/"：原来 8099 后面已经跟着 /static，会拼出 //static 变成跨域主机）
html = html.replaceAll("http://127.0.0.1:8099", "");
// 2) meta 里的 authority 字段（含 HTML 转义后的形态）留给运行时脚本用当前 origin 重写
html = html.replaceAll('"authority":"127.0.0.1:8099"', '"authority":"__HOST__"');
html = html.replaceAll("127.0.0.1:8099", "__HOST__");

// 3) 页面最前面挂 SW 兜底（自身检测 crossOriginIsolated，最多刷 3 次）
html = html.replace("<head>", '<head>\n\t\t<script src="/coi-serviceworker.js"></script>');

// 4) workbench 启动前：把配置里的扩展 URI 重写成当前 origin，根相对路径补全为绝对地址
const FIX = `<script>
(function () {
  var origin = location.origin;
  var proto = location.protocol.replace(/:$/, "");
  var host = location.host;
  var m = document.getElementById("vscode-workbench-web-configuration");
  if (!m) return;
  var raw = (m.getAttribute("data-settings") || "").split("__HOST__").join(host);
  try {
    var cfg = JSON.parse(raw);
    // 扩展位置：scheme/authority 用当前页面
    function fixExt(e) {
      if (!e) return;
      e.scheme = proto;
      e.authority = host;
    }
    if (cfg.developmentOptions && cfg.developmentOptions.extensions) cfg.developmentOptions.extensions.forEach(fixExt);
    if (cfg.additionalBuiltinExtensions) { cfg.additionalBuiltinExtensions = []; }
    if (cfg.workspaceUri) delete cfg.workspaceUri;
    // endpoint 模板：根相对路径补成绝对
    var pc = cfg.productConfiguration || {};
    Object.keys(pc).forEach(function (k) {
      if (typeof pc[k] === "string" && pc[k].charAt(0) === "/") pc[k] = origin + pc[k];
    });
    // ⚠️ setAttribute 存的是字面量：不能把 " 转义成 &quot;（HTML 解析期的转义在
    //    getAttribute 时会被解码，但 JS 写入的不会被解码）→ 否则 workbench 启动时
    //    JSON.parse 直接报 "Expected property name or '}'"
    m.setAttribute("data-settings", JSON.stringify(cfg));
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

# 扩展本体必须每次校验：否则 CF 缓存旧 bundle，而 manifest 是新的，
# 会出现"命令面板里有命令、点了却说 command not found"
/static/devextensions/*
  Cache-Control: no-cache

/static/devextensions/dist/*
  Cache-Control: no-cache

/static/devextensions/dist/web/*
  Cache-Control: no-cache

# ⚠️ assets 不设长缓存：文件名固定（无内容哈希），max-age=86400 会让改过的
# dwarf 引擎 worker.js / 各 wasm 在部署后一天内仍是旧的（"改了没生效"）。
# no-cache 只是每次带 ETag 回来校验，命中 304 时几乎不耗流量。
/static/devextensions/assets/*
  Cache-Control: no-cache

/index.html
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
  // ⚠️ 必须先删旧的：`zip -q` 是"更新模式"，会保留 zip 里已删除/已改名的旧条目，
  //    导致 zip 里同时存在 dwarfWorker.js / dwarfWorker.deae5d7ddb.js / dwarfWorker.<新>.js
  //    三份，体积膨胀且极易误传旧文件。
  zipPath = path.join(ROOT, "oi-web-cf.zip");
  rmSync(zipPath, { force: true });
  execFileSync("zip", ["-qr", zipPath, "."], { cwd: OUT });
} catch (e) {
  console.warn("⚠ 未生成 zip（缺少 zip 命令？）：" + e.message);
  zipPath = null;
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
