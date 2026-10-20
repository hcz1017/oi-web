// DWARF 符号引擎宿主 worker（经典脚本）
//
// 引擎本体是微软 @vscode/dwarf-debugging 里编译好的 Chrome cxx_debugging（SymbolsBackend.wasm，
// 56MB / gz 12.7MB），我们把它上游的 worker.js 做了一层浏览器 shim（见 scripts/build-dwarf-worker.mjs），
// 产物在 assets/dwarf/worker.js。这里负责：
//   1. 收到 __oiConfig 后用 importScripts 加载引擎（同步，加载完引擎会接管 self.onmessage）
//   2. 在加载完成前把消息排队（正常情况下主线程会等 __oiReady 再发消息）
//
// ⚠️ 引擎内部自己设置 self.onmessage / self.postMessage，所以本文件加载完成后不要再覆盖 onmessage。
(() => {
  let booted = false;
  const pending = [];

  self.onmessage = (ev) => {
    const m = ev.data;
    if (!m || typeof m !== "object") return;

    if (!booted) {
      if (!m.__oiConfig) { pending.push(m); return; }
      const base = String((m.__oiConfig && m.__oiConfig.base) || "").replace(/\/+$/, "");
      self.__oiDwarfBase = base;
      try {
        // 引擎（已 patch）是经典脚本，直接 importScripts 即可；它会自己接管 onmessage
        importScripts(base + "/dwarf/worker.js");
        booted = true;
        self.postMessage({ __oiReady: true });
        const q = pending.splice(0);
        for (const msg of q) {
          try { self.onmessage({ data: msg }); } catch (e) { console.error("[oi dwarf] 排队消息派发失败:", e); }
        }
      } catch (e) {
        self.postMessage({ __oiError: String((e && (e.stack || e.message)) || e) });
      }
      return;
    }
    // 理论上到不了这里（引擎已接管），保底不吞消息
    console.warn("[oi dwarf] 未处理的消息（引擎未接管 onmessage？）");
  };

  self.addEventListener("error", (e) => {
    self.postMessage({ __oiError: "worker error: " + ((e && (e.message || e.error)) || e) });
  });
  self.addEventListener("unhandledrejection", (e) => {
    self.postMessage({ __oiError: "worker unhandledrejection: " + ((e && e.reason && (e.reason.stack || e.reason.message)) || e) });
  });
})();
