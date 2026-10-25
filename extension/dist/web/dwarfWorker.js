(() => {
  // wdb/src/symbols/dwarf.worker.js
  (() => {
    let booted = false;
    const pending = [];
    self.onmessage = (ev) => {
      const m = ev.data;
      if (!m || typeof m !== "object") return;
      if (!booted) {
        if (!m.__wdbConfig) {
          pending.push(m);
          return;
        }
        const base = String(m.__wdbConfig && m.__wdbConfig.base || "").replace(/\/+$/, "");
        self.__wdbDwarfBase = base;
        try {
          importScripts(base + "/dwarf/worker.js");
          booted = true;
          self.postMessage({ __wdbReady: true });
          const q = pending.splice(0);
          for (const msg of q) {
            try {
              self.onmessage({ data: msg });
            } catch (e) {
              console.error("[wdb] \u6392\u961F\u6D88\u606F\u6D3E\u53D1\u5931\u8D25:", e);
            }
          }
        } catch (e) {
          self.postMessage({ __wdbError: String(e && (e.stack || e.message) || e) });
        }
        return;
      }
      console.warn("[wdb] \u672A\u5904\u7406\u7684\u6D88\u606F\uFF08\u5F15\u64CE\u672A\u63A5\u7BA1 onmessage\uFF1F\uFF09");
    };
    self.addEventListener("error", (e) => {
      self.postMessage({ __wdbError: "worker error: " + (e && (e.message || e.error) || e) });
    });
    self.addEventListener("unhandledrejection", (e) => {
      self.postMessage({ __wdbError: "worker unhandledrejection: " + (e && e.reason && (e.reason.stack || e.reason.message) || e) });
    });
  })();
})();
