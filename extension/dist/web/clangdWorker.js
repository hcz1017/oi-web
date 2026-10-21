(() => {
  // src/core/flags.mjs
  var TRIPLE = "wasm32-wasip1";
  var RESOURCE_DIR = "/lib/clang/22";
  var ISYS = ["/compat", "/include/c++/v1", "/include/wasm32-wasi", "/include", `${RESOURCE_DIR}/include`];
  var SHARED_FLAGS = ["-fno-exceptions", "-nostdinc", "-nostdinc++"];
  var splitFlags = (s) => String(s || "").split(/\s+/).filter(Boolean);
  function clangdArgs(userFlags, filePath, { opt = 2, debug = true } = {}) {
    const { kept } = filterUserFlags(splitFlags(userFlags));
    return [
      "clang++",
      `--target=${TRIPLE}`,
      `-O${opt}`,
      ...debug ? ["-g", "-debug-info-kind=standalone", "-dwarf-version=4", "-debugger-tuning=gdb"] : [],
      ...kept,
      "-isysroot",
      "/",
      ...SHARED_FLAGS,
      ...ISYS.flatMap((d) => ["-isystem", d]),
      filePath
    ];
  }
  var FORBIDDEN_BARE = [/^-c$/, /^-S$/, /^-E$/, /^-fsyntax-only$/, /^-emit-llvm$/, /^-emit-ast$/];
  var FORBIDDEN_WITH_VALUE = [/^-o$/, /^-x$/];
  var FORBIDDEN_INLINE = [/^-o./, /^--output=/, /^-x./, /^-emit-/];
  function filterUserFlags(flags) {
    const list = Array.isArray(flags) ? flags : splitFlags(flags);
    const kept = [], dropped = [];
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (FORBIDDEN_WITH_VALUE.some((r) => r.test(f))) {
        dropped.push(f);
        if (i + 1 < list.length) dropped.push(list[++i]);
        continue;
      }
      if (FORBIDDEN_BARE.some((r) => r.test(f)) || FORBIDDEN_INLINE.some((r) => r.test(f))) {
        dropped.push(f);
        continue;
      }
      kept.push(f);
    }
    return { kept, dropped };
  }

  // src/web/clangd.worker.js
  var enc = new TextEncoder();
  var stage = (msg) => {
    try {
      self.postMessage({ __oiLog: msg, __oiProgress: 1 });
    } catch {
    }
  };
  var reportError = (e) => {
    const text = e && (e.stack || e.message) || String(e);
    console.error("[oi clangd] \u5931\u8D25:", text);
    try {
      self.postMessage({ __oiError: text });
    } catch {
    }
  };
  var isPthreadWorker = typeof self.name === "string" && self.name.startsWith("em-pthread");
  async function gunzip(buf) {
    const ds = new DecompressionStream("gzip");
    return new Uint8Array(await new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer());
  }
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  var stdinQueue = [];
  var stdinChunk = null;
  var stdinPos = 0;
  var stdinWaiters = [];
  function pushStdin(bytes) {
    stdinQueue.push(bytes);
    const waiters = stdinWaiters;
    if (waiters.length) {
      stdinWaiters = [];
      for (const w of waiters) w();
    }
  }
  function feed(json) {
    const body = enc.encode(JSON.stringify(json));
    const head = enc.encode(`Content-Length: ${body.length}\r
\r
`);
    const frame = new Uint8Array(head.length + body.length);
    frame.set(head, 0);
    frame.set(body, head.length);
    pushStdin(frame);
  }
  function stdinByte() {
    if (!stdinChunk || stdinPos >= stdinChunk.length) {
      if (stdinQueue.length === 0) return null;
      stdinChunk = stdinQueue.shift();
      stdinPos = 0;
    }
    return stdinChunk[stdinPos++];
  }
  function stdinReady() {
    if (stdinQueue.length > 0) return Promise.resolve();
    if (stdinChunk && stdinPos < stdinChunk.length) return Promise.resolve();
    return new Promise((r) => {
      stdinWaiters.push(r);
    });
  }
  var outBytes = [];
  var outHeaderEnd = -1;
  var outNeed = 0;
  function ascii(u8) {
    return new TextDecoder().decode(Uint8Array.from(u8));
  }
  function pushBytes(arr, b) {
    if (typeof b === "number") arr.push(b & 255);
    else for (let i = 0; i < b.length; i++) arr.push(b[i] & 255);
  }
  function onStdout(b) {
    pushBytes(outBytes, b);
    for (; ; ) {
      if (outHeaderEnd < 0) {
        const n = outBytes.length;
        if (n < 4 || outBytes[n - 4] !== 13 || outBytes[n - 3] !== 10 || outBytes[n - 2] !== 13 || outBytes[n - 1] !== 10) return;
        const sep = n - 4;
        const m = /content-length:\s*(\d+)/i.exec(ascii(outBytes.slice(0, sep)));
        if (!m) {
          outBytes = outBytes.slice(sep + 4);
          continue;
        }
        outHeaderEnd = sep;
        outNeed = sep + 4 + Number(m[1]);
      }
      if (outBytes.length < outNeed) return;
      const bodyBytes = outBytes.slice(outHeaderEnd + 4, outNeed);
      outBytes = outBytes.slice(outNeed);
      outHeaderEnd = -1;
      outNeed = 0;
      try {
        const parsed = JSON.parse(ascii(bodyBytes));
        self.postMessage(parsed);
      } catch (e) {
        console.warn("[oi clangd] \u4E22\u5E27", bodyBytes.length, "B:", ascii(bodyBytes.slice(0, 120)), e && e.message || e);
      }
    }
  }
  var errBytes = [];
  var stderrSeen = /* @__PURE__ */ new Set();
  var stderrDup = 0;
  function onStderr(b) {
    if (typeof b === "number") errBytes.push(b & 255);
    else for (const x of b) errBytes.push(x & 255);
    if (errBytes.length > 4096) errBytes = errBytes.slice(-4096);
    let nl = errBytes.lastIndexOf(10);
    if (nl >= 0) {
      const line = ascii(errBytes.slice(0, nl + 1)).trimEnd();
      errBytes = errBytes.slice(nl + 1);
      if (line) {
        if (stderrSeen.has(line)) {
          stderrDup++;
          return;
        }
        stderrSeen.add(line);
        if (stderrSeen.size > 500) stderrSeen.clear();
        try {
          self.postMessage({ __oiStderr: line });
        } catch {
        }
      }
    }
  }
  var started = false;
  var M = null;
  var pendingMessages = [];
  function drainPending() {
    const list = pendingMessages.splice(0);
    for (const m of list) feed(m);
  }
  async function loadGlueModule(glueUrl) {
    stage("\u6293\u53D6 glue \u6587\u672C\u5E76\u8F6C blob");
    const text = await (async () => {
      const r = await fetch(glueUrl);
      if (!r.ok) throw new Error(`\u53D6\u4E0D\u5230 glue: HTTP ${r.status}`);
      if (!r.body || !r.body.getReader) return r.text();
      const rd = r.body.getReader();
      const chunks = [];
      let total = 0, last = 0;
      for (; ; ) {
        const { done, value } = await rd.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
        const now = Date.now();
        if (now - last > 400) {
          last = now;
          try {
            self.postMessage({ __oiProgress: 1 });
          } catch {
          }
        }
      }
      const bytes = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        bytes.set(c, off);
        off += c.length;
      }
      return new TextDecoder().decode(bytes);
    })();
    if (!text) throw new Error("glue \u4E3A\u7A7A");
    let patched = text.replace(/var pthreadPoolSize\s*=\s*8/, "var pthreadPoolSize=4");
    if (patched === text) stage("\u26A0 glue \u91CC\u6CA1\u627E\u5230 pthreadPoolSize=8\uFF08\u7248\u672C\u53D8\u4E86\uFF1F\u6C60\u5927\u5C0F\u4FDD\u6301\u9ED8\u8BA4\uFF09");
    if (patched === text) stage("\u26A0 glue \u91CC\u6CA1\u627E\u5230 pthreadPoolSize=8\uFF08\u7248\u672C\u53D8\u4E86\uFF1F\u6C60\u5927\u5C0F\u4FDD\u6301\u9ED8\u8BA4\uFF09");
    const blobUrl = URL.createObjectURL(new Blob([patched], { type: "text/javascript" }));
    stage("import() glue blob");
    const mod = await import(blobUrl);
    const factory = mod && (mod.default || mod.Module);
    if (typeof factory !== "function") throw new Error("glue \u6CA1\u6709\u5BFC\u51FA Module \u5DE5\u5382");
    return { Module: factory, scriptUrl: blobUrl };
  }
  async function start({ base, files, flags, opt = 2, debug = true }) {
    if (!self.crossOriginIsolated) throw new Error("clangd \u9700\u8981 COOP/COEP \u8DE8\u6E90\u9694\u79BB");
    const b = String(base).replace(/\/+$/, "");
    const get = async (url) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`\u53D6\u4E0D\u5230 ${url}: HTTP ${r.status}`);
      const total = Number(r.headers.get("content-length")) || 0;
      if (!r.body || !r.body.getReader) return r.arrayBuffer();
      const reader = r.body.getReader();
      const chunks = [];
      let received = 0, last = 0;
      for (; ; ) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        const now = Date.now();
        if (now - last > 400) {
          last = now;
          try {
            self.postMessage({ __oiProgress: 1, __oiDownload: total ? { received, total } : { received } });
          } catch {
          }
        }
      }
      const out = new Uint8Array(received);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.length;
      }
      return out.buffer;
    };
    const [wasmGz, hdrGz] = await Promise.all([
      get(`${b}/clangd/clangd.wasm.gz`),
      get(`${b}/clangd/headers.json.gz`)
    ]);
    stage("\u8D44\u4EA7\u5DF2\u4E0B\u8F7D");
    const wasm = await gunzip(wasmGz);
    const headers = JSON.parse(new TextDecoder().decode(await gunzip(hdrGz)));
    const compat = await fetch(`${b}/compat/bits/stdc++.h`).then((r) => r.ok ? r.text() : "").catch(() => "");
    console.log(`[oi clangd] wasm ${(wasm.length / 1048576).toFixed(0)}MB, headers ${Object.keys(headers).length}`);
    stage("wasm \u89E3\u538B\u5B8C\u6210");
    const OrigWorker = self.Worker;
    const oiWorkerLog = (msg) => {
      try {
        self.postMessage({ __oiLog: "pthread " + msg });
      } catch {
      }
    };
    let oiWorkerSeq = 0;
    self.Worker = class extends OrigWorker {
      constructor(url, opts) {
        super(url, opts);
        const id = ++oiWorkerSeq;
        const u = String(url);
        if (id <= 10) oiWorkerLog(`#${id} \u521B\u5EFA type=${opts && opts.type || "-"}`);
        else if (id % 32 === 0) oiWorkerLog(`pthread worker \u7D2F\u8BA1\u5DF2\u521B\u5EFA ${id} \u4E2A\uFF08\u7EBF\u7A0Bchurn\uFF0Cclangd \u6BCF\u5F00\u4E00\u4E2A std::thread \u5C31\u4F1A\u65B0\u5EFA\uFF09`);
        if (id === 12) {
          try {
            self.postMessage({ __oiRestart: { workers: id, force: false } });
          } catch {
          }
          oiWorkerLog("worker \u6570\u8FBE 12\uFF0C\u8BF7\u6C42\u91CD\u542F\uFF08\u5E26\u51B7\u5374\uFF09");
        }
        if (id === 32) {
          try {
            self.postMessage({ __oiRestart: { workers: id, force: true } });
          } catch {
          }
          oiWorkerLog("worker \u6570\u8FBE 32\uFF0C\u5F3A\u5236\u91CD\u542F\uFF08\u65E0\u51B7\u5374\uFF09");
        }
        if (id === 64 || id === 128 || id === 256) {
          oiWorkerLog(`\u26A0 pthread worker \u5DF2\u8FBE ${id} \u4E2A\uFF0C\u82E5\u7EE7\u7EED\u589E\u957F\u5EFA\u8BAE\u91CD\u542F clangd\uFF08\u547D\u4EE4\uFF1AOI C++: \u91CD\u542F clangd\uFF09`);
        }
        this.addEventListener("message", (ev) => {
          const d = ev.data;
          if (!d || typeof d !== "object" || !d.cmd) return;
          if (d.cmd === "loaded" && id <= 10) oiWorkerLog(`#${id} loaded`);
        });
        this.addEventListener("error", (e) => {
          oiWorkerLog(`#${id} \u9519\u8BEF: ${e && (e.message || e.type) || e} @${e && e.filename || "?"}:${e && e.lineno || "?"}`);
          try {
            self.postMessage({ jsonrpc: "2.0", method: "window/logMessage", params: { type: 1, message: "pthread worker \u5931\u8D25: " + (e && e.message) } });
          } catch {
          }
        });
        this.addEventListener("messageerror", () => oiWorkerLog(`#${id} messageerror`));
      }
    };
    stage("\u51C6\u5907\u52A0\u8F7D glue\uFF08ESM \u6A21\u5F0F\uFF09");
    const { Module, scriptUrl } = await loadGlueModule(`${b}/clangd/clangd.js`);
    stage("glue \u52A0\u8F7D\u5B8C\u6210\uFF08ESM\uFF09");
    const wasmBlobUrl = URL.createObjectURL(new Blob([wasm], { type: "application/wasm" }));
    stage("wasm blob URL \u5C31\u7EEA\uFF08\u4F9B pthread \u5B50 worker \u52A0\u8F7D\uFF09");
    stage("\u8C03\u7528 Module()");
    M = await Module({
      thisProgram: "/usr/bin/clangd",
      wasmBinary: wasm,
      mainScriptUrlOrBlob: scriptUrl,
      // pthread 子 worker 用同一个 ESM glue（type:"module"）
      locateFile: (f) => /\.wasm$/.test(f) ? wasmBlobUrl : `${b}/clangd/${f}`,
      stdinReady,
      stdin: stdinByte,
      stdout: onStdout,
      stderr: onStderr,
      onAbort: (e) => console.error("[oi clangd] abort:", e)
    });
    stage("Module() \u8FD4\u56DE\uFF0C\u5F00\u59CB\u586B FS");
    const FS = M.FS;
    for (const [path, b64] of Object.entries(headers)) {
      const dir = path.slice(0, path.lastIndexOf("/"));
      if (dir) FS.mkdirTree(dir);
      FS.writeFile(path, b64ToBytes(b64));
    }
    FS.mkdirTree("/workspace");
    FS.writeFile("/workspace/main.cpp", "");
    const mainFile = "/workspace/main.cpp";
    const addFlags = [
      `--target=${TRIPLE}`,
      "-O2",
      ...SHARED_FLAGS,
      ...ISYS.flatMap((d) => ["-isystem", d])
    ];
    FS.writeFile("/workspace/.clangd", new TextEncoder().encode([
      "CompileFlags:",
      "  Compiler: clang++",
      "  Add: [" + addFlags.map((f) => JSON.stringify(f)).join(", ") + "]",
      "  Remove: [-o, -x, -c]",
      "Diagnostics:",
      "  UnusedIncludes: None",
      "  MissingIncludes: None",
      "Index:",
      "  Background: Skip",
      "InlayHints:",
      "  Enabled: No",
      "Tidy:",
      "  Enabled: No",
      ""
    ].join("\n")));
    stage("\u5199\u5165 /workspace/.clangd\uFF08\u542B sysroot \u6807\u5FD7\uFF0C\u8986\u76D6\u6240\u6709\u6587\u4EF6\uFF09");
    FS.writeFile(
      "/workspace/compile_commands.json",
      new TextEncoder().encode(JSON.stringify([
        { directory: "/workspace", file: mainFile, arguments: clangdArgs(flags, mainFile, { opt, debug }) }
      ]))
    );
    stage("FS \u5C31\u7EEA\uFF0CcallMain");
    started = true;
    drainPending();
    M.callMain([
      "--compile-commands-dir=/workspace",
      "--background-index=false",
      "--clang-tidy=false",
      "--completion-parse=always",
      "--pch-storage=memory",
      "-j=2",
      // 2 个后台线程：1 个太慢（用户实测），线程数带来的 worker 增长已由 didChange 去抖压住
      "--log=error"
    ]);
    stage("callMain \u8FD4\u56DE\uFF08clangd \u5DF2\u5728\u8FD0\u884C\uFF09");
  }
  if (!isPthreadWorker) {
    self.addEventListener("error", (e) => reportError(e.message || e));
    self.addEventListener("unhandledrejection", (e) => reportError(e.reason));
    (function guardThreadPoolFlood() {
      const origWarn = console.warn.bind(console);
      const origErr = console.error.bind(console);
      let hits = 0, lastBeat = 0;
      const check = (args) => {
        const str = String(args && args[0] || "");
        if (!str.includes("thread pool is exhausted")) return false;
        hits++;
        const now = Date.now();
        if (hits === 1) {
          try {
            self.postMessage({ __oiWarnOnce: "clangd \u7EBF\u7A0B\u6C60\u6682\u65F6\u8017\u5C3D\uFF0C\u4EE3\u7801\u63D0\u793A/\u8BCA\u65AD\u53EF\u80FD\u8F83\u7F13\u6162" });
          } catch {
          }
        }
        if (now - lastBeat > 1e4) {
          lastBeat = now;
          try {
            self.postMessage({ __oiProgress: 1 });
          } catch {
          }
        }
        return true;
      };
      console.warn = (...a) => {
        if (check(a)) return;
        origWarn(...a);
      };
      console.error = (...a) => {
        if (check(a)) return;
        origErr(...a);
      };
    })();
    let cfg = null;
    const notifyError = (msg) => {
      try {
        self.postMessage({ jsonrpc: "2.0", method: "window/showMessage", params: { type: 1, message: msg } });
      } catch {
      }
    };
    let dead = false;
    const boot = async (config) => {
      cfg = config;
      stage("worker \u542F\u52A8 \u2714 url=" + String(self.location && self.location.href || "?").slice(0, 96));
      try {
        await start({
          base: cfg.base,
          files: cfg.files || ["main.cpp"],
          flags: cfg.flags || "-std=c++20",
          opt: cfg.opt ?? 2,
          debug: cfg.debug !== false
        });
      } catch (e) {
        dead = true;
        reportError(e);
        const msg = "clangd \u542F\u52A8\u5931\u8D25: " + (e && (e.message || e) || e);
        notifyError(msg);
        for (const m of pendingMessages.splice(0)) {
          if (m && typeof m.id !== "undefined") {
            self.postMessage({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: msg } });
          }
        }
      }
    };
    self.onmessage = (ev) => {
      const m = ev.data;
      if (!m || typeof m !== "object") return;
      if (m.__oiConfig) {
        boot(m.__oiConfig);
        return;
      }
      if (dead) {
        if (typeof m.id !== "undefined") {
          self.postMessage({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "clangd \u672A\u80FD\u542F\u52A8" } });
        }
        return;
      }
      if (!cfg || !started) {
        pendingMessages.push(m);
        return;
      }
      feed(m);
    };
  }
})();
