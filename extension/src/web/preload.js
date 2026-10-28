// 首次启动的**后台预加载**：把编译/调试要用的资产先用网络拉一遍，灌进浏览器 HTTP 缓存。
//
// 目的：第一次按 Ctrl+Shift+B 或 F5 时不再干等 15M+7.5M+5.2M 的下载。这里只做
// "发请求 + 读掉 body + 报进度"，不做任何解析、不建 worker；失败也不影响任何功能。
//
// 几条刻意的设计（都是踩过的坑）：
//   · **不预加载 clangd**：26M，而且打开 .cpp 时 clangd 自己会拉；塞进来只会拖慢首屏。
//   · **必须读完 body**：只发请求不消费响应体，浏览器不保证写进 HTTP 缓存 → 等于白预热。
//   · **严格串行**：几个大文件并发会互相抢带宽，弱网下反而更慢。
//   · **不设超时**：慢就慢慢下，绝不能因为预加载把什么东西卡住或中断。
//   · **单个失败只记日志**：失败的那个等真正用到时再下，其余继续。
//   · **可取消**：宿主传 AbortSignal 进来，用户点"取消"就停下（已下载的部分仍然有效，
//     浏览器缓存不会浪费）。
//   · 进度要**流式上报**（边下边报），否则通知里的进度条会一直卡着然后突然满。

/**
 * 超过这个时长才弹进度通知：缓存全命中时几百毫秒就结束，弹一下再消失反而碍眼。
 * 抽成常量 + 纯函数，方便测试钉住（改阈值时别把测试和实现改歪）。
 */
export const NOTIFY_AFTER_MS = 10000;

/** 是否该弹出进度通知（elapsedMs 为预加载已耗时） */
export function shouldShowProgress(elapsedMs) {
  return Number(elapsedMs) >= NOTIFY_AFTER_MS;
}

/** 预加载清单（相对 assets 根）。⚠️ 不要往里加 clangd/* —— 见 test/preload.mjs 的断言 */
export const PRELOAD_MANIFEST = [
  "clang.wasm.gz",
  "lld.wasm.gz",
  "sysroot.tar.gz",
  "compat/bits/stdc++.h",
  "dwarf/worker.js",
  "dwarf/SymbolsBackend.wasm.gz",
];

/** 拼 URL：base 尾部斜杠归一化，避免出现 "//" */
export function joinAssetUrl(base, rel) {
  const b = String(base || "").replace(/\/+$/, "");
  const r = String(rel || "").replace(/^\/+/, "");
  return `${b}/${r}`;
}

/**
 * 后台预加载。**不抛异常**（永远 resolve），返回一个简报便于日志/测试。
 *
 * @param {object} o
 * @param {string} o.base            assets 根 URL
 * @param {(s:string)=>void} [o.log] 日志出口
 * @param {Function} [o.fetchImpl]   fetch 实现（测试注入）
 * @param {number} [o.delayMs]       开始前的让路延迟（默认 1200ms）
 * @param {string[]} [o.manifest]    覆盖清单（测试用）
 * @param {Function} [o.sleep]       sleep 实现（测试注入）
 * @param {AbortSignal} [o.signal]   取消信号
 * @param {(e:object)=>void} [o.onProgress]
 *        进度回调：{ loaded, total, cached, file, done, cancelled, fromCache }
 *        loaded/total 单位为字节；total 为 0 表示还没测出总量（进度未知）
 * @param {(rel:string)=>number|null} [o.lookupTransferSize]
 *        可选：查某个 URL 本次是否**来自缓存**（transferSize 为 0 即缓存命中）。
 *        web 端默认用 performance.getEntriesByName；Node 测试可注入。
 */
