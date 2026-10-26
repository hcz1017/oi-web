// 回归：trap（除零）走**完整 DAP 适配器链**（复刻 dap-flow.mjs 的骨架，源码换成除零）：
//   stopped(reason="exception") → stackTrace 顶帧在崩溃行 → variables 能列出 locals。
// 用户桌面端报告"RE 后不停、无帧、变量面板空"——这条链在 Node 里必须先证明是通的。
import { readFileSync } from "fs";
import { gunzipSync } from "zlib";
import { createRequire } from "module";
import { Worker as NodeWorker } from "worker_threads";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import * as esbuild from "esbuild";
import { Toolchain } from "../src/core/toolchain.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, "..");
const A = (f) => path.join(EXT, "assets", f);
const require = createRequire(import.meta.url);

let pass = true;
const must = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) pass = false; return c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

globalThis.Worker = class CompatWorker extends NodeWorker {
  constructor(bundleUrl) {
    super(path.join(HERE, "node-worker-self.cjs"), { workerData: { bundlePath: bundleUrl } });
    this.onmessage = null;
    this.on("message", (d) => { if (this.onmessage) this.onmessage({ data: d }); });
    this.addEventListener = (type, cb) => { if (type === "error") this.on("error", cb); };
  }
};

const outfile = path.join(EXT, ".dev/adapter-for-test.mjs");   // 与 dap-flow 共用
await esbuild.build({
  entryPoints: [path.join(EXT, "..", "wdb", "src", "adapters", "dap", "adapter.js")],
  bundle: true, format: "esm", platform: "neutral", target: ["es2022"], outfile,
  plugins: [{ name: "vscode-stub", setup(b) { b.onResolve({ filter: /^vscode$/ }, () => ({ path: path.join(HERE, "vscode-stub.mjs") })); } }],
  logLevel: "error",
});
const { WasmDebugAdapter } = await import(pathToFileURL(outfile).href);

const tc = new Toolchain({
  clangWasm: gunzipSync(readFileSync(A("clang.wasm.gz"))),
  lldWasm: gunzipSync(readFileSync(A("lld.wasm.gz"))),
  sysrootTar: gunzipSync(readFileSync(A("sysroot.tar.gz"))),
  compatBits: readFileSync(A("compat/bits/stdc++.h")),
});
let spawn;
try { ({ spawn } = require(path.join(EXT, "..", "wdb", ".dev-dwarf-pkg/node-test/index.cjs"))); }
catch { console.log("跳过：缺少 .dev/dwarf-pkg"); process.exit(0); }
// 变量读取宿主：暂停快照（由 adapter.onSnapshot 回填）→ SparseMem，等价于 debug-vars.mjs
let snap = null, frame = null, modId = null, codeBase = 0;
class SparseMem {
  constructor(size, segs) { this.size = size; this.segs = segs; }
  read(off, len) {
    for (const s of this.segs) {
      const end = s.offset + s.bytes.length;
      if (off >= s.offset && off + len <= end) return s.bytes.slice(off - s.offset, off - s.offset + len);
    }
    throw new Error(`no segment @${off}`);
  }
  dv(off, len) { return new DataView(this.read(off, len).buffer); }
}
const host = {
  getWasmLinearMemory(offset, length) {
    if (!snap) throw new Error("no snapshot");
    return snap.read(offset, length);
  },
  getWasmLocal(local) {
    if (!snap) throw new Error("no snapshot");
    if (!frame) throw new Error("no frame");
    const type = (frame.types || [])[local];
    const dv = snap.dv(frame.base + local * 8, 8);
    switch (type) {
      case 0x7f: return { type: "i32", value: dv.getInt32(0, true) };
      case 0x7e: return { type: "i64", value: dv.getBigInt64(0, true) };
      case 0x7d: return { type: "f32", value: dv.getFloat32(0, true) };
      case 0x7c: return { type: "f64", value: dv.getFloat64(0, true) };
      default: return { type: "i32", value: dv.getInt32(0, true) };
    }
  },
  getWasmGlobal(global) {
    if (!snap || !frame) throw new Error("no snapshot");
    const dv = snap.dv(frame.globalsBase + global * 8, 8);
    return { type: "i32", value: dv.getInt32(0, true) };
  },
  getWasmOp() { throw new Error("no stack"); },
};
const rpc = spawn(host).rpc;
await rpc.sendMessage("hello", [], false);
const usedModuleIds = new Set();
const engine = {
  addRawModule: (id, url, bytes) => {
    if (usedModuleIds.has(id)) return Promise.reject(new Error("Duplicate module"));
    usedModuleIds.add(id);
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const code = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    return rpc.sendMessage("addRawModule", id, undefined, { url, code });
  },
  getMappedLines: (...a) => rpc.sendMessage("getMappedLines", ...a),
  sourceLocationToRawLocation: (...a) => rpc.sendMessage("sourceLocationToRawLocation", ...a),
  rawLocationToSourceLocation: (...a) => rpc.sendMessage("rawLocationToSourceLocation", ...a),
  getFunctionInfo: (...a) => rpc.sendMessage("getFunctionInfo", ...a),
  listVariablesInScope: (...a) => rpc.sendMessage("listVariablesInScope", ...a),
  evaluate: (...a) => rpc.sendMessage("evaluate", ...a),
  getValueInfo: () => Promise.resolve(null),
  releaseObject: () => Promise.resolve(),
  removeRawModule: () => Promise.resolve(),
};

