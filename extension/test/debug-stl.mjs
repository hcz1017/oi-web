// STL 展开端到端验证（走真实 DebugAdapter + 真 DWARF 引擎 + 真 debugWorker）：
//   set / map / priority_queue / list / unordered_set / vector 在变量面板里应能展开出元素。
// 这条对应浏览器里"变量面板点开容器"的完整路径。
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = true;
const must = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) pass = false; return c; };

// ---------- 浏览器 Worker API → worker_threads ----------
globalThis.Worker = class CompatWorker extends NodeWorker {
  constructor(bundleUrl) {
    super(path.join(HERE, "node-worker-self.cjs"), { workerData: { bundlePath: bundleUrl } });
    this.onmessage = null;
    this.on("message", (d) => { if (this.onmessage) this.onmessage({ data: d }); });
    this.addEventListener = (t, cb) => { if (t === "error") this.on("error", cb); };
  }
};

// ---------- 打测试包（vscode → 桩）----------
const outfile = path.join(EXT, ".dev/adapter-for-stl.mjs");
await esbuild.build({
  entryPoints: [path.join(EXT, "src/web/debugAdapter.js")],
  bundle: true, format: "esm", platform: "neutral", target: ["es2022"], outfile,
  plugins: [{ name: "vscode-stub", setup(b) { b.onResolve({ filter: /^vscode$/ }, () => ({ path: path.join(HERE, "vscode-stub.mjs") })); } }],
  logLevel: "error",
});
const { WasmDebugAdapter } = await import(pathToFileURL(outfile).href);

// ---------- 编译 ----------
const SRC = `#include <bits/stdc++.h>
using namespace std;
int main() {
  set<int> s{3, 1, 2};
  map<int, int> m{{1, 10}, {2, 20}};
  priority_queue<int> pq; pq.push(5); pq.push(9); pq.push(7);
  list<int> lst{4, 6};
  unordered_set<int> us{8, 9};
  unordered_map<int, int> um{{3, 30}, {4, 40}};
  string a = "hello";
  string b = "this_is_a_very_long_string_over_22";
  set<string> ss{"ab", "cd"};
  map<string, int> ms{{"k1", 1}, {"k2", 2}};
  map<int, string> mi{{1, "x"}, {2, "y"}};
  __int128 big = (__int128)1 << 100;
  vector<int> v{11, 12};
  printf("%zu\\n", s.size() + m.size() + pq.size() + lst.size() + us.size() + v.size());
  return 0;
}
`;
const tc = new Toolchain({
  clangWasm: gunzipSync(readFileSync(A("clang.wasm.gz"))),
  lldWasm: gunzipSync(readFileSync(A("lld.wasm.gz"))),
  sysrootTar: gunzipSync(readFileSync(A("sysroot.tar.gz"))),
  compatBits: readFileSync(A("compat/bits/stdc++.h")),
});
const built = await tc.compile({ source: SRC, fileName: "stl.cpp", opt: 0, debug: true, debugStub: true });
if (!must(!!built.wasm, "编译 STL 程序")) process.exit(1);

// ---------- 真引擎（宿主 getter 读暂停快照）----------
let spawn;
try { ({ spawn } = require(path.join(EXT, ".dev/dwarf-pkg/node-test/index.js"))); }
catch { console.log("跳过：缺少 .dev/dwarf-pkg"); process.exit(0); }
let snap = null, frame = null;
const rd = (dv, t) => t === 0x7f ? { type: "i32", value: dv.getInt32(0, true) }
  : t === 0x7e ? { type: "i64", value: dv.getBigInt64(0, true) }
  : t === 0x7d ? { type: "f32", value: dv.getFloat32(0, true) }
  : { type: "f64", value: dv.getFloat64(0, true) };
const host = {
  getWasmLinearMemory(o, l) {
    if (!snap) throw new Error("no snapshot");
    return snap.buffer.slice(snap.byteOffset + o, snap.byteOffset + o + l);
  },
  getWasmLocal(i) { return rd(new DataView(snap.buffer, snap.byteOffset + frame.base + i * 8, 8), frame.types[i]); },
  getWasmGlobal(i) { return rd(new DataView(snap.buffer, snap.byteOffset + frame.globalsBase + i * 8, 8), frame.globalTypes[i]); },
  getWasmOp() { throw new Error("no ops"); },
};
const spawned = spawn(host);
const rpc = spawned.rpc;
await rpc.sendMessage("hello", [], false);
const engine = {
  addRawModule: (id, url, bytes) => {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return rpc.sendMessage("addRawModule", id, undefined, { url, code: u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) });
  },
  getMappedLines: (...a) => rpc.sendMessage("getMappedLines", ...a),
  sourceLocationToRawLocation: (...a) => rpc.sendMessage("sourceLocationToRawLocation", ...a),
  rawLocationToSourceLocation: (...a) => rpc.sendMessage("rawLocationToSourceLocation", ...a),
  getFunctionInfo: (...a) => rpc.sendMessage("getFunctionInfo", ...a),
  listVariablesInScope: (...a) => rpc.sendMessage("listVariablesInScope", ...a),
  evaluate: (...a) => rpc.sendMessage("evaluate", ...a),
  getProperties: (...a) => rpc.sendMessage("getProperties", ...a),
  releaseObject: (...a) => rpc.sendMessage("releaseObject", ...a),
  removeRawModule: (...a) => rpc.sendMessage("removeRawModule", ...a),
};

