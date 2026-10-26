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
const MAX_ENTRIES = 4;
const MAX_BYTES = 12 * 1024 * 1024;

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
  const load = () => {
    if (mem) return mem;
    try { mem = memento.get(CACHE_KEY, { entries: {} }); } catch { mem = { entries: {} }; }
    if (!mem || typeof mem !== "object" || !mem.entries || typeof mem.entries !== "object") {
      mem = { entries: {} };
    }
    return mem;
  };

  return {
    /** @returns {{wasm:Uint8Array, ms:number}|null} */
    get(k) {
      if (!k) return null;
      const e = load().entries[k];
      if (!e || typeof e.b64 !== "string" || !e.b64) return null;
      try {
        const wasm = b64dec(e.b64);
        if (!wasm.length) return null;
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
        m.entries[k] = { b64: b64enc(wasm), ms: ms || 0, t: ++tick };
        const keys = Object.keys(m.entries).sort((a, b) => (m.entries[b].t || 0) - (m.entries[a].t || 0));
        while (keys.length > MAX_ENTRIES) delete m.entries[keys.pop()];
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
