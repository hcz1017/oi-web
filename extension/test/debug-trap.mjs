// Trap 捕获回归：
//   1) 程序在 wasm 层崩溃（除零/越界/unreachable）时要上报 trap，而不是只有 exit code；
//   2) 影子重放要能给出**完整调用栈**与**崩溃瞬间的变量**（locals 可读）。
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { Toolchain } from "../src/core/toolchain.mjs";
import { parseWasm, instrumentWasm } from "../../wdb/src/instrument/wasm-bin.mjs";
import { SparseMem } from "../../wdb/src/runtime/mem-view.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, "..");
const A = (f) => path.join(EXT, "assets", f);
const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = true;
const must = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) pass = false; return c; };

const SRC = `#include <cstdio>
int inc(int v) { return v + 1; }
int main() {
  int z = 0;
  printf("before\\n");
  int k = inc(1);
  int x = 1 / z;          // 整数除零 → wasm trap
  printf("%d %d\\n", k, x);
  return 0;
}
`;
const srcUrl = "file:///workspace/trap.cpp";

// ---------- 编译 ----------
const tc = new Toolchain({
  clangWasm: gunzipSync(readFileSync(A("clang.wasm.gz"))),
  lldWasm: gunzipSync(readFileSync(A("lld.wasm.gz"))),
  sysrootTar: gunzipSync(readFileSync(A("sysroot.tar.gz"))),
  compatBits: readFileSync(A("compat/bits/stdc++.h")),
});
const r = await tc.compile({ source: SRC, fileName: "trap.cpp", opt: 0, debug: true, debugStub: true });
if (!must(!!r.wasm, "编译（带 probe/pause 桩）")) process.exit(1);
const orig = new Uint8Array(r.wasm);
const info = parseWasm(orig);
const codeBase = info.code.contentStart;

// ---------- DWARF 引擎（算站点 + 之后读变量） ----------
let spawn;
try { ({ spawn } = require(path.join(EXT, "..", "wdb", ".dev-dwarf-pkg/node-test/index.cjs"))); } catch { spawn = null; }
if (!spawn) { console.log("跳过：缺少 .dev-dwarf-pkg"); process.exit(0); }

let snapMem = null, frame = null;
const host = {
  getWasmLinearMemory(off, len) { if (!snapMem) throw new Error("no snapshot"); return snapMem.read(off, len); },
  getWasmLocal(local) {
    if (!snapMem || !frame) throw new Error("no frame");
    const type = (frame.types || [])[local];
    const dv = snapMem.dv(frame.base + local * 8, 8);
    switch (type) {
      case 0x7f: return { type: "i32", value: dv.getInt32(0, true) };
      case 0x7e: return { type: "i64", value: dv.getBigInt64(0, true) };
      case 0x7d: return { type: "f32", value: dv.getFloat32(0, true) };
      case 0x7c: return { type: "f64", value: dv.getFloat64(0, true) };
      default: throw new Error("bad local type " + type);
    }
  },
  getWasmGlobal() { throw new Error("no globals"); },
  getWasmOp() { throw new Error("no op"); },
};
const engine = spawn(host);
const MOD = "trapmod";
await engine.rpc.sendMessage("hello", [], false);
await engine.rpc.sendMessage("addRawModule", MOD, undefined, {
  url: srcUrl, code: orig.buffer.slice(orig.byteOffset, orig.byteOffset + orig.byteLength),
});

