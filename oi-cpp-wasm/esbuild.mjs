import esbuild from "esbuild";
import { mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

// 用绝对路径，避免"从仓库根执行 node oi-cpp-wasm/esbuild.mjs"时产物写错地方
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "src", "web");
const OUT = path.join(HERE, "dist", "web");
mkdirSync(OUT, { recursive: true });

const common = {
  bundle: true,
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
  entryPoints: [path.join(SRC, "dwarf.worker.js")],
  outfile: path.join(OUT, "dwarfWorker.js"),
  format: "iife",
  minify: false,
});

// 6) 调试运行 worker：运行插桩后的 wasm（经典 worker）
await esbuild.build({
  ...common,
  entryPoints: [path.join(SRC, "debug.worker.js")],
  outfile: path.join(OUT, "debugWorker.js"),
  format: "iife",
  minify: false,
});

console.log("bundled: extension.js / compileWorker.js / runWorker.js / clangdWorker.js / dwarfWorker.js / debugWorker.js");
