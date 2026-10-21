// 官方 vscode-languageclient(browser) 接 clangd.wasm。
// 我们只做两件事：
//   ① 给客户端一对"会改写 URI 的" reader/writer（clangd 只认 /workspace/<file> 路径）
//   ② 双向映射 URI（文档 URI ↔ file:///workspace/<name>），含诊断与 WorkspaceEdit
import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/browser";
import { sanitizeName } from "../core/names.mjs";
import { clangdArgs } from "../core/flags.mjs";

const WS = "file:///workspace/";
// clangd 虚拟 FS 里的系统头文件（/compat、/include、/lib/clang）在 VS Code 里不存在，
// 直接给 file:/// 会让"跳转到 bits/stdc++.h"报 "No file system handle registered"。
// 统一映射到我们注册的只读虚拟文件系统（内容来自 headers.json.gz）。
export const HEADER_SCHEME = "clangd-hdr";
const HEADER_PREFIX = HEADER_SCHEME + ":";
const T0 = performance.now();   // 日志基准（毫秒）

class UriMap {
  constructor() {
    this.fwd = new Map();     // docUriString -> clangd uri
    this.rev = new Map();     // clangd uri     -> docUriString
  }
  toClangd(docUri) {
    const key = String(docUri);
    if (this.fwd.has(key)) return this.fwd.get(key);
    const base = sanitizeName(String(docUri).split("/").pop() || "main.cpp");
    let name = base, i = 1;
    while (this.rev.has(WS + name) && this.rev.get(WS + name) !== key) {
      name = base.replace(/(\.[^.]*)?$/, `_${i++}$1`);   // 同名文件加下标，避免互相覆盖
    }
    const mapped = WS + name;
    this.fwd.set(key, mapped);
    this.rev.set(mapped, key);
    return mapped;
  }
  fromClangd(uriStr) {
    if (typeof uriStr !== "string") return uriStr;
    if (this.rev.has(uriStr)) return this.rev.get(uriStr);
    const base = uriStr.startsWith(WS) ? uriStr.slice(WS.length) : null;
    if (base) {
      // 兜底：clangd 可能对未 didOpen 的头文件发诊断，按文件名找已打开的同名文档
      for (const [mapped, doc] of this.rev) {
        if (sanitizeName(String(doc).split("/").pop() || "") === base) return doc;
      }
      return uriStr;                       // 实在没有：保留原样，别丢（否则旧波浪线清不掉）
    }
    // 系统头文件等 clangd 虚拟路径 → 只读虚拟 FS（否则点击/引用面板会报
    // "No file system handle registered (/compat)"）
    if (uriStr.startsWith("file:///")) return HEADER_PREFIX + uriStr.slice("file://".length);
    return uriStr;
  }
  /** 递归改写返回值/参数里所有 URI 字段（含 WorkspaceEdit 的 changes 键） */
  rewriteDeep(x, fn) {
    if (x === null || x === undefined) return x;
    if (Array.isArray(x)) { for (let i = 0; i < x.length; i++) x[i] = this.rewriteDeep(x[i], fn); return x; }
    if (typeof x !== "object") return x;
    for (const k of Object.keys(x)) {
      if (k === "uri" || k === "targetUri" || k === "target") {
        if (typeof x[k] === "string") x[k] = fn(x[k]);
      } else if (k === "changes" && x[k] && typeof x[k] === "object") {
        const out = {};
        for (const [u, v] of Object.entries(x[k])) out[fn(u)] = this.rewriteDeep(v, fn);
        x[k] = out;
      } else {
        x[k] = this.rewriteDeep(x[k], fn);
      }
    }
    return x;
  }
}

