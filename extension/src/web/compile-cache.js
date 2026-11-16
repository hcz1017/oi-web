// 编译缓存：源码/参数没变就直接复用上一版 wasm 产物。
//
// ⚠️⚠️ 为什么单独成文件并带测试（test/compile-cache.mjs）：
//   这块逻辑已经被三种不同的方式写坏过一次，每次表现都是"缓存好像没生效"，很难查：
//     1) 终端运行路径只在编译完成后写、开头从不读；
//     2) 写入时用的 key 变量从来没被赋值（undefined），put 静默跳过；
//     3) 把 ArrayBuffer 塞进 globalState —— Memento 只保证 **JSON 可序列化**，
//        JSON.stringify(ArrayBuffer) === "{}"，读回来 wasm 长度为 0。
//   所以这里用 base64 字符串存，并且在测试里用"会 JSON 往返"的假 memento 复现
//   Web 端（vscode.dev 底层是 IndexedDB + JSON）的真实行为。
//
// 宿主无关：只依赖一个 { get(key, def), update(key, value) } 的 Memento 接口。

/** Uint8Array → base64（分块，避免 apply 参数过多爆栈） */
export function b64enc(u8) {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  }
  return btoa(s);
}

/** base64 → Uint8Array */
export function b64dec(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

export const CACHE_KEY = "oiCpp.compileCache.v2";   // v1 存的是 ArrayBuffer（永远是坏的）
// ⚠️ 上限别太小：调试产物实测 3.2–3.6MB（-O0 -g + 桩），而 `dbg:` 键本来就有好几种口径
//    （F5 / 符号探针 / 对拍面板各一套参数），3 条会互相淘汰 —— 表现就是
//    "运行能缓存、调试不缓存"。6 条 + 24MB 足够覆盖"运行/调试/对拍"混用的场景。
const MAX_ENTRIES = 6;
const MAX_BYTES = 24 * 1024 * 1024;
// L1：进程内直接存 Uint8Array，命中时省掉 base64 解码（3.6MB → 4.8MB 字符串，来回都要走一遍）
const L1_MAX_ENTRIES = 6;
const L1_MAX_BYTES = 48 * 1024 * 1024;
// L2 的**总**字节预算：单条上限之外还要有总量上限，否则 6 条 × 24MB = 144MB wasm
// （base64 后 192MB）全塞进 globalState，网页版会触发配额失败 / "large extension state"。
// 而每次 put 都要把整包 JSON 序列化一次，越大越卡。
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;

/**
 * @param {{get:Function, update:Function}} memento 通常就是 ctx.globalState
 * @param {{log?:(s:string)=>void}} [opts]
 */
export function createCompileCache(memento, opts = {}) {
  const log = opts.log || (() => {});
  // ⚠️ LRU 的时间戳必须**严格单调递增**：以前用 Date.now()，同一毫秒内连写几条时间戳全相等，
  //    排序退化为插入顺序 → 淘汰时把"最新那条"给删了（缓存看起来时灵时不灵）。
  //    从 Date.now() 起步是为了和上一个会话存下来的 t 保持可比（跨重启仍然按新旧排序）。
  let tick = Date.now();
  let mem = null;
  // L1 内存缓存：key → { wasm, ms }（不做 base64，命中直接返回同一份字节）
  const l1 = new Map();
  let l1Bytes = 0;
  const l1Get = (k) => {
    const e = l1.get(k);
    if (!e) return null;
    // ⚠️ 调用方可能把产物 buffer transfer 给 worker（transfer 后 byteLength 变 0）。
    //    母本一旦被转移，这条 L1 就废了 —— 当作未命中并清掉。
    if (!e.wasm || e.wasm.byteLength === 0) { l1Bytes -= (e.wasm ? e.wasm.length : 0); l1.delete(k); return null; }
    // 命中即提到队尾（真正的 LRU）
    l1.delete(k); l1.set(k, e);
    // 每次都返回**副本**：调用方可能会 transfer/改写，母本必须保持干净
    return { wasm: new Uint8Array(e.wasm), ms: e.ms };
  };
  const l1Put = (k, wasm, ms) => {
    if (wasm.length > MAX_BYTES) return;
    if (l1.has(k)) { l1Bytes -= l1.get(k).wasm.length; l1.delete(k); }
    // 母本另存一份（不与被 transfer 的那份共享 buffer）
    l1.set(k, { wasm: new Uint8Array(wasm), ms: ms || 0 });
    l1Bytes += wasm.length;
    while (l1.size > L1_MAX_ENTRIES || l1Bytes > L1_MAX_BYTES) {
      const oldest = l1.keys().next().value;
      l1Bytes -= l1.get(oldest).wasm.length;
      l1.delete(oldest);
    }
  };
  const load = () => {
    if (mem) return mem;
    try { mem = memento.get(CACHE_KEY, { entries: {} }); } catch { mem = { entries: {} }; }
    if (!mem || typeof mem !== "object" || !mem.entries || typeof mem.entries !== "object") {
      mem = { entries: {} };
    }
    return mem;
  };

  // 命中即刷新 recency：以前只有 put 才 ++tick，get 命中不刷新 →
  // 淘汰的是"最久没被**写入**"的，而不是"最久没被**使用**"的。
  // 正在反复使用的调试产物会被一次对拍写入挤掉，表现就是"调试永远不缓存"。
  // 命中即刷新 recency（真 LRU）：只改**内存里**的 t，不回写 memento。
  // ⚠️ 别在这里 memento.update：缓存最多 24MB base64，写一次就是把整包 JSON 重新序列化，
  //    网页版（IndexedDB）上会明显卡顿，正是以前 "large extension state detected" 的来源。
  //    真正的落盘交给 put（写入新条目时顺带把顺序带下去）。
  const markTouched = (k) => {
    const m = load();
    const e = m.entries[k];
    if (!e) return;
    e.t = ++tick;
  };

  return {
    /** @returns {{wasm:Uint8Array, ms:number}|null} */
    get(k) {
      if (!k) return null;
      // L1 命中：不碰 base64/memento
      const hot = l1Get(k);
      if (hot) {
        log(`缓存命中(L1) ${k}（${(hot.wasm.length / 1048576).toFixed(1)}MB）`);
        markTouched(k);
        return { wasm: hot.wasm, ms: hot.ms };
      }
      const e = load().entries[k];
      if (!e || typeof e.b64 !== "string" || !e.b64) return null;
      try {
        const wasm = b64dec(e.b64);
        if (!wasm.length) return null;
        // 校验 wasm magic（\0asm）：缓存被截断/写坏时，坏字节直接喂给 WebAssembly.compile
        // 会让所有用例报 RE，症状和"编译产物有问题"一模一样。宁可当未命中重编一次。
        if (!(wasm.length >= 4 && wasm[0] === 0x00 && wasm[1] === 0x61 && wasm[2] === 0x73 && wasm[3] === 0x6d)) {
          log(`缓存条目损坏（不是 wasm），按未命中处理：${k}`);
          return null;
        }
        log(`缓存命中 ${k}（${(wasm.length / 1048576).toFixed(1)}MB，上次编译 ${e.ms}ms）`);
        return { wasm, ms: e.ms || 0 };
      } catch (e2) {
        log("缓存解码失败，当作未命中: " + ((e2 && e2.message) || e2));
        return null;
      }
    },
    /** @param {Uint8Array} wasm */
    put(k, wasm, ms) {
      if (!k || !wasm || !wasm.length) return false;
      try {
        if (wasm.length > MAX_BYTES) { log(`产物 ${(wasm.length / 1048576).toFixed(1)}MB 超过缓存上限，跳过`); return false; }
        const m = load();
        m.entries[k] = { b64: b64enc(wasm), ms: ms || 0, t: ++tick, bytes: wasm.length };
        l1Put(k, wasm, ms);
        // 淘汰：条数上限 + **总字节上限**（按最近使用时间从旧到新删）
        const keys = Object.keys(m.entries).sort((a, b) => (m.entries[b].t || 0) - (m.entries[a].t || 0));
        const sizeOf = (key) => {
          const e = m.entries[key];
          return (e && (e.bytes || Math.floor((e.b64 || "").length * 0.75))) || 0;
        };
        let total = keys.reduce((n, key) => n + sizeOf(key), 0);
        while (keys.length > MAX_ENTRIES || (total > MAX_TOTAL_BYTES && keys.length > 1)) {
          const dead = keys.pop();
          total -= sizeOf(dead);
          delete m.entries[dead];
          log(`缓存淘汰 ${dead}（总 ${(total / 1048576).toFixed(1)}MB / 条数 ${keys.length}）`);
        }
        const p = memento.update(CACHE_KEY, m);
        if (p && typeof p.catch === "function") p.catch((e) => log("缓存写入失败（忽略）: " + ((e && e.message) || e)));
        log(`已写入缓存 ${k}（${(wasm.length / 1048576).toFixed(1)}MB）`);
        return true;
      } catch (e) {
        log("缓存写入异常（忽略）: " + ((e && e.message) || e));
        return false;
      }
    },
    /** 调试用 */
    size() { return Object.keys(load().entries).length; },
  };
}
