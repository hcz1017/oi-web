// DAP 流程端到端验证（Node）：
//   用 esbuild 把 debugAdapter.js 打成一个测试包（vscode 换成桩），
//   真跑一遍 VS Code 的握手序列：initialize → launch → setBreakpoints → configurationDone
//   → stopped → stackTrace → continue → exited/terminated。
// 这正是之前"点了调试就卡住"暴露出的问题类型（请求分发/事件顺序），所以做成常驻测试。
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

// ---------- 浏览器 Worker → worker_threads 适配 ----------
globalThis.Worker = class CompatWorker extends NodeWorker {
  constructor(bundleUrl) {
    super(path.join(HERE, "node-worker-self.cjs"), { workerData: { bundlePath: bundleUrl } });
    this.onmessage = null;
    this.onmessageerror = null;
    this.on("message", (d) => { if (this.onmessage) this.onmessage({ data: d }); });
    this.addEventListener = (type, cb) => { if (type === "error") this.on("error", cb); };
  }
};

// ---------- 打测试包（vscode → 桩）----------
const outfile = path.join(EXT, ".dev/adapter-for-test.mjs");
await esbuild.build({
  entryPoints: [path.join(EXT, "src/web/debugAdapter.js")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: ["es2022"],
  outfile,
  plugins: [{
    name: "vscode-stub",
    setup(b) {
      b.onResolve({ filter: /^vscode$/ }, () => ({ path: path.join(HERE, "vscode-stub.mjs") }));
    },
  }],
  logLevel: "error",
});
const { WasmDebugAdapter } = await import(pathToFileURL(outfile).href);

// ---------- 工具链 + DWARF 引擎（Node 版 RPC 客户端）----------
const tc = new Toolchain({
  clangWasm: gunzipSync(readFileSync(A("clang.wasm.gz"))),
  lldWasm: gunzipSync(readFileSync(A("lld.wasm.gz"))),
  sysrootTar: gunzipSync(readFileSync(A("sysroot.tar.gz"))),
  compatBits: readFileSync(A("compat/bits/stdc++.h")),
});
let spawn;
try {
  ({ spawn } = require(path.join(EXT, ".dev/dwarf-pkg/node-test/index.js")));
} catch {
  console.log("跳过：缺少 .dev/dwarf-pkg（见 scripts/build-dwarf-worker.mjs 的说明）");
  process.exit(0);
}
const host = {
  getWasmLinearMemory() { throw new Error("no snapshot in node RPC harness"); },
  getWasmLocal() { throw new Error("no locals"); },
  getWasmGlobal() { throw new Error("no globals"); },
  getWasmOp() { throw new Error("no stack"); },
};
const spawned = spawn(host);
const rpc = spawned.rpc;
await rpc.sendMessage("hello", [], false);
const engine = {
  // 与 DwarfEngine.addRawModule 等价：upstream 期望 rawModule = { url, code }
  addRawModule: (id, url, bytes) => {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const code = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    return rpc.sendMessage("addRawModule", id, undefined, { url, code });
  },
  getMappedLines: (...a) => rpc.sendMessage("getMappedLines", ...a),
  sourceLocationToRawLocation: (...a) => rpc.sendMessage("sourceLocationToRawLocation", ...a),
  rawLocationToSourceLocation: (...a) => rpc.sendMessage("rawLocationToSourceLocation", ...a),
  getFunctionInfo: (...a) => rpc.sendMessage("getFunctionInfo", ...a),
  listVariablesInScope: () => Promise.resolve([]),
  getValueInfo: () => Promise.resolve(null),
  removeRawModule: () => Promise.resolve(),
};

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
const target = { source: SRC, fileName: "main.cpp", sourceUri: "vscode-test-web://mount/main.cpp", flags: "-std=c++20" };
const adapter = new WasmDebugAdapter({
  target,
  getEngine: async () => engine,
  compile: async (args) => {
    const r = await tc.compile(args);
    if (!r.wasm) {
      console.log("   [compile 失败] exit=" + r.exit + " log:\n" +
        String(r.log || "").split("\n").slice(-12).join("\n"));
    }
    return r;
  },
  workerUrl: path.join(EXT, "dist/web/debugWorker.js"),
  log: (s) => console.log("   [adapter]", s),
});

const msgs = [];
adapter.onDidSendMessage((m) => msgs.push(m));
const send = (command, args, seq) => adapter.handleMessage({ type: "request", seq, command, arguments: args });
const waitFor = async (pred, ms = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const m = msgs.find(pred);
    if (m) return m;
    await sleep(10);
  }
  return null;
};

// ---------- 握手序列 ----------
send("initialize", { adapterID: "oi-cpp-wasm" }, 1);
const initResp = await waitFor((m) => m.type === "response" && m.command === "initialize");
must(!!initResp && initResp.success, "initialize 有响应");
const caps = initResp && initResp.body;
must(!!caps && caps.supportsConfigurationDoneRequest === true, "capabilities.supportsConfigurationDoneRequest=true");

send("launch", { type: "oi-cpp-wasm", request: "launch", name: "t" }, 2);
const launchResp = await waitFor((m) => m.type === "response" && m.command === "launch", 60000);
must(!!launchResp && launchResp.success, `launch 成功（${launchResp ? "" : "超时"}）`);
const initialized = await waitFor((m) => m.type === "event" && m.event === "initialized");
must(!!initialized, "收到 initialized 事件（VS Code 收到它才会发断点/configurationDone）");

send("setBreakpoints", { source: { path: "vscode-test-web://mount/main.cpp" }, breakpoints: [{ line: 10 }] }, 3);
const bpResp = await waitFor((m) => m.type === "response" && m.command === "setBreakpoints");
const bps = bpResp && bpResp.body && bpResp.body.breakpoints;
must(!!bps && bps.length === 1 && bps[0].verified === true, `断点已验证: ${JSON.stringify(bps)}`);

send("configurationDone", {}, 4);
const stopped = await waitFor((m) => m.type === "event" && m.event === "stopped", 30000);
must(!!stopped, "命中断点（stopped 事件）");

send("stackTrace", { threadId: 1 }, 5);
const stResp = await waitFor((m) => m.type === "response" && m.command === "stackTrace");
const frames = stResp && stResp.body && stResp.body.stackFrames;
must(!!frames && frames.length > 0, `stackTrace 有帧: ${JSON.stringify((frames || []).map((f) => f.name + "@" + f.line))}`);
must(!!frames && frames[0].source && String(frames[0].source.path).startsWith("vscode-test-web://"),
  "栈帧 source.path 已映射回 VS Code 文档 URI");

send("continue", { threadId: 1 }, 6);
const exited = await waitFor((m) => m.type === "event" && m.event === "exited", 30000);
must(!!exited && exited.body.exitCode === 0, `continue 后正常退出（exitCode ${exited && exited.body && exited.body.exitCode}）`);
const out = msgs.filter((m) => m.type === "event" && m.event === "output").map((m) => m.body.output).join("");
must(/3/.test(out), `输出事件里能看到程序输出（${JSON.stringify(out.slice(-40))}）`);

send("disconnect", {}, 7);
await waitFor((m) => m.type === "response" && m.command === "disconnect");
try { await spawned.dispose(); } catch {}
console.log(pass ? "\n全部通过" : "\n存在失败项");
process.exit(pass ? 0 : 1);
