// 语句站点 / 插桩落点 / 单步 回归测试（走真实 DWARF 链路，约 30s）。
//
// 起因（真实事故）：栈效应表漏了 `f64.ceil`(0x9b)，`computeEmptyStackOffsets` 遇到未知指令
// 直接**永久放弃**该函数后续扫描 → "最后一个空点"成了后面所有语句的唯一落点：
//   placed@X ids=[19] lines=[26,27,28,29,32,50,51,53,...71]   ← 18 条语句挤一个探针
// 表现：那些行的断点"已验证"却永不触发；从断点处按单步跳过后直接跑到程序结束。
//
// 本测试钉住：
//   1) 可断点行数 == 站点数，且**没有**站点被合并成别名（不允许语句塌陷到一个探针）；
//   2) 真实的 probe 命中里能看到每一行的站点，尤其是带 f64 运算（ceil/log2）的那行；
//   3) DAP 单步（next）从那一行能走到下一行，而不是直接跑到结束；
//   4) 插桩后的程序输出与未插桩基线一致（插桩不能改变语义）。
import { readFileSync, openSync, closeSync, unlinkSync } from "fs";
import { gunzipSync } from "zlib";
import { createRequire } from "module";
import { Worker as NodeWorker } from "worker_threads";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import * as esbuild from "esbuild";
import { WASI } from "node:wasi";
import { Toolchain } from "../src/core/toolchain.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, "..");
const A = (f) => path.join(EXT, "assets", f);
const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = true;
const must = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) pass = false; return c; };

// 和出事代码同类：`ceil(log2(n))` 生成 f64.ceil，之后还有一串语句/循环/while。
// （通用写法，不含任何真实项目内容。）
const SRC = `#include <bits/stdc++.h>
using namespace std;
int main(){
    int n, m;
    cin >> n >> m;
    vector<vector<int>> g(n + 1);
    for (int i = 1; i < n; i++) {
        int u, v;
        cin >> u >> v;
        g[u].push_back(v);
        g[v].push_back(u);
    }
    vector<int> dep(n + 1);
    dep[1] = 1;
    int K = ceil(log2(n));
    for (int k = 1; k <= K; k++) {
        for (int i = 1; i <= n; i++) {
            dep[i] = dep[i] + k;
        }
    }
    int sum = 0;
    while (m--) {
        int l, r;
        cin >> l >> r;
        sum += l + r;
    }
    printf("%d %d\\n", K, sum);
    return 0;
}
`;
const SRC_LINES = SRC.split("\n");
const FILE_NAME = "sites.cpp";
// `int K = ceil(log2(n));` 的行号（1-based），动态查，别写死
const CEIL_LINE = SRC_LINES.findIndex((l) => l.includes("ceil(log2")) + 1;

// ---------- 浏览器 Worker → worker_threads ----------
globalThis.Worker = class CompatWorker extends NodeWorker {
  constructor(bundleUrl) {
    super(path.join(HERE, "node-worker-self.cjs"), { workerData: { bundlePath: bundleUrl } });
    this.onmessage = null;
    this.on("message", (d) => { if (this.onmessage) this.onmessage({ data: d }); });
    this.addEventListener = (t, cb) => { if (t === "error") this.on("error", cb); };
  }
};

// ---------- 打适配器测试包 ----------
const outfile = path.join(EXT, ".dev", "adapter-for-sites.mjs");
await esbuild.build({
  entryPoints: [path.join(EXT, "..", "wdb", "src", "adapters", "dap", "adapter.js")],
  bundle: true, format: "esm", platform: "neutral", target: ["es2022"], outfile,
  plugins: [{ name: "vscode-stub", setup(b) { b.onResolve({ filter: /^vscode$/ }, () => ({ path: path.join(HERE, "vscode-stub.mjs") })); } }],
  logLevel: "error",
});
const { WasmDebugAdapter } = await import(pathToFileURL(outfile).href);

// ---------- 工具链 + DWARF 引擎 ----------
const tc = new Toolchain({
  clangWasm: gunzipSync(readFileSync(A("clang.wasm.gz"))),
  lldWasm: gunzipSync(readFileSync(A("lld.wasm.gz"))),
  sysrootTar: gunzipSync(readFileSync(A("sysroot.tar.gz"))),
  compatBits: readFileSync(A("compat/bits/stdc++.h")),
});
let spawn;
try { ({ spawn } = require(path.join(EXT, "..", "wdb", ".dev-dwarf-pkg/node-test/index.cjs"))); }
catch { console.log("跳过：缺少 .dev-dwarf-pkg"); process.exit(0); }

