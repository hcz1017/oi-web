// 调试运行 worker（经典 worker）：
//   运行【已插桩】的 wasm，通过 import "oi"."probe" 在语句起点回调；
//   命中"应暂停"的条件时：抓取调用栈 + 线性内存快照 → 通知宿主 → Atomics.wait 阻塞，等宿主恢复。
//
// 与宿主的控制协议（SharedArrayBuffer，Int32Array）：
//   ctrl[0] = 0（worker 正在等）/ 1（宿主已恢复）
//   ctrl[1] = 恢复模式：1=continue(只停断点) 2=stepIn(任意语句) 3=stepOver(同函数) 4=stepOut(离开当前函数)
import { WASI, File, OpenFile, ConsoleStdout } from "@bjorn3/browser_wasi_shim";

const post = (m, transfer) => self.postMessage(m, transfer || []);

let cfg = null;
let siteById = new Map();      // siteId -> { id, line, file, body, origOffset }
let enabledSites = new Set();  // 当前生效的断点 siteId
let ctrl = null;               // Int32Array(SAB)
let inst = null;
let resumeMode = 1;            // 默认 continue（只在断点处停）
let stopBody = -1;             // 最近一次暂停所在的函数体（stepOver/stepOut 用）
let running = false;

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

function probe(siteId) {
  const site = siteById.get(siteId);
  if (!site) return;
  const hit =
    resumeMode === 2 ? true :
    resumeMode === 3 ? site.body === stopBody :
    resumeMode === 4 ? site.body !== stopBody :
    enabledSites.has(siteId);
  if (!hit) return;

  // 暂停：抓栈 + 内存快照（快照给宿主的 DWARF 引擎读变量用）
  const frames = captureStack();
  let memory = null;
  try {
    const buf = inst && inst.exports && inst.exports.memory && inst.exports.memory.buffer;
    if (buf) memory = new Uint8Array(buf).slice(0);   // copy：程序还要继续跑
  } catch { /* ignore */ }

  post({ type: "paused", siteId, site, frames, memory });

  // 阻塞等待宿主：ctrl[0]==0 时等待，被 notify 后读取模式
  Atomics.wait(ctrl, 0, 0);
  const mode = Atomics.load(ctrl, 1) || 1;
  resumeMode = mode;
  stopBody = site.body;
  Atomics.store(ctrl, 0, 0);
}

async function run() {
  running = true;
  const fds = [
    new OpenFile(new File(new Uint8Array(0))),              // stdin：调试期暂时给空
    new ConsoleStdout((b) => post({ type: "stdout", text: decode(b) })),
    new ConsoleStdout((b) => post({ type: "stderr", text: decode(b) })),
  ];
  const wasi = new WASI([cfg.fileName || "program"], [], fds);
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
      oi: { probe },
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
    enabledSites = new Set(m.breakpoints || []);
    ctrl = new Int32Array(m.sab);
    run();
    return;
  }
  if (m.type === "breakpoints") { enabledSites = new Set(m.ids || []); return; }
  if (m.type === "resume") {
    // 宿主写模式到 ctrl[1]，把 ctrl[0] 置 1 并唤醒
    Atomics.store(ctrl, 1, m.mode || 1);
    Atomics.store(ctrl, 0, 1);
    Atomics.notify(ctrl, 0);
    return;
  }
  if (m.type === "shutdown") { try { self.close(); } catch {} }
};

self.addEventListener("error", (e) => post({ type: "error", message: "worker error: " + ((e && (e.message || e.error)) || e) }));
self.addEventListener("unhandledrejection", (e) => post({ type: "error", message: "worker rejection: " + ((e && e.reason && (e.reason.stack || e.reason.message)) || e) }));
