// oi-cpp-wasm：VS Code Web 扩展
//   · WASM clang 编译单文件 C++（产物 wasm32-wasip1）
//   · 在真实终端里交互运行（真正的行编辑 + stdin 阻塞读）
//   · 官方 vscode-languageclient 接 clangd.wasm
//
// 架构要点（每次修 bug 得出的结论，别改回去）：
//   1) 编译 worker 常驻（持有 28MB 工具链）；运行 worker 每次新建。
//      → Ctrl+C 只 terminate 运行实例，不必重下工具链。
//   2) 一个源文件一个终端（各自的编译/运行实例），多文件互不干扰。
//   3) stdin 走 SharedArrayBuffer 单槽 + 宿主队列 + consumed 握手（主线程不能 Atomics.wait）。
//   4) 终端必须自己做行编辑与 \r\n 规范化（VS Code 的 Pseudoterminal 不做这些）。
import * as vscode from "vscode";
import { startClangd, stopClangd, resetClangdFatal } from "./lsp.js";
import { registerHeaderFs } from "./headerfs.js";
import { registerLocalFolder } from "./fsa-folder.js";
import { DwarfEngine } from "../../../wdb/src/symbols/dwarf.js";
import * as platform from "oi-platform";
import { WasmDebugAdapter } from "../../../wdb/src/adapters/dap/adapter.js";
import { createLineEditor } from "./lineedit.mjs";
import { createCompileCache } from "./compile-cache.js";
import { preloadAssets, NOTIFY_AFTER_MS } from "./preload.js";

const TERM_NAME = "WebC++ (WASM)";
const SAB_SIZE = 8 + 64 * 1024;
const S_EMPTY = 0, S_DATA = 1, S_EOF = 3;

let ctx;
let statusItem = null;

function setStatus(kind) {
  if (!statusItem) return;
  const map = {
    idle: ["$(check) WebC++: 就绪", "Ctrl+Shift+B 编译运行当前文件"],
    compile: ["$(sync~spin) WebC++: 编译中…", "正在用 WASM clang 编译，完成后自动运行"],
    run: ["$(play) WebC++: 运行中", "程序在终端里等待输入（Ctrl+D=EOF，Ctrl+C=终止）"],
  };
  const [text, tip] = map[kind] || map.idle;
  statusItem.text = text;
  statusItem.tooltip = tip;
  statusItem.show();
}

// ---------------------------------------------------------------- 语言服务
let lspPromise = null;
/** 「WebC++」输出面板：clangd 阶段日志 / stderr / 生命周期都记这里（网页版控制台不好翻） */
let logChannel = null;
const logRing = [];
function logLine(line) {
  const text = String(line == null ? "" : line);
  logRing.push(text);
  if (logRing.length > 2000) logRing.splice(0, logRing.length - 2000);
  try { logChannel?.appendLine(text); } catch {}
  // 不再 console.log：devtools 会保留所有参数，长跑会把内存吃光
}

/** 当前打开的 C/C++ 文档数（clangd 只在这些文件存在时活着） */
function openCppCount() {
  return vscode.workspace.textDocuments.filter(
    (d) => (d.languageId === "cpp" || d.languageId === "c") && !d.isClosed,
  ).length;
}

/** 没有 cpp 文件打开时释放 clangd（worker + wasm 内存一起回收） */
async function releaseLspIfIdle() {
  if (openCppCount() > 0) return;
  if (!lspPromise && !vscode.workspace.getConfiguration("oiCpp").get("lsp", true)) return;
  lspPromise = null;
  try { await stopClangd(); } catch { /* ignore */ }
  vscode.window.setStatusBarMessage("$(circle-slash) WebC++: clangd 已释放（无打开的 C++ 文件）", 4000);
}

// ⚠️ 野但有效的兜底：clangd 的 pthread worker 数异常增长（正常只需 4 个）说明线程池被打爆，
//    重启能恢复（池子重建、线程清空）。策略按用户要求分两档：
//      · 12 个：**带冷却**的重启（60s 内只重启一次，可能只是短时突发）
//      · 32 个：**强制**重启（已雪崩，无条件立即重来）
let lastSilentRestart = 0;
const RESTART_COOLDOWN_MS = 60000;
async function silentRestartClangd(info) {
  const force = !!(info && info.force);
  const now = Date.now();
  if (!force && now - lastSilentRestart < RESTART_COOLDOWN_MS) {
    logLine(`[restart] 跳过（${Math.round((RESTART_COOLDOWN_MS - (now - lastSilentRestart)) / 1000)}s 冷却中）workers=${info && info.workers}`);
    return;
  }
  lastSilentRestart = now;
  logLine(`[restart] ${force ? "强制" : "冷却"}重启 clangd（workers=${info && info.workers}）`);
  lspPromise = null;
  try { await stopClangd(); } catch { /* ignore */ }
  if (openCppCount() > 0) ensureLsp();
}

/** 工作区变了（切换/关闭文件夹）→ 彻底重启，避免旧实例泄漏 */
async function restartLspClean() {
  lspPromise = null;
  try { await stopClangd(); } catch { /* ignore */ }
  if (openCppCount() > 0) ensureLsp();
}

async function listCppFiles() {
  try {
    const uris = await vscode.workspace.findFiles("**/*.{cpp,cc,cxx,c}", null, 50);
    return uris.map((u) => String(u.path).split("/").pop()).filter(Boolean);
  } catch { return []; }
}
function ensureLsp() {
  if (lspPromise) return lspPromise;
  const cfg = vscode.workspace.getConfiguration("oiCpp");
  if (!cfg.get("lsp", true)) return null;
  // 只给"真正打开着的 cpp 文件"启语言服务：没有打开就不启动，省内存/CPU
  if (openCppCount() === 0) return null;
  lspPromise = (async () => {
    // ⚠️ setStatusBarMessage 返回的 Disposable 必须手动 dispose，
    //    否则"启动中…"会一直挂在下边栏（之前给了 600s 超时，等于 10 分钟内都显示加载中）
    let busy = null;
    try {
      const files = await listCppFiles();
      const flags = String(cfg.get("flags", "-std=c++20"));
      busy = vscode.window.setStatusBarMessage("$(sync~spin) WebC++: 启动 clangd(WASM)…", 600000);
      const c = await startClangd(ctx, {
        files: files.length ? files : ["main.cpp"], flags,
        base: assetsBase(),
        opt: cfg.get("opt", 2),
        debug: cfg.get("debugInfo", true),
        verbose: cfg.get("verbose", false),
        log: (line) => logLine("[clangd] " + line),
        onRestart: (info) => { silentRestartClangd(info); },
      });
      busy?.dispose(); busy = null;
      vscode.window.setStatusBarMessage("$(check) WebC++: clangd 就绪", 5000);
      return c;
    } catch (e) {
      busy?.dispose(); busy = null;
      vscode.window.showErrorMessage("clangd 启动失败: " + ((e && e.message) || e));
      stopClangd();
      lspPromise = null;
      return null;
    }
  })();
  return lspPromise;
}

// ---------------------------------------------------------------- 终端
class OiPty {
  constructor(fileName) {
    this.fileName = fileName;
    this._w = new vscode.EventEmitter();
    this._c = new vscode.EventEmitter();
    this.onDidWrite = this._w.event;
    this.onDidClose = this._c.event;
    this.closed = false;

    this.runner = null;        // 本次运行的 worker（每次新建）

    this.state = "idle";       // idle | compiling | running
    this.reqId = 0;
    this.sab = null;
    this.queue = [];           // 待写入 SAB 的字节（主线程不能阻塞，只能排队）
    this.eof = false;
    this._line = "";
    this._atLineStart = true;
    this._outDec = new TextDecoder("utf-8", { fatal: false });
    this._errDec = new TextDecoder("utf-8", { fatal: false });
    // ⚠️ 必须在构造器里初始化：open() 之前 VS Code 还没接上终端，写入得先缓冲，
    //    否则首次运行的 "[编译中…]" 会被丢弃（也避免 open() 里 splice(undefined) 崩）。
    this._openDone = false;
    this._pendingWrites = [];
    shared.ptys.add(this);
  }

