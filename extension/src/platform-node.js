// SPDX-License-Identifier: AGPL-3.0-or-later
// 平台适配：**桌面版（Node 扩展宿主）**。
//
// 与浏览器版的差别只有三件事：
//   1. worker 用 node:worker_threads，脚本是我们的 IIFE 打包产物 → 需要一个垫片
//      （src/node/worker-shim.cjs）把 worker_threads 伪装成 Web Worker 的 self/postMessage，
//      并给 worker 内的 fetch 补上 file:// 支持（Node 的 fetch 不认 file:）；
//   2. 资源用**文件路径**而不是 URL（但 worker 里仍然用 fetch 读，由垫片转换）；
//   3. 没有 File System Access API（那是浏览器专属）。
//
// ⚠️ 为什么桌面版反而"功能更全"：Node 里 SharedArrayBuffer/Atomics 天生可用，
//    不需要跨源隔离，所以交互 stdin 与断点暂停（Atomics.wait）都能正常工作。
import * as vscode from "vscode";
import path from "node:path";
import { Worker as NodeWorker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { wrapNodeWorker } from "./node/wrap-worker.js";

export const isWeb = false;
export const label = "desktop(node)";

let extRoot = "";   // dist/node/extension.js 所在扩展根目录
export function setExtensionRoot(p) { extRoot = p; }

/** 打包产物路径：dist/node/workers/<name> */
export function workerRef(name) { return path.join(extRoot, "dist", "node", "workers", name); }

/** 资产根（文件路径）。worker 内用 fetch(assetsBase + "/dwarf/...")，由垫片转 file:// */
export function assetsBase() { return path.join(extRoot, "assets"); }

const shimPath = () => path.join(extRoot, "dist", "node", "worker-shim.cjs");

/**
 * 创建 worker。
 * @param {string} name  dist/node/workers/ 下的文件名，例如 debugWorker.js
 * @param {{log?:Function, shim?:boolean}} [opts] shim=false 时直接跑该脚本（用于纯 Node 的引擎 worker）
 */
export function createNamedWorker(name, opts = {}) {
  const log = opts.log || (() => {});
  const bundle = workerRef(name);
  const useShim = opts.shim !== false;
  const file = useShim ? shimPath() : bundle;
  if (opts.extraWorkerData && !useShim) {
    // 纯 Node worker（例如 DWARF 引擎）：需要额外 workerData
    return Promise.resolve(wrap(new NodeWorker(file, { workerData: opts.extraWorkerData }), log, name));
  }
  // clangd 需要"浏览器环境伪装"（emscripten 的 -sENVIRONMENT=web,worker 产物）
  const workerData = useShim
    ? { bundle, log: !!opts.verbose, browserEmulation: !!opts.browserEmulation, threadName: opts.browserEmulation ? "main-shim" : undefined }
    : {};
  return Promise.resolve(wrap(new NodeWorker(file, { workerData }), log, name));
}

function wrap(w, log, name) { return wrapNodeWorker(w, { log, name }); }

// ---------------- DWARF 引擎（Node 版） ----------------
// 上游 node 引擎是 emscripten 的 node 构建：它用 fs 读同目录下的 SymbolsBackend.wasm。
// 我们把引擎 + launcher + 解压出来的 wasm 放到一个临时目录里跑（只做一次）。
let dwarfLauncher = null;
export async function ensureDwarfEngine() {
  if (dwarfLauncher) return dwarfLauncher;
  const os = await import("node:os");
  const fs = await import("node:fs");
  const dir = path.join(os.tmpdir(), "webcpp-wdb-dwarf-0.1");
  fs.mkdirSync(dir, { recursive: true });
  const launcher = path.join(dir, "launch.cjs");
  const wasm = path.join(dir, "SymbolsBackend.wasm");
  const gz = path.join(extRoot, "assets", "dwarf", "SymbolsBackend.wasm.gz");
  const bundled = path.join(extRoot, "dist", "node", "workers", "dwarfEngine.node.cjs");
  // ⚠️ 上游 node 引擎是用**自己所在目录**找 SymbolsBackend.wasm 的，
  //    所以必须把引擎也拷进这个临时目录（只改 fs 相对路径不够，它用的是 import.meta.url/__dirname）。
  const engineSrc = path.join(dir, "dwarfEngine.node.cjs");
  if (!fs.existsSync(engineSrc) || fs.statSync(engineSrc).size !== (fs.existsSync(bundled) ? fs.statSync(bundled).size : -1)) {
    fs.copyFileSync(bundled, engineSrc);
  }
  if (!fs.existsSync(wasm) || fs.statSync(wasm).size < 1024) {
    // 12.7MB gz → 55.7MB wasm，只解一次
    const { gunzipSync } = await import("node:zlib");
    fs.writeFileSync(wasm, gunzipSync(fs.readFileSync(gz)));
  }
  if (!fs.existsSync(engineSrc)) throw new Error("缺少 dist/node/workers/dwarfEngine.node.cjs（构建时没拷进来？）");
  // ⚠️ worker 里不允许 process.chdir()（"not supported in workers"），
  //    所以改成劫持 fs 的相对路径解析：emscripten node 分支是 readFileSync("SymbolsBackend.wasm")
  fs.writeFileSync(launcher,
    `const fs = require("fs");\n` +
    `const path = require("path");\n` +
    `const DIR = __dirname;\n` +
    `const origSync = fs.readFileSync, origAsync = fs.readFile;\n` +
    `fs.readFileSync = function (p, ...rest) { if (typeof p === "string" && !path.isAbsolute(p)) p = path.join(DIR, p); return origSync.call(this, p, ...rest); };\n` +
    `fs.readFile = function (p, ...rest) { if (typeof p === "string" && !path.isAbsolute(p)) p = path.join(DIR, p); return origAsync.call(this, p, ...rest); };\n` +
    `require(${JSON.stringify(engineSrc)});\n`);
  dwarfLauncher = launcher;
  return launcher;
}

export async function createDwarfEngineWorker(opts = {}) {
  const launcher = await ensureDwarfEngine();
  return wrap(new NodeWorker(launcher), opts.log || (() => {}), "dwarfEngine");
}

/** 读扩展资产里的 .gz 文本（桌面版：直接读文件，不能用 fetch） */
export async function readAssetGzText(rel) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { gunzipSync } = await import("node:zlib");
  return gunzipSync(fs.readFileSync(path.join(assetsBase(), rel))).toString("utf8");
}

export const hasFsAccess = false;   // File System Access API 不存在
export const extensionPathToUri = (p) => vscode.Uri.file(p);
export { fileURLToPath };