export async function preloadAssets({
  base,
  log = () => {},
  fetchImpl = typeof fetch === "function" ? fetch : null,
  delayMs = 1200,
  manifest = PRELOAD_MANIFEST,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  signal = null,
  onProgress = () => {},
  lookupTransferSize = null,
} = {}) {
  const started = Date.now();
  if (!fetchImpl) return { ok: false, skipped: "no-fetch", items: [] };
  if (!base) return { ok: false, skipped: "no-base", items: [] };
  if (delayMs > 0) await sleep(delayMs);      // 先让激活/其它初始化跑完

  const aborted = () => !!(signal && signal.aborted);
  const items = [];
  let loaded = 0;          // 已完成（含缓存命中）的字节
  let total = 0;           // 已知总量（可能随测量推进而增长）
  let cachedBytes = 0;     // 其中来自缓存的字节

  // 进度上报（节流：同一毫秒内的多次 write 合并）
  let lastReport = 0;
  const report = (extra = {}) => {
    const now = Date.now();
    if (!extra.force && now - lastReport < 80) return;
    lastReport = now;
    try { onProgress({ loaded, total, cached: cachedBytes, ...extra }); } catch { }
  };

  // ---------- 阶段 1：测总量（HEAD，便宜且能命中缓存）----------
  const sizes = new Map();
  for (const rel of manifest) {
    if (aborted()) break;
    const url = joinAssetUrl(base, rel);
    try {
      const res = await fetchImpl(url, { method: "HEAD", cache: "force-cache", signal: signal || undefined });
      const len = res && res.ok !== false && res.headers && res.headers.get ? Number(res.headers.get("content-length")) : NaN;
      if (Number.isFinite(len) && len > 0) { sizes.set(rel, len); total += len; }
    } catch { /* HEAD 不被支持就算了，总量未知 */ }
  }
  report({ force: true, file: null });

  // ---------- 阶段 2：串行下载（流式统计字节）----------
  let cancelled = false;
  for (const rel of manifest) {
    if (aborted()) { cancelled = true; break; }
    const url = joinAssetUrl(base, rel);
    const t0 = Date.now();
    let bytes = 0;
    try {
      const res = await fetchImpl(url, { cache: "force-cache", signal: signal || undefined });
      if (!res || res.ok === false) {
        items.push({ rel, ok: false, error: `HTTP ${res && res.status}` });
        log(`预加载: ${rel} 失败（HTTP ${res && res.status}），用到时再说`);
        continue;
      }
      // 有的服务器 HEAD 不给长度，这里用 GET 的 content-length 补上
      if (!sizes.has(rel)) {
        const len = res.headers && res.headers.get ? Number(res.headers.get("content-length")) : NaN;
        if (Number.isFinite(len) && len > 0) { sizes.set(rel, len); total += len; }
      }
      bytes = await consumeBody(res, (n) => {
        loaded += n;
        report({ file: rel });
      });
      // 用 HEAD 测到的长度对齐（流式统计可能因 gzip/长度头缺失而偏小）
      const known = sizes.get(rel) || 0;
      if (bytes > known) {           // 实际比预估大：修正总量
        total += bytes - known;
        sizes.set(rel, bytes);
      } else if (known > bytes && bytes === 0) {
        // 流读完但没统计到字节（实现兜底）：按已知长度记
        bytes = known; loaded += known;
      }
      const transfer = typeof lookupTransferSize === "function" ? lookupTransferSize(url) : null;
      const fromCache = transfer === 0;
      if (fromCache) cachedBytes += bytes;
      const ms = Date.now() - t0;
      items.push({ rel, ok: true, bytes, ms, fromCache });
      log(`预加载: ${rel} ${(bytes / 1048576).toFixed(2)}MB ${(ms / 1000).toFixed(1)}s${fromCache ? "（缓存命中）" : ""}`);
    } catch (e) {
      if (aborted()) { cancelled = true; break; }
      items.push({ rel, ok: false, error: String((e && e.message) || e) });
      log(`预加载: ${rel} 出错（${(e && e.message) || e}），忽略`);
    }
    report({ file: rel, force: true });   // 每个文件收尾必报一次（否则快网下通知里看不到文件名）
  }

  const failed = items.filter((x) => !x.ok).length;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (cancelled) {
    log(`预加载: 已取消（已完成 ${(loaded / 1048576).toFixed(1)}MB）`);
  } else {
    log(`预加载完成 ${(loaded / 1048576).toFixed(1)}MB / ${(total / 1048576).toFixed(1)}MB` +
      ` / ${secs}s${cachedBytes ? `（缓存命中 ${(cachedBytes / 1048576).toFixed(1)}MB）` : ""}` +
      (failed ? `（${failed} 项失败，用到时会重试）` : "（编译与调试首次使用不再等待下载）"));
  }
  report({ force: true, file: null, done: true, cancelled });
  return { ok: failed === 0 && !cancelled, items, bytes: loaded, total, cachedBytes, ms: Date.now() - started, cancelled };
}

/**
 * 读掉响应体并返回字节数（优先流式，边读边回调进度）。
 * @param {(n:number)=>void} [onChunk]
 */
async function consumeBody(res, onChunk = () => {}) {
  const headerLen = Number(res.headers && res.headers.get && res.headers.get("content-length"));
  if (res.body && typeof res.body.getReader === "function") {
    try {
      const reader = res.body.getReader();
      let n = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const len = value && value.byteLength ? value.byteLength : 0;
        n += len;
        if (len) onChunk(len);
      }
      return n;
    } catch { /* 落到下面的兜底 */ }
  }
  if (res.body && typeof res.body.pipeTo === "function") {
    try {
      let n = 0;
      await res.body.pipeTo(new WritableStream({ write(chunk) { const len = chunk && chunk.byteLength || 0; n += len; if (len) onChunk(len); } }));
      return n;
    } catch { /* 继续兜底 */ }
  }
  try {
    const buf = await res.arrayBuffer();
    const n = (buf && buf.byteLength) || 0;
    if (n) onChunk(n);
    return n || (Number.isFinite(headerLen) && headerLen > 0 ? headerLen : 0);
  } catch { return Number.isFinite(headerLen) && headerLen > 0 ? headerLen : 0; }
}