  // Pseudoterminal 必备接口
  async open() {
    this._openDone = true;
    // 补播 open 之前的写入（否则首次运行的 "[编译中…]" 会被静默丢掉）
    const pending = (this._pendingWrites || []).splice(0);
    for (const s2 of pending) this._w.fire(s2);
    this.write("\x1b[36m[WebC++] " + this.fileName + " 的运行终端\x1b[0m\r\n");
    this.write("\x1b[90mCtrl+Shift+B 编译运行；Ctrl+D=EOF；Ctrl+C=终止；编译完成后才能输入\x1b[0m\r\n");
  }
  setDimensions() {}

  write(s) {
    if (this.closed || !s) return;
    this._atLineStart = /[\r\n]$/.test(s);
    if (!this._openDone) { (this._pendingWrites ||= []).push(s); return; }
    this._w.fire(s);
  }
  wln(s = "") { this.write(s + "\r\n"); }
  _log(s) {
    if (!vscode.workspace.getConfiguration("oiCpp").get("verbose", false)) return;
    if (!this._atLineStart) this.write("\r\n");
    this.wln(`\x1b[90m[oi] ${s}\x1b[0m`);
  }

  _workerUrl(name) { return platform.workerRef(name); }
  // ---- 编译 worker：全局单例 ----
  _spawnCompiler() { return getCompiler(); }

  /** worker 崩溃/工具链失败时统一收敛 */
  _fail(msg) {
    this.wln(`\x1b[31m[${msg}]\x1b[0m`);
    this._killRunner();
    this.busyReset("idle");
  }

  busyReset(kind = "idle") {
    this.state = kind;
    setStatus(kind);
  }

  /** 缓存命中：跳过编译直接运行 */
  _startRunnerWithWasm(wasm) {
    if (this.state === "running") { this.wln("\x1b[90m[停止上一个程序]\x1b[0m"); this._killRunner(); }
    this.state = "running";
    setStatus("run");
    this.sab = typeof SharedArrayBuffer === "undefined" ? null : new SharedArrayBuffer(SAB_SIZE);
    this.queue = []; this.eof = false; this._line = "";
    this._startRunner(wasm);
  }

  // ---- 运行 worker（每次新建） ----
  async _startRunner(wasmBuf) {
    this._killRunner();
    try {
      // web: URL + 跨源 blob 兜底；桌面: worker_threads + 垫片
      this.runner = await platform.createNamedWorker("runWorker.js", { log: (m) => debugLog("[wdb] " + m) });
    } catch (e) {
      this._fail("无法创建运行 worker: " + e.message);
      return;
    }
    this.runner.onmessage = (ev) => this._runnerMsg(ev.data);
    this.runner.onerror = (e) => {
      this.wln(`\x1b[31m[运行崩溃] ${e.message || e}\x1b[0m`);
      this._killRunner();
      this.busyReset("idle");
    };
    this.runner.postMessage({ type: "run", bytes: wasmBuf, stdinSAB: this.sab }, [wasmBuf]);
  }

  _killRunner() {
    if (this.runner) { try { this.runner.terminate(); } catch {} }
    this.runner = null;
  }

  // ---- 消息 ----
  _msg(m) {
    if (!m || !m.type) return;
    switch (m.type) {
      case "log": this._log(m.message); break;
      case "ready": this._log("工具链就绪"); this._readyResolve?.(); break;
      case "compiled": {
        // 写入编译缓存（终端运行也缓存；成功才写）
        if (m.ok && this.cacheKey && m.wasm) {
          try { compileCache.put(this.cacheKey, new Uint8Array(m.wasm), m.ms || 0); } catch {}
        }
        if (m.id !== this.reqId || this.state !== "compiling") return;   // 过期/已被取消
        if (!m.ok) {
          this.busyReset("idle");
          if (!this._atLineStart) this.write("\r\n");
          this.wln(`\x1b[31m[编译失败 ${m.ms}ms，exit ${m.exit}] \x1b[0m`);
          const log = String(m.log || "").replace(/\x1b\[[0-9;]*m/g, "").trim();
          if (log) this.wln(log.split("\n").slice(0, 60).join("\r\n"));
          return;
        }
        this.state = "running";
        setStatus("run");
        if (!this._atLineStart) this.write("\r\n");
        this.wln(`\x1b[32m[编译成功 ${m.ms}ms，${(m.size / 1048576).toFixed(1)}MB → 开始运行，可以输入了]\x1b[0m`);
        this._startRunner(m.wasm);
        break;
      }
      case "error":
        if (m.id != null && m.id !== this.reqId) return;   // 过期错误不要干扰新一次编译
        this.busyReset("idle");
        if (!this._atLineStart) this.write("\r\n");
        this.wln(`\x1b[31m[错误] ${m.message}\x1b[0m`);
        this._readyReject?.(new Error(m.message));
        break;
    }
  }

  _runnerMsg(m) {
    if (!m || !m.type) return;
    switch (m.type) {
      case "out": {
        const bytes = new Uint8Array(m.bytes);
        if (m.stream === "stderr") {
          const t = this._errDec.decode(bytes, { stream: true }).replace(/\r?\n/g, "\r\n");
          this.write(`\x1b[31m${t}\x1b[0m`);
        } else {
          const t = this._outDec.decode(bytes, { stream: true }).replace(/\r?\n/g, "\r\n");
          this.write(t);
        }
        break;
      }
      case "consumed": this._flushQueue(); break;
      case "exited":
        if (!this._atLineStart) this.write("\r\n");
        this.wln(`\x1b[90m[退出码 ${m.code}]\x1b[0m`);
        // 收尾未 flush 的解码器尾巴
        { const a = this._outDec.decode(); const b = this._errDec.decode(); if (a) this.write(a); if (b) this.write(b); }
        this._outDec = new TextDecoder("utf-8", { fatal: false });
        this._errDec = new TextDecoder("utf-8", { fatal: false });
        this._killRunner();
        this.busyReset("idle");
        break;
      case "error":
        this.wln(`\x1b[31m[运行错误] ${m.message}\x1b[0m`);
        this._killRunner();
        this.busyReset("idle");
        break;
    }
  }

  // ---- 编译 + 运行 ----
  async runSource(source, fileName, cacheKey) {
    if (this.state === "compiling") { this.wln("\x1b[33m[正在编译，忽略本次请求]\x1b[0m"); return; }
    if (this.state === "running") { this.wln("\x1b[90m[停止上一个程序]\x1b[0m"); this._killRunner(); }
    this.cacheKey = cacheKey;   // ⚠️ 以前漏了这行：compiled 消息回来自取 this.cacheKey 永远是 undefined → 缓存永远写不进

    const myId = shared.nextId++;   // 全局唯一 id（不用实例级 reqId）
    this.reqId = myId;
    this.state = "compiling";
    setStatus("compile");
    this.sab = typeof SharedArrayBuffer === "undefined" ? null : new SharedArrayBuffer(SAB_SIZE);
    this.queue = [];
    this.eof = false;
    this._line = "";
    if (!this.sab) this.wln("\x1b[33m[注意] 页面未跨源隔离，没有 SharedArrayBuffer → 程序拿到空 stdin\x1b[0m");

    if (!this._atLineStart) this.write("\r\n");
    // ⚠️ 终端运行也要走编译缓存：以前只有 F5 调试（compileForDebug）会读缓存，
    //    这里只写不读 → 反复 Ctrl+Shift+B 同一个文件永远全量重编。
    const cachedRun = compileCache.get(cacheKey);
    if (cachedRun) {
      this.wln(`\x1b[32m[编译缓存命中（代码未变化，上次耗时 ${cachedRun.ms}ms）→ 开始运行]\x1b[0m`);
      this._startRunnerWithWasm(cachedRun.wasm.slice().buffer);
      return;
    }
    this.wln(`\x1b[36m[编译中… ${fileName}（完成后才能输入）]\x1b[0m`);

    try {
      await this._spawnCompiler();
    } catch (e) {
      if (this.reqId === myId) this.busyReset("idle");
      this.wln(`\x1b[31m[启动失败] ${e.message}\x1b[0m`);
      return;
    }
    // await 期间可能被 Ctrl+C 打断或又发起了一次运行 → 重新校验
    if (this.reqId !== myId || this.state !== "compiling" || !shared.worker) return;

    const cfg = vscode.workspace.getConfiguration("oiCpp");
    const flags = String(cfg.get("flags", "")).split(/\s+/).filter(Boolean);
    shared.byId.set(myId, this);          // 结果按 id 路由回发起它的终端
    shared.worker.postMessage({
      type: "compile", id: myId, source, fileName, flags,
      opt: cfg.get("opt", 2),
      debugInfo: cfg.get("debugInfo", true),
    });
  }

  // ---- 输入（行编辑 + SAB 投递） ----
  handleInput(data) {
    if (data === "\x03") {                          // Ctrl+C
      this.write("^C\r\n");
      this.reqId++;                                  // 作废在途编译结果
      this._killRunner();
      this._line = "";
      this.queue = [];
      this.busyReset("idle");
      return;
    }
    if (this.state !== "running" || !this.sab) return;
    if (this.eof) { this.write(data); return; }   // 已 EOF：只回显，不再入队

    // 先整串剥离 ANSI 转义序列（方向键/Home/Delete 等），否则 "[A" 会被当输入
    const cleaned = String(data)
      .replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, "")
      .replace(/\x1bO[A-Za-z]/g, "")
      .replace(/\r\n/g, "\n");          // 粘贴 CRLF 不能变成两个换行
    for (const ch of cleaned) {
      if (ch === "\x04") {                          // Ctrl+D
        if (this._line) { this._queueSend(this._line + "\n"); this._line = ""; }
        this.write("^D\r\n");
        this.eof = true;
        this._flushQueue();
        return;
      }
      if (ch === "\r" || ch === "\n") {
        this.write("\r\n");
        this._queueSend(this._line + "\n");
        this._line = "";
      } else if (ch === "\x7f" || ch === "\b") {
        if (this._line.length) { this._line = this._line.slice(0, -1); this.write("\b \b"); }
      } else if (ch >= " " && ch !== "\x1b") {
        this._line += ch;
        this.write(ch);
      }
    }
  }