/** 包住真实 worker：所有进出 LSP 消息里的 URI 都做映射 */
class LspWorkerProxy {
  constructor(worker, map) {
    this._sentAt = new Map();     // id -> 发出时刻，用来算往返耗时 / 判断在途请求
    this._pumpTimer = null;       // flush pump 定时器
    this._pumpDelay = 40;         // 首次 40ms，之后退避
    this.worker = worker;
    this.map = map;
    this._listeners = new Set();
    this.verbose = false;
    this._onMessage = (ev) => {
      let msg = ev.data;
      // ⚠️ 改写失败绝不能丢消息：以前 try{cb()}catch{} 把整条响应吞掉，
      //    表现就是"悬停一直 loading"（请求有去无回）。现在失败就用原始消息继续投递。
      if (msg && typeof msg === "object") {
        try { msg = this.map.rewriteDeep(msg, (u) => this.map.fromClangd(u)); }
        catch (e) { console.warn("[oi clangd] 入站 URI 改写失败，按原样投递:", e && e.message); }
      }
      if (this.verbose && msg && typeof msg === "object") {
        if (msg.method) console.log("[lsp←]", msg.method, msg.id != null ? "#" + msg.id : "");
        else if (msg.id != null) {
          const t = Math.round(performance.now() - T0);
          const st = this._sentAt.get(msg.id);
          this._sentAt.delete(msg.id);
          if (this._sentAt.size === 0 && this._pumpTimer) { clearTimeout(this._pumpTimer); this._pumpTimer = null; }
          const dt = st == null ? "?" : Math.round(performance.now() - st) + "ms";
          console.log(`[lsp←] resp #${msg.id} @${t}ms (+${dt})`, msg.error ? "ERROR " + (msg.error.message || "") : "ok");
        }
      }
      for (const cb of this._listeners) {
        try { cb(msg); } catch (e) { console.error("[oi clangd] 消息分发异常:", e && (e.stack || e.message)); }
      }
    };
    worker.addEventListener("message", this._onMessage);
  }
  addEventListener(type, cb) { if (type === "message") this._listeners.add(cb); }
  removeEventListener(type, cb) { if (type === "message") this._listeners.delete(cb); }
  postMessage(msg) {
    if (msg && typeof msg === "object") {
      try { msg = this.map.rewriteDeep(msg, (u) => this.map.toClangd(u)); }
      catch (e) { console.warn("[oi clangd] 出站 URI 改写失败，按原样投递:", e && e.message); }
    }
    if (this.verbose && msg && typeof msg === "object") {
      const t = Math.round(performance.now() - T0);
      if (msg.method) {
        if (msg.id != null) this._sentAt.set(msg.id, performance.now());
        console.log(`[lsp→] ${msg.method}${msg.id != null ? " #" + msg.id : ""} @${t}ms`);
      } else if (msg.id != null) {
        console.log(`[lsp→] resp-to-server #${msg.id} @${t}ms`);
      }
    }
    this.worker.postMessage(msg);

    // 发出去的是「请求」→ 启动 flush pump（详见 pumpFlush 注释）
    if (msg && typeof msg === "object" && msg.method && msg.id != null) {
      this._sentAt.set(msg.id, performance.now());
      this._pumpDelay = 40;
      this.pumpFlush();
    }
  }

  /**
   * clangd(WASI) 的 stdout 是行缓冲：它【读到下一次 stdin 输入】时才会把上一批输出 flush 出来。
   * 实测（@20583ms 那条）：hover 的响应要等 definition（用户按 Ctrl）到达后才出现。
   * 因此只要还有请求在途，就周期性喂一条协议允许、无副作用的通知，把 clangd 的读循环推一下。
   * 用 $/setTrace：LSP 规范定义为纯 no-op，clangd 不产生响应、不改状态；空闲时（无在途请求）不发。
   */
  pumpFlush() {
    if (this._pumpTimer) return;
    const tick = () => {
      this._pumpTimer = null;
      if (this._sentAt.size === 0) return;                  // 没有在途请求 → 停止
      const now = performance.now();
      let oldest = Infinity;
      for (const t of this._sentAt.values()) oldest = Math.min(oldest, t);
      if (now - oldest >= this._pumpDelay) {
        try { this.worker.postMessage({ jsonrpc: "2.0", method: "$/setTrace", params: { value: "off" } }); } catch {}
        this._pumpDelay = Math.min(this._pumpDelay * 2, 150);   // 退避，别把 stdin 塞满
      }
      this._pumpTimer = setTimeout(tick, this._pumpDelay);
    };
    this._pumpTimer = setTimeout(tick, this._pumpDelay);
  }
  dispose() {
    try { this.worker.removeEventListener("message", this._onMessage); } catch {}
    if (this._pumpTimer) { clearTimeout(this._pumpTimer); this._pumpTimer = null; }
    this._sentAt.clear();
    this._listeners.clear();
  }
}

/** vscode-jsonrpc 的 Event 语义：可注册监听，返回 Disposable */
function makeEvent() {
  const listeners = new Set();
  const event = (l) => { listeners.add(l); return { dispose: () => listeners.delete(l) }; };
  event.fire = (e) => { for (const l of [...listeners]) { try { l(e); } catch {} } };
  return event;
}

