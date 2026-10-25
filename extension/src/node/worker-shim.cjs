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
// browser 模式：进一步伪装成"浏览器 worker 里的 clangd"，让 emscripten 的
// -sENVIRONMENT=web,worker 产物以为自己在合规环境里（详见下方注释）
if (workerData && workerData.browserEmulation) {
  // ⚠️ 1) glue 的 Node 拒绝逻辑在 fetch 到 glue 文本时用文本替换掉（见下面 fetch 里的 patchGlue）。
  // ⚠️ 2) ENVIRONMENT_IS_WORKER = !!globalThis.WorkerGlobalScope
  globalThis.WorkerGlobalScope = globalThis.WorkerGlobalScope || class WorkerGlobalScope {};
  // ⚠️ 3) 我们的 clangd.worker.js 会检查跨源隔离；Node 里 SAB 本来就可用的
  globalThis.crossOriginIsolated = true;
}
globalThis.self = globalThis;
if (workerData && workerData.threadName) globalThis.name = workerData.threadName;
globalThis.location = { href: pathToFileURL(__filename).href, origin: "file://" };
globalThis.postMessage = (m, transfer) => parentPort.postMessage(m, transfer);
globalThis.close = () => process.exit(0);
// ⚠️ 不能是空函数：emscripten 的 pthread 运行时用
//    `self.addEventListener("message", handler)` 挂主线程消息处理器。
//    以前这里是空的 → pthread 发回主线程的工作项全被丢掉 → clangd 卡住不回包。
const shimMsgListeners = [];
globalThis.addEventListener = (type, cb) => {
  if (typeof cb !== "function") return;
  if (type === "message") shimMsgListeners.push(cb);
  if (type === "error") process.on("uncaughtException", (e) => cb({ message: e && e.message, error: e }));
  if (type === "unhandledrejection") process.on("unhandledRejection", (r) => cb({ reason: r }));
};
globalThis.removeEventListener = (type, cb) => {
  const i = shimMsgListeners.indexOf(cb);
  if (i >= 0) shimMsgListeners.splice(i, 1);
};
parentPort.on("message", (data) => {
  try { globalThis.onmessage && globalThis.onmessage({ data }); } catch (e) { console.error("worker onmessage 异常", e); }
  for (const cb of [...shimMsgListeners]) { try { cb({ data }); } catch (e) { console.error("message 监听器异常", e && e.message); } }
});

// ---------------- browser 模式下补 Worker / Blob URL ----------------
if (workerData && workerData.browserEmulation) {
  // emscripten 的 pthread 子线程 → worker_threads（名字带 em-pthread- 才会被识别为 pthread）
  globalThis.Worker = class BrowserLikeWorker {
    constructor(url, opts = {}) {
      const u = String(url && url.url ? url.url : url);
      const file = /^file:/i.test(u) ? fileURLToPath(u) : u;
      const child = new (require("node:worker_threads").Worker)(__filename, {
        workerData: { ...workerData, bundle: file, threadName: opts.name || "worker" },
      });
      this.workerID = -1;
      this._listeners = { message: [], error: [] };
      this.onmessage = null;
      child.on("message", (d) => {
        if (typeof this.onmessage === "function") { try { this.onmessage({ data: d }); } catch {} }
        for (const cb of this._listeners.message) { try { cb({ data: d }); } catch {} }
      });
      child.on("error", (e) => { for (const cb of this._listeners.error) { try { cb(e); } catch {} } });
      this._child = child;
    }
    addEventListener(t, cb) { (this._listeners[t] ||= []).push(cb); }
    removeEventListener(t, cb) { const a = this._listeners[t]; if (a) { const i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); } }
    postMessage(m, transfer) { this._child.postMessage(m, transfer); }
    terminate() { this._child.terminate(); }
  };
  // Node 的 Blob 读不出字节（异步），而我们的用法都是 new Blob([文本]) → 换成同步实现
  globalThis.Blob = class SyncBlob {
    constructor(parts = [], opts = {}) {
      this.type = opts.type || "";
      // ⚠️ 必须处理 ArrayBuffer / TypedArray：new Blob([arrayBuffer]) 在浏览器里正常，
      //    但如果这里退化成 String(p) 就变成 "[object ArrayBuffer]" → gunzip 失败
      const toBuf = (p) => {
        if (Buffer.isBuffer(p)) return p;
        if (p instanceof ArrayBuffer) return Buffer.from(p);
        if (ArrayBuffer.isView(p)) return Buffer.from(p.buffer, p.byteOffset, p.byteLength);
        if (p && p._bytes) return p._bytes;
        return Buffer.from(String(p));
      };
      this._bytes = Buffer.concat((parts || []).map(toBuf));
    }
    get size() { return this._bytes.length; }
    stream() {
      // 支持 new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"))
      // 用 node:stream 的 Readable→Web 流，比 Response(...).body 稳（后者在部分 Node 版本会和
      // webstreams 适配层打架，报一个毫无信息的 TypeError）
      const { Readable } = require("node:stream");
      return Readable.toWeb(Readable.from([this._bytes]));
    }
    async arrayBuffer() {
      const b = this._bytes;
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
    }
    async text() { return this._bytes.toString("utf8"); }
  };
  // Blob → 落盘成 .mjs，URL.createObjectURL 返回 file://（Node 的动态 import 支持）
  const blobDir = path.join(require("node:os").tmpdir(), "webcpp-blobs");
  fs.mkdirSync(blobDir, { recursive: true });
  let blobSeq = 0;
  const origCreate = URL.createObjectURL;
  URL.createObjectURL = (blobOrBuf) => {
    const bytes = blobOrBuf && blobOrBuf._bytes
      ? blobOrBuf._bytes
      : Buffer.isBuffer(blobOrBuf) ? blobOrBuf : Buffer.from(String(blobOrBuf));
    const f = path.join(blobDir, `blob-${process.pid}-${blobSeq++}.mjs`);
    fs.writeFileSync(f, bytes);
    return pathToFileURL(f).href;
  };
}

// ---------------- fetch：补 file:// 与普通路径 ----------------
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const s = String(input && input.url ? input.url : input);
  const isFile = /^file:/i.test(s) || (!/^[a-z]+:/i.test(s) && path.isAbsolute(s));
  if (!isFile) return realFetch(input, init);
  const file = /^file:/i.test(s) ? fileURLToPath(s) : s;
  if (!fs.existsSync(file)) return new Response(null, { status: 404, statusText: "not found (file)" });
  let buf = fs.readFileSync(file);
  // ⚠️ 关键：glue 是 -sENVIRONMENT=web,worker 构建，里面有
  //   `typeof process!=="undefined"&&process.versions?.node ? … : TARGET_NOT_SUPPORTED`
  //   检测到 node 就直接 throw "not compiled for this environment"。
  //   不能全局删 process.versions.node（Node 的 undici/fetch 会炸），所以在文本层面改。
  if (workerData && workerData.browserEmulation && /clangd\.js$/.test(file)) {
    const t0 = buf.toString("utf8");
    const patched = t0
      // 关掉 node 环境判定（否则 emscripten 断言 "node environment detected but not enabled at build time"）
      .replace(/ENVIRONMENT_IS_NODE=globalThis\.process\?\.versions\?\.node&&globalThis\.process\?\.type!="renderer"/g, "ENVIRONMENT_IS_NODE=false")
      // 关掉"检测到 node 版本就 throw"的那段
      .replace(/typeof process!=="undefined"&&process\.versions\?\.node/g, "false");
    if (patched !== t0) console.log("[shim] 已改写 glue 的 node 环境检测");
    buf = Buffer.from(patched);
  }
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
