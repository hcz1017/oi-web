// Node 侧的"浏览器 worker"外壳：让 dist/web/debugWorker.js（IIFE）能在 worker_threads 里跑。
// 只做最少的 Web Worker API 映射，用来在 Node 里验证调试暂停协议（真实浏览器行为一致）。
const { parentPort, workerData } = require("worker_threads");

globalThis.self = globalThis;
self.postMessage = (m, transfer) => parentPort.postMessage(m, transfer);
// 最小 EventTarget 兼容（浏览器 worker 有 addEventListener；Node 里没有）
const listeners = new Map();
self.addEventListener = (type, cb) => { listeners.set(type, cb); };
self.removeEventListener = (type) => { listeners.delete(type); };
self.dispatchEvent = (ev) => { const cb = listeners.get(ev && ev.type); if (cb) cb(ev); };
process.on("uncaughtException", (e) => {
  const cb = listeners.get("error");
  if (cb) cb({ type: "error", message: String((e && (e.stack || e.message)) || e) });
  else parentPort.postMessage({ type: "error", message: "uncaught: " + String((e && (e.stack || e.message)) || e) });
});
process.on("unhandledRejection", (reason) => {
  const cb = listeners.get("unhandledrejection");
  if (cb) cb({ type: "unhandledrejection", reason });
  else parentPort.postMessage({ type: "error", message: "unhandledRejection: " + String(reason) });
});
self.close = () => { try { parentPort.close(); } catch {} process.exit(0); };

require(workerData.bundlePath);

parentPort.on("message", (data) => {
  try {
    if (typeof self.onmessage === "function") self.onmessage({ data });
  } catch (e) {
    parentPort.postMessage({ type: "error", message: "wrapper: " + String((e && (e.stack || e.message)) || e) });
  }
});