class Reader {
  constructor(proxy) {
    this.proxy = proxy; this.cbs = [];
    this.onError = makeEvent();
    this.onClose = makeEvent();
    this.onPartialMessage = makeEvent();
    this._h = (m) => { for (const cb of this.cbs) cb(m); };
    proxy.addEventListener("message", this._h);
  }
  listen(cb) {
    this.cbs.push(cb);
    return { dispose: () => { const i = this.cbs.indexOf(cb); if (i >= 0) this.cbs.splice(i, 1); } };
  }
  dispose() { this.cbs = []; this.proxy.removeEventListener("message", this._h); }
}
class Writer {
  constructor(proxy, opts) {
    this.proxy = proxy;
    this.opts = opts || {};            // { flags, opt, debug }：didOpen 时同步给 clangd
    this.onError = makeEvent();
    this.onClose = makeEvent();
  }
  // ⚠️ vscode-jsonrpc 的 MessageWriter 契约：write() 必须返回 Promise（内部会 write(...).catch(...)）
  write(msg) {
    try { this.proxy.postMessage(msg); }
    catch (e) { try { this.onError.fire([e, msg, 1]); } catch {} return Promise.reject(e); }

    return Promise.resolve();
  }
  end() {}
  dispose() {}
}

let client = null;
let current = null;
// ⚠️ clangd 每个实例都会加载 121MB wasm + 预建 8 个 pthread worker（各自 instantiating），
//    所以**必须**保证全局只有一个实例：反复开关文件夹/反复启动会叠加到 5G+ 内存，
//    且线程池耗尽后再也起不来。stopClangd() 里 terminate + dispose 缺一不可。
let fatal = false;   // 线程池耗尽等致命错误：本次会话不再自动启动 clangd
// current = { worker, proxy, lc }

export function resetClangdFatal() { fatal = false; }

export async function startClangd(ctx, opts = {}) {
  const merged = { files: ["main.cpp"], flags: "-std=c++20", opt: 2, debug: true, base: "", verbose: false, log: undefined, ...opts };
  // ⚠️ 只用 module worker（ESM glue 要求）。不再"降级经典 worker"：
  //    经典 worker + ESM glue 会抛 "Module scripts don't support importScripts()"，
  //    降级只会把错误变成另一种错误，掩盖真正原因。
  return await startOnce(ctx, merged);
}