// 站点：只取**用户文件**的行（真实扩展也是这样，lastSite 因此一定是用户语句）
const lines0 = (await engine.rpc.sendMessage("getMappedLines", MOD, srcUrl)) || [];
const sites = [];
let nextId = 1;
for (const line0 of lines0) {
  let start = null;
  for (let col = 0; col <= 200 && start == null; col++) {
    const rs = await engine.rpc.sendMessage("sourceLocationToRawLocation", {
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

const instr = instrumentWasm(orig, sites.map((s) => ({ id: s.id, offset: s.origOffset })));
// ⚠️ origOffset 必须是**插桩前**的偏移：引擎的 rawLocation 用原始码偏移算的
//    （真实扩展里 adapter 也是这么存的；插桩只按 siteId 回填新偏移）
const useSites = sites;

// ---------- 跑起来 ----------
const worker = new Worker(path.join(HERE, "node-worker-self.cjs"), {
  workerData: { bundlePath: path.join(EXT, "dist/web/debugWorker.js") },
});
const events = [];
worker.on("message", (m) => events.push(m));
const sab = new SharedArrayBuffer(8);
const ctrl = new Int32Array(sab);
worker.postMessage({
  type: "init", wasm: instr.wasm.buffer, sites: useSites,
  breakpointSab: new SharedArrayBuffer(8), sab,
  bodyLocals: instr.bodyLocals || [], globalTypes: instr.globalTypes || [], fileName: "trap.cpp",
});
const waitFor = async (pred, ms = 40000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const e = events.find(pred); if (e) return e; await sleep(10); } return null; };

const tr = await waitFor((e) => e.type === "trap");
if (!must(!!tr, "收到 trap 事件（而不是只有 exit code）")) {
  console.log("   事件序列:", events.map((e) => e.type).join(","));
  process.exit(1);
}
console.log(`   reason=${JSON.stringify(tr.reason)} 帧=${(tr.frames || []).length} 站点=${tr.site ? tr.site.file.split("/").pop() + ":" + tr.site.line : "?"} replayed=${!!tr.replayed}`);
must(/divide by zero|unreachable|out of bounds/i.test(String(tr.reason)), "原因里带 wasm trap 语义");
must(!!tr.site, "带「崩溃前最后一句」的站点");
must(tr.site.line === 7 || tr.site.line === 6, `定位到崩溃语句附近（第 ${tr.site.line} 行，期望 6/7）`);

// ---------- 影子重放：栈 + 变量 ----------
must(!!tr.replayed, "标记为影子重放结果");
must(Array.isArray(tr.frames) && tr.frames.length >= 2, `重放拿到调用栈（${(tr.frames || []).length} 帧，期望 ≥2：main 调用链）`);
must(tr.localsBase > 0, `重放暂停点有 locals 快照区（${tr.localsBase}）`);

snapMem = new SparseMem(tr.memorySize || 0, tr.memorySegments || []);
frame = { base: tr.localsBase, types: tr.bodyLocals || [] };
const rawLoc = { rawModuleId: MOD, codeOffset: tr.site.origOffset - codeBase, inlineFrameIndex: 0 };
let vars = [];
try { vars = await engine.rpc.sendMessage("listVariablesInScope", rawLoc); } catch { vars = []; }
const names = (vars || []).map((v) => v.name);
must(names.includes("z"), `崩溃点能列出用户变量 z（实际: ${JSON.stringify(names)}）`);
let z = null;
try { z = await engine.rpc.sendMessage("evaluate", "z", rawLoc, tr.siteId); } catch (e) { z = { error: String(e && e.message) }; }
must(z && (z.value === 0 || z.description === "0"), `崩溃瞬间 z = ${JSON.stringify(z && (z.value ?? z.description ?? z.error))}（期望 0）`);
let k = null;
try { k = await engine.rpc.sendMessage("evaluate", "k", rawLoc, tr.siteId); } catch (e) { k = { error: String(e && e.message) }; }
must(k && (k.value === 2 || k.description === "2"), `崩溃瞬间 k = ${JSON.stringify(k && (k.value ?? k.description ?? k.error))}（期望 2）`);

// ---------- trap 后应阻塞、唤醒后正常退出 ----------
await sleep(300);
must(!events.some((e) => e.type === "exit"), "trap 后没有立刻 exit（等宿主结束会话）");
Atomics.store(ctrl, 0, 1);
Atomics.notify(ctrl, 0);
must(!!(await waitFor((e) => e.type === "exit", 5000)), "宿主唤醒后正常退出");
try { worker.terminate(); } catch {}
try { await engine.dispose(); } catch {}
console.log(pass ? "\n全部通过" : "\n存在失败项");
process.exit(pass ? 0 : 1);
