import esbuild from "esbuild";
import { mkdirSync, cpSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

// 用绝对路径，避免"从仓库根执行 node oi-cpp-wasm/esbuild.mjs"时产物写错地方
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "src", "web");
// wdb 核心（独立仓库，默认与本仓库同级：<repo>/../wdb 或 <repo>/wdb）
const WDB = path.resolve(HERE, "..", "wdb", "src");
const OUT = path.join(HERE, "dist", "web");

// ⚠️ wdb 是 git submodule（调试器核心）。忘了初始化就构建时会报一堆 esbuild 解析错误，
//    这里提前给出人话提示，省得以为是仓库坏了。
if (!existsSync(path.join(WDB, "index.js"))) {
  console.error(
    "\n✗ 缺少 wdb 源码（调试器核心）。请在仓库根执行：\n" +
    "    git submodule update --init --recursive\n" +
    "  或克隆时用：\n" +
    "    git clone --recurse-submodules https://github.com/hcz1017/oi-web.git\n",
  );
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const webPlatform = path.join(HERE, "src", "platform-web.js");
const nodePlatform = path.join(HERE, "src", "platform-node.js");

const common = {
  bundle: true,
  resolveExtensions: [".mjs", ".js"],
  nodePaths: [path.join(HERE, "node_modules")],
  platform: "browser",
  target: ["es2022"],
  logLevel: "info",
  sourcemap: false,
};
// 只有扩展宿主入口需要 external vscode；三个 worker 不该出现裸 require("vscode")
const hostOnly = { external: ["vscode"] };

// 1) 扩展宿主侧入口（VS Code web 扩展是 CJS + external vscode）
await esbuild.build({
  ...common,
  ...hostOnly,
  entryPoints: [path.join(SRC, "extension.js")],
  outfile: path.join(OUT, "extension.js"),
  format: "cjs",
  minify: true,
  alias: { "oi-platform": webPlatform },
});

// 1b) 桌面版宿主入口（Node 扩展宿主）：同一份源码，换平台实现
const OUT_NODE = path.join(HERE, "dist", "node");
mkdirSync(OUT_NODE, { recursive: true });
await esbuild.build({
  ...common,
  ...hostOnly,
  entryPoints: [path.join(SRC, "extension.js")],
  outfile: path.join(OUT_NODE, "extension.js"),
  format: "cjs",
  minify: true,
  platform: "node",
  alias: { "oi-platform": nodePlatform },
  external: ["vscode", "vscode-languageclient/browser", "node:worker_threads", "node:fs", "node:path", "node:url", "node:os"],
});

// 2) 编译 worker：经典 worker（IIFE）。
//    drop console：browser_wasi_shim 会把每一次文件查找都 console.log（"wasi: include/..."），
//    编译时能刷爆控制台。
await esbuild.build({
  ...common,
  entryPoints: [path.join(SRC, "compileWorker.js")],
  outfile: path.join(OUT, "compileWorker.js"),
  format: "iife",
  minify: false,
  drop: ["console"],
});

// 3) 运行 worker：经典 worker（IIFE）
await esbuild.build({
  ...common,
  entryPoints: [path.join(SRC, "runWorker.js")],
  outfile: path.join(OUT, "runWorker.js"),
  format: "iife",
  minify: false,
  drop: ["console"],
});

// 4) clangd 桥 worker：经典 worker（IIFE）。
//    注意 glue（clangd.js）是 ESM 且要用 import.meta.url 建 pthread 线程池 ——
//    所以这里【不能静态 import】glue，而是运行时动态 import 它的原始 URL（见源码），
//    这样线程池 worker 加载的是 assets/clangd/clangd.js 这个真正的 ESM 文件。
await esbuild.build({
  ...common,
  entryPoints: [path.join(SRC, "clangd.worker.js")],
  outfile: path.join(OUT, "clangdWorker.js"),
  format: "iife",
  minify: false,
});

// 5) DWARF 符号引擎宿主 worker：经典 worker（IIFE）。
//    它运行时 importScripts(assets/dwarf/worker.js)（上游引擎 + 浏览器 shim），
//    所以这里只打包我们自己的引导逻辑。
await esbuild.build({
  ...common,
  entryPoints: [path.join(WDB, "symbols/dwarf.worker.js")],
  outfile: path.join(OUT, "dwarfWorker.js"),
  format: "iife",
  minify: false,
});

// 6) 调试运行 worker：运行插桩后的 wasm（经典 worker）
await esbuild.build({
  ...common,
  entryPoints: [path.join(WDB, "runtime/debug.worker.js")],
  outfile: path.join(OUT, "debugWorker.js"),
  format: "iife",
  minify: false,
});

// 7) 把 wdb 的 DWARF 引擎资产拷进扩展（运行时按 assets/dwarf/... 取）
//    资产的真身在 wdb 仓库里，这里是构建期同步，避免两处各存一份 12MB。
const wdbDwarf = path.resolve(HERE, "..", "wdb", "assets", "dwarf");
if (existsSync(wdbDwarf)) {
  cpSync(wdbDwarf, path.join(HERE, "assets", "dwarf"), { recursive: true });
  console.log("copied: wdb/assets/dwarf → assets/dwarf");
} else {
  console.warn("⚠ 未找到 wdb/assets/dwarf（wdb 仓库不在预期位置？DWARF 引擎缺失，调试会失败）");
}

// 8) 桌面版资源：同一份 IIFE worker 产物 + worker_threads 垫片 + 上游 node 版 DWARF 引擎
const nodeWorkers = path.join(OUT_NODE, "workers");
mkdirSync(nodeWorkers, { recursive: true });
for (const name of ["runWorker.js", "compileWorker.js", "debugWorker.js"]) {
  const src = path.join(OUT, name);
  if (existsSync(src)) cpSync(src, path.join(nodeWorkers, name));
}
cpSync(path.join(HERE, "src", "node", "worker-shim.cjs"), path.join(OUT_NODE, "worker-shim.cjs"));
{
  const engine = path.resolve(HERE, "..", "wdb", "assets", "dwarf", "worker.node.cjs");
  if (existsSync(engine)) cpSync(engine, path.join(nodeWorkers, "dwarfEngine.node.cjs"));
  else console.warn("⚠ 缺少 wdb/assets/dwarf/worker.node.cjs（桌面版调试不可用；先跑 wdb 的 build:dwarf）");
}
console.log("copied: dist/node/workers/{runWorker,compileWorker,debugWorker}.js + 垫片 + node 引擎");

console.log("bundled: extension.js / compileWorker.js / runWorker.js / clangdWorker.js / dwarfWorker.js / debugWorker.js");
