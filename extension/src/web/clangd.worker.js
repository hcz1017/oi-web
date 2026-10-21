// clangd 桥 worker：把 clangd.wasm 的 stdin/stdout 暴露成【裸 LSP over postMessage】，
// 扩展侧用官方 vscode-languageclient/browser，不用自己实现 LSP。
//
// 启动方式（踩了很多坑，最终可用的组合）：
//   · 本 worker 必须是【经典 worker】（IIFE）：
//     扩展宿主 iframe 里 module worker 的加载路径不可靠（会报 importScripts 之类）
//   · glue（clangd.js）是 ESM，且内部用 import.meta.url 建 pthread 线程池，
//     所以用【动态 import()】从 HTTP URL 加载它，并通过 new Function 包裹避免被打包改写
//   · 【不要传】mainScriptUrlOrBlob、【不要】用 blob：
//     传了会让线程池的加载路径与 import() 不一致，卡在 emscripten 的 loading-workers
//   · clangd 虚拟 FS 由 headers.json.gz（1338 个路径→内容）填充，无需 sysroot tar
//   · stdin 是按字节拉的队列 + stdinReady 唤醒；stdout 是裸字节流，按 Content-Length 拆帧
import { clangdArgs } from "../core/flags.mjs";
import { sanitizeName } from "../core/names.mjs";

const enc = new TextEncoder();


// 阶段日志 / 错误直传：LSP 握手前 window/showMessage 会被客户端丢掉，
// 所以调试信息单独用 {__oiLog}/{__oiError} 直接发给扩展侧。
const stage = (msg) => {
  console.log("[oi clangd] stage:", msg);
  try { self.postMessage({ __oiLog: msg }); } catch {}
};
const reportError = (e) => {
  const text = (e && (e.stack || e.message)) || String(e);
  console.error("[oi clangd] 失败:", text);
  try { self.postMessage({ __oiError: text }); } catch {}
};

// pthread 子 worker 会重新执行本脚本：它们只需要跑 glue，不能执行我们的桥逻辑
const isPthreadWorker = typeof self.name === "string" && self.name.startsWith("em-pthread");

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

// ---------- stdin：按【字节】队列（emscripten 的 stdin() 每次返回一个字节码） ----------
let stdinQueue = [];        // 待读的 chunk（每个是 Uint8Array）
let stdinChunk = null;      // 当前 chunk
let stdinPos = 0;
// ⚠️ 必须是"等待者队列"而不是单个回调：clangd 可能在拿到数据前连续 await 多次
//    （读循环里 stdinReady 会被重复调用）。只存一个回调的话，先前的 Promise 永远没人
//    resolve，后面所有响应都要"再发一条请求"才被放出来 —— 这就是那个错位一拍的根源。
let stdinWaiters = [];

function pushStdin(bytes) {
  stdinQueue.push(bytes);
  const waiters = stdinWaiters;
  if (waiters.length) { stdinWaiters = []; for (const w of waiters) w(); }
}
function feed(json) {
  const body = enc.encode(JSON.stringify(json));
  const head = enc.encode(`Content-Length: ${body.length}\r\n\r\n`);
  const frame = new Uint8Array(head.length + body.length);
  frame.set(head, 0);
  frame.set(body, head.length);
  pushStdin(frame);
}
/** emscripten 契约：返回下一个字节码；没有数据时返回 null（= 本次无数据/EOF） */
function stdinByte() {
  if (!stdinChunk || stdinPos >= stdinChunk.length) {
    if (stdinQueue.length === 0) return null;
    stdinChunk = stdinQueue.shift();
    stdinPos = 0;
  }
  return stdinChunk[stdinPos++];
}
/** 队列空时挂起，等 feed() 唤醒（所有等待者一起唤醒，不漏） */
function stdinReady() {
  if (stdinQueue.length > 0) return Promise.resolve();
  if (stdinChunk && stdinPos < stdinChunk.length) return Promise.resolve();
  return new Promise((r) => { stdinWaiters.push(r); });
}

// ---------- stdout：按【字节】收，再拼 Content-Length 帧 ----------
// ⚠️ emscripten 的 stdout 回调参数是【单个字节码 number】，不是 Uint8Array。
//    性能注意：不能每来一个字节就全量扫缓冲区（那样是 O(n²)，大补全结果会明显卡），
//    只在尾部 4 字节匹配 \r\n\r\n 时才解析头部，之后按 Content-Length 精确切。
let outBytes = [];
let outHeaderEnd = -1;   // 当前帧 header 结束位置（= CRLFCRLF 起始下标）
let outNeed = 0;         // 当前帧总长度（header + body）
function ascii(u8) { return new TextDecoder().decode(Uint8Array.from(u8)); }

