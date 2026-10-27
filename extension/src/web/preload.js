// 首次启动的**后台预加载**：把编译/调试要用的资产先用网络拉一遍，灌进浏览器 HTTP 缓存。
//
// 目的：第一次按 Ctrl+Shift+B 或 F5 时不再干等 15M+7.5M+5.2M 的下载（日志里那个
// "调试准备完成 … 19238ms" 主要就是下载 + 解压）。这里只做"发请求 + 读掉 body"，
// 不做任何解析、不建 worker、不管结果，失败也不影响任何功能。
//
// 几条刻意的设计（都是踩过的坑）：
//   · **不预加载 clangd**：26M，而且打开 .cpp 时 clangd 自己会拉；塞进来只会拖慢首屏。
//   · **必须读完 body**：只发请求不消费响应体，浏览器不保证写进 HTTP 缓存 → 等于白预热。
//     用 pipeTo(WritableStream) 流式丢弃，避免 15M 驻留内存。
//   · **严格串行**：几个大文件并发会互相抢带宽，弱网下反而更慢。
//   · **不设超时**：慢就慢慢下，绝不能因为预加载把什么东西卡住或中断。
//   · **单个失败只记日志**：失败的那个等真正用到时再下，其余继续。
//   · 纯函数式依赖注入（fetchImpl/log/streamFactory），方便用假实现做单元测试。

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
 * @param {number} [o.delayMs]       开始前的让路延迟（默认 1500ms）
 * @param {string[]} [o.manifest]    覆盖清单（测试用）
 * @param {Function} [o.sleep]       sleep 实现（测试注入）
 */
export async function preloadAssets({
  base,
  log = () => {},
  fetchImpl = typeof fetch === "function" ? fetch : null,
  delayMs = 1500,
  manifest = PRELOAD_MANIFEST,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const started = Date.now();
  if (!fetchImpl) return { ok: false, skipped: "no-fetch", items: [] };
  if (!base) return { ok: false, skipped: "no-base", items: [] };
  if (delayMs > 0) await sleep(delayMs);      // 先让激活/其它初始化跑完

  const items = [];
  for (const rel of manifest) {
    const url = joinAssetUrl(base, rel);
    const t0 = Date.now();
    let bytes = 0;
    try {
      // cache: force-cache —— 已在缓存里就直接命中，不重复走网络
      const res = await fetchImpl(url, { cache: "force-cache" });
      if (!res || (res.ok === false)) {
        items.push({ rel, ok: false, error: `HTTP ${res && res.status}` });
        log(`预加载: ${rel} 失败（HTTP ${res && res.status}），用到时再说`);
        continue;
      }
      // 关键：把 body 消费掉，浏览器才会真正缓存住
      bytes = await consumeBody(res);
      const ms = Date.now() - t0;
      items.push({ rel, ok: true, bytes, ms });
      log(`预加载: ${rel} ${(bytes / 1048576).toFixed(2)}MB ${(ms / 1000).toFixed(1)}s`);
    } catch (e) {
      items.push({ rel, ok: false, error: String((e && e.message) || e) });
      log(`预加载: ${rel} 出错（${(e && e.message) || e}），忽略`);
    }
  }

  const totalBytes = items.reduce((a, x) => a + (x.bytes || 0), 0);
  const failed = items.filter((x) => !x.ok).length;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  log(`预加载完成 ${(totalBytes / 1048576).toFixed(1)}MB / ${secs}s` +
    (failed ? `（${failed} 项失败，用到时会重试）` : "（编译与调试首次使用不再等待下载）"));
  return { ok: failed === 0, items, bytes: totalBytes, ms: Date.now() - started };
}

/** 读掉响应体并返回字节数（优先流式，兜底 arrayBuffer） */
async function consumeBody(res) {
  try {
    const len = Number(res.headers && res.headers.get && res.headers.get("content-length"));
    if (res.body && typeof res.body.pipeTo === "function") {
      await res.body.pipeTo(new WritableStream());       // 流式丢弃，不驻留内存
      return Number.isFinite(len) && len > 0 ? len : 0;
    }
  } catch { /* 流不可用就退回下面的 arrayBuffer */ }
  try {
    const buf = await res.arrayBuffer();
    return (buf && buf.byteLength) || 0;
  } catch { return 0; }
}
