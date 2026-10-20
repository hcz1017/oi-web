// 调试运行 worker（经典 worker）：
//   运行【已插桩】的 wasm，通过 import "oi"."probe" 在语句起点回调；
//   命中"应暂停"的条件时：抓取调用栈 + 线性内存快照 → 通知宿主 → Atomics.wait 阻塞，等宿主恢复。
//
// 与宿主的控制协议（SharedArrayBuffer，Int32Array）：
//   ctrl[0] = 0（worker 正在等）/ 1（宿主已恢复）
//   ctrl[1] = 恢复模式：1=continue(只停断点) 2=stepIn(任意语句) 3=stepOver(同函数) 4=stepOut(离开当前函数)
import { WASI, File, OpenFile, ConsoleStdout, Fd } from "@bjorn3/browser_wasi_shim";

const post = (m, transfer) => self.postMessage(m, transfer || []);

// stdin 协议与 runWorker.js 完全一致：
//   ctrl[0] state: 0=空闲(宿主可写) 1=有数据(worker 可取) 3=EOF；ctrl[1] len；data 从偏移 8 开始
/** 终端 stdin：单槽握手 + _justServed（防止一次 fd_read 的第二个 iovec 假 EOF） */
class TermStdin extends Fd {
  constructor(sab) {
    super();
    this.ctrl = new Int32Array(sab, 0, 2);
    this.buf = new Uint8Array(sab, 8);
    this._justServed = false;
  }
  fd_fdstat_get() {
    return { ret: 0, fdstat: { fs_filetype: 2, fs_flags: 0, fs_rights_base: 0xffffffffn, fs_rights_inheriting: 0xffffffffn } };
  }
  resetJustServed() { this._justServed = false; }
  fd_read(size) {
    for (;;) {
      const st = Atomics.load(this.ctrl, 0);
      if (st === 3) { this._justServed = false; return { ret: 0, data: new Uint8Array(0) }; }
      if (st === 1) {
        const len = Atomics.load(this.ctrl, 1);
        const n = Math.min(size, len);
        const data = this.buf.slice(0, n);
        const rest = len - n;
        if (rest > 0) this.buf.copyWithin(0, n, len);
        Atomics.store(this.ctrl, 1, rest);
        Atomics.store(this.ctrl, 0, rest > 0 ? 1 : 0);
        Atomics.notify(this.ctrl, 0);
        post({ type: "consumed" });          // 让宿主继续冲刷输入队列
        this._justServed = true;
        return { ret: 0, data };
      }
      // 同一次 syscall 的第二个 iovec：已交付过就不能再阻塞等新输入
      if (this._justServed) { this._justServed = false; return { ret: 0, data: new Uint8Array(0) }; }
      // 等用户输入是正常状态（页面/终端关闭会 terminate worker）
      Atomics.wait(this.ctrl, 0, 0, 30000);
    }
  }
}

let cfg = null;
let siteById = new Map();      // siteId -> { id, line, file, body, origOffset }
let bp = null;                 // 断点位图（Int32Array on SharedArrayBuffer）：宿主可随时改，无需消息
let ctrl = null;               // Int32Array(SAB)
let inst = null;
let resumeMode = 1;            // 默认 continue（只在断点处停）
let stopBody = -1;             // 最近一次暂停所在的函数体（stepOver/stepOut 用）
let stopLine = -1;             // 最近一次暂停的行号（单步按行前进，避免同一条语句反复停）
let running = false;
let pending = null;            // probe 判定要暂停后暂存的站点（等 pause() 真正停）
let scratchBase = 0;           // locals 快照区（memory.grow 出来的那一页）
let bodyLocals = [];           // 每个函数体的 local 类型表（来自插桩）
let globalTypes = [];          // 全局变量类型表（插桩时按 wasm global 索引顺序）