function pushBytes(arr, b) {
  if (typeof b === "number") arr.push(b & 0xff);
  else for (let i = 0; i < b.length; i++) arr.push(b[i] & 0xff);
}

function onStdout(b) {
  pushBytes(outBytes, b);

  for (;;) {
    if (outHeaderEnd < 0) {
      const n = outBytes.length;
      // 只检查尾部是不是 CRLFCRLF（O(1)）
      if (n < 4 || outBytes[n - 4] !== 13 || outBytes[n - 3] !== 10 || outBytes[n - 2] !== 13 || outBytes[n - 1] !== 10) return;
      const sep = n - 4;
      const m = /content-length:\s*(\d+)/i.exec(ascii(outBytes.slice(0, sep)));
      if (!m) { outBytes = outBytes.slice(sep + 4); continue; }   // 坏头：丢掉
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
      // 坏帧不再静默：否则表现为"某条响应永远不回来"（悬停一直 loading）
      console.warn("[oi clangd] 丢帧", bodyBytes.length, "B:", ascii(bodyBytes.slice(0, 120)), (e && e.message) || e);
    }
  }
}

// stderr 打出来（排查阶段非常有用，clangd 的错误都在这里）
let errBytes = [];
function onStderr(b) {
  if (typeof b === "number") errBytes.push(b & 0xff);
  else for (const x of b) errBytes.push(x & 0xff);
  if (errBytes.length > 4096) errBytes = errBytes.slice(-4096);
  let nl = errBytes.lastIndexOf(10);
  if (nl >= 0) {
    const line = ascii(errBytes.slice(0, nl + 1)).trimEnd();
    errBytes = errBytes.slice(nl + 1);
    if (line) {
      console.warn("[oi clangd stderr]", line);
      // 同时回传给扩展宿主 → 写入"OI C++"输出面板（浏览器控制台不好翻）
      try { self.postMessage({ __oiStderr: line }); } catch {}
    }
  }
}

let started = false;
let M = null;
let pendingMessages = [];

/** 把等待中的 LSP 消息灌进 clangd stdin */
function drainPending() {
  const list = pendingMessages.splice(0);
  for (const m of list) feed(m);
}
// ESM glue 用 import.meta.url 建 pthread 线程池：
//   · 本 worker 是经典脚本（IIFE），没有 import.meta
//   · 所以必须【动态 import】glue 的原始 URL，让 glue 拿到自己的地址去建线程池
//   · 经典 worker 里允许动态 import()（Chrome 63+/FF 108+）
/** 把 ESM 版 clangd glue 转成经典脚本（只做字符串级替换，已在 Node 里验证语法合法） */
/**
 * ⚠️⚠️ 本文件踩过大坑，改动前务必读 docs/CLANGD-WASM-PITFALLS.md
 *
 *  1) glue 是 ESM，必须 import() 加载；emscripten 创建 pthread 子 worker 时用
 *     `{type:"module"}`。一旦把它"转经典脚本"或删掉 type:"module"，子 worker
 *     会 importScripts 一个 ESM 文件 → 失败 → 主线程在 asyncify 里死等
 *     （症状：一敲 #include 就卡死 + 刷屏 thread pool exhausted）。
 *  2) 别把 pthreadPoolSize 改成 0：预建 worker 必须在 callMain 之前 ready。
 *  3) 子 worker 需要 wasm，而我们只发布 .gz → locateFile 要给 blob URL。
 *
 * 加载 emscripten glue（ESM）并返回 Module 工厂。
 *
 * 参考实现（yqloss.cpp-studio-web）的做法：**动态 import() 原始 ESM glue**，
 * 不做任何"转经典脚本"的改造，并保留 emscripten 自己创建 pthread worker 时的
 * `{type:"module"}`。我们之前把 glue 转成经典脚本 + importScripts，同时删掉了
 * 子 worker 的 type:"module"，导致子 worker 变成经典 worker 去 importScripts
 * 一个 ESM 文件 —— 直接失败，主线程永远等（刷屏 + 卡死）。
 */
async function loadGlueModule(glueUrl) {
  stage("动态 import() glue（ESM）");
  let mod;
  try {
    mod = await import(glueUrl);
  } catch (e) {
    stage("直接 import 失败，改用 blob: " + ((e && e.message) || e));
    const text = await (await fetch(glueUrl)).text();
    const url = URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
    mod = await import(url);
  }
  const factory = mod && (mod.default || mod.Module);
  if (typeof factory !== "function") throw new Error("glue 没有导出 Module 工厂");
  return { Module: factory, scriptUrl: glueUrl };
}

