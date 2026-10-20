// COOP/COEP 自动补齐（Service Worker 版）
//
// 作用：有些静态托管（GitHub Pages 等）不能配置响应头，导致浏览器没有跨源隔离，
// SharedArrayBuffer / pthreads 不可用（clangd、WASI 线程都会挂）。
// 这个文件身兼两职：
//   · 作为 Service Worker：拦截文档请求，给响应补上 COOP/COEP 头
//   · 作为页面脚本：检测 crossOriginIsolated，不满足就注册 SW 并刷新，最多尝试 3 次
//
// 注意：CF Pages / Netlify 这类能配 _headers 的托管优先用响应头；SW 是兜底。
(function () {
  "use strict";
  var ATTEMPT_KEY = "oi.coi.attempts";
  var MAX_ATTEMPTS = 3;
  var SW_URL = "/coi-serviceworker.js";

  // ============ Service Worker 侧 ============
  if (typeof window === "undefined") {
    self.addEventListener("install", function () { self.skipWaiting(); });
    self.addEventListener("activate", function (e) {
      e.waitUntil(self.clients.claim());
    });
    self.addEventListener("fetch", function (event) {
      var req = event.request;
      if (req.mode !== "navigate" && req.destination !== "document") return;
      event.respondWith(
        fetch(req).then(function (resp) {
          try {
            var headers = new Headers(resp.headers);
            headers.set("Cross-Origin-Opener-Policy", "same-origin");
            headers.set("Cross-Origin-Embedder-Policy", "require-corp");
            headers.set("Cross-Origin-Resource-Policy", "cross-origin");
            return new Response(resp.body, {
              status: resp.status,
              statusText: resp.statusText,
              headers: headers,
            });
          } catch (_e) {
            return resp;
          }
        }).catch(function () { return fetch(req); }),
      );
    });
    return;
  }

  // ============ 页面侧 ============
  function attempts() {
    try { return parseInt(sessionStorage.getItem(ATTEMPT_KEY) || "0", 10) || 0; } catch (_e) { return 0; }
  }
  function bump() {
    try { sessionStorage.setItem(ATTEMPT_KEY, String(attempts() + 1)); } catch (_e) {}
  }
  function reset() {
    try { sessionStorage.removeItem(ATTEMPT_KEY); } catch (_e) {}
  }

  if (window.crossOriginIsolated) { reset(); return; }
  if (!("serviceWorker" in navigator) || !window.isSecureContext) {
    console.warn("[oi coi] 无法注册 Service Worker（需 https/localhost），SharedArrayBuffer 可能不可用");
    return;
  }

  navigator.serviceWorker.register(SW_URL, { scope: "/" }).then(function (reg) {
    // 已有 SW 控制本页 → 仍没隔离：说明响应头没生效，重试有限次数
    if (navigator.serviceWorker.controller) {
      if (attempts() >= MAX_ATTEMPTS) {
        console.warn("[oi coi] 已重试 " + MAX_ATTEMPTS + " 次仍无跨源隔离，放弃");
        return;
      }
      bump();
      console.warn("[oi coi] 仍无跨源隔离，刷新重试 " + attempts() + "/" + MAX_ATTEMPTS);
      location.reload();
      return;
    }
    // 首次注册：等 SW 激活/接管后刷新一次，让文档由 SW 代理
    var done = false;
    function reloadOnce() {
      if (done) return;
      done = true;
      if (attempts() >= MAX_ATTEMPTS) return;
      bump();
      console.log("[oi coi] 已注册 Service Worker，刷新启用跨源隔离 " + attempts() + "/" + MAX_ATTEMPTS);
      location.reload();
    }
    if (reg.active) { reloadOnce(); return; }
    var worker = reg.installing || reg.waiting;
    if (worker) {
      worker.addEventListener("statechange", function () {
        if (worker.state === "activated") reloadOnce();
      });
    } else {
      navigator.serviceWorker.ready.then(reloadOnce);
    }
    setTimeout(reloadOnce, 3000); // 兜底：3 秒还没激活也刷新一次
  }).catch(function (e) {
    console.warn("[oi coi] Service Worker 注册失败:", e);
  });
})();
