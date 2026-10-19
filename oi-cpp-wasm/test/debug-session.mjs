// 调试会话端到端验证（Node，用 worker_threads 模拟浏览器 Worker）：
//   编译(debugStub) → 引擎建站点 → 插桩 → 启动 debugWorker → 命中断点 → 继续 → 单步 → 退出
// 覆盖：暂停/继续/单步协议、栈帧抓取、内存快照、输出转发、退出码
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

const SRC = `#include <cstdio>

int add(int a, int b) {
  int sum = a + b;
  return sum;
}

int main() {
  int n = 0;
  n = add(1, 2);
  printf("%d\\n", n);
  return 0;
}
`;

const tc = new Toolchain({
  clangWasm: gunzipSync(readFileSync(A("clang.wasm.gz"))),
  lldWasm: gunzipSync(readFileSync(A("lld.wasm.gz"))),
  sysrootTar: gunzipSync(readFileSync(A("sysroot.tar.gz"))),
  compatBits: readFileSync(A("compat/bits/stdc++.h")),
});

// ---------- 编译 + 基线 ----------
const r = await tc.compile({ source: SRC, fileName: "main.cpp", opt: 0, debug: true, debugStub: true });
if (!must(!!r.wasm, "调试构建编译成功")) process.exit(1);
const orig = new Uint8Array(r.wasm);
const info = parseWasm(orig);
const baseOut = [];
const baseCode = await tc.run(orig, { onOut: (b) => baseOut.push(Buffer.from(b)), extraImports: { oi: { probe() { return 0; }, pause() {} } } });
const baseText = Buffer.concat(baseOut).toString().trim();
must(baseCode === 0 && baseText === "3", `基线运行输出 ${JSON.stringify(baseText)}`);

// ---------- 第三个会话：stdin 走终端通道（b.cpp 就是 cin 循环，这条必须通） ----------
const SRC2 = `#include <cstdio>
int main() {
  int a, b;
  while (scanf("%d %d", &a, &b) == 2) printf("%d\\n", a + b);
  return 0;
}
`;
const r2 = await tc.compile({ source: SRC2, fileName: "echo.cpp", opt: 0, debug: true, debugStub: true });
must(!!r2.wasm, "stdin 用例编译成功");
if (!r2.wasm) console.log("   compile log:", String(r2.log || "").split("\n").slice(-8).join("\n"));
if (r2.wasm) {
  const orig2 = new Uint8Array(r2.wasm);
  const instr2 = instrumentWasm(orig2, []);            // 不需要站点，只验证 stdin
  const stdinSab = new SharedArrayBuffer(8 + 65536);
  const stdinCtrl = new Int32Array(stdinSab, 0, 2);
  const stdinBuf = new Uint8Array(stdinSab, 8);
  const events3 = [];
  const w3 = new Worker(path.join(HERE, "node-worker-self.cjs"), {
    workerData: { bundlePath: path.join(EXT, "dist/web/debugWorker.js") },
  });
  w3.on("message", (m) => events3.push(m));
  w3.postMessage({
    type: "init",
    wasm: instr2.wasm.buffer,
    sites: [],
    breakpointSab: new SharedArrayBuffer(4),
    sab: new SharedArrayBuffer(8),
    stdinSAB: stdinSab,
    fileName: "echo.cpp",
  });
  const wait3 = async (pred, ms = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const e = events3.find(pred);
      if (e) return e;
      await sleep(10);
    }
    return null;
  };
  // 宿主侧输入：单槽协议（state 0 才写），收到 consumed 再继续；写空后置 EOF(3)
  const pending = [...Buffer.from("10 20\n3 4\n")];
  const pump = () => {
    while (pending.length) {
      if (Atomics.load(stdinCtrl, 0) !== 0) return;
      const n = Math.min(pending.length, stdinBuf.length);
      stdinBuf.set(pending.splice(0, n), 0);
      Atomics.store(stdinCtrl, 1, n);
      Atomics.store(stdinCtrl, 0, 1);
      Atomics.notify(stdinCtrl, 0);
      return;
    }
    Atomics.store(stdinCtrl, 0, 3);
    Atomics.notify(stdinCtrl, 0);
  };
  const pumpTimer = setInterval(() => { pump(); console.log("    pump state=", Atomics.load(stdinCtrl,0), "pending=", pending.length); }, 20);
  const ex3 = await wait3((e) => e.type === "exit");
  clearInterval(pumpTimer);
  const out3 = events3.filter((e) => e.type === "stdout").map((e) => e.text).join("").trim();
  must(!!ex3 && ex3.code === 0, `stdin 用例正常退出（code ${ex3 && ex3.code}）`);
  console.log("   事件:", JSON.stringify(events3.map((e) => e.type + (e.text ? ":" + JSON.stringify(e.text) : "")).slice(0, 12)));
  must(out3 === "30\n7", `调试终端输入生效（输出 ${JSON.stringify(out3)}）`);
  try { w3.terminate(); } catch {}
}