async function start({ base, files, flags, opt = 2, debug = true }) {
  if (!self.crossOriginIsolated) throw new Error("clangd 需要 COOP/COEP 跨源隔离");
  const b = String(base).replace(/\/+$/, "");
  const get = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`取不到 ${url}: HTTP ${r.status}`);
    return r.arrayBuffer();
  };
  const [wasmGz, hdrGz] = await Promise.all([
    get(`${b}/clangd/clangd.wasm.gz`),
    get(`${b}/clangd/headers.json.gz`),
  ]);
  stage("资产已下载");
  const wasm = await gunzip(wasmGz);
  const headers = JSON.parse(new TextDecoder().decode(await gunzip(hdrGz)));
  const compat = await fetch(`${b}/compat/bits/stdc++.h`).then((r) => (r.ok ? r.text() : "")).catch(() => "");

  console.log(`[oi clangd] wasm ${(wasm.length / 1048576).toFixed(0)}MB, headers ${Object.keys(headers).length}`);
  stage("wasm 解压完成");

  // glue 是 ESM，但扩展宿主里 module worker 会失败（importScripts 报错）。
  // 解法（构建期已生成）：把 glue 转成【经典脚本】clangd.classic.js（self.Module = Module），
  // 这里 importScripts 它，pthread 线程池也用它 —— 全程零 module worker。
  // 启动方式对齐上游可用实现（必须在【经典 worker】里）：
  //   · 动态 import() HTTP 上的 clangd.js（ESM glue），拿到 Module 工厂
  //   · 【不传】mainScriptUrlOrBlob：让 glue 用自身的 import.meta.url 建 pthread 线程池，
  //     线程池 worker 加载的就是同一个 clangd.js 文件（这是唯一被验证可用的组合）
  //   · 不要 blob：blob 的 base URL 语义不同，线程池会卡在 loading-workers
  // 探针：emscripten 的 pthread 线程池用 new Worker 建子 worker，
  // 失败时 glue 只会"永远等待"，不打任何错。这里包一层把真实原因暴露出来。
  const OrigWorker = self.Worker;
  const oiWorkerLog = (msg) => {
    console.warn("[oi clangd pthread]", msg);
    try { self.postMessage({ __oiLog: "pthread " + msg }); } catch {}
  };
  let oiWorkerSeq = 0;          // 本模块创建了多少个 pthread 子 worker（诊断用）
  self.Worker = class extends OrigWorker {
    constructor(url, opts) {
      super(url, opts);
      const id = ++oiWorkerSeq;
      const u = String(url);
      oiWorkerLog(`#${id} 创建 url=${u.slice(0, 48)}${u.length > 48 ? "…" : ""} type=${(opts && opts.type) || "-"} 累计=${id}`);
      this.addEventListener("message", (ev) => {
        const d = ev.data;
        if (d && typeof d === "object" && d.cmd) oiWorkerLog(`#${id} 收到 cmd=${d.cmd}`);
      });
      this.addEventListener("error", (e) => {
        oiWorkerLog(`#${id} 错误: ${(e && (e.message || e.type)) || e} @${(e && e.filename) || "?"}:${(e && e.lineno) || "?"}`);
        try { self.postMessage({ jsonrpc: "2.0", method: "window/logMessage", params: { type: 1, message: "pthread worker 失败: " + (e && e.message) } }); } catch {}
      });
      this.addEventListener("messageerror", () => oiWorkerLog(`#${id} messageerror`));
    }
  };

  stage("准备加载 glue");
  const { Module, scriptUrl } = await loadGlueModule(`${b}/clangd/clangd.js`);
  stage("glue 已通过 import() 加载完成");
  // ⚠️ pthread 子 worker 需要**自己加载** wasm：我们只发布了 clangd.wasm.gz，
  //    解压后的 wasm 从来没有对应的 URL，于是子 worker 请求 `clangd.wasm` 得到 404，
  //    clangd 就永远等着（表现为"一敲 #include 就卡死"+ 刷屏 thread pool exhausted）。
  //    这里给 wasm 建一个 blob URL，让线程池 worker 也能取到。
  const wasmBlobUrl = URL.createObjectURL(new Blob([wasm], { type: "application/wasm" }));
  stage("wasm blob URL 就绪（供 pthread 子 worker 加载）");
  stage("调用 Module()");
  M = await Module({
    thisProgram: "/usr/bin/clangd",
    wasmBinary: wasm,
    mainScriptUrlOrBlob: scriptUrl,        // pthread 子 worker 用同一个 ESM glue（type:"module"）
    locateFile: (f) => (/\.wasm$/.test(f) ? wasmBlobUrl : `${b}/clangd/${f}`),
    stdinReady,
    stdin: stdinByte,
    stdout: onStdout,
    stderr: onStderr,
    onAbort: (e) => console.error("[oi clangd] abort:", e),
  });

  stage("Module() 返回，开始填 FS");
  const FS = M.FS;
  for (const [path, b64] of Object.entries(headers)) {
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (dir) FS.mkdirTree(dir);
    FS.writeFile(path, b64ToBytes(b64));
  }
  FS.mkdirTree("/workspace");

  // 与原版一致：只写 main.cpp（空）。其它文件靠 didOpen 的 VFS overlay。
  // compile_commands 里只放 main.cpp 一条（原版就是这么做的，5s 启动）。
  FS.writeFile("/workspace/main.cpp", "");
  const mainFile = "/workspace/main.cpp";
  // .clangd：关掉最拖性能的诊断。include-cleaner / missing-includes 会为每个 #include
  // 反复解析头文件，wasm 版里表现为"一写 #include 就卡死"；顺带禁用后台索引与 inlay hints。
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
    "",
  ].join("\n")));
  FS.writeFile("/workspace/compile_commands.json",
    new TextEncoder().encode(JSON.stringify([
      { directory: "/workspace", file: mainFile, arguments: clangdArgs(flags, mainFile, { opt, debug }) },
    ])));

  stage("FS 就绪，callMain");
  // ⚠️ M.callMain() 是【同步阻塞】的（clangd 主循环），调用后本函数不会再往下走，
  //    所以必须在这里就把客户端已排队的 LSP 消息灌进 stdin，否则双方永远互等。
  started = true;
  drainPending();
  // 与原版（5s 启动）完全一致，一个参数都不要多
  M.callMain([
    "--compile-commands-dir=/workspace",
    "--background-index=false",
    "--clang-tidy=false",
    "--completion-parse=always",
    "--pch-storage=memory",
    "-j=2",
    "--log=error",
  ]);
  stage("callMain 返回（clangd 已在运行）");
}