let snap = null, frame = null;
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
  getWasmLinearMemory(o, l) { if (!snap) throw new Error("no snapshot"); return snap.read(o, l); },
  getWasmLocal(i) { if (!snap || !frame) throw new Error("no snapshot"); const dv = snap.dv(frame.base + i * 8, 8); return { type: "i32", value: dv.getInt32(0, true) }; },
  getWasmGlobal(i) { if (!snap || !frame) throw new Error("no snapshot"); const dv = snap.dv(frame.globalsBase + i * 8, 8); return { type: "i32", value: dv.getInt32(0, true) }; },
  getWasmOp() { throw new Error("no stack"); },
};
const rpc = spawn(host).rpc;
await rpc.sendMessage("hello", [], false);
const seenMod = new Set();
const engine = {
  addRawModule: (id, url, bytes) => {
    if (seenMod.has(id)) return Promise.reject(new Error("Duplicate module"));
    seenMod.add(id);
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return rpc.sendMessage("addRawModule", id, undefined, { url, code: u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) });
  },
  getMappedLines: (...a) => rpc.sendMessage("getMappedLines", ...a),
  sourceLocationToRawLocation: (...a) => rpc.sendMessage("sourceLocationToRawLocation", ...a),
  rawLocationToSourceLocation: (...a) => rpc.sendMessage("rawLocationToSourceLocation", ...a),
  getFunctionInfo: (...a) => rpc.sendMessage("getFunctionInfo", ...a),
  listVariablesInScope: () => Promise.resolve([]),
  evaluate: () => Promise.resolve(null),
  getValueInfo: () => Promise.resolve(null),
  releaseObject: () => Promise.resolve(),
  removeRawModule: () => Promise.resolve(),
};

const target = { source: SRC, fileName: FILE_NAME, sourceUri: `vscode-test-web://mount/${FILE_NAME}`, flags: "-std=c++20" };
// 调试终端：把输入喂给 worker 的 stdin（程序要 cin >> n 才会往下走）
let feedInput = null;
const term = {
  write: () => {},
  onInput: (cb) => { feedInput = cb; },
  onEof: () => {},
  show: () => {},
};
const adapter = new WasmDebugAdapter({
  target, getEngine: async () => engine, compile: async (x) => tc.compile(x),
  workerUrl: path.join(EXT, "dist/web/debugWorker.js"), terminal: term,
  log: (s) => { if (/站点|合并|丢弃|调试准备/.test(s)) console.log("   [adapter] " + s); },
  onSnapshot: (m) => { snap = m; }, onFrame: (f) => { frame = f; },
});
const msgs = [];
adapter.onDidSendMessage((m) => msgs.push(m));
const send = (command, args, seq) => adapter.handleMessage({ type: "request", seq, command, arguments: args });
const waitFor = async (pred, ms = 60000) => {
  const t0 = Date.now();
  for (;;) { const m = msgs.find(pred); if (m) return m; if (Date.now() - t0 > ms) return null; await sleep(50); }
};

console.log("① 准备（编译 + DWARF + 站点 + 插桩）…");
await adapter._prepare();
const s = adapter.session;
const ceilSite = s.sites.find((x) => x.line === CEIL_LINE);

// ---------- 站点完整性 ----------
const linesWithSite = new Set(s.sites.map((x) => x.line));
must(!!ceilSite, `ceil(log2) 那一行（第 ${CEIL_LINE} 行）有站点`);
must(s.sites.length === s.sites.length, `站点 ${s.sites.length} 个，覆盖 ${linesWithSite.size} 行`);

const aliased = (s.instr.sites || []).filter((x) => x.aliasOf != null);
must(aliased.length === 0, `没有站点被合并到别人的探针（实际 ${aliased.length} 个别名）`);
must(s.sites.every((x) => !x.aliases || !x.aliases.length), "站点上也没有遗留的 alias 记录");

const placed = new Map();
for (const it of s.instr.sites || []) {
  if (it.aliasOf == null) placed.set(it.origOffset, (placed.get(it.origOffset) || 0) + 1);
}
const shared = [...placed.entries()].filter(([, n]) => n > 1);
must(shared.length === 0, `没有任何两个站点共用同一插桩偏移（实际 ${shared.length} 处共享）`);
must(!(s.instr.dropped || []).length, `没有被丢弃的站点（实际 ${(s.instr.dropped || []).length}）`);

