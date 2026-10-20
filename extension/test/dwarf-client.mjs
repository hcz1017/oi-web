// DwarfEngine（主线程 RPC 客户端）单元测试：不依赖真引擎，用假 Worker 校验协议实现。
// 覆盖：hello 响应为 undefined、请求/响应路由、宿主同步 getter（sync_request + io_buffer 序列化）。
let pass = true;
const must = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) pass = false; return c; };

// 假 Worker：记录出站消息，onmessage 由测试控制
class FakeWorker {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.listeners = { message: [], error: [] };
  }
  addEventListener(type, cb) { (this.listeners[type] ||= []).push(cb); }
  postMessage(m, transfer) { this.sent.push({ m, transfer }); }
  terminate() { this.terminated = true; }
  // 模拟引擎 → 宿主
  reply(requestId, response) {
    for (const cb of this.listeners.message) cb({ data: { requestId, response } });
  }
  replyError(requestId, error) {
    for (const cb of this.listeners.message) cb({ data: { requestId, error } });
  }
  event(data) { for (const cb of this.listeners.message) cb({ data }); }
}
const workers = [];
globalThis.Worker = class extends FakeWorker { constructor(url) { super(url); workers.push(this); } };

const { DwarfEngine } = await import("../src/web/dwarf.js");

const host = {
  getWasmLinearMemory(offset, length) {
    const buf = new ArrayBuffer(length);
    new Uint8Array(buf).fill(0xab);
    return buf;
  },
  getWasmLocal() { return { type: "i32", value: -7 }; },
  getWasmGlobal() { throw new Error("boom"); },
  getWasmOp() { return { type: "f64", value: 1.5 }; },
};

const engine = new DwarfEngine("fake://dwarfWorker.js", "https://assets/base/", host);
const w = workers[0];
must(!!w && w.url === "fake://dwarfWorker.js", "worker 已创建");
must(w.sent.length === 1 && w.sent[0].m.__oiConfig && w.sent[0].m.__oiConfig.base === "https://assets/base",
  `首条消息是 __oiConfig（base=${w.sent[0] && w.sent[0].m.__oiConfig && w.sent[0].m.__oiConfig.base}）`);

// 1) ready → hello 的响应是 undefined（真实引擎就是这样），不能抛
w.event({ __oiReady: true });
const starting = engine.start();
await Promise.resolve();          // 让 hello 发出去
const helloSent = w.sent.find((x) => x.m.request && x.m.request.method === "hello");
must(!!helloSent, "start() 发出了 hello");
w.reply(helloSent.m.requestId, undefined);   // ⚠️ 曾经这里因为 JSON.stringify(undefined).slice 抛异常
const started = await Promise.race([starting.then(() => true), new Promise((r) => setTimeout(() => r(false), 1000))]);
must(started === true, "hello 的 response 为 undefined 时也能正常 resolve（回归）");

// 2) addRawModule 的参数形状：{ url, code }，且 code 是独立 ArrayBuffer
const bytes = new Uint8Array([1, 2, 3, 4]);
const p1 = engine.addRawModule("m1", "file:///workspace/main.wasm", bytes);
await Promise.resolve();
const addSent = w.sent.find((x) => x.m.request && x.m.request.method === "addRawModule");
must(!!addSent && addSent.m.request.params[2] && addSent.m.request.params[2].url === "file:///workspace/main.wasm",
  "addRawModule 传 { url, code }");
must(addSent.m.request.params[2].code instanceof ArrayBuffer && addSent.m.request.params[2].code !== bytes.buffer,
  "code 是拷贝出来的独立 ArrayBuffer");
w.reply(addSent.m.requestId, ["file:///workspace/main.cpp"]);
must(JSON.stringify(await p1) === '["file:///workspace/main.cpp"]', "addRawModule 正常 resolve");

// 3) 错误响应 → reject
const p2 = engine.getMappedLines("m1", "file:///workspace/main.cpp");
await Promise.resolve();
const gl = w.sent.find((x) => x.m.request && x.m.request.method === "getMappedLines");
w.replyError(gl.m.requestId, "no such module");
let rejected = false;
try { await p2; } catch { rejected = true; }
must(rejected, "error 响应会 reject");

// 4) 宿主同步 getter：内存
const ioBuf = new SharedArrayBuffer(64);
const sem = new SharedArrayBuffer(4);
w.event({ sync_request: { request: { method: "getWasmLinearMemory", params: [0, 8] }, io_buffer: { semaphore: sem, data: ioBuf } } });
const sig = Atomics.load(new Int32Array(sem), 0);
must(sig === 8, `getWasmLinearMemory 返回字节数（signal=${sig}）`);
must(new Uint8Array(ioBuf)[0] === 0xab, "内存内容写进了 io_buffer");

// 5) 宿主同步 getter：i32 / f64
const sem2 = new SharedArrayBuffer(4);
const io2 = new SharedArrayBuffer(64);
w.event({ sync_request: { request: { method: "getWasmLocal", params: [0, {}] }, io_buffer: { semaphore: sem2, data: io2 } } });
must(Atomics.load(new Int32Array(sem2), 0) === 1 && new DataView(io2).getInt32(0, true) === -7,
  "getWasmLocal 序列化为 i32（tag=1, value=-7）");

const sem3 = new SharedArrayBuffer(4);
const io3 = new SharedArrayBuffer(64);
w.event({ sync_request: { request: { method: "getWasmOp", params: [0, {}] }, io_buffer: { semaphore: sem3, data: io3 } } });
must(Atomics.load(new Int32Array(sem3), 0) === 4 && new DataView(io3).getFloat64(0, true) === 1.5,
  "getWasmOp 序列化为 f64（tag=4, value=1.5）");

// 6) 宿主 getter 抛异常 → signal -1（引擎会显示不可用，而不是卡死）
const sem4 = new SharedArrayBuffer(4);
const io4 = new SharedArrayBuffer(64);
w.event({ sync_request: { request: { method: "getWasmGlobal", params: [0, {}] }, io_buffer: { semaphore: sem4, data: io4 } } });
must(Atomics.load(new Int32Array(sem4), 0) === -1, "宿主 getter 抛异常时 signal=-1");

await engine.stop();
must(w.terminated === true, "stop() 终止了 worker");
console.log(pass ? "\n全部通过" : "\n存在失败项");
process.exit(pass ? 0 : 1);