  _queueSend(text) {
    this.queue.push(new TextEncoder().encode(text));
    this._flushQueue();
  }

  /** 把队列里的字节塞进 SAB；只有 state===0（worker 已交还所有权）时才写 */
  _flushQueue() {
    if (!this.sab || this.state !== "running") return;
    const ctrl = new Int32Array(this.sab, 0, 2);
    const buf = new Uint8Array(this.sab, 8);
    for (;;) {
      if (this.queue.length === 0) {
        if (this.eof && Atomics.load(ctrl, 0) === S_EMPTY) {
          Atomics.store(ctrl, 0, S_EOF);
          Atomics.notify(ctrl, 0);
        }
        return;
      }
      if (Atomics.load(ctrl, 0) !== S_EMPTY) return;      // worker 还没取走上一批
      const chunk = this.queue[0];
      const n = Math.min(chunk.length, buf.length);
      buf.set(chunk.subarray(0, n));
      if (n === chunk.length) this.queue.shift();
      else this.queue[0] = chunk.subarray(n);
      Atomics.store(ctrl, 1, n);
      Atomics.store(ctrl, 0, S_DATA);
      Atomics.notify(ctrl, 0);
      return;
    }
  }

  _dispose() {
    this.closed = true;
    this.reqId++;                                   // 作废在途编译
    this._killRunner();
    for (const [id, p] of shared.byId) if (p === this) shared.byId.delete(id);
    shared.ptys.delete(this);
    this.queue = [];
    try { this._w.dispose(); this._c.dispose(); } catch {}
  }

  close() { this._c.fire(0); this._dispose(); }
}

// ---------------------------------------------------------------- 编译 worker 单例
// 原来每个终端各一份工具链（28MB × N），且失败后该终端的 compiler 引用不会清 → 永久不可编译。
// 现在全局共享一个；出错就整个丢弃，下次编译自动重建。
const shared = {
  worker: null, ready: null, resolve: null, reject: null,
  byId: new Map(),        // 全局编译 id → OiPty
  nextId: 1,              // ⚠️ 全局自增：每个终端各自的 reqId 会撞车（都是 1）
  ptys: new Set(),        // 所有活着的终端（用于广播工具链加载日志）
};

function assetsBase() {
  const cfg = vscode.workspace.getConfiguration("oiCpp");
  const custom = String(cfg.get("assetsBaseUrl", "") || "").replace(/\/+$/, "");
  // 外置资产只对浏览器版有意义（桌面版直接读扩展目录里的文件）
  if (custom && platform.isWeb) return custom;
  return platform.assetsBase();
}

function workerUrl(name) { return platform.workerRef(name); }

/**
 * 首次激活时**后台**把编译/调试要用的资产预拉一遍（灌 HTTP 缓存）。
 *
 * 要点（详见 src/web/preload.js 的注释）：
 *   · fire-and-forget：不 await、不阻塞任何命令；延迟 1.5s 让激活先跑完；
 *   · 不设超时；单个失败只记日志；全程不抛异常；
 *   · 不含 clangd（26M，打开 .cpp 时它自己会加载）；
 *   · 桌面版跳过（资产在本地磁盘，fetch 没意义）。
 */
// 预加载状态：每次打开 .cpp 都重新预热一遍（浏览器可能已经把缓存挤掉了），
// 但同一时刻只允许一轮；上一轮还在跑就直接跳过（"没有在加载才触发"）。
const preloadState = { running: false, lastDoneAt: 0 };
/** 字节数格式化：给用户看的（MB 一位小数） */
const fmtMB = (n) => `${(Number(n || 0) / 1048576).toFixed(1)}MB`;

/**
 * 后台预热编译/调试资产（灌 HTTP 缓存）。
 *
 * 用户可见行为（按需求确认过的）：
 *   · **只有一轮**：同时只跑一个预加载；上一轮没结束就不再开新的（每次打开 .cpp 会尝试触发）；
 *   · **只弹一个进度条**，数值是**全部文件的合计**（已下载/缓存 ÷ 总大小），不按文件分开；
 *   · **超过 10 秒还没下完才弹**通知 —— 缓存全命中时几乎瞬间结束，不该闪一下；
 *   · 通知可取消；结束后状态栏给一句结果（取消/失败/完成）。
 *
 * 工程约束（详见 src/web/preload.js）：不阻塞任何命令、不设超时、单项失败只记日志、
 * 不含 clangd（打开 .cpp 时它自己会加载）、桌面版跳过、`oiCpp.preload=false` 可整体关闭。
 */
