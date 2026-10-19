// 变量/求值端到端验证（Node）：
//   插桩（含 locals 快照）→ 命中断点 → 引擎用宿主 getWasmLocal 读局部变量 → evaluate 出值。
// 这条链路对应调试控制台里的 `x`、`y` 以及变量面板里的局部变量。
import { readFileSync } from "fs";
import { gunzipSync } from "zlib";
import { createRequire } from "module";
import { Worker } from "worker_threads";
import path from "path";
import { fileURLToPath } from "url";
import { Toolchain } from "../src/core/toolchain.mjs";
import { parseWasm, instrumentWasm } from "../src/core/wasm-bin.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, "..");
const A = (f) => path.join(EXT, "assets", f);
const require = createRequire(import.meta.url);

let pass = true;
const must = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) pass = false; return c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tc = new Toolchain({
  clangWasm: gunzipSync(readFileSync(A("clang.wasm.gz"))),
  lldWasm: gunzipSync(readFileSync(A("lld.wasm.gz"))),
  sysrootTar: gunzipSync(readFileSync(A("sysroot.tar.gz"))),
  compatBits: readFileSync(A("compat/bits/stdc++.h")),
});

const SRC = `#include <cstdio>
int main() {
  int x = 42;
  long long y = 7;
  y = y * x;
  printf("%lld\\n", y);
  return 0;
}
`;
const r = await tc.compile({ source: SRC, fileName: "eval.cpp", opt: 0, debug: true, debugStub: true });
if (!must(!!r.wasm, "编译（带 probe/pause 桩）")) process.exit(1);
const orig = new Uint8Array(r.wasm);
const info = parseWasm(orig);
must(info.probeImportIndex >= 0 && info.pauseImportIndex >= 0,
  `产物里有 oi.probe(#${info.probeImportIndex}) 和 oi.pause(#${info.pauseImportIndex})`);

// ---------- DWARF 引擎（宿主 getter 从暂停快照读） ----------
let spawn;
try {
  ({ spawn } = require(path.join(EXT, ".dev/dwarf-pkg/node-test/index.js")));
} catch {
  console.log("跳过：缺少 .dev/dwarf-pkg");
  process.exit(0);
}
let snap = null, frame = null;
const host = {
  getWasmLinearMemory(offset, length) {
    if (!snap) throw new Error("no snapshot");
    return snap.buffer.slice(snap.byteOffset + offset, snap.byteOffset + offset + length);
  },
  getWasmLocal(local) {
    if (!snap || !frame) throw new Error("no frame");
    const type = (frame.types || [])[local];
    const dv = new DataView(snap.buffer, snap.byteOffset + frame.base + local * 8, 8);
    switch (type) {
      case 0x7f: return { type: "i32", value: dv.getInt32(0, true) };
      case 0x7e: return { type: "i64", value: dv.getBigInt64(0, true) };
      case 0x7d: return { type: "f32", value: dv.getFloat32(0, true) };
      case 0x7c: return { type: "f64", value: dv.getFloat64(0, true) };
      default: throw new Error("bad local type " + type);
    }
  },
  getWasmGlobal() { throw new Error("no globals"); },
  getWasmOp() { throw new Error("no operand stack"); },
};
const spawned = spawn(host);
const rpc = spawned.rpc;
await rpc.sendMessage("hello", [], false);
const MOD = "eval";
const codeBase = info.code.contentStart;
await rpc.sendMessage("addRawModule", MOD, undefined, {
  url: "file:///workspace/eval.cpp",
  code: orig.buffer.slice(orig.byteOffset, orig.byteOffset + orig.byteLength),
});

// ---------- 站点 ----------
const srcUrl = "file:///workspace/eval.cpp";
const lines0 = await rpc.sendMessage("getMappedLines", MOD, srcUrl);
const sites = [];
let nextId = 1;
for (const line0 of lines0) {
  let start = null;
  for (let col = 0; col <= 200 && start == null; col++) {
    const rs = await rpc.sendMessage("sourceLocationToRawLocation", {
      rawModuleId: MOD, sourceFileURL: srcUrl, lineNumber: line0, columnNumber: col,
    });
    if (rs && rs.length) start = rs[0].startOffset;
  }
  if (start == null) continue;
  const origOffset = codeBase + start;
  const body = info.code.bodies.findIndex((b) => origOffset >= b.bodyStart && origOffset < b.end);
  if (body < 0) continue;
  sites.push({ id: nextId++, line: line0 + 1, file: srcUrl, body, origOffset });
}
must(sites.length >= 3, `站点 ${sites.map((s) => "L" + s.line).join(",")}`);
// 断在 printf 之前那行（y = y * x 之后），这样 x/y 都已有值
const bp = sites.find((s) => s.line === 6) || sites[sites.length - 1];

