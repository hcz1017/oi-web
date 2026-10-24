// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 把 node:worker_threads 的 Worker 包成 **Web Worker 风格**的接口。
//
// ⚠️ 必须同时支持两种订阅方式，我们的代码两种都在用：
//     w.onmessage = fn      （属性赋值，extension.js / adapter.js 都用这种）
//     w.addEventListener("message", fn)
// 第一版只实现了 addEventListener，结果桌面版 worker 的消息**永远收不到** →
// 工具链一直等不到 ready → 报"工具链加载超时"。
export function wrapNodeWorker(w, { log = () => {}, name = "worker" } = {}) {
  const listeners = { message: [], error: [] };
  const api = {
    onmessage: null,
    onerror: null,
    addEventListener(type, cb) { (listeners[type] ||= []).push(cb); },
    removeEventListener(type, cb) {
      const arr = listeners[type];
      if (arr) { const i = arr.indexOf(cb); if (i >= 0) arr.splice(i, 1); }
    },
    postMessage(m, transfer) {
      try { w.postMessage(m, transfer || undefined); } catch (e) { log(`[${name}] postMessage 失败: ${e && e.message}`); }
    },
    terminate() { try { w.terminate(); } catch {} },
    _nodeWorker: w,
  };

  w.on("message", (data) => {
    if (typeof api.onmessage === "function") {
      try { api.onmessage({ data }); } catch (e) { log(`[${name}] onmessage 抛错: ${(e && (e.message || e))}`); }
    }
    for (const cb of [...listeners.message]) {
      try { cb({ data }); } catch (e) { log(`[${name}] message 监听器抛错: ${(e && (e.message || e))}`); }
    }
  });
  w.on("error", (e) => {
    const ev = { message: `worker error: ${(e && (e.stack || e.message)) || e}`, error: e };
    if (typeof api.onerror === "function") { try { api.onerror(ev); } catch {} }
    for (const cb of [...listeners.error]) { try { cb(ev); } catch {} }
  });
  w.on("exit", (code) => { if (code !== 0) log(`[${name}] worker 退出 code=${code}`); });
  return api;
}