function startPreload(trigger = "activate") {
  try {
    if (!platform.isWeb) { if (trigger === "activate") logLine("预加载: 桌面版跳过（资产在本地磁盘，直接 fs 读取）"); return; }
    if (vscode.workspace.getConfiguration("oiCpp").get("preload", true) !== true) {
      if (trigger === "activate") logLine("预加载: 已被设置关闭（oiCpp.preload=false）");
      return;
    }
    if (preloadState.running) { logLine(`预加载: 上一轮还在进行，跳过本次触发（${trigger}）`); return; }
    preloadState.running = true;

    const base = assetsBase();
    const t0 = Date.now();
    logLine(`预加载: 开始（${trigger}，后台进行，不影响使用）${base}`);
    const ac = new AbortController();
    const status = { loaded: 0, total: 0, cached: 0, cancelled: false, finished: false };
    let notify = null;          // 只有真的超过 10s 才创建（保证全程只有一个条）
    let lastPct = 0;
    let doneSignal = null;
    const doneP = new Promise((r) => { doneSignal = r; });

    // 通知里的文字：合计大小（+ 缓存命中量），不显示单个文件名
    const text = () => {
      const size = status.total
        ? `${fmtMB(status.loaded)} / ${fmtMB(status.total)}`
        : (status.loaded ? fmtMB(status.loaded) : "正在测量大小…");
      return status.cached ? `${size} · 缓存 ${fmtMB(status.cached)}` : size;
    };
    const flush = () => {
      if (!notify || status.finished) return;
      const pct = status.total ? Math.min(100, Math.floor((status.loaded / status.total) * 100)) : null;
      try {
        notify.progress.report({
          message: text(),
          increment: pct == null ? undefined : Math.max(0, pct - lastPct),
        });
      } catch { }
      if (pct != null) lastPct = pct;
    };

    // 10 秒还没完 → 弹官方通知进度条（整轮只有一个）
    const timer = setTimeout(() => {
      if (status.finished || notify) return;
      try {
        vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: "WebC++ 预加载编译/调试资产",
          cancellable: true,
        }, (progress, token) => {
          notify = { progress };
          token.onCancellationRequested(() => { try { ac.abort(); } catch { } });
          flush();                       // 把已经走过的百分比一次性补上
          return doneP;                  // 预加载结束时这个通知自动收起
        });
      } catch (e) { logLine("预加载: 打开进度通知失败（忽略）: " + ((e && e.message) || e)); }
    }, NOTIFY_AFTER_MS);

    preloadAssets({
      base,
      log: (m) => logLine(m),
      signal: ac.signal,
      lookupTransferSize: makeCacheLookup(),
      onProgress: (e) => {
        status.loaded = e.loaded || 0;
        status.total = e.total || 0;
        status.cached = e.cached || 0;
        if (e.cancelled) status.cancelled = true;
        flush();
      },
    }).then((r) => {
      status.finished = true;
      clearTimeout(timer);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (r && r.cancelled) {
        logLine(`预加载: 已取消（完成 ${fmtMB(r.bytes)}，${secs}s）`);
        vscode.window.setStatusBarMessage(`$(circle-slash) WebC++ 预加载已取消（完成 ${fmtMB(r.bytes)}）`, 6000);
      } else if (r && r.ok) {
        logLine(`预加载完成 ${fmtMB(r.bytes)} / ${fmtMB(r.total)} / ${secs}s`);
        // 只有弹过通知（说明真的慢）才在状态栏再报一句，快速命中缓存时保持安静
        if (notify) {
          const hit = r.cachedBytes ? `（其中缓存命中 ${fmtMB(r.cachedBytes)}）` : "";
          vscode.window.setStatusBarMessage(`$(check) WebC++ 预加载完成 ${fmtMB(r.bytes)}${hit}`, 6000);
        }
      } else if (r) {
        logLine(`预加载: 部分失败（${fmtMB(r.bytes)}/${fmtMB(r.total)}），用到时会重试`);
        vscode.window.setStatusBarMessage(`$(warning) WebC++ 预加载部分失败，用到时会重试`, 8000);
      }
    }).catch((e) => {
      status.finished = true;
      clearTimeout(timer);
      logLine("预加载: 意外失败（忽略）: " + ((e && e.message) || e));
    }).finally(() => {
      clearTimeout(timer);
      status.finished = true;
      preloadState.running = false;
      preloadState.lastDoneAt = Date.now();
      try { doneSignal(); } catch { }    // 收起通知
    });
  } catch (e) {
    preloadState.running = false;
    logLine("预加载: 启动失败（忽略）: " + ((e && e.message) || e));
  }
}

/**
 * 判断某个资源这次是否**来自缓存**（浏览器 Resource Timing 的 transferSize 为 0 即命中）。
 * 拿不到就返回 null（不谎报"缓存命中"）。
 */
function makeCacheLookup() {
  try {
    if (typeof performance === "undefined" || typeof performance.getEntriesByName !== "function") return null;
    return (url) => {
      try {
        const es = performance.getEntriesByName(url);
        const e = es && es[es.length - 1];
        if (!e || typeof e.transferSize !== "number") return null;
        return e.transferSize;
      } catch { return null; }
    };
  } catch { return null; }
}

// ---------------- 编译缓存：代码/参数没变就直接复用上一版产物 ----------------
// 实现放在 ./compile-cache.js（纯逻辑、有回归测试 test/compile-cache.mjs）：
// 那个文件里详细记录了这块曾经被写坏过的三种方式，尤其是"ArrayBuffer 进 globalState
// 在 Web 端会被 JSON 序列化成 {}"这个只有 vscode.dev 才暴露的坑。
// ⚠️ 必须懒创建：ctx（extension context）是 activate() 里才有的，模块加载时还是 null。
//    直接在这里建就等于把缓存接到一个假的 memento 上 → 又是"缓存永远不命中"。
let _compileCache = null;
const realCompileCache = () => {
  if (!_compileCache) {
    _compileCache = createCompileCache(ctx.globalState, { log: (s) => debugLog("[缓存] " + s) });
  }
  return _compileCache;
};
const compileCache = {
  get: (k) => realCompileCache().get(k),
  put: (k, wasm, ms) => realCompileCache().put(k, wasm, ms),
};

/**
 * 编译一份源码并拿到 wasm 字节（给调试/符号功能用，不走终端）。
 * 用独立的 id 走同一套编译 worker；opt/debugInfo 可覆盖。
 * ⚠️ 代码/参数没变时直接命中缓存 —— "保存后反复 F5"不再重复编译。
 */
function compileForDebug({ source, fileName, flags, opt = 0, debugInfo = true, debugStub = false }) {
  const key = "dbg:" + hash64(source + "|" + fileName + "|" + flags + "|" + opt + "|" + (debugInfo ? 1 : 0) + "|" + (debugStub ? 1 : 0));
  const cached = compileCache.get(key);
  if (cached) {
    debugLog(`② 编译缓存命中（${fileName}，上次耗时 ${cached.ms}ms，跳过编译）`);
    return Promise.resolve({ wasm: cached.wasm, log: "[cache] 未重新编译（代码与参数未变化）", exit: 0, ms: 0 });
  }
  return new Promise(async (resolve, reject) => {
    let wasmBytes = null, took = 0;
    try {
      await getCompiler();
    } catch (e) {
      reject(e); return;
    }
    const id = shared.nextId++;
    const timer = setTimeout(() => {
      if (shared.byId.has(id)) { shared.byId.delete(id); reject(new Error("编译超时（60s）")); }
    }, 60000);
    shared.byId.set(id, {
      _msg(m) {
        clearTimeout(timer);
        // ⚠️ 编译成功要写缓存：以前 F5 调试路径只读不写 → 第二次 F5 还是全量重编
        if (m.ok && m.wasm) {
          try { compileCache.put(key, new Uint8Array(m.wasm), m.ms || 0); } catch {}
        }
        if (m.ok) resolve(m);
        else reject(new Error("编译失败: " + String(m.log || "").split("\n").slice(0, 8).join(" | ")));
      },
      _fail(msg) { clearTimeout(timer); reject(new Error(msg)); },
    });
    // ⚠️ 必须把 debugStub 一起传下去：调试构建靠它链入 wdb 的 src/stub/wdb-stub.c，
    //    否则产物里没有 import "oi"."probe"，插桩阶段会直接报"桩没链上"
    shared.worker.postMessage({ type: "compile", id, source, fileName, flags, opt, debugInfo, debugStub });
  });
}

/** 符号引擎单例：只做 DWARF 查询（行映射/变量），不负责运行程序 */
const symbols = { engine: null, ready: null, memory: null, frame: null };

