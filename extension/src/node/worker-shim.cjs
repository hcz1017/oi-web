// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Node 端的 Web Worker 垫片 —— 让**同一份** IIFE worker 打包产物能在桌面版跑起来。
//
// 为什么需要：我们的 worker（runWorker/compileWorker/debugWorker）是按"经典 Web Worker"
// 写的：用 self.postMessage 通信、self.onmessage 收消息、fetch 读资产、importScripts 载脚本。
// Node 的 worker_threads 没有这些全局，所以这里补齐，最小化差异：
//   self / postMessage / onmessage / addEventListener / removeEventListener
//   fetch：支持 file:// 与普通文件路径（Node 原生 fetch 不认 file:）
//   importScripts：按路径读取并 eval（dwarf 引擎的浏览器版会用到）
//
// ⚠️ Node 里 SharedArrayBuffer / Atomics 天生可用（不需要跨源隔离），
//    所以交互 stdin 与断点暂停（Atomics.wait）在桌面版反而是"完整功能"。
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL, fileURLToPath } = require("node:url");
const vm = require("node:vm");

// ---------------- Web Worker 全局垫片 ----------------
globalThis.self = globalThis;
globalThis.location = { href: pathToFileURL(__filename).href, origin: "file://" };
globalThis.postMessage = (m, transfer) => parentPort.postMessage(m, transfer);
globalThis.close = () => process.exit(0);
globalThis.addEventListener = (type, cb) => {
  if (type === "error") process.on("uncaughtException", (e) => cb({ message: e && e.message, error: e }));
  if (type === "unhandledrejection") process.on("unhandledRejection", (r) => cb({ reason: r }));
};
globalThis.removeEventListener = () => {};
parentPort.on("message", (data) => { try { globalThis.onmessage && globalThis.onmessage({ data }); } catch (e) { console.error("worker onmessage 异常", e); } });

// ---------------- fetch：补 file:// 与普通路径 ----------------
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const s = String(input && input.url ? input.url : input);
  const isFile = /^file:/i.test(s) || (!/^[a-z]+:/i.test(s) && path.isAbsolute(s));
  if (!isFile) return realFetch(input, init);
  const file = /^file:/i.test(s) ? fileURLToPath(s) : s;
  if (!fs.existsSync(file)) return new Response(null, { status: 404, statusText: "not found (file)" });
  const buf = fs.readFileSync(file);
  return new Response(buf, { status: 200, headers: { "content-type": "application/octet-stream" } });
};

// ---------------- importScripts：读文件后 eval 到全局 ----------------
globalThis.importScripts = (...urls) => {
  for (const u of urls) {
    const s = String(u);
    const file = /^file:/i.test(s) ? fileURLToPath(s) : (/^[a-z]+:/i.test(s) ? null : s);
    if (!file) throw new Error(`importScripts 只支持文件路径: ${s}`);
    const code = fs.readFileSync(file, "utf8");
    vm.runInThisContext(code, { filename: file });
  }
};

// ---------------- 加载业务 worker 代码 ----------------
try {
  require(path.resolve(workerData.bundle));
} catch (e) {
  console.error("[worker-shim] 加载 worker 失败:", (e && (e.stack || e.message)) || e);
  parentPort.postMessage({ type: "error", message: "worker 加载失败: " + ((e && e.message) || e) });
}
