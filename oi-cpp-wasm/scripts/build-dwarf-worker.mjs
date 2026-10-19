// 把上游 @vscode/dwarf-debugging 的 worker.js 改造成「经典 Worker 可直接 importScripts」的版本。
//
// 上游 worker.js 是 Node 的 CJS 打包（worker_threads + fs.readFile 读 SymbolsBackend.wasm）。
// 浏览器里没有 require / __filename，但 emscripten 的 Node 分支在浏览器里本来就不会执行
// （ENVIRONMENT_IS_NODE=false），所以只需要在上游代码最前面注入一层极小的 shim：
//   · require("url"/"path"/"worker_threads"/"fs"/"crypto"/"ws")
//   · parentPort → self.postMessage / self.onmessage
//   · fs.promises.readFile("/SymbolsBackend.wasm") → fetch 我们托管的 .wasm.gz
//
// 用法：node scripts/build-dwarf-worker.mjs
// 输入：.dev/dwarf-pkg/package/dist/{worker.js, SymbolsBackend.wasm}
// 输出：assets/dwarf/{worker.js, SymbolsBackend.wasm.gz, LICENSE}
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { gzipSync } from "zlib";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, "..");
const SRC = path.join(EXT, ".dev/dwarf-pkg/package");
const OUT = path.join(EXT, "assets/dwarf");

// 优先用原始（未 patch）文件：调试时可能会把 patch 结果覆盖到 worker.js
const origPath = path.join(SRC, "dist/worker.orig.js");
const workerPath = existsSync(origPath) ? origPath : path.join(SRC, "dist/worker.js");
const wasmPath = path.join(SRC, "dist/SymbolsBackend.wasm");
for (const p of [workerPath, wasmPath]) {
  if (!existsSync(p)) {
    console.error(`缺少输入文件: ${p}\n  先下载 npm 包: npm pack @vscode/dwarf-debugging@0.0.2 并解包到 .dev/dwarf-pkg/package`);
    process.exit(1);
  }
}
mkdirSync(OUT, { recursive: true });

let src = readFileSync(workerPath, "utf8");

// ---- 改动 1：import_meta_url 在浏览器里取 worker 自身 URL ----
const origMeta = `var import_url = require("url");\nvar import_meta_url = (0, import_url.pathToFileURL)(__filename);`;
if (!src.includes(origMeta)) throw new Error("未找到 import_meta_url 原始代码（上游版本变了？）");
src = src.replace(
  origMeta,
  `var import_meta_url = (typeof self !== "undefined" && self.location && self.location.href)
  ? new URL(self.location.href)
  : require("url").pathToFileURL(__filename);`,
);

// ---- 改动 2：浏览器环境 shim（在 Node 下整体跳过，因此同一份文件两边都能跑）----
const shim = `"use strict";
/* ===== oi-cpp-wasm: browser shim（Node 下自动跳过）=====
   经典 Worker 里没有 require/__filename；emscripten 的 Node 分支不会执行，
   这里只把上游真正会调用的几个 Node API 映射到浏览器能力。 */
if (typeof require === "undefined") {
  var __dirname = "/";
  var __filename = "/worker.js";
  var parentPortShim = {
    postMessage: (m) => self.postMessage(m),
    on: (ev, cb) => { self.onmessage = (e) => cb(e.data); },
  };
  var require = (name) => {
    if (name === "url") return {
      pathToFileURL: (p) => new URL(p, self.location.href),
      fileURLToPath: (u) => decodeURIComponent(String(u).split("file://").join("")),
    };
    if (name === "path") return {
      join: (...a) => a.join("/").replace(/\\/{2,}/g, "/"),
      dirname: (p) => p.replace(/\\/[^/]*$/, "") || "/",
      basename: (p) => p.replace(/^.*\\//, ""),
    };
    if (name === "worker_threads") return { parentPort: parentPortShim };
    if (name === "fs") return {
      promises: {
        readFile: async (p) => {
          // 上游只会读 SymbolsBackend.wasm：改成 fetch 我们托管的压缩资产
          const base = String(self.__oiDwarfBase || "").replace(/\\/+$/, "");
          const r = await fetch(base + "/dwarf/SymbolsBackend.wasm.gz");
          if (!r.ok) throw new Error("SymbolsBackend.wasm.gz: HTTP " + r.status);
          return new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
        },
      },
      readSync() { throw new Error("fs.readSync 在浏览器 worker 里不支持"); },
    };
    if (name === "crypto") return {
      randomUUID: () => (self.crypto && self.crypto.randomUUID
        ? self.crypto.randomUUID()
        : String(Math.random()).slice(2) + Date.now().toString(16)),
    };
    if (name === "ws") return {};
    throw new Error("browser worker 不支持 require(\\"" + name + "\\")");
  };
}
/* ===== shim 结束 ===== */
`;
src = shim + src;

writeFileSync(path.join(OUT, "worker.js"), src);

// ---- 资产：SymbolsBackend.wasm 压缩（56MB → 约十几 MB）----
const wasm = readFileSync(wasmPath);
const gz = gzipSync(wasm, { level: 9 });
writeFileSync(path.join(OUT, "SymbolsBackend.wasm.gz"), gz);
writeFileSync(path.join(OUT, "LICENSE"), readFileSync(path.join(SRC, "LICENSE")));
// .d.ts 文件目录是上游导出类型的相对路径，运行时不依赖（worker.js 已打包全部逻辑）

console.log(`✓ assets/dwarf/worker.js               ${(src.length / 1024).toFixed(0)}KB`);
console.log(`✓ assets/dwarf/SymbolsBackend.wasm.gz  ${(wasm.length / 1048576).toFixed(1)}MB → ${(gz.length / 1048576).toFixed(1)}MB`);
console.log("✓ assets/dwarf/LICENSE                 (MIT, Microsoft / Chrome DevTools)");