// ---------- 引擎建站点 ----------
const host = {
  getWasmLinearMemory() { throw new Error("unexpected"); },
  getWasmLocal() { throw new Error("unexpected"); },
  getWasmGlobal() { throw new Error("unexpected"); },
  getWasmOp() { throw new Error("unexpected"); },
};
// .dev/ 是本地开发脚手架（gitignore）：没准备好就跳过，而不是报错
let spawn;
try {
  ({ spawn } = require(path.join(EXT, ".dev/dwarf-pkg/node-test/index.js")));
} catch {
  console.log("跳过：缺少 .dev/dwarf-pkg（先跑 scripts/build-dwarf-worker.mjs，并把 @vscode/dwarf-debugging 解包到 .dev/dwarf-pkg/package）");
  process.exit(0);
}
const engine = spawn(host);
await engine.rpc.sendMessage("hello", [], false);
const MOD = "sess";
await engine.rpc.sendMessage("addRawModule", MOD, undefined, {
  url: "file:///workspace/main.wasm",
  code: orig.buffer.slice(orig.byteOffset, orig.byteOffset + orig.byteLength),
});
const srcUrl = "file:///workspace/main.cpp";
const lines0 = await engine.rpc.sendMessage("getMappedLines", MOD, srcUrl);
const codeBase = info.code.contentStart;
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
must(sites.length > 0, `站点 ${sites.length} 个；行号: ${JSON.stringify(sites.map((s) => s.line))}`);

// 选一行下断点：printf 那一行（1-based 12）——它一定会在 main 里执行到
const bpSite = sites.find((s) => s.line === 10) || sites[0];
must(!!bpSite, `断点选在 line ${bpSite && bpSite.line}（site ${bpSite && bpSite.id}）`);

const instr = instrumentWasm(orig, sites.map((s) => ({ id: s.id, offset: s.origOffset })));
must(instr.sites.length === sites.length, `插桩点 ${instr.sites.length}/${sites.length}`);

// ---------- 启动 debugWorker ----------
const sab = new SharedArrayBuffer(8);
const ctrl = new Int32Array(sab);
const bpSab = new SharedArrayBuffer((Math.ceil(Math.max(...sites.map((x) => x.id)) / 32) + 1) * 4);
const bp = new Int32Array(bpSab);
const setBp = (ids) => { bp.fill(0); for (const id of ids) { const w = id >>> 5; Atomics.store(bp, w, Atomics.load(bp, w) | (1 << (id & 31))); } };
setBp([bpSite.id]);
const events = [];
const worker = new Worker(path.join(HERE, "node-worker-self.cjs"), {
  workerData: { bundlePath: path.join(EXT, "dist/web/debugWorker.js") },
});
worker.on("message", (m) => events.push(m));
worker.on("error", (e) => events.push({ type: "error", message: String(e && (e.stack || e.message) || e) }));

worker.postMessage({
  type: "init",
  wasm: instr.wasm.buffer,
  sites,
  breakpointSab: bpSab,
  sab,
  fileName: "main.cpp",
});

// 等第一次暂停
const waitFor = async (pred, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const e = events.find(pred);
    if (e) return e;
    await sleep(10);
  }
  return null;
};