function getSymbolsEngine() {
  if (symbols.engine) return symbols.ready;
  symbols.ready = (async () => {
    // 宿主 4 个同步 getter：读"暂停快照"（由调试会话在 paused 时塞进来）
    const host = {
      getWasmLinearMemory(offset, length) {
        const mem = symbols.memory;
        if (!mem) throw new Error("当前没有暂停快照");
        // 分段快照：按绝对地址取，缺失区间补 0
        if (typeof mem.read === "function") return mem.read(offset, length);
        return mem.buffer.slice(mem.byteOffset + offset, mem.byteOffset + offset + length);
      },
      // 暂停时插桩会把所有 wasm local 写进线性内存的一页里（frame.base + i*8），
      // 这里按类型读出对应值交给 DWARF 引擎（clang -O0 下局部变量通常就在 wasm local 里）
      getWasmLocal(local) {
        const mem = symbols.memory, f = symbols.frame;
        if (!mem || !f) throw new Error("当前没有暂停快照");
        const type = (f.types || [])[local];
        const dv = typeof mem.dv === "function" ? mem.dv(f.base + local * 8, 8)
          : new DataView(mem.buffer, mem.byteOffset + f.base + local * 8, 8);
        switch (type) {
          case 0x7f: return { type: "i32", value: dv.getInt32(0, true) };
          case 0x7e: return { type: "i64", value: dv.getBigInt64(0, true) };
          case 0x7d: return { type: "f32", value: dv.getFloat32(0, true) };
          case 0x7c: return { type: "f64", value: dv.getFloat64(0, true) };
          default: throw new Error("不支持的 local 类型: " + type);
        }
      },
      getWasmGlobal(global) {
        const mem = symbols.memory, f = symbols.frame;
        if (!mem || !f || !f.globalsBase) throw new Error("当前没有 globals 快照");
        const type = (f.globalTypes || [])[global];
        const dv = typeof mem.dv === "function" ? mem.dv(f.globalsBase + global * 8, 8)
          : new DataView(mem.buffer, mem.byteOffset + f.globalsBase + global * 8, 8);
        switch (type) {
          case 0x7f: return { type: "i32", value: dv.getInt32(0, true) };
          case 0x7e: return { type: "i64", value: dv.getBigInt64(0, true) };
          case 0x7d: return { type: "f32", value: dv.getFloat32(0, true) };
          case 0x7c: return { type: "f64", value: dv.getFloat64(0, true) };
          default: throw new Error("不支持的 global 类型: " + type);
        }
      },
      getWasmOp() { throw new Error("operand stack 不可用"); },
    };
    // web：跑我们打包的浏览器版引擎 worker（blob 兜底）；
    // 桌面：跑上游 node 版引擎（自己用 fs 读 wasm，没有 __wdbConfig/__wdbReady 握手）
    const engine = platform.isWeb
      ? new DwarfEngine(workerUrl("dwarfWorker.js"), assetsBase(), host)
      : new DwarfEngine("(node-engine)", assetsBase(), host, {
          createWorker: () => platform.createDwarfEngineWorker({ log: debugLog }),
          assumeReady: true,
        });
    engine.verbose = vscode.workspace.getConfiguration("oiCpp").get("verbose", false);
    await engine.start();
    symbols.engine = engine;
    return engine;
  })();
  symbols.ready.catch(() => { symbols.engine = null; symbols.ready = null; });
  return symbols.ready;
}

/** 探针命令：验证「源码行 ↔ wasm offset」映射（调试功能的地基） */
async function symbolsProbe() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { vscode.window.showWarningMessage("先打开一个 C/C++ 文件"); return; }
  const doc = ed.document;
  const fileName = doc.uri.path.split("/").pop() || "main.cpp";
  const cfg = vscode.workspace.getConfiguration("oiCpp");
  const out = vscode.window.createOutputChannel("WebC++ 符号");
  out.show(true);
  const log = (s) => { out.appendLine(s); console.log("[oi symbols]", s); };

  try {
    log("== 编译（-O0 -g）==");
    const t0 = Date.now();
    const r = await compileForDebug({
      source: doc.getText(), fileName,
      flags: String(cfg.get("flags", "-std=c++20")),
      opt: 0, debugInfo: true,
    });
    log(`编译 OK，wasm ${(r.wasm.byteLength / 1024).toFixed(0)}KB，${Date.now() - t0}ms`);

    log("== 启动 DWARF 引擎（首次约加载 12.7MB）==");
    const t1 = Date.now();
    const engine = await getSymbolsEngine();
    log(`引擎就绪，${Date.now() - t1}ms`);

    const modId = "doc:" + fileName;
    const wasmUrl = "file:///workspace/" + fileName;
    const sources = await engine.addRawModule(modId, wasmUrl, r.wasm);
    log(`源文件数 ${Array.isArray(sources) ? sources.length : "?"}，其中本项目文件:`);
    for (const u of (sources || []).filter((u) => /workspace/.test(u)).slice(0, 5)) log("  " + u);

    const srcUrl = "file:///workspace/" + fileName;
    const lines = await engine.getMappedLines(modId, srcUrl);
    log(`可下断点的行(${lines ? lines.length : 0}): ${JSON.stringify((lines || []).slice(0, 40))}`);

    log("== 抽查：行 → raw offset → 回映射 ==");
    for (const line of (lines || []).slice(0, 6)) {
      let hit = null;
      for (let col = 0; col <= 40 && !hit; col++) {
        const rs = await engine.sourceLocationToRawLocation({ rawModuleId: modId, sourceFileURL: srcUrl, lineNumber: line, columnNumber: col });
        if (rs && rs.length) hit = { col, r: rs[0] };
      }
      if (!hit) { log(`  line ${line}: (无)`); continue; }
      const back = await engine.rawLocationToSourceLocation({ rawModuleId: modId, codeOffset: hit.r.startOffset, inlineFrameIndex: 0 });
      const b = (back || [])[0];
      log(`  line ${line} (col ${hit.col}) → [${hit.r.startOffset},${hit.r.endOffset}) → ${b ? b.sourceFileURL.split("/").pop() + ":" + b.lineNumber : "?"}`);
    }
    log("== 完成 ==");
    vscode.window.showInformationMessage("WebC++ 符号探针完成，见「WebC++ 符号」输出面板");
  } catch (e) {
    log("失败: " + ((e && (e.stack || e.message)) || e));
    vscode.window.showErrorMessage("符号探针失败: " + ((e && e.message) || e));
  }
}

// ---------------------------------------------------------------- 调试（DAP）
let pendingDebugTarget = null;
/** 调试日志统一出口：Output 面板 + DevTools（否则浏览器里只能靠 DevTools，很难自查） */
let debugChannel = null;
function debugLog(s) {
  if (!debugChannel) debugChannel = vscode.window.createOutputChannel("WebC++ 调试");
  const line = String(s);
  console.log("[oi debug]", line);
  try { debugChannel.appendLine(line); } catch {}
}
function showDebugLog() {
  if (!debugChannel) debugChannel = vscode.window.createOutputChannel("WebC++ 调试");
  try { debugChannel.show(true); } catch {}
}

// ---------------- anycode（网页版内置的"近似语言服务"）----------------
// 只处理它的 **C/C++ 标识符补全**：它会把工作区里所有出现过的声明都塞进补全候选，
// 和本扩展的 clangd 重复且不准。其它功能（跳转/引用/大纲/面包屑/常量高亮）一律不动，
// 也**不禁用扩展本身**；代码高亮与本项无关（anycode 没有 languages/grammars 贡献点，
// 高亮来自内置 cpp 语言基础 TextMate 语法）。
//
// ⚠️ 原则：**不擅自改用户设置**。首次在 C/C++ 语境下询问一次（推荐关闭），
//    用户选什么就记住什么，之后不再打扰；随时可用命令面板
//    「WebC++: 处理 anycode 补全」重新选择。
const ANYCODE_ASKED_KEY = "oiCpp.anycodeAsked.v1";
const anycodeState = { asking: false };

function anycodeExt() {
  try { return vscode.extensions.getExtension("ms-vscode.anycode") || null; } catch { return null; }
}
function anycodeAnswered() {
  try { return ctx.globalState.get(ANYCODE_ASKED_KEY, false) === true; } catch { return true; }
}
async function anycodeMarkAnswered() {
  try { await ctx.globalState.update(ANYCODE_ASKED_KEY, true); } catch {}
}
/** 读当前 anycode 的 completions 是否已关（以 cpp 为准） */
function anycodeCompletionsOff() {
  try {
    const c = vscode.workspace.getConfiguration("", { languageId: "cpp" });
    const v = c.get("anycode.language.features") || {};
    return v.completions === false;
  } catch { return false; }
}
/**
 * 关（off=true）或恢复（off=false）anycode 在 c/cpp 的补全。
 * 只改 completions 这一个键，并把已有的 [语言] 段展开合并，保留用户其它自定义。
 * 恢复时把该键删掉（写 undefined 即"移除语言级覆盖"）。
 */
async function anycodeSetCompletions(off) {
  const res = [];
  for (const lang of ["cpp", "c"]) {
    const c = vscode.workspace.getConfiguration("", { languageId: lang });
    const insp = c.inspect("anycode.language.features") || {};
    const cur = insp.globalLanguageValue || insp.workspaceLanguageValue || {};
    try {
      if (off) {
        await c.update("anycode.language.features", { ...cur, completions: false },
          vscode.ConfigurationTarget.Global, true);
        logLine(`anycode: 已关闭 [${lang}] 的标识符补全（completions=false）`);
        res.push(`${lang}:off`);
      } else {
        const next = { ...cur };
        delete next.completions;
        await c.update("anycode.language.features", Object.keys(next).length ? next : undefined,
          vscode.ConfigurationTarget.Global, true);
        logLine(`anycode: 已恢复 [${lang}] 的补全（移除 completions 覆盖，其它键保留）`);
        res.push(`${lang}:on`);
      }
    } catch (e) {
      logLine(`anycode: 写 [${lang}] 设置失败: ${(e && e.message) || e}`);
      res.push(`${lang}:fail`);
    }
  }
  return res;
}