/** 从 JS 栈里提取 wasm 帧（V8：at name (wasm-function[12]:0x1a5)） */
function captureStack() {
  const frames = [];
  const lines = String(new Error().stack || "").split("\n");
  for (const line of lines) {
    const m = /wasm-function\[(\d+)\]:0x([0-9a-f]+)/i.exec(line);
    if (!m) continue;
    const nm = /^\s*at\s+(?:([^\s(]+)\s*\()?/.exec(line);
    frames.push({
      funcIndex: Number(m[1]),
      offset: parseInt(m[2], 16),
      name: nm && nm[1] ? nm[1].split(".").pop() : "",
    });
  }
  return frames;
}

/** 探针：判断是否需要暂停；需要则返回 locals 快照地址（0 = 不暂停） */
function probe(siteId) {
  const site = siteById.get(siteId);
  if (!site) return 0;
  const isBreakpoint = !!bp && (Atomics.load(bp, siteId >>> 5) & (1 << (siteId & 31))) !== 0;
  const sameLine = resumeMode !== 1 && site.line === stopLine;
  const hit =
    resumeMode === 2 ? !sameLine :
    resumeMode === 3 ? (!sameLine && site.body === stopBody) :
    resumeMode === 4 ? (!sameLine && site.body !== stopBody) :
    isBreakpoint;
  if (!hit) return 0;

  // locals 快照区：第一次暂停时 grow 一页并复用（不碰堆/栈）
  if (!scratchBase) {
    try {
      const old = inst.exports.memory.buffer.byteLength;
      inst.exports.memory.grow(1);
      scratchBase = old;
    } catch (e) {
      scratchBase = 0;
    }
  }
  pending = site;
  return scratchBase;
}

/** pause：locals 已写入快照区，这里抓栈 + 内存快照并阻塞等宿主恢复 */
function pause() {
  const site = pending;
  pending = null;
  if (!site) return;

  const frames = captureStack();
  let memory = null;
  try {
    const buf = inst && inst.exports && inst.exports.memory && inst.exports.memory.buffer;
    if (buf) memory = new Uint8Array(buf).slice(0);   // copy：程序还要继续跑
  } catch { /* ignore */ }

  const locals = bodyLocals[site.body] || [];
  post({
    type: "paused", siteId: site.id, site, frames, memory,
    localsBase: scratchBase, body: site.body,
    bodyLocals: locals,
    // globals 紧跟在 locals 之后；宿主按 globalTypes 解释
    globalsBase: scratchBase + locals.length * 8,
    globalTypes,
  });

  Atomics.wait(ctrl, 0, 0);
  const mode = Atomics.load(ctrl, 1) || 1;
  resumeMode = mode;
  stopBody = site.body;
  stopLine = site.line;
  Atomics.store(ctrl, 0, 0);
}

async function run() {
  running = true;
  // stdin：有 SAB 就接终端（交互输入）；没有则给"读即 EOF"的真 fd
  const stdin = cfg.stdinSAB ? new TermStdin(cfg.stdinSAB) : null;
  const fds = [
    stdin ?? new OpenFile(new File(new Uint8Array(0))),
    new ConsoleStdout((b) => post({ type: "stdout", text: decode(b) })),
    new ConsoleStdout((b) => post({ type: "stderr", text: decode(b) })),
  ];
  const wasi = new WASI([cfg.fileName || "program"], [], fds);
  // 一次 fd_read syscall 内的多个 iovec 共享 _justServed，出 syscall 复位（同 runWorker）
  if (stdin) {
    const origFdRead = wasi.wasiImport.fd_read;
    wasi.wasiImport.fd_read = (...args) => {
      try { return origFdRead(...args); }
      finally { try { stdin.resetJustServed(); } catch {} }
    };
  }
  let mod;
  try {
    mod = await WebAssembly.compile(cfg.wasm);
  } catch (e) {
    post({ type: "error", message: "插桩后的 wasm 无法编译: " + ((e && e.message) || e) });
    return;
  }
  try {
    inst = await WebAssembly.instantiate(mod, {
      wasi_snapshot_preview1: wasi.wasiImport,
      oi: { probe, pause },
    });
  } catch (e) {
    post({ type: "error", message: "实例化失败: " + ((e && e.message) || e) });
    return;
  }
  post({ type: "started" });
  let code = 0;
  try {
    code = wasi.start(inst) ?? 0;
  } catch (e) {
    if (e && typeof e.code === "number") code = e.code;
    else if (e && e.name === "WASIProcExit") code = e.code ?? 0;
    else post({ type: "error", message: "运行异常: " + ((e && (e.stack || e.message)) || e) });
  }
  running = false;
  post({ type: "exit", code });
}

const dec = new TextDecoder();
function decode(b) { return dec.decode(b, { stream: true }); }

self.onmessage = (ev) => {
  const m = ev.data || {};
  if (m.type === "init") {
    cfg = m;
    siteById = new Map((m.sites || []).map((s) => [s.id, s]));
    bodyLocals = m.bodyLocals || [];
    globalTypes = m.globalTypes || [];
    ctrl = new Int32Array(m.sab);
    bp = m.breakpointSab ? new Int32Array(m.breakpointSab) : null;
    run();
    return;
  }
  // 注意：暂停期间 worker 阻塞在 Atomics.wait，收不到消息 ——
  // 断点更新/恢复都由宿主直接改 SharedArrayBuffer（见 probe() 与 ctrl 协议）。
  if (m.type === "shutdown") { try { self.close(); } catch {} }
};

self.addEventListener("error", (e) => post({ type: "error", message: "worker error: " + ((e && (e.message || e.error)) || e) }));
self.addEventListener("unhandledrejection", (e) => post({ type: "error", message: "worker rejection: " + ((e && e.reason && (e.reason.stack || e.reason.message)) || e) }));