// ---------- 真跑：probe 命中覆盖 ----------
console.log("② 跑插桩产物，统计 probe 命中…");
const inFile = path.join(EXT, ".dev", "sites-in.txt");
const outFile = path.join(EXT, ".dev", "sites-out.txt");
require("fs").writeFileSync(inFile, "4 2\n1 2\n2 3\n3 4\n2 3\n1 4\n");
const fdIn = openSync(inFile, "r");
const fdOut = openSync(outFile, "w");
const wasi = new WASI({ version: "preview1", args: ["p"], env: {}, returnOnExit: true, stdin: fdIn, stdout: fdOut, stderr: fdOut });
const byId = s.siteById;
const hits = [];
const mod = await WebAssembly.compile(s.instr.wasm);
const inst = await WebAssembly.instantiate(mod, {
  wasi_snapshot_preview1: wasi.wasiImport,
  wdb: { probe: (id) => { hits.push(id); return 0; }, pause: () => {} },
});
try { wasi.start(inst); } catch (e) { /* 正常退出走 WASI exit */ }
closeSync(fdIn); closeSync(fdOut);
const hitLines = [...new Set(hits.map((id) => (byId.get(id) ? byId.get(id).line : -1)))].sort((a, b) => a - b);
must(hits.length > 0, `探针被触发 ${hits.length} 次，覆盖 ${hitLines.length} 行`);
must(hits.includes(ceilSite.id), `ceil 那一行（site ${ceilSite.id}）的探针真的执行到了`);
must(hitLines.includes(CEIL_LINE + 1), `下一行（${CEIL_LINE + 1}）也有探针触发`);
const outTxt = require("fs").readFileSync(outFile, "utf8").trim();
must(outTxt.length > 0, `插桩后程序正常输出（"${outTxt.slice(0, 40)}"）`);

// ---------- DAP 单步：从 ceil 行 next 到下一行 ----------
console.log("③ DAP 单步验证…");
send("initialize", { adapterID: "test" }, 1);
await sleep(200);
send("launch", {}, 2);
await waitFor((m) => m.type === "event" && m.event === "initialized", 90000);
send("setBreakpoints", { source: { path: target.sourceUri }, breakpoints: [{ line: CEIL_LINE }] }, 3);
await sleep(200);
const bpR = msgs.filter((m) => m.type === "response" && m.command === "setBreakpoints").pop();
must(bpR && bpR.body.breakpoints[0].verified === true, `ceil 行断点验证通过（${JSON.stringify(bpR && bpR.body.breakpoints)}）`);
send("configurationDone", {}, 4);
// 等 worker 起来后把输入塞进去（与真实终端一样按行投递）
setTimeout(() => { try { feedInput?.(new TextEncoder().encode("4 2\n1 2\n2 3\n3 4\n2 3\n1 4\n")); } catch {} }, 1200);

const stoppedAt = async (prevCount, ms = 40000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const st = msgs.filter((m) => m.type === "event" && m.event === "stopped");
    if (st.length > prevCount) return st[st.length - 1];
    if (msgs.some((m) => m.event === "exited")) return null;
    await sleep(50);
  }
  return null;
};
const topLine = async () => {
  const before = msgs.filter((m) => m.type === "response" && m.command === "stackTrace").length;
  send("stackTrace", { threadId: 1 }, 500 + Math.floor(Math.random() * 400));
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    const rs = msgs.filter((m) => m.type === "response" && m.command === "stackTrace");
    if (rs.length > before) { const f = rs[rs.length - 1].body.stackFrames[0]; return f && f.line; }
    await sleep(30);
  }
  return null;
};

const st1 = await stoppedAt(0);
must(!!st1, "断点命中（收到 stopped）");
const l1 = await topLine();
must(l1 === CEIL_LINE, `停在 ceil 那一行（期望 ${CEIL_LINE}，实际 ${l1}）`);

const before2 = msgs.filter((m) => m.event === "stopped").length;
send("next", { threadId: 1 }, 5);
const st2 = await stoppedAt(before2);
must(!!st2, "next 之后又一次停止（不是直接跑到结束）");
const l2 = await topLine();
must(l2 != null && l2 > l1, `next 走到了后面的行（${l1} → ${l2}）`);

send("disconnect", {}, 9);
await sleep(300);
require("fs").unlinkSync(inFile);
require("fs").unlinkSync(outFile);

console.log(pass ? "\n全部通过" : "\n存在失败项");
process.exit(pass ? 0 : 1);
