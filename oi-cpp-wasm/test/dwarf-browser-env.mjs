// 「浏览器语义」下的 DWARF 引擎测试：
//   用 vm 造一个没有 require / 没有 process 的新 realm（= 经典 Worker 的语义），
//   加载 assets/dwarf/worker.js（我们的浏览器 shim 版），验证它能：
//     ① 通过 emscripten 的 node-only 环境检查
//     ② 用 fetch 拿到 SymbolsBackend.wasm.gz 并实例化
//     ③ 响应 hello / addRawModule（解析我们 -g 产物的嵌入式 DWARF）
// 这条测试能抓住「伪装 node 环境」和 shim 缺 API 这类只有浏览器才暴露的问题。
import { readFileSync } from "fs";
import vm from "node:vm";
import path from "path";
import { fileURLToPath } from "url";
import { gunzipSync } from "zlib";
import { Toolchain } from "../src/core/toolchain.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, "..");
const A = (f) => path.join(EXT, "assets", f);

let pass = true;
const must = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) pass = false; return c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 编译一个带 DWARF 的小程序 ----------
const tc = new Toolchain({
  clangWasm: gunzipSync(readFileSync(A("clang.wasm.gz"))),
  lldWasm: gunzipSync(readFileSync(A("lld.wasm.gz"))),
  sysrootTar: gunzipSync(readFileSync(A("sysroot.tar.gz"))),
  compatBits: readFileSync(A("compat/bits/stdc++.h")),
});
const r = await tc.compile({
  source: `#include <cstdio>\nint add(int a,int b){int s=a+b;return s;}\nint main(){printf("%d\\n",add(1,2));return 0;}\n`,
  fileName: "main.cpp", opt: 0, debug: true, debugStub: true,
});
if (!must(!!r.wasm, "编译测试程序")) process.exit(1);

// ---------- 造一个「像浏览器 Worker」的 realm ----------
const engineCode = readFileSync(path.join(EXT, "assets/dwarf/worker.js"), "utf8");
const gz = readFileSync(path.join(EXT, "assets/dwarf/SymbolsBackend.wasm.gz"));

const outbox = [];
const self = {
  location: { href: "http://127.0.0.1:8083/static/devextensions/assets/dwarf/worker.js" },
  postMessage: (m) => { outbox.push(m); },
  addEventListener: () => {},
  removeEventListener: () => {},
  close: () => {},
  crypto: globalThis.crypto,
  __oiDwarfBase: "http://127.0.0.1:8083/static/devextensions/assets",
};
let fetchCount = 0;
const fetched = [];
const sandbox = {
  self,
  console,
  // vm 的新 realm 只有 ECMAScript 内建，web/node 全局都要显式注入
  fetch: async (url) => {
    fetchCount++;
    fetched.push(String(url));
    if (String(url).endsWith("/dwarf/SymbolsBackend.wasm.gz")) {
      return new Response(gz, { status: 200, headers: { "content-type": "application/gzip" } });
    }
    return new Response("not found", { status: 404 });
  },
  Response, Headers, Blob, DecompressionStream,
  TextEncoder, TextDecoder, URL, URLSearchParams,
  WebAssembly, SharedArrayBuffer, Atomics,
  performance, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  crypto: globalThis.crypto,
  // 浏览器里有 MessageEvent；vm 的新 realm 没有，补一个最小实现
  MessageEvent: globalThis.MessageEvent || class MessageEvent {
    constructor(type, init) { this.type = type; this.data = init && init.data; }
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

let loadError = null;
try {
  vm.runInContext(engineCode, sandbox, { filename: "assets/dwarf/worker.js" });
} catch (e) {
  loadError = e;
}
must(!loadError, `引擎脚本在「无 require/process」的 realm 里加载成功${loadError ? "：" + loadError.message : ""}`);
must(typeof sandbox.self.onmessage === "function", "引擎已接管 self.onmessage（parentPort 垫片生效）");

if (typeof sandbox.self.onmessage !== "function") { console.log("\n存在失败项"); process.exit(1); }

const send = (msg) => sandbox.self.onmessage({ data: msg });
const waitFor = async (pred, ms = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const m = outbox.find(pred);
    if (m) return m;
    await sleep(20);
  }
  return null;
};

// ---------- hello ----------
send({ requestId: 1, request: { method: "hello", params: [[], false] } });
const hello = await waitFor((m) => m.requestId === 1);
must(!!hello, "hello 有响应（说明通过了环境检查 + wasm 实例化）");
must(!hello || !hello.error, `hello 没报错${hello && hello.error ? "：" + hello.error : ""}`);

// ---------- addRawModule（真 DWARF）----------
const wasmBytes = new Uint8Array(r.wasm);
const code = wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength);
send({
  requestId: 2,
  request: {
    method: "addRawModule",
    params: ["m0", undefined, { url: "file:///workspace/main.wasm", code }],
  },
});
const addResp = await waitFor((m) => m.requestId === 2);
must(!!addResp && !addResp.error, `addRawModule 成功${addResp && addResp.error ? "：" + addResp.error : ""}`);
// wasm 是懒加载的：addRawModule 才会触发 Engine 实例化
must(fetchCount > 0 && fetched.some((u) => u.endsWith("/dwarf/SymbolsBackend.wasm.gz")),
  `用 fetch 加载了 SymbolsBackend.wasm.gz（fetch ${fetchCount} 次）`);
const sources = addResp && addResp.response;
must(Array.isArray(sources) && sources.some((u) => u.endsWith("/workspace/main.cpp")),
  `解析出源文件（${Array.isArray(sources) ? sources.length : "?"} 个，含 main.cpp）`);

// ---------- 行映射 ----------
send({ requestId: 3, request: { method: "getMappedLines", params: ["m0", "file:///workspace/main.cpp"] } });
const linesResp = await waitFor((m) => m.requestId === 3);
const lines = linesResp && linesResp.response;
must(Array.isArray(lines) && lines.length > 0, `getMappedLines 返回 ${Array.isArray(lines) ? JSON.stringify(lines) : "?"}`);

console.log(pass ? "\n全部通过" : "\n存在失败项");
process.exit(pass ? 0 : 1);
