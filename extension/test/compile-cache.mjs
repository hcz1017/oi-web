// 编译缓存回归测试（纯 Node，不需要工具链，秒级）。
//
// 这块曾经被三种方式写坏过，表现都是"缓存没生效"，所以：
//   1) 假 memento **强制 JSON 往返**（复现 vscode.dev 的 IndexedDB+JSON 行为）——
//      直接挡住"塞 ArrayBuffer 进去、读回来变成 {}"那类 bug；
//   2) 覆盖命中/未命中、key 隔离、LRU 淘汰、超限跳过、坏数据容错。
import { createCompileCache, b64enc, b64dec } from "../src/web/compile-cache.js";

let pass = true;
const must = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) pass = false; return c; };

/** 模拟真实 Memento：写入即 JSON 序列化，读出是全新对象（Web 端就是这样） */
function fakeMemento() {
  const store = new Map();
  return {
    _raw: store,
    get(k, def) {
      if (!store.has(k)) return def;
      return JSON.parse(store.get(k));           // ← 关键：JSON 往返
    },
    update(k, v) {
      store.set(k, JSON.stringify(v));           // ← 关键：JSON 序列化
      return Promise.resolve();
    },
  };
}

const logs = [];
const log = (s) => logs.push(s);

// ---------- 1. base64 编解码无损（含 0x00 / 0xFF / 非 3 倍数长度） ----------
{
  const src = new Uint8Array([0, 1, 2, 255, 254, 0, 7]);            // 7 字节：不是 3 的倍数
  const back = b64dec(b64enc(src));
  must(Buffer.compare(Buffer.from(back), Buffer.from(src)) === 0, `base64 往返无损（${src.length} 字节）`);

  const big = new Uint8Array(300000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 37) & 0xff;
  const bigBack = b64dec(b64enc(big));
  must(Buffer.compare(Buffer.from(bigBack), Buffer.from(big)) === 0, "base64 往返无损（300KB 分块）");
}

// ---------- 2. 命中 / 未命中 ----------
{
  const cache = createCompileCache(fakeMemento(), { log });
  must(cache.get("run:abc") === null, "空缓存未命中");

  const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);   // wasm magic
  must(cache.put("run:abc", wasm, 1234) === true, "写入成功");
  const hit = cache.get("run:abc");
  must(!!hit, "JSON 往返后仍能命中（这是 vscode.dev 上曾经失效的点）");
  must(hit && Buffer.compare(Buffer.from(hit.wasm), Buffer.from(wasm)) === 0, "命中的 wasm 字节完全一致");
  must(hit && hit.ms === 1234, `记录了上次编译耗时（${hit && hit.ms}ms）`);
  must(cache.get("run:different") === null, "不同 key 互不干扰");
}

// ---------- 3. 参数变化 → key 变化（调用方职责，这里验证不同 key 不串味） ----------
{
  const cache = createCompileCache(fakeMemento(), { log });
  const a = new Uint8Array([1, 1, 1]);
  const b = new Uint8Array([2, 2, 2, 2]);
  cache.put("dbg:O0", a, 10);
  cache.put("dbg:O2", b, 20);
  must(cache.get("dbg:O0").wasm.length === 3 && cache.get("dbg:O2").wasm.length === 4, "调试/运行、不同优化级各自独立");
}

// ---------- 4. LRU：最多 4 条 ----------
{
  const cache = createCompileCache(fakeMemento(), { log });
  for (let i = 0; i < 7; i++) cache.put("k" + i, new Uint8Array([i]), i);
  must(cache.size() === 4, `LRU 只保留 4 条（实际 ${cache.size()}）`);
  must(cache.get("k6") !== null, "最新的那条在");
  must(cache.get("k0") === null, "最老的被淘汰");
}

// ---------- 5. 超过 12MB 不缓存 ----------
{
  const cache = createCompileCache(fakeMemento(), { log });
  const huge = new Uint8Array(13 * 1024 * 1024);
  must(cache.put("big", huge, 1) === false, "超过 12MB 拒绝缓存");
  must(cache.get("big") === null, "超限的那条确实没进去");
}

// ---------- 6. 坏数据容错（旧的 ArrayBuffer 版留下的垃圾） ----------
{
  const m = fakeMemento();
  m.update("oiCpp.compileCache.v2", { entries: { bad: { wasm: {}, ms: 1 } } });   // 旧格式
  const cache = createCompileCache(m, { log });
  must(cache.get("bad") === null, "旧格式（非 base64）条目当作未命中，不炸");
  must(cache.put("ok", new Uint8Array([9]), 1) === true, "坏数据不影响后续写入");
}

// ---------- 7. memento 抛异常也不炸 ----------
{
  const broken = { get() { throw new Error("boom"); }, update() { throw new Error("boom"); } };
  const cache = createCompileCache(broken, { log });
  must(cache.get("x") === null, "memento.get 抛异常 → 未命中");
  must(cache.put("x", new Uint8Array([1]), 1) === false, "memento.update 抛异常 → 返回 false 而不是崩");
}

// ---------- 8. 空 key / 空 wasm 不写 ----------
{
  const cache = createCompileCache(fakeMemento(), { log });
  must(cache.put("", new Uint8Array([1]), 1) === false, "空 key 不写");
  must(cache.put("k", new Uint8Array(0), 1) === false, "空产物不写");
}

console.log(pass ? "\n全部通过" : "\n存在失败项");
process.exit(pass ? 0 : 1);