const SRC = `#include <cstdio>
int main() {
    int k = 2;
    int z = 0;
    int x = 1 / z;
    printf("%d\\n", x);
    return 0;
}`;
// 文件名可用环境变量覆盖（中文文件名曾在终端/调用栈里显示成 percent-encoded 的乱码）
const FILE_NAME = process.env.DAP_TRAP_FILE || "trapd.cpp";
const ENC = encodeURIComponent(FILE_NAME);
const target = { source: SRC, fileName: FILE_NAME, sourceUri: `vscode-test-web://mount/${ENC}`, flags: "-std=c++20" };

// 假调试终端：把适配器写进终端的所有文案捞出来（用户就是在这里看到
// "st%E8%A1%A8.cpp" 这种 percent-encoded 乱码的）
const termText = [];
const fakeTerminal = {
  write: (t) => termText.push(String(t)),
  onInput: () => {}, onEof: () => {}, show: () => {},
};
let modIdOut = null;
const adapter = new WasmDebugAdapter({
  target,
  getEngine: async () => engine,
  compile: async (args) => tc.compile(args),
  workerUrl: path.join(EXT, "dist/web/debugWorker.js"),
  terminal: fakeTerminal,
  log: (s) => { console.log("   [adapter]", s); const mm = /rawModuleId: (\d+)/.exec(s); if (mm) modIdOut = Number(mm[1]); },
  onSnapshot: (m) => { snap = m; },
  onFrame: (f) => { frame = f; },
});
const msgs = [];
adapter.onDidSendMessage((m) => msgs.push(m));
const send = (command, args, seq) => adapter.handleMessage({ type: "request", seq, command, arguments: args });
const waitFor = async (pred, ms = 30000) => {
  const t0 = Date.now();
  for (;;) {
    const m = msgs.find(pred);
    if (m) return m;
    if (Date.now() - t0 > ms) return null;
    await sleep(50);
  }
};
const event = (name) => msgs.filter((m) => m.type === "event" && m.event === name).map((m) => m.body);

send("initialize", { adapterID: "test" }, 1);
await waitFor((m) => m.type === "response" && m.command === "initialize");
must(msgs.some((m) => m.type === "response" && m.command === "initialize" && m.body.supportsExceptionInfoRequest), "initialize 声明 supportsExceptionInfoRequest");
await waitFor((m) => m.type === "event" && m.event === "initialized", 60000);

send("launch", {}, 2);
await waitFor((m) => m.type === "response" && m.command === "launch", 120000);

send("configurationDone", {}, 3);
const stopped = await waitFor((m) => m.type === "event" && m.event === "stopped", 120000);
must(!!stopped, "崩溃后收到 stopped 事件（不是一直 running）");
must(!!stopped && stopped.body && stopped.body.reason === "exception", `stopped.reason === "exception"（实际 ${stopped && stopped.body && stopped.body.reason}）`);

send("stackTrace", { threadId: 1 }, 4);
const st = await waitFor((m) => m.type === "response" && m.command === "stackTrace");
const frames = st && st.body && st.body.stackFrames || [];
must(frames.length > 0, `stackTrace 有帧（${frames.length}）`);
must(frames[0].source && String(frames[0].source.path).startsWith("vscode-test-web://"), `顶帧 source.path 已映射（${frames[0] && frames[0].source && frames[0].source.path}）`);
must(frames[0].line >= 5 && frames[0].line <= 6, `顶帧行号在除零语句（实际 ${frames[0].line}）`);
must(frames[0].source && frames[0].source.name === FILE_NAME,
  `栈帧显示名是解码后的文件名（期望 ${FILE_NAME}，实际 ${frames[0] && frames[0].source && frames[0].source.name}）`);
// 终端横幅里的"崩溃前最后执行的一句"也必须是解码后的名字
const banner = termText.join("");
must(banner.includes("运行时错误 (RE)"), "终端里有 RE 横幅");
must(banner.includes(`${FILE_NAME}:`), `终端横幅文件名已解码（含「${FILE_NAME}:」）`);
must(!/%[0-9A-F]{2}/i.test(banner), "终端横幅里没有 percent-encoded 乱码");

send("scopes", { frameId: 1 }, 5);
const sc = await waitFor((m) => m.type === "response" && m.command === "scopes");
const scopes = sc && sc.body && sc.body.scopes || [];
must(scopes.length > 0, "scopes 非空");

send("variables", { variablesReference: (scopes[0] || {}).variablesReference }, 6);
const vr = await waitFor((m) => m.type === "response" && m.command === "variables");
const vars = vr && vr.body && vr.body.variables || [];
const names = vars.map((v) => v.name);
must(names.includes("k") && names.includes("z"), `variables 列出 locals（${JSON.stringify(names)}）`);
const zv = vars.find((v) => v.name === "z");
must(zv && /0/.test(String(zv.value)), `崩溃瞬间 z = ${zv && zv.value}`);

send("exceptionInfo", { threadId: 1 }, 7);
const ei = await waitFor((m) => m.type === "response" && m.command === "exceptionInfo");
must(!!ei && ei.body && /divide by zero/i.test(String(ei.body.exceptionId || "") + String(ei.body.exceptionDescription || "")), "exceptionInfo 给出除零原因");

send("disconnect", {}, 8);
await sleep(500);
console.log(pass ? "\n全部通过" : "\n存在失败项");
process.exit(pass ? 0 : 1);