// ---------- 外层：裸 LSP ----------
if (!isPthreadWorker) {
  self.addEventListener("error", (e) => reportError(e.message || e));
  self.addEventListener("unhandledrejection", (e) => reportError(e.reason));

  // ⚠️ emscripten 线程池耗尽会**每几毫秒**打印一次警告，主线程在 asyncify 里空转，
  //    表现为"控制台刷屏 + CPU 拉满 + clangd 永久卡住"。
  //    这里拦截该警告：去重 + 累计到阈值后直接上报致命错误，让扩展停掉 clangd。
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
        try { self.postMessage({ __oiLog: `pthread 线程池耗尽（命中 ${hits} 次）；已创建子 worker 数见上几条` }); } catch {}
        try { self.postMessage({ __oiFatal: "pthread-exhausted" }); } catch {}
      }
      return true;   // 吞掉后续刷屏
    };
    console.warn = (...a) => { if (check(a)) return; origWarn(...a); };
    console.error = (...a) => { if (check(a)) return; origErr(...a); };
  })();

  let cfg = null;

  const notifyError = (msg) => {
    // 用 LSP 的 window/showMessage 让扩展弹出来，而不是只躺在 devtools 里
    try { self.postMessage({ jsonrpc: "2.0", method: "window/showMessage", params: { type: 1, message: msg } }); } catch {}
  };

  let dead = false;

  const boot = async (config) => {
    cfg = config;
    try {
      // 注意：start() 因 callMain 阻塞而不会 resolve，这里不能依赖它返回后的逻辑
      await start({
        base: cfg.base, files: cfg.files || ["main.cpp"], flags: cfg.flags || "-std=c++20",
        opt: cfg.opt ?? 2, debug: cfg.debug !== false,
      });
    } catch (e) {
      dead = true;
      reportError(e);
      const msg = "clangd 启动失败: " + ((e && (e.message || e)) || e);
      notifyError(msg);
      // 不然后续每条 LSP 请求都会堆进 pending（无上限），initialize 永远没应答
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
    if (m.__oiConfig) { boot(m.__oiConfig); return; }
    if (dead) {
      if (typeof m.id !== "undefined") {
        self.postMessage({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "clangd 未能启动" } });
      }
      return;
    }
    if (!cfg || !started) { pendingMessages.push(m); return; }
    feed(m);
  };
}
