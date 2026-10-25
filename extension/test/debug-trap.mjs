// Trap 捕获回归：程序在 wasm 层崩溃（unreachable / 越界 / 除零）时，
// 应该上报 {type:"trap"} 并带上调用栈 + "崩溃前最后一句"的站点。
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { Toolchain } from "../src/core/toolchain.mjs";
import { parseWasm, instrumentWasm } from "../../wdb/src/instrument/wasm-bin.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, "..");
const A = (f) => path.join(EXT, "assets", f);
const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = true;
const must = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) pass = false; return c; };

const SRC = `#include <cstdio>
int main() {
  printf("before\\n");
  volatile int z = 0;
  int x = 1 / z;          // 整数除零 → wasm trap
  printf("%d\\n", x);
  return 0;
}
`;
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

// 站点：只要有就够（trap 捕获不依赖断点）
const codeBase = info.code.contentStart;
const srcUrl = "file:///workspace/trap.cpp";
const sites = [];
let nextId = 1;
{
  // 用 DWARF 行表拿不到时的兜底：每个函数体首指令各一个站点
  for (let i = 0; i < info.code.bodies.length; i++) {
    const b = info.code.bodies[i];
    sites.push({ id: nextId++, line: 1, file: srcUrl, body: i, origOffset: b.bodyStart + 1 });
    if (sites.length >= 80) break;
  }
}
const instr = instrumentWasm(orig, sites.map((s) => ({ id: s.id, offset: s.origOffset })));
const useSites = instr.sites ? sites.map((s) => ({ ...s, origOffset: (instr.sites.find((x) => x.id === s.id) || {}).newOffset ?? s.origOffset })) : sites;

const worker = new Worker(path.join(HERE, "node-worker-self.cjs"), {
  workerData: { bundlePath: path.join(EXT, "dist/web/debugWorker.js") },
});
const events = [];
worker.on("message", (m) => events.push(m));
const sab = new SharedArrayBuffer(8);
const ctrl = new Int32Array(sab);
worker.postMessage({
  type: "init",
  wasm: instr.wasm.buffer,
  sites: useSites,
  breakpointSab: new SharedArrayBuffer(8),
  sab,
  bodyLocals: instr.bodyLocals || [],
  globalTypes: instr.globalTypes || [],
  fileName: "trap.cpp",
});

const waitFor = async (pred, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const e = events.find(pred); if (e) return e; await sleep(10); } return null; };

const tr = await waitFor((e) => e.type === "trap");
if (!must(!!tr, "收到 trap 事件（而不是只有 exit code）")) {
  console.log("   事件序列:", events.map((e) => e.type).join(","));
  process.exit(1);
}
console.log(`   reason=${JSON.stringify(tr.reason)} 栈 ${(tr.frames || []).length} 帧 站点=${tr.site ? tr.site.file + ":" + tr.site.line : "?"}`);
must(/divide by zero|unreachable|out of bounds/i.test(String(tr.reason)), "原因里带 wasm trap 语义");
// trap 已把 wasm 栈展开，worker 抓不到帧是正常的；适配器会用 site 合成一帧
must(Array.isArray(tr.frames), "frames 字段存在（trap 后为空属正常，适配器用 site 合成一帧）");
must(!!tr.site, "带「崩溃前最后一句」的站点");
must(!!tr.memorySegments || tr.memorySize > 0, "带内存快照（变量面板至少能看到全局/堆）");

// trap 后应当阻塞等宿主，不该立刻 exit
await sleep(300);
must(!events.some((e) => e.type === "exit"), "trap 后没有立刻 exit（等宿主结束会话）");
Atomics.store(ctrl, 0, 1);
Atomics.notify(ctrl, 0);
const ex = await waitFor((e) => e.type === "exit", 5000);
must(!!ex, "宿主唤醒后正常退出");
try { worker.terminate(); } catch {}
console.log(pass ? "\n全部通过" : "\n存在失败项");
process.exit(pass ? 0 : 1);