/**
 * 首次询问（只问一次，结果记住）。trigger 仅用于日志。
 * 什么时候问：激活时已有 C/C++ 编辑器，或之后第一次打开 C/C++ 文件。
 * 不满足条件（没 anycode / 已问过 / 用户关掉询问 / 已经是关闭状态）就静默返回。
 */
async function maybeAskAnycode(trigger = "activate") {
  if (anycodeState.asking) return;
  if (!vscode.workspace.getConfiguration("oiCpp").get("anycodePrompt", true)) return;
  if (anycodeAnswered()) return;
  if (!anycodeExt()) return;
  if (anycodeCompletionsOff()) { await anycodeMarkAnswered(); return; }   // 已经是关的，不打扰
  anycodeState.asking = true;
  const CLOSE = "关闭 anycode 补全（推荐）";
  const KEEP = "保持原样";
  let pick = undefined;
  try {
    // 用官方消息框（MessageOptions.modal = 真正的模态弹窗），由 VS Code 自己渲染
    pick = await vscode.window.showInformationMessage(
      "要关闭 anycode 的 C/C++ 代码补全吗？",
      {
        modal: true,
        detail: "网页版（vscode.dev 等）内置的 anycode 是「按标识符猜」的近似语言服务：" +
          "它把工作区里所有出现过的声明都塞进补全候选，所以输入 int 会冒出满屏别的文件的语句，" +
          "与 WebC++ 内置的 clangd 重复且不准确。\n\n" +
          "· 只会关闭它的一项功能：补全（completions）\n" +
          "· 代码高亮、跳转、引用、大纲、面包屑全部保持原样\n" +
          "· 不会禁用 anycode 扩展本身，随时可用命令「WebC++: 处理 anycode 补全」改回来",
      },
      CLOSE, KEEP);
  } catch (e) {
    logLine("anycode: 询问失败: " + ((e && e.message) || e));
  } finally {
    anycodeState.asking = false;
    await anycodeMarkAnswered();          // 只弹一次：选了什么（或直接关掉）都算已处理
  }
  logLine(`anycode: 用户选择 ${pick === CLOSE ? "关闭补全" : pick === KEEP ? "保持原样" : "未选择"}（触发: ${trigger}）`);
  if (pick === CLOSE) {
    const r = await anycodeSetCompletions(true);
    if (r.some((x) => x.endsWith(":fail"))) {
      vscode.window.showWarningMessage("写入设置失败，可手动在 settings.json 添加：" +
        '"[cpp]": { "anycode.language.features": { "completions": false } }');
    }
  }
}

/** 命令：随时切换（不受"只问一次"限制） */
async function cmdAnycodeCompletions() {
  if (!anycodeExt()) {
    vscode.window.showInformationMessage("当前环境没有内置 anycode（桌面版通常没有），无需处理。");
    return;
  }
  const off = anycodeCompletionsOff();
  const CLOSE = "关闭 anycode 补全（推荐）";
  const OPEN = "恢复 anycode 默认补全";
  const pick = await vscode.window.showInformationMessage(
    `anycode 的 C/C++ 补全当前：${off ? "已关闭" : "开启"}`,
    {
      modal: true,
      detail: "anycode 是网页版内置的近似语言服务（按标识符猜）：补全里会混进工作区所有声明，" +
        "和 WebC++ 的 clangd 重复。\n\n只影响「补全」这一个功能，代码高亮、跳转、引用、大纲不受影响。",
    },
    ...(off ? [OPEN, CLOSE] : [CLOSE, OPEN]));
  if (pick === CLOSE) { await anycodeSetCompletions(true); vscode.window.setStatusBarMessage("$(check) anycode C/C++ 补全已关闭", 4000); }
  else if (pick === OPEN) { await anycodeSetCompletions(false); vscode.window.setStatusBarMessage("$(check) anycode C/C++ 补全已恢复", 4000); }
}

/**
 * 确保"任意文件都能下断点"。
 * VS Code 默认只在"有调试器的语言"里提供行号左侧断点凹槽；Web 版里 cpp 语言 id/调试器
 * 注册时序稍有差异就会出现点不动。debug.allowBreakpointsEverywhere 是官方开关。
 */
async function ensureBreakpointsEnabled() {
  try {
    const cfg = vscode.workspace.getConfiguration("debug");
    if (cfg.get("allowBreakpointsEverywhere") !== true) {
      await cfg.update("allowBreakpointsEverywhere", true, vscode.ConfigurationTarget.Global);
    }
    const now = vscode.workspace.getConfiguration("debug").get("allowBreakpointsEverywhere");
    debugLog(`断点凹槽: allowBreakpointsEverywhere=${now}，contributes.breakpoints=cpp/c`);
  } catch (e) {
    debugLog("开启 allowBreakpointsEverywhere 失败: " + ((e && e.message) || e));
  }
}

/** 在当前行切换断点（F9 / 右键菜单）：不依赖行号左侧凹槽，永远可用 */
async function toggleBreakpoint() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { vscode.window.showWarningMessage("先打开一个 C/C++ 文件"); return; }
  const doc = ed.document;
  const line0 = ed.selection.active.line;
  const uri = doc.uri.toString();
  const existing = vscode.debug.breakpoints.filter((b) => {
    if (!b.enabled || !b.location) return false;
    const loc = b.location;
    return loc.uri.toString() === uri && loc.range.start.line === line0;
  });
  if (existing.length) {
    vscode.debug.removeBreakpoints(existing);
    debugLog(`已删除断点 line ${line0 + 1}`);
    return;
  }
  const bp = new vscode.SourceBreakpoint(new vscode.Location(doc.uri, new vscode.Position(line0, 0)));
  vscode.debug.addBreakpoints([bp]);
  debugLog(`已添加断点 line ${line0 + 1}`);
}

/**
 * 从当前活动编辑器构造调试目标。
 * ⚠️ 命令（Ctrl+Shift+B 那条 / 标题栏按钮）和 **F5** 必须走同一份逻辑：
 *    F5 是通用启动，不经过我们的命令，以前只有命令里设了 pendingDebugTarget，
 *    F5 时它为空 → 适配器退化成硬编码的 "main.cpp"（编译一个不存在的空文件），
 *    表现为"调的不是当前文件、断点全灰"。
 */
function targetFromActiveEditor() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return null;
  const doc = ed.document;
  const rawName = doc.uri.path.split("/").pop() || "";
  let fileName = rawName;
  // uri.path 在部分 provider 下是 percent-encoded 的，解码后再用于编译文件名
  try { fileName = decodeURIComponent(rawName); } catch {}
  if (!/\.(cpp|cc|cxx|c)$/i.test(fileName)) return null;
  const cfg = vscode.workspace.getConfiguration("oiCpp");
  return {
    source: doc.getText(),
    fileName,
    sourceUri: doc.uri.toString(),
    flags: String(cfg.get("flags", "-std=c++20")),
  };
}

const NO_CPP_HINT = "先打开一个 C/C++ 源文件（.cpp/.cc/.cxx/.c）再调试";

async function startDebugging() {
  const t = targetFromActiveEditor();
  if (!t) { vscode.window.showWarningMessage(NO_CPP_HINT); return; }
  pendingDebugTarget = t;
  symbols.memory = null;
  symbols.frame = null;
  showDebugLog();
  debugLog(`== 开始调试 ${t.fileName} ==`);
  try {
    await vscode.debug.startDebugging(undefined, {
      type: "oi-cpp-wasm",
      request: "launch",
      name: "WebC++ 调试（WASM）",
    });
  } catch (e) {
    debugLog("启动调试失败: " + ((e && (e.stack || e.message)) || e));
    vscode.window.showErrorMessage("启动调试失败: " + ((e && e.message) || e));
  }
}