async function startOnce(ctx, { files, flags, opt, debug, base: baseOverride, verbose, log }) {
  const out = typeof log === "function" ? log : (line) => console.warn("[oi clangd]", line);
  if (client) return client;
  if (fatal) throw new Error("clangd 已被停用（pthread 线程池不足）。重启扩展或运行「OI C++: 重启 clangd(WASM)」可再试");
  // 资产 base 支持外置（oiCpp.assetsBaseUrl）：传进来就用，否则用扩展自带 assets/
  const base = (baseOverride || vscode.Uri.joinPath(ctx.extensionUri, "assets").toString()).replace(/\/+$/, "");
  const workerUrl = vscode.Uri.joinPath(ctx.extensionUri, "dist", "web", "clangdWorker.js").toString();

  // ⚠️ 必须用 module worker：clangd 的 glue 是 ESM，worker 里要动态 import()，
  //    且 emscripten 的 pthread 子 worker 也是 {type:"module"}。
  //    （早期为了"兼容"改成经典 worker + importScripts，直接导致 #include 卡死，
  //     细节见 docs/CLANGD-WASM-PITFALLS.md）
  let worker;
  try {
    // ⚠️ 必须是**经典 worker**（与参考实现一致）：`new Worker(url)` 不带 type。
    //    worker 脚本内部用**动态 import()** 加载 ESM glue —— 动态 import 在经典
    //    worker 里是允许的；而如果这里传 {type:"module"}，worker 就成了 module
    //    scope，一旦有任何 importScripts（包括 emscripten 老路径）就会抛
    //    "Module scripts don't support importScripts()"。
    worker = new Worker(workerUrl);
    console.warn("[oi clangd] worker(classic) ←", workerUrl);
  } catch (e) {
    // 跨源部署时的兜底：fetch 源码再 blob 化
    const resp = await fetch(workerUrl);
    if (!resp.ok) throw new Error(`取不到 clangdWorker.js: HTTP ${resp.status}`);
    const code = await resp.text();
    // 兜底也是经典 worker（同上面原因：动态 import 在经典 worker 里可用）
    worker = new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
    console.warn("[oi clangd] worker(blob fallback) ←", workerUrl, "err=", (e && e.message) || e);
  }
  // 调试通道：worker 的阶段日志/错误直接进控制台，避免被 LSP 握手前的丢弃规则吞掉
  worker.addEventListener("message", (ev) => {
    const d = ev.data;
    if (!d || typeof d !== "object") return;
    // 日志只进输出面板（不 console.warn，避免 devtools 保留巨量日志）
    if (d.__oiLog) { out("[stage] " + d.__oiLog); if (d.__oiProgress) bumpInitDeadline(); }
    if (d.__oiStderr) out("[stderr] " + String(d.__oiStderr).slice(0, 400));
    if (d.__oiError) {
      console.error("[oi clangd] 失败:", d.__oiError);
      vscode.window.showErrorMessage("clangd 启动失败: " + String(d.__oiError).split("\n")[0]);
    }
    if (d.__oiFatal) {
      // 线程池耗尽：clangd 主线程已在 asyncify 里空转，继续留着只会烧 CPU / 卡编辑器
      console.error("[oi clangd] 致命：pthread 线程池耗尽，自动停用本次会话");
      fatal = true;
      vscode.window.showWarningMessage(
        "clangd(WASM) 在这个环境下线程池不足，已自动停用（补全/诊断暂时不可用；真编译与调试不受影响）。" +
        "可运行「OI C++: 重启 clangd(WASM)」再试，或在设置里关闭 oiCpp.lsp。",
      );
      setTimeout(() => { stopClangd().catch(() => {}); }, 0);
    }
  });
  worker.postMessage({ __oiConfig: { base, files, flags, opt, debug, verbose } });

  const map = new UriMap();
  const proxy = new LspWorkerProxy(worker, map);
  proxy.verbose = !!verbose;   // oiCpp.verbose：打印 LSP 流量，排查"悬停不返回/进度不结束"
  let liveReader = null;
  // worker 挂了要让客户端知道（以前 onError/onClose 是空函数，在途请求永久挂起）
  worker.addEventListener("error", (e) => { try { liveReader?.onError.fire([e, undefined, 1]); } catch {} });
  worker.addEventListener("messageerror", () => { try { liveReader?.onError.fire([new Error("messageerror"), undefined, 1]); } catch {} });
  // provider 每次新建 reader/writer：lc.stop() 会 dispose reader，复用同一对会让重启后静默丢弃消息
  let clientRef = null;   // middleware 里要发请求，构造完回指
  const lc = new LanguageClient(
    "oi-cpp-clangd",
    "clangd (WASM)",
    async () => {
      const r = new Reader(proxy);
      liveReader = r;
      return { reader: r, writer: new Writer(proxy, { flags, opt, debug }) };
    },
    {
      documentSelector: [{ language: "cpp" }],
      // 仅用于观测悬停是否走到客户端（真正的 flush 在传输层 pump 里做，见 LspWorkerProxy）
      middleware: verbose ? {
        provideHover: async (document, position, token, next) => {
          const t0 = performance.now();
          const r = await next(document, position, token);
          if (r) console.log("[hover] resolved", Math.round(performance.now() - t0), "ms;",
            "contents=" + (Array.isArray(r.contents) ? r.contents.length + " items" : "markup"));
          return r;
        },
      } : undefined,
    },
  );
  clientRef = lc;
  // 启动失败要让上层能感知（以前 worker 静默挂掉 → start() 永远不 resolve）
  // ⚠️ 首次启动要下载 24MB clangd + 1.3k 头文件，原来 30s 固定超时会被误杀。
  //    改成"**空闲**超时"：只要 worker 还在推进（stage 带 __oiProgress），就重置计时；
  //    真正的死锁（没有任何进展）45s 后仍然会失败。
  let initTimer = null, initReject = null;
  const timeout = new Promise((_, rej) => {
    initReject = rej;
    initTimer = setTimeout(() => rej(new Error("clangd 初始化超时（45s 无进展）")), 45000);
  });
  const bumpInitDeadline = () => {
    if (!initTimer) return;
    clearTimeout(initTimer);
    initTimer = setTimeout(() => initReject?.(new Error("clangd 初始化超时（45s 无进展）")), 45000);
  };
  // worker 自身报错（例如 module worker 里 importScripts 不被支持）要**立刻**失败，
  // 不能等 30s 超时——否则降级重试要等半分钟以上，用户体感就是"起不动"。
  const workerFailed = new Promise((_, rej) => {
    worker.addEventListener("error", (e) => {
      rej(new Error("worker error: " + String((e && (e.message || e.type)) || e)));
    });
  });
  const started = lc.start();
  started.catch(() => {});          // race 输掉的一方也要有人接，避免 unhandledrejection
  try {
    await Promise.race([started, timeout, workerFailed]);
  } catch (e) {
    // lc 可能已处于 startFailed/starting，stop() 会同步抛，必须吞掉
    try { await Promise.resolve(lc.stop()).catch(() => {}); } catch {}
    try { worker.terminate(); } catch {}
    try { proxy.dispose(); } catch {}
    throw e;
  }
  client = lc;
  current = { worker, proxy, lc };
  return client;
}

export async function stopClangd() {
  const c = current;
  current = null;
  client = null;
  if (!c) return;
  // lc 还在 starting/startFailed 时 stop() 会抛 "Client is not running and can't be stopped"
  try { await Promise.resolve(c.lc.stop()).catch(() => {}); } catch {}
  // terminate 必须在 stop 失败时也能执行，否则旧 worker（及其 pthread 子 worker）泄漏
  try { c.worker.terminate(); } catch {}
  try { c.proxy.dispose(); } catch {}
}
