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
    console.log("[oi clangd] stage:", msg);
    try {
      self.postMessage({ __oiLog: msg });
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
  function onStderr(b) {
    if (typeof b === "number") errBytes.push(b & 255);
    else for (const x of b) errBytes.push(x & 255);
    if (errBytes.length > 4096) errBytes = errBytes.slice(-4096);
    let nl = errBytes.lastIndexOf(10);
    if (nl >= 0) {
      const line = ascii(errBytes.slice(0, nl + 1)).trimEnd();
      errBytes = errBytes.slice(nl + 1);
      if (line) {
        console.warn("[oi clangd stderr]", line);
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
  async function loadClassicGlue(glueUrl) {
    const r = await fetch(glueUrl);
    if (!r.ok) throw new Error(`\u53D6\u4E0D\u5230 clangd.js: HTTP ${r.status}`);
    const text = await r.text();
    stage(`glue \u6587\u672C ${text.length}B`);
    let src = text.replace(/import\.meta\.url/g, "(self.__oiGlueUrl||self.location.href)").replace(/,\{type:"module",name:"em-pthread-"/g, ',{name:"em-pthread-"').replace(/export default Module;?/g, "self.Module=Module;");
    src = "self.__oiGlueUrl=self.__oiGlueUrl||self.location.href;\n" + src;
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    self.__oiGlueUrl = url;
    stage("importScripts(blob) \u8C03\u7528");
    importScripts(url);
    stage("importScripts \u8FD4\u56DE, self.Module=" + typeof self.Module);
    if (typeof self.Module !== "function") throw new Error("glue \u8F6C\u7ECF\u5178\u811A\u672C\u540E\u6CA1\u6709\u66B4\u9732 Module");
    return { Module: self.Module, scriptUrl: url };
  }
  async function start({ base, files, flags, opt = 2, debug = true }) {
    if (!self.crossOriginIsolated) throw new Error("clangd \u9700\u8981 COOP/COEP \u8DE8\u6E90\u9694\u79BB");
    const b = String(base).replace(/\/+$/, "");
    const get = async (url) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`\u53D6\u4E0D\u5230 ${url}: HTTP ${r.status}`);
      return r.arrayBuffer();
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
      console.warn("[oi clangd pthread]", msg);
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
        oiWorkerLog(`#${id} \u521B\u5EFA url=${u.slice(0, 48)}${u.length > 48 ? "\u2026" : ""} type=${opts && opts.type || "-"} \u7D2F\u8BA1=${id}`);
        this.addEventListener("message", (ev) => {
          const d = ev.data;
          if (d && typeof d === "object" && d.cmd) oiWorkerLog(`#${id} \u6536\u5230 cmd=${d.cmd}`);
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
    stage("\u51C6\u5907\u52A0\u8F7D glue");
    const { Module, scriptUrl } = await loadClassicGlue(`${b}/clangd/clangd.js`);
    stage("glue \u5DF2\u8F6C\u7ECF\u5178\u811A\u672C\u5E76 importScripts \u5B8C\u6210");
    const wasmBlobUrl = URL.createObjectURL(new Blob([wasm], { type: "application/wasm" }));
    stage("wasm blob URL \u5C31\u7EEA\uFF08\u4F9B pthread \u5B50 worker \u52A0\u8F7D\uFF09");
    stage("\u8C03\u7528 Module()");
    M = await Module({
      thisProgram: "/usr/bin/clangd",
      wasmBinary: wasm,
      mainScriptUrlOrBlob: scriptUrl,
      // pthread 线程池加载同一个经典脚本 blob
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
    FS.writeFile("/workspace/.clangd", new TextEncoder().encode([
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
      "-j=1",
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
      let hits = 0, reported = false;
      const check = (args) => {
        const s = String(args && args[0] || "");
        if (!s.includes("thread pool is exhausted")) return false;
        hits++;
        if (!reported && hits >= 6) {
          reported = true;
          try {
            self.postMessage({ __oiLog: `pthread \u7EBF\u7A0B\u6C60\u8017\u5C3D\uFF08\u547D\u4E2D ${hits} \u6B21\uFF09\uFF1B\u5DF2\u521B\u5EFA\u5B50 worker \u6570\u89C1\u4E0A\u51E0\u6761` });
          } catch {
          }
          try {
            self.postMessage({ __oiFatal: "pthread-exhausted" });
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