// ---------- 驱动适配器 ----------
const printfLine = SRC.split("\n").findIndex((l) => l.includes("printf")) + 1;
const adapter = new WasmDebugAdapter({
  target: { source: SRC, fileName: "stl.cpp", sourceUri: "vscode-test-web://mount/stl.cpp", flags: "-std=c++20" },
  getEngine: async () => engine,
  compile: async (args) => built,          // 编译结果复用，省时间
  workerUrl: path.join(EXT, "dist/web/debugWorker.js"),
  log: () => {},
  onSnapshot: (m) => { snap = m; },
  onFrame: (f) => { frame = f; },
});
const msgs = [];
adapter.onDidSendMessage((m) => msgs.push(m));
const send = (command, args, seq) => adapter.handleMessage({ type: "request", seq, command, arguments: args });
const waitFor = async (pred, ms = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const m = msgs.find(pred); if (m) return m; await sleep(10); }
  return null;
};

send("initialize", { adapterID: "oi-cpp-wasm" }, 1);
await waitFor((m) => m.type === "response" && m.command === "initialize");
send("launch", {}, 2);
must(!!(await waitFor((m) => m.type === "response" && m.command === "launch", 60000)), "launch 成功");
send("setBreakpoints", { source: { path: "vscode-test-web://mount/stl.cpp" }, breakpoints: [{ line: printfLine }] }, 3);
const bpResp = await waitFor((m) => m.type === "response" && m.command === "setBreakpoints");
must(!!bpResp && bpResp.body.breakpoints[0].verified, `断点在 printf 行(${printfLine})已验证`);
send("configurationDone", {}, 4);
must(!!(await waitFor((m) => m.type === "event" && m.event === "stopped")), "命中断点");

// 拿顶层变量（Locals scope）
send("scopes", { frameId: 1 }, 5);
const scopes = await waitFor((m) => m.type === "response" && m.command === "scopes");
const scopeRef = scopes.body.scopes[0].variablesReference;
send("variables", { variablesReference: scopeRef }, 6);
const varsResp = await waitFor((m) => m.type === "response" && m.command === "variables");
const vars = (varsResp.body.variables || []);
const byName = new Map(vars.map((v) => [v.name, v]));
must(vars.length > 0, `Locals 变量: ${JSON.stringify(vars.map((v) => v.name))}`);
must(!vars.some((v) => /^std::/.test(v.name)), "没有 std:: 内部变量（piecewise_construct 等已过滤）");

// 展开某个变量
let seqNo = 20;
const expand = async (name) => {
  const v = byName.get(name);
  if (!v) return null;
  must(v.variablesReference > 0, `${name} 有子成员（${v.type}）`);
  const seq = seqNo++;
  send("variables", { variablesReference: v.variablesReference }, seq);
  const r = await waitFor((m) => m.type === "response" && m.command === "variables" && m.request_seq === seq);
  return r && r.body.variables;
};
const fmt = (list) => (list || []).map((x) => x.name + "=" + x.value);

const sKids = await expand("s");
must(!!sKids && fmt(sKids).join(",") === "[0]=1,[1]=2,[2]=3", `set<int> 展开: ${JSON.stringify(fmt(sKids))}`);

const mKids = await expand("m");
must(!!mKids && fmt(mKids).join(",") === "[1]=10,[2]=20", `map<int,int> 展开: ${JSON.stringify(fmt(mKids))}`);

const pqKids = await expand("pq");
must(!!pqKids && (pqKids[0].name || "").includes("top") && pqKids[0].value === "9",
  `priority_queue 堆顶: ${JSON.stringify(fmt((pqKids || []).slice(0, 2)))}`);

const lstKids = await expand("lst");
must(!!lstKids && fmt(lstKids).join(",") === "[0]=4,[1]=6", `list<int> 展开: ${JSON.stringify(fmt(lstKids))}`);

const umKids = await expand("um");
must(!!umKids && (umKids || []).length >= 2, `unordered_map<int,int> 展开: ${JSON.stringify(fmt((umKids || []).slice(0, 4)))}`);

const usKids = await expand("us");
must(!!usKids && (usKids || []).length >= 2 && (usKids || []).every((x) => /^\d+$/.test(x.value) || /^\[/.test(x.name)),
  `unordered_set<int> 展开: ${JSON.stringify(fmt(usKids))}`);

// 字符串 / int128 / 带 string 的容器
const aVar = byName.get("a");
must(!!aVar && aVar.value === '"hello"', `string a = ${aVar && aVar.value}（应为 "hello"）`);
const bVar = byName.get("b");
must(!!bVar && bVar.value === '"this_is_a_very_long_string_over_22"', `长 string b = ${bVar && bVar.value}`);
const bigVar = byName.get("big");
must(!!bigVar && bigVar.value === ((1n << 100n).toString()), `__int128 big = ${bigVar && bigVar.value}`);

const ssKids = await expand("ss");
must(!!ssKids && fmt(ssKids).join(",") === '[0]="ab",[1]="cd"', `set<string> 展开: ${JSON.stringify(fmt(ssKids))}`);

const msKids = await expand("ms");
must(!!msKids && fmt(msKids).some((x) => x.includes("k1") && x.endsWith("=1")), `map<string,int> 展开: ${JSON.stringify(fmt(msKids))}`);

const miKids = await expand("mi");
must(!!miKids && fmt(miKids).some((x) => x.endsWith('="x"')), `map<int,string> 展开: ${JSON.stringify(fmt(miKids))}`);

const vKids = await expand("v");
must(!!vKids && fmt(vKids).join(",") === "0=11,1=12", `vector<int> 展开: ${JSON.stringify(fmt(vKids))}`);

// 收尾
send("disconnect", {}, 99);
await waitFor((m) => m.type === "response" && m.command === "disconnect");
try { await spawned.dispose(); } catch {}
console.log(pass ? "\n全部通过" : "\n存在失败项");
process.exit(pass ? 0 : 1);