/** 调试专用终端：程序输出写这里，键盘输入直接喂给调试 worker 的 stdin */
let debugTerminal = null;
function getDebugTerminal(fileName) {
  // 上一次的调试终端（已结束的会话）先收掉，避免终端越积越多
  if (debugTerminal) { try { debugTerminal.term.dispose(); } catch {} debugTerminal = null; }
  const writeEmitter = new vscode.EventEmitter();
  const closeEmitter = new vscode.EventEmitter();
  let inputCb = null;
  let eofCb = null;
  // 和正常运行一致的行编辑：回车才提交一行，否则单按空格/字母就被程序读走
  const editor = createLineEditor({
    write: (s) => { try { writeEmitter.fire(s); } catch {} },
    send: (text, opts) => {
      if (opts && opts.eof) { try { eofCb?.(); } catch {} return; }
      if (text == null) return;
      if (inputCb) inputCb(new TextEncoder().encode(text));
    },
  });
  const pty = {
    onDidWrite: writeEmitter.event,
    onDidClose: closeEmitter.event,
    open() {},
    close() { try { closeEmitter.fire(); } catch {} },
    handleInput(data) { editor.input(data); },
  };
  const term = vscode.window.createTerminal({ name: `OI 调试 · ${fileName}`, pty });
  term.show();
  debugTerminal = {
    term,
    write: (s) => { try { writeEmitter.fire(String(s)); } catch {} },
    onInput: (cb) => { inputCb = cb; },
    onEof: (cb) => { eofCb = cb; },
    show: () => { try { term.show(); } catch {} },
  };
  return debugTerminal;
}

function registerDebugAdapter(c) {
  c.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory("oi-cpp-wasm", {
    createDebugAdapterDescriptor() {
      // ⚠️ 不要退化成 main.cpp：F5 / 从"运行和调试"面板启动时不会有 pendingDebugTarget
      const target = pendingDebugTarget || targetFromActiveEditor();
      pendingDebugTarget = null;   // 用掉即清：避免下次 F5 复用上一次的文件
      if (!target) {
        vscode.window.showWarningMessage(NO_CPP_HINT);
        throw new Error(NO_CPP_HINT);
      }
      debugLog(`创建调试适配器（${target.fileName}，${target.source.length} 字节源码）`);
      const terminal = getDebugTerminal(target.fileName);
      const adapter = new WasmDebugAdapter({
        target,
        // 横幅里显示 "wdb x.y.z ｜ WebC++ 0.2.x"（自己的版本从 package.json 读，别硬编码）
        version: (c.extension && c.extension.packageJSON && c.extension.packageJSON.version) || "?", 
        getEngine: () => getSymbolsEngine(),
        compile: (args) => compileForDebug(args),
        workerUrl: workerUrl("debugWorker.js"),
        createWorker: () => platform.createNamedWorker("debugWorker.js", { log: (m) => debugLog("[wdb] " + m) }),
        log: debugLog,
        onSnapshot: (mem) => { symbols.memory = mem; },
        onFrame: (f) => { symbols.frame = f; },
        terminal,
        // wdb 的 DAP 适配器是宿主无关的，状态提示由我们（VS Code）自己画
        onStatus: (text) => {
          try {
            symbols.status?.dispose?.();
            symbols.status = vscode.window.setStatusBarMessage(String(text), 600000);
          } catch {}
        },
      });
      return new vscode.DebugAdapterInlineImplementation(adapter);
    },
  }));
  // 会话结束也清一次（例如用户中途取消启动）
  c.subscriptions.push(vscode.debug.onDidTerminateDebugSession(() => { pendingDebugTarget = null; }));
  c.subscriptions.push(vscode.debug.registerDebugConfigurationProvider("oi-cpp-wasm", {
    provideDebugConfigurations: () => [{ type: "oi-cpp-wasm", request: "launch", name: "WebC++ 调试（WASM）" }],
    resolveDebugConfiguration: (_folder, config) => {
      const cfg = config && config.type ? config : { type: "oi-cpp-wasm", request: "launch", name: "WebC++ 调试（WASM）" };
      // F5 会直接到这里：把"当前活动文件"补成调试目标（命令路径已经设好了就不动）
      if (!pendingDebugTarget) {
        const t = targetFromActiveEditor();
        if (!t) { vscode.window.showWarningMessage(NO_CPP_HINT); return undefined; }  // undefined = 中止启动
        pendingDebugTarget = t;
        symbols.memory = null;
        symbols.frame = null;
        showDebugLog();
        debugLog(`== F5 启动调试 ${t.fileName} ==`);
      }
      return cfg;
    },
  }));
}

function resetCompiler() {
  if (shared.worker) { try { shared.worker.terminate(); } catch {} }
  shared.worker = null;
  shared.ready = null;
  shared.spawnPromise = null;
  shared.byId.clear();
}

function getCompiler() {
  if (shared.worker) return shared.ready;
  if (shared.spawnPromise) return shared.spawnPromise;   // 并发调用只创建一次
  // 创建是异步的（web 要 fetch+blob，桌面要起 worker_threads），所以整个过程包成 promise
  shared.spawnPromise = platform.createNamedWorker("compileWorker.js", { log: (m) => debugLog("[wdb] " + m) })
    .then((w) => {
      shared.worker = w;
      shared.ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("工具链加载超时（120s）")), 120000);
        shared.resolve = () => { clearTimeout(timer); resolve(); };
        shared.reject = (err) => { clearTimeout(timer); reject(err); };
        w.postMessage({ type: "init", assetsBase: assetsBase() });
      });
      // init 失败必须把 worker 丢掉：否则之后每个终端都会立刻拿到这个已 reject 的 promise
      shared.ready.catch(() => { resetCompiler(); });
      w.onmessage = (ev) => onCompileWorkerMessage(ev.data);
      w.onerror = (e) => { shared.reject?.(new Error("compile worker error: " + ((e && e.message) || e))); };
      return shared.ready;
    })
    .catch((e) => { shared.spawnPromise = null; throw e; });
  return shared.spawnPromise;
}

function onCompileWorkerMessage(m0) {
    const m = m0 || {};
    if (m.type === "compiled") {
      const owner = shared.byId.get(m.id);
      shared.byId.delete(m.id);
      owner?._msg(m);
      return;
    }
    if (m.type === "error") {
      const owner = m.id != null ? shared.byId.get(m.id) : null;
      if (owner) { shared.byId.delete(m.id); owner._msg(m); }
      else {
        for (const p of shared.byId.values()) p._fail?.("编译失败: " + (m.message || "未知错误"));
        shared.byId.clear();
        shared.reject?.(new Error(m.message));
        resetCompiler();
      }
      return;
    }
    if (m.type === "ready") { shared.resolve?.(); return; }
    if (m.type === "log") { for (const p of shared.ptys) p._log?.(m.message); return; }
}

// ---------------------------------------------------------------- 会话（一个文件一个终端）
const sessions = new Map();   // fileName -> { pty, term }

function ensureTerminal(fileName = "main.cpp") {
  const cur = sessions.get(fileName);
  if (cur && !cur.pty.closed) { try { cur.term.show(); return cur.pty; } catch {} }
  const p = new OiPty(fileName);
  const t = vscode.window.createTerminal({ name: `${TERM_NAME} · ${fileName}`, pty: p });
  sessions.set(fileName, { pty: p, term: t });
  t.show();
  return p;
}

/** 轻量 64 位哈希（FNV-1a × 2 通道）：只用于缓存键，不用于安全 */
function hash64(str) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = (h1 ^ c) >>> 0; h1 = Math.imul(h1, 16777619) >>> 0;
    h2 = (h2 + Math.imul(c + i, 2654435761)) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0"));
}
function compileKey(source, fileName) {
  const cfg = vscode.workspace.getConfiguration("oiCpp");
  const flags = String(cfg.get("flags", ""));
  const opt = cfg.get("opt", 2);
  return "run:" + hash64(source + "|" + fileName + "|" + flags + "|" + opt);
}

