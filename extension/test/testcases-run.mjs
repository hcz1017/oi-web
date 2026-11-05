// 对拍端到端：编译 → runWorker 的 runTest（一次性喂 stdin）→ 判定。
// 覆盖 AC / WA / TLE 三种真实结果，确保"面板上的判定"是真的。
import { readFileSync } from "fs";
import { gunzipSync } from "zlib";
import { Worker as NodeWorker } from "worker_threads";
import path from "path";
import { fileURLToPath } from "url";
import { Toolchain } from "../src/core/toolchain.mjs";
import { judgeCase, VERDICT } from "../src/web/testcases.js";
import { createRunner } from "../src/web/testrunner.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, "..");
const A = (f) => path.join(EXT, "assets", f);
let pass = true;
const must = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) pass = false; return c; };

// 浏览器 Worker → worker_threads（和 dap-flow 同样的垫片）
globalThis.Worker = class CompatWorker extends NodeWorker {
  constructor(bundleUrl) {
    super(path.join(HERE, "node-worker-self.cjs"), { workerData: { bundlePath: bundleUrl } });
    this.onmessage = null;
    this.on("message", (d) => { if (this.onmessage) this.onmessage({ data: d }); });
    this.addEventListener = (t, cb) => { if (t === "error") this.on("error", cb); };
  }
};

const tc = new Toolchain({
  clangWasm: gunzipSync(readFileSync(A("clang.wasm.gz"))),
  lldWasm: gunzipSync(readFileSync(A("lld.wasm.gz"))),
  sysrootTar: gunzipSync(readFileSync(A("sysroot.tar.gz"))),
  compatBits: readFileSync(A("compat/bits/stdc++.h")),
});

// 读两个数相加；n<0 时死循环（测 TLE）
const SRC = `#include <bits/stdc++.h>
using namespace std;
int main(){
    long long a, b;
    cin >> a >> b;
    if (a < 0) { while (true) { } }
    cout << a + b << "\\n";
    return 0;
}
`;
console.log("① 编译…");
const r = await tc.compile({ source: SRC, fileName: "sum.cpp", opt: 2, debug: false, debugStub: false });
if (!must(!!r.wasm, "编译成功")) process.exit(1);

console.log("② 创建对拍运行器（runWorker + runTest）…");
const runner = createRunner({
  createWorker: async () => new Worker(path.join(EXT, "dist/web/runWorker.js")),
  log: () => {},
});

try {
  // ---- AC ----
  const ac = await runner.run(r.wasm, "1 2\n", 5000);
  const jAc = judgeCase(ac, "3");
  must(jAc.verdict === VERDICT.AC, `正常用例 → AC（实际输出 ${JSON.stringify((ac.out || "").trim())}）`);
  must(ac.ms >= 0 && typeof ac.ms === "number", `结果带耗时（${ac.ms}ms）`);

  // ---- 同一个 worker 复用（第二个用例不该重建 worker） ----
  const wa = await runner.run(r.wasm, "2 3\n", 5000);
  const jWa = judgeCase(wa, "6");
  must(jWa.verdict === VERDICT.WA, `输出不符 → WA（实际 ${JSON.stringify((wa.out || "").trim())} vs 期望 6）`);
  must(wa.out.trim() === "5", "实际输出内容正确（说明第二个用例也跑在新的内存实例上）");

  // ---- 多行输入 + 多余空白/换行容忍 ----
  const trails = await runner.run(r.wasm, "10 20\n\n", 5000);
  must(judgeCase(trails, "30  \n\n").verdict === VERDICT.AC, "行尾空白与多余空行不影响 AC");

  // ---- TLE：死循环必须被宿主超时掐掉 ----
  const t0 = Date.now();
  const tle = await runner.run(r.wasm, "-1 0\n", 800);
  const elapsed = Date.now() - t0;
  must(tle.timedOut === true, "死循环 → 判为超时");
  must(elapsed >= 700 && elapsed < 5000, `超时在设定时间附近返回（${elapsed}ms，阈值 800ms）`);
  must(judgeCase(tle, "任意").verdict === VERDICT.TLE, "judgeCase 把超时判成 TLE");

  // ---- wasm 既有可能是 Uint8Array（缓存命中）也可能是 ArrayBuffer（缓存未命中）----
  //      以前 runner 里写 `wasm.slice(0).buffer`，对 ArrayBuffer 得到 undefined →
  //      postMessage 抛 "Failed to convert value to 'object'" → 面板上全变 RE。
  {
    const asArrayBuffer = r.wasm instanceof Uint8Array
      ? r.wasm.slice(0).buffer                     // 模拟 compileWorker 返回的 ArrayBuffer
      : r.wasm;
    const viaAB = await runner.run(asArrayBuffer, "3 4\n", 5000);
    must(judgeCase(viaAB, "7").verdict === VERDICT.AC,
      `ArrayBuffer 形态的产物也能跑（实际输出 ${JSON.stringify((viaAB.out || "").trim())}）`);
  }

  // ---- 超时后 worker 已被杀掉，下一个用例仍能正常工作（自动重建） ----
  const again = await runner.run(r.wasm, "7 8\n", 5000);
  must(judgeCase(again, "15").verdict === VERDICT.AC, "超时杀掉 worker 之后，新用例仍能跑（自动重建 worker）");
} finally {
  runner.dispose();
}

console.log(pass ? "\n全部通过" : "\n存在失败项");
process.exit(pass ? 0 : 1);