const instr = instrumentWasm(orig, sites.map((s) => ({ id: s.id, offset: s.origOffset })));
must(Array.isArray(instr.bodyLocals) && instr.bodyLocals.some((l) => l.length > 0),
  `插桩返回 bodyLocals（例：${JSON.stringify(instr.bodyLocals.find((l) => l.length) || [])}）`);

// ---------- 跑起来，命中断点 ----------
const sab = new SharedArrayBuffer(8);
const ctrl = new Int32Array(sab);
const bpSab = new SharedArrayBuffer((Math.ceil(Math.max(...sites.map((x) => x.id)) / 32) + 1) * 4);
const bpmap = new Int32Array(bpSab);
{ const w = bp.id >>> 5; Atomics.store(bpmap, w, Atomics.load(bpmap, w) | (1 << (bp.id & 31))); }
const events = [];
const worker = new Worker(path.join(HERE, "node-worker-self.cjs"), {
  workerData: { bundlePath: path.join(EXT, "dist/web/debugWorker.js") },
});
worker.on("message", (m) => events.push(m));
worker.postMessage({
  type: "init",
  wasm: instr.wasm.buffer,
  sites,
  breakpointSab: bpSab,
  sab,
  bodyLocals: instr.bodyLocals,
  fileName: "eval.cpp",
});
const waitFor = async (pred, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const e = events.find(pred); if (e) return e; await sleep(10); }
  return null;
};
const paused = await waitFor((e) => e.type === "paused");
if (!must(!!paused, "命中断点")) { console.log("事件:", events.map((e) => e.type)); process.exit(1); }
must(paused.localsBase > 0, `locals 快照地址 ${paused.localsBase}`);
must(Array.isArray(paused.bodyLocals), `暂停帧的 local 类型表: ${JSON.stringify(paused.bodyLocals)}`);

// 交给引擎
snap = paused.memory;
frame = { base: paused.localsBase, types: paused.bodyLocals };
const rawLoc = { rawModuleId: MOD, codeOffset: bp.origOffset - codeBase, inlineFrameIndex: 0 };

// ---------- 变量列表 + 求值 ----------
let vars = [];
try { vars = await rpc.sendMessage("listVariablesInScope", rawLoc); } catch (e) { vars = []; }
must(Array.isArray(vars) && vars.length > 0, `listVariablesInScope: ${JSON.stringify((vars || []).map((v) => v.name + ":" + v.type))}`);

const evalOne = async (expr) => {
  try { return await rpc.sendMessage("evaluate", expr, rawLoc, paused.siteId); }
  catch (e) { return { error: String((e && e.message) || e) }; }
};
const xv = await evalOne("x");
const yv = await evalOne("y");
const show = (v) => {
  if (v && v.error) return "ERR " + v.error;
  try { return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() + "n" : x)); }
  catch { return String(v); }
};
must(show(xv).includes("42"), `evaluate("x") = ${show(xv)}`);
must(show(yv).includes("294"), `evaluate("y") = ${show(yv)}`);

// 继续跑完
Atomics.store(ctrl, 1, 1); Atomics.store(ctrl, 0, 1); Atomics.notify(ctrl, 0);
const exited = await waitFor((e) => e.type === "exit");
must(!!exited && exited.code === 0, `继续后正常退出（code ${exited && exited.code}）`);
const out = events.filter((e) => e.type === "stdout").map((e) => e.text).join("").trim();
must(out === "294", `程序输出 ${JSON.stringify(out)}`);

try { worker.terminate(); } catch {}
try { await spawned.dispose(); } catch {}
console.log(pass ? "\n全部通过" : "\n存在失败项");
process.exit(pass ? 0 : 1);