async function runActive() {
  console.log("[oi-cpp-wasm] runInTerminal 被调用");
  const ed = vscode.window.activeTextEditor;
  if (!ed) { vscode.window.showWarningMessage("先打开一个 C/C++ 文件"); return; }
  const doc = ed.document;
  const fileName = doc.uri.path.split("/").pop() || "main.cpp";
  if (!/\.(cpp|cc|cxx|c)$/i.test(fileName)) { vscode.window.showWarningMessage("当前文件不是 C/C++ 源文件"); return; }
  const p = ensureTerminal(fileName);
  p.wln("");
  await p.runSource(doc.getText(), fileName, compileKey(doc.getText(), fileName));
}

// ⚠️ 模块级日志：区分"扩展 bundle 压根没被加载"和"activate 内部某步抛错"。
//    桌面端排查时这两者的处理完全不同，所以必须先留下这一行。
try { console.log("[WebC++] bundle loaded（activate 之前）"); } catch {}

export async function activate(c) {
  ctx = c;
  try { platform.setExtensionRoot(platform.isWeb ? c.extensionUri : c.extensionPath); } catch {}
  console.log("[oi-cpp-wasm] activate 开始");
  try {
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusItem.command = "oiCpp.runInTerminal";
    c.subscriptions.push(statusItem);
    setStatus("idle");

    logChannel = vscode.window.createOutputChannel("WebC++");
    c.subscriptions.push(logChannel);
    logLine(`activate 开始（v${(c.extension && c.extension.packageJSON && c.extension.packageJSON.version) || "?"}）`);
    // 环境自述：桌面 / 网页两种宿主的差异全靠这几行定位（尤其是 SAB 与跨源隔离）
    try {
      const hasSAB = typeof SharedArrayBuffer !== "undefined";
      logLine(`环境: uiKind=${vscode.env.uiKind === vscode.UIKind.Web ? "web" : "desktop"}` +
        ` crossOriginIsolated=${typeof self !== "undefined" && self.crossOriginIsolated === true}` +
        ` SharedArrayBuffer=${hasSAB}` +
        ` extensionUri=${ctx.extensionUri.scheme}:` +
        ` activeEditor=${vscode.window.activeTextEditor ? "有" : "无"}`);
      if (!hasSAB) {
        logLine("⚠ 当前环境没有 SharedArrayBuffer：终端交互输入与断点调试依赖它，可能不可用" +
          "（网页版需要 COOP/COEP 跨源隔离；桌面版跑 Web 扩展宿主时同理）");
      }
    } catch (e) { logLine("环境自述失败: " + ((e && e.message) || e)); }
    c.subscriptions.push(vscode.commands.registerCommand("oiCpp.showLogs", () => logChannel.show(true)));
    c.subscriptions.push(vscode.commands.registerCommand("oiCpp.copyLogs", async () => {
      // 输出面板内容无法直接读，改为重放最近日志（保存在环形缓冲里）
      await vscode.env.clipboard.writeText(logRing.join("\n"));
      vscode.window.showInformationMessage("已复制 WebC++ 日志（最近 " + logRing.length + " 行）");
    }));

    c.subscriptions.push(vscode.window.onDidCloseTerminal((t) => {
      for (const [name, s] of sessions) {
        if (s.term === t) { s.pty._dispose(); sessions.delete(name); break; }
      }
    }));

    c.subscriptions.push(vscode.commands.registerCommand("oiCpp.runInTerminal", runActive));
    c.subscriptions.push(vscode.commands.registerCommand("oiCpp.runTerminal", () => ensureTerminal("main.cpp")));
    c.subscriptions.push(vscode.commands.registerCommand("oiCpp.symbolsProbe", symbolsProbe));
    c.subscriptions.push(vscode.commands.registerCommand("oiCpp.debug", startDebugging));
    c.subscriptions.push(vscode.commands.registerCommand("oiCpp.anycodeCompletions", cmdAnycodeCompletions));
    c.subscriptions.push(vscode.commands.registerCommand("oiCpp.toggleBreakpoint", toggleBreakpoint));
    registerDebugAdapter(c);
    // 双保险：contributes.breakpoints 让行号凹槽可用；再把 allowBreakpointsEverywhere 也打开，
    // 即使某个 Web 构建忽略贡献点，行号左侧也一定能点出断点。
    // ⚠️ 必须单独 try：某些宿主（虚拟工作区/桌面 web 宿主）里改配置会抛错，
    //    以前它抛出去会把后面的 clangd 初始化、文件夹注册全带崩 → 表现为"扩展没激活"。
    try { ensureBreakpointsEnabled(); } catch (e) { logLine("⚠ 打开断点凹槽开关失败（不影响使用）: " + ((e && e.message) || e)); }
    // 网页版内置 anycode 的补全很吵：**询问用户**是否关闭（只问一次，不擅自改设置）
    const acEd = vscode.window.activeTextEditor;
    if (acEd && (acEd.document.languageId === "cpp" || acEd.document.languageId === "c")) {
      try { await maybeAskAnycode("activate"); } catch (e) { logLine("⚠ anycode 询问失败（不影响使用）: " + ((e && e.message) || e)); }
    }
    c.subscriptions.push(vscode.commands.registerCommand("oiCpp.restartLsp", async () => {
      resetClangdFatal();          // 手动重启时清掉"已停用"标记
      await stopClangd().catch(() => {});
      lspPromise = null;
      await ensureLsp();
    }));

    // 只读虚拟 FS：让 clangd 虚拟路径（bits/stdc++.h 等）可点击/可跳转
    try { c.subscriptions.push(registerHeaderFs(assetsBase)); logLine("头文件虚拟 FS 已注册"); }
    catch (e) { logLine("⚠ 注册头文件虚拟 FS 失败: " + ((e && e.message) || e)); }

    // 浏览器本地文件夹（File System Access API）：vscode-web 自带的"打开文件夹"在空窗口下是坏的
    try {
      if (platform.isWeb) { registerLocalFolder(c); logLine("本地文件夹（FSA）命令已注册"); }
      else logLine("桌面版：跳过 FSA 文件夹命令（用 VS Code 自带的打开文件夹）");
    }
    catch (e) {
      logLine("本地文件夹注册失败（网页版专属功能，桌面端可忽略）: " + ((e && e.message) || e));
    }

    // 第一次打开 C/C++ 文件时再问一次（激活时可能还没打开任何 cpp）
    c.subscriptions.push(vscode.workspace.onDidOpenTextDocument((d) => {
      if (d.languageId !== "cpp" && d.languageId !== "c") return;
      maybeAskAnycode("open-document").catch(() => {});
      // 每次打开 C/C++ 文件都重新预热一遍资产（浏览器可能已经把 HTTP 缓存挤掉了）；
      // startPreload 内部保证"上一轮没结束就跳过"，不会叠加。
      startPreload("open-document");
    }));

    const maybeLsp = () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (doc && doc.languageId === "cpp") ensureLsp();
    };
    c.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(maybeLsp));
    c.subscriptions.push(vscode.workspace.onDidOpenTextDocument((d) => {
      if (d.languageId === "cpp" || d.languageId === "c") ensureLsp();
    }));
    // 关闭文件后若已经没有 cpp 文档 → 释放 clangd（worker + 121MB wasm 内存一起回收）
    c.subscriptions.push(vscode.workspace.onDidCloseTextDocument(() => { releaseLspIfIdle(); }));
    // 切换/关闭工作区文件夹 → 彻底重启，避免旧实例残留（内存 5G+ 的根因之一）
    c.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { restartLspClean(); }));
    try { maybeLsp(); } catch (e) { logLine("⚠ 启动 clangd 失败（不影响编译运行）: " + ((e && e.message) || e)); }
    // 首次启动就后台预热编译/调试资产（不影响任何操作，纯网络请求）
    startPreload("activate");
    logLine("activate 完成");
    console.log(`[oi-cpp-wasm] activate 完成 v${(c.extension && c.extension.packageJSON && c.extension.packageJSON.version) || "?"}（命令: runInTerminal/debug/openFolder/restartLsp 已注册）`);
  } catch (e) {
    const msg = (e && (e.stack || e.message)) || String(e);
    try { logLine("✗ activate 失败: " + msg); } catch {}
    console.error("[WebC++] activate 失败", e);
    try { vscode.window.showErrorMessage("WebC++ 激活失败: " + msg); } catch {}
  }
}

export function deactivate() {
  for (const s of sessions.values()) { try { s.pty._dispose(); } catch {} }
  sessions.clear();
  resetCompiler();
  stopClangd();
}