const p1 = await waitFor((e) => e.type === "paused");
must(!!p1, "命中断点并暂停");
if (p1) {
  must(p1.siteId === bpSite.id, `暂停在期望站点（${p1.siteId} == ${bpSite.id}）`);
  must(Array.isArray(p1.frames) && p1.frames.length >= 2, `栈帧 ${p1.frames.length} 层（含 wasm 函数索引）`);
  must(!!p1.memory && p1.memory.byteLength > 0, `内存快照 ${p1.memory ? (p1.memory.byteLength / 1024).toFixed(0) + "KB" : "-"}`);
  // 用引擎把栈帧映射成源码行（验证适配器 stackTrace 的关键路径）
  let mapped = 0;
  for (const f of p1.frames.slice(0, 3)) {
    const bodyIdx = f.funcIndex - info.funcImports.length;
    const body = info.code.bodies[bodyIdx];
    if (!body) continue;
    const off = ((body.bodyStart + 1) - 1) - codeBase; // 用函数体起点近似
    const locs = await engine.rpc.sendMessage("rawLocationToSourceLocation", {
      rawModuleId: MOD, codeOffset: off, inlineFrameIndex: 0,
    });
    if ((locs || []).length) mapped++;
  }
  must(mapped > 0, `栈帧可映射到源码（${mapped} 帧）`);
}

// 继续 → 应该跑完（宿主直接写共享内存：worker 阻塞时收不到消息）
const resume = (mode) => {
  Atomics.store(ctrl, 1, mode);
  Atomics.store(ctrl, 0, 1);
  Atomics.notify(ctrl, 0);
};
resume(1);
const exited = await waitFor((e) => e.type === "exit");
must(!!exited && exited.code === 0, `继续后正常退出（code ${exited && exited.code}）`);
const outText = events.filter((e) => e.type === "stdout").map((e) => e.text).join("").trim();
must(outText === baseText, `输出与基线一致（${JSON.stringify(outText)}）`);
if (!exited) console.log("   事件类型:", JSON.stringify(events.map((e) => e.type + (e.code != null ? ":" + e.code : ""))));

// ---------- 再来一次：单步（stepIn），验证第二次暂停在下一个站点 ----------
const events2 = [];
worker.removeAllListeners("message");
worker.on("message", (m) => events2.push(m));
const sab2 = new SharedArrayBuffer(8);
const bp2Sab = new SharedArrayBuffer((Math.ceil(Math.max(...sites.map((x) => x.id)) / 32) + 1) * 4);
const bp2 = new Int32Array(bp2Sab);
for (const id of [bpSite.id]) { const w = id >>> 5; Atomics.store(bp2, w, Atomics.load(bp2, w) | (1 << (id & 31))); }
const worker2 = new Worker(path.join(HERE, "node-worker-self.cjs"), {
  workerData: { bundlePath: path.join(EXT, "dist/web/debugWorker.js") },
});
worker2.on("message", (m) => events2.push(m));
worker2.postMessage({
  type: "init",
  wasm: instrumentWasm(orig, sites.map((s) => ({ id: s.id, offset: s.origOffset }))).wasm.buffer,
  sites,
  breakpointSab: bp2Sab,
  sab: sab2,
  fileName: "main.cpp",
});
const wait2 = async (pred, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const e = events2.find(pred);
    if (e) return e;
    await sleep(10);
  }
  return null;
};
const q1 = await wait2((e) => e.type === "paused");
must(!!q1 && q1.siteId === bpSite.id, "第二次会话命中同一断点");
const ctrl2 = new Int32Array(sab2);
const resume2 = (mode) => { Atomics.store(ctrl2, 1, mode); Atomics.store(ctrl2, 0, 1); Atomics.notify(ctrl2, 0); };
resume2(2);          // stepIn：任意语句即停
const q2 = await wait2((e) => e.type === "paused" && e !== q1);
must(!!q2 && q2.siteId !== bpSite.id, `stepIn 停在另一个站点（${q2 && q2.siteId}，期望 ≠ ${bpSite.id}）`);
if (!q2) console.log("   事件类型:", JSON.stringify(events2.map((e) => e.type)));
resume2(1);
const ex2 = await wait2((e) => e.type === "exit");
must(!!ex2, "单步后继续仍能跑完");

await engine.dispose();
try { worker.terminate(); worker2.terminate(); } catch {}
console.log(pass ? "\n全部通过" : "\n存在失败项");
process.exit(pass ? 0 : 1);
