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
import { startClangd, stopClangd } from "./lsp.js";
import { registerHeaderFs } from "./headerfs.js";
import { DwarfEngine } from "./dwarf.js";
import { WasmDebugAdapter } from "./debugAdapter.js";

const TERM_NAME = "OI C++ (WASM)";
const SAB_SIZE = 8 + 64 * 1024;
const S_EMPTY = 0, S_DATA = 1, S_EOF = 3;

let ctx;
let statusItem = null;

function setStatus(kind) {
  if (!statusItem) return;
  const map = {
    idle: ["$(check) OI C++: 就绪", "Ctrl+Shift+B 编译运行当前文件"],
    compile: ["$(sync~spin) OI C++: 编译中…", "正在用 WASM clang 编译，完成后自动运行"],
    run: ["$(play) OI C++: 运行中", "程序在终端里等待输入（Ctrl+D=EOF，Ctrl+C=终止）"],
  };
  const [text, tip] = map[kind] || map.idle;
  statusItem.text = text;
  statusItem.tooltip = tip;
  statusItem.show();
}

// ---------------------------------------------------------------- 语言服务
let lspPromise = null;
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
  lspPromise = (async () => {
    // ⚠️ setStatusBarMessage 返回的 Disposable 必须手动 dispose，
    //    否则"启动中…"会一直挂在下边栏（之前给了 600s 超时，等于 10 分钟内都显示加载中）
    let busy = null;
    try {
      const files = await listCppFiles();
      const flags = String(cfg.get("flags", "-std=c++20"));
      busy = vscode.window.setStatusBarMessage("$(sync~spin) OI C++: 启动 clangd(WASM)…", 600000);
      const c = await startClangd(ctx, {
        files: files.length ? files : ["main.cpp"], flags,
        base: assetsBase(),
        opt: cfg.get("opt", 2),
        debug: cfg.get("debugInfo", true),
        verbose: cfg.get("verbose", false),
      });
      busy?.dispose(); busy = null;
      vscode.window.setStatusBarMessage("$(check) OI C++: clangd 就绪", 5000);
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
    this.write("\x1b[36m[OI C++] " + this.fileName + " 的运行终端\x1b[0m\r\n");
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

  _workerUrl(name) {
    // ⚠️ 不要用 toString(true)：skipEncoding 会让含空格/中文的扩展路径拼出非法 URL
    return vscode.Uri.joinPath(ctx.extensionUri, "dist", "web", name).toString();
  }
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

  // ---- 运行 worker（每次新建） ----
  _startRunner(wasmBuf) {
    this._killRunner();
    let url;
    try { url = this._workerUrl("runWorker.js"); } catch (e) { this.wln("[错误] " + e.message); return; }
    try {
      this.runner = new Worker(url);
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
  async runSource(source, fileName) {
    if (this.state === "compiling") { this.wln("\x1b[33m[正在编译，忽略本次请求]\x1b[0m"); return; }
    if (this.state === "running") { this.wln("\x1b[90m[停止上一个程序]\x1b[0m"); this._killRunner(); }

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
  if (custom) return custom;               // 资产外置（VSIX 不含 assets）时指向静态托管
  return vscode.Uri.joinPath(ctx.extensionUri, "assets").toString().replace(/\/+$/, "");
}

function workerUrl(name) {
  // ⚠️ 不要 toString(true)：skipEncoding 会让含空格/中文的扩展路径拼出非法 URL
  return vscode.Uri.joinPath(ctx.extensionUri, "dist", "web", name).toString();
}

/**
 * 编译一份源码并拿到 wasm 字节（给调试/符号功能用，不走终端）。
 * 用独立的 id 走同一套编译 worker；opt/debugInfo 可覆盖。
 */
function compileForDebug({ source, fileName, flags, opt = 0, debugInfo = true, debugStub = false }) {
  return new Promise(async (resolve, reject) => {
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
        if (m.ok) resolve(m);
        else reject(new Error("编译失败: " + String(m.log || "").split("\n").slice(0, 8).join(" | ")));
      },
      _fail(msg) { clearTimeout(timer); reject(new Error(msg)); },
    });
    // ⚠️ 必须把 debugStub 一起传下去：调试构建靠它链入 src/core/dbg-stub.c，
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
        return mem.buffer.slice(mem.byteOffset + offset, mem.byteOffset + offset + length);
      },
      // 暂停时插桩会把所有 wasm local 写进线性内存的一页里（frame.base + i*8），
      // 这里按类型读出对应值交给 DWARF 引擎（clang -O0 下局部变量通常就在 wasm local 里）
      getWasmLocal(local) {
        const mem = symbols.memory, f = symbols.frame;
        if (!mem || !f) throw new Error("当前没有暂停快照");
        const type = (f.types || [])[local];
        const dv = new DataView(mem.buffer, mem.byteOffset + f.base + local * 8, 8);
        switch (type) {
          case 0x7f: return { type: "i32", value: dv.getInt32(0, true) };
          case 0x7e: return { type: "i64", value: dv.getBigInt64(0, true) };
          case 0x7d: return { type: "f32", value: dv.getFloat32(0, true) };
          case 0x7c: return { type: "f64", value: dv.getFloat64(0, true) };
          default: throw new Error("不支持的 local 类型: " + type);
        }
      },
      getWasmGlobal() { throw new Error("globals 快照尚未实现"); },
      getWasmOp() { throw new Error("operand stack 不可用"); },
    };
    const engine = new DwarfEngine(workerUrl("dwarfWorker.js"), assetsBase(), host);
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
  const out = vscode.window.createOutputChannel("OI C++ 符号");
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
    vscode.window.showInformationMessage("OI C++ 符号探针完成，见「OI C++ 符号」输出面板");
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
  if (!debugChannel) debugChannel = vscode.window.createOutputChannel("OI C++ 调试");
  const line = String(s);
  console.log("[oi debug]", line);
  try { debugChannel.appendLine(line); } catch {}
}
function showDebugLog() {
  if (!debugChannel) debugChannel = vscode.window.createOutputChannel("OI C++ 调试");
  try { debugChannel.show(true); } catch {}
}

/**
 * 确保"任意文件都能下断点"。
 * VS Code 默认只在"有调试器的语言"里提供行号左侧断点凹槽；Web 版里 cpp 语言 id/调试器
 * 注册时序稍有差异就会出现点不动。debug.allowBreakpointsEverywhere 是官方开关。
 */
async function ensureBreakpointsEnabled() {
  try {
    const cfg = vscode.workspace.getConfiguration("debug");
    if (cfg.get("allowBreakpointsEverywhere") === true) return;
    await cfg.update("allowBreakpointsEverywhere", true, vscode.ConfigurationTarget.Global);
    debugLog("已开启 debug.allowBreakpointsEverywhere（否则 Web 版里行号左侧点不出断点）");
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

async function startDebugging() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { vscode.window.showWarningMessage("先打开一个 C/C++ 文件"); return; }
  const doc = ed.document;
  const fileName = doc.uri.path.split("/").pop() || "main.cpp";
  if (!/\.(cpp|cc|cxx|c)$/i.test(fileName)) { vscode.window.showWarningMessage("当前文件不是 C/C++ 源文件"); return; }
  const cfg = vscode.workspace.getConfiguration("oiCpp");
  pendingDebugTarget = {
    source: doc.getText(),
    fileName,
    sourceUri: doc.uri.toString(),
    flags: String(cfg.get("flags", "-std=c++20")),
  };
  symbols.memory = null;
  symbols.frame = null;
  showDebugLog();
  debugLog(`== 开始调试 ${fileName} ==`);
  try {
    await vscode.debug.startDebugging(undefined, {
      type: "oi-cpp-wasm",
      request: "launch",
      name: "OI C++ 调试（WASM）",
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
  const pty = {
    onDidWrite: writeEmitter.event,
    onDidClose: closeEmitter.event,
    open() {},
    close() { try { closeEmitter.fire(); } catch {} },
    handleInput(data) {
      // Pseudoterminal 不会自动回显：自己回显，否则用户以为"输入没反应"
      let echo = "";
      for (const ch of String(data)) {
        if (ch === "\r") echo += "\r\n";
        else if (ch === "\x7f") echo += "\b \b";     // 退格
        else echo += ch;
      }
      try { writeEmitter.fire(echo); } catch {}
      // 终端回车是 \r，程序里的 scanf/cin 期待 \n
      if (inputCb) inputCb(new TextEncoder().encode(String(data).replace(/\r/g, "\n")));
    },
  };
  const term = vscode.window.createTerminal({ name: `OI 调试 · ${fileName}`, pty });
  term.show();
  debugTerminal = {
    term,
    write: (s) => { try { writeEmitter.fire(String(s)); } catch {} },
    onInput: (cb) => { inputCb = cb; },
    show: () => { try { term.show(); } catch {} },
  };
  return debugTerminal;
}

function registerDebugAdapter(c) {
  c.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory("oi-cpp-wasm", {
    createDebugAdapterDescriptor() {
      const target = pendingDebugTarget || {
        source: "",
        fileName: "main.cpp",
        flags: String(vscode.workspace.getConfiguration("oiCpp").get("flags", "-std=c++20")),
      };
      debugLog(`创建调试适配器（${target.fileName}，${target.source.length} 字节源码）`);
      const terminal = getDebugTerminal(target.fileName);
      const adapter = new WasmDebugAdapter({
        target,
        getEngine: () => getSymbolsEngine(),
        compile: (args) => compileForDebug(args),
        workerUrl: workerUrl("debugWorker.js"),
        log: debugLog,
        onSnapshot: (mem) => { symbols.memory = mem; },
        onFrame: (f) => { symbols.frame = f; },
        terminal,
      });
      return new vscode.DebugAdapterInlineImplementation(adapter);
    },
  }));
  c.subscriptions.push(vscode.debug.registerDebugConfigurationProvider("oi-cpp-wasm", {
    provideDebugConfigurations: () => [{ type: "oi-cpp-wasm", request: "launch", name: "OI C++ 调试（WASM）" }],
    resolveDebugConfiguration: (_folder, config) =>
      config && config.type ? config : { type: "oi-cpp-wasm", request: "launch", name: "OI C++ 调试（WASM）" },
  }));
}

function resetCompiler() {
  if (shared.worker) { try { shared.worker.terminate(); } catch {} }
  shared.worker = null;
  shared.ready = null;
  shared.byId.clear();
}

function getCompiler() {
  if (shared.worker) return shared.ready;
  const url = workerUrl("compileWorker.js");
  try {
    shared.worker = new Worker(url);
  } catch (e) {
    return Promise.reject(new Error("创建编译 worker 失败: " + e.message));
  }
  shared.ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("工具链加载超时（120s）")), 120000);
    shared.resolve = () => { clearTimeout(timer); resolve(); };
    shared.reject = (err) => { clearTimeout(timer); reject(err); };
    shared.worker.postMessage({ type: "init", assetsBase: assetsBase() });
  });
  // init 失败必须把 worker 丢掉：否则之后每个终端都会立刻拿到这个已 reject 的 promise
  shared.ready.catch(() => { resetCompiler(); });
  shared.worker.onmessage = (ev) => {
    const m = ev.data || {};
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
  };
  shared.worker.onerror = (e) => {
    // worker 硬崩：所有在编译的终端都要回到 idle，不能永远卡 compiling
    for (const p of shared.byId.values()) p._fail?.("编译 worker 崩溃: " + (e.message || e));
    shared.byId.clear();
    shared.reject?.(new Error(e.message || "compile worker error"));
    resetCompiler();
  };
  return shared.ready;
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

async function runActive() {
  console.log("[oi-cpp-wasm] runInTerminal 被调用");
  const ed = vscode.window.activeTextEditor;
  if (!ed) { vscode.window.showWarningMessage("先打开一个 C/C++ 文件"); return; }
  const doc = ed.document;
  const fileName = doc.uri.path.split("/").pop() || "main.cpp";
  if (!/\.(cpp|cc|cxx|c)$/i.test(fileName)) { vscode.window.showWarningMessage("当前文件不是 C/C++ 源文件"); return; }
  const p = ensureTerminal(fileName);
  p.wln("");
  await p.runSource(doc.getText(), fileName);
}

export async function activate(c) {
  ctx = c;
  console.log("[oi-cpp-wasm] activate 开始");
  try {
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusItem.command = "oiCpp.runInTerminal";
    c.subscriptions.push(statusItem);
    setStatus("idle");

    c.subscriptions.push(vscode.window.onDidCloseTerminal((t) => {
      for (const [name, s] of sessions) {
        if (s.term === t) { s.pty._dispose(); sessions.delete(name); break; }
      }
    }));

    c.subscriptions.push(vscode.commands.registerCommand("oiCpp.runInTerminal", runActive));
    c.subscriptions.push(vscode.commands.registerCommand("oiCpp.runTerminal", () => ensureTerminal("main.cpp")));
    c.subscriptions.push(vscode.commands.registerCommand("oiCpp.symbolsProbe", symbolsProbe));
    c.subscriptions.push(vscode.commands.registerCommand("oiCpp.debug", startDebugging));
    c.subscriptions.push(vscode.commands.registerCommand("oiCpp.toggleBreakpoint", toggleBreakpoint));
    registerDebugAdapter(c);
    c.subscriptions.push(vscode.commands.registerCommand("oiCpp.restartLsp", async () => {
      stopClangd();
      lspPromise = null;
      await ensureLsp();
    }));

    // 只读虚拟 FS：让 clangd 虚拟路径（bits/stdc++.h 等）可点击/可跳转
    try { c.subscriptions.push(registerHeaderFs(assetsBase)); }
    catch (e) { console.warn("[oi-cpp-wasm] 注册头文件虚拟 FS 失败:", e && e.message); }

    const maybeLsp = () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (doc && doc.languageId === "cpp") ensureLsp();
    };
    c.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(maybeLsp));
    c.subscriptions.push(vscode.workspace.onDidOpenTextDocument((d) => { if (d.languageId === "cpp") ensureLsp(); }));
    maybeLsp();
    console.log("[oi-cpp-wasm] activate 完成");
  } catch (e) {
    console.error("[oi-cpp-wasm] activate 失败", e);
    vscode.window.showErrorMessage("oi-cpp-wasm 激活失败: " + ((e && e.message) || e));
  }
}

export function deactivate() {
  for (const s of sessions.values()) { try { s.pty._dispose(); } catch {} }
  sessions.clear();
  resetCompiler();
  stopClangd();
}
