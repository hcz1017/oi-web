// 后台预加载回归测试（纯逻辑 + 假 fetch / 假响应，秒级，不需要网络和工具链）。
//
// 钉住的都是容易写坏的点：
//   · 清单里**绝不能**出现 clangd（26M，打开 cpp 时它自己会拉，塞进来只会拖慢首屏）；
//   · 必须真的**读掉 body**（只发请求不消费响应体，浏览器不保证写进 HTTP 缓存）；
//   · 严格串行（大文件并发互相抢带宽）；
//   · 单项失败不影响后续，且整体不抛异常（预加载绝不能把激活搞崩）；
//   · 进度要**边下边报**（loaded 单调增、总量来自 HEAD 的 content-length）；
//   · 支持 AbortSignal 取消，取消后不再发新请求；
//   · 能识别"这次来自缓存"（transferSize === 0）并单独统计。
import { PRELOAD_MANIFEST, preloadAssets, joinAssetUrl, NOTIFY_AFTER_MS, shouldShowProgress } from "../src/web/preload.js";

let pass = true;
const must = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) pass = false; return c; };

// ---------- 1. 清单内容 ----------
must(Array.isArray(PRELOAD_MANIFEST) && PRELOAD_MANIFEST.length > 0, "清单非空");
must(!PRELOAD_MANIFEST.some((x) => /clangd/i.test(x)), "清单里不含 clangd（打开 cpp 时自然加载）");
for (const need of ["clang.wasm.gz", "lld.wasm.gz", "sysroot.tar.gz", "compat/bits/stdc++.h"]) {
  must(PRELOAD_MANIFEST.includes(need), `清单包含编译必需资产 ${need}`);
}
must(PRELOAD_MANIFEST.includes("dwarf/SymbolsBackend.wasm.gz"), "清单包含调试符号引擎（F5 必用 13M）");

// ---------- 2. URL 拼接 ----------
must(joinAssetUrl("https://x/assets/", "clang.wasm.gz") === "https://x/assets/clang.wasm.gz", "base 尾部斜杠归一化");
must(joinAssetUrl("https://x/assets", "/clang.wasm.gz") === "https://x/assets/clang.wasm.gz", "rel 头部斜杠归一化");
must(!joinAssetUrl("https://x/assets/", "a").includes("//a"), "不出现双斜杠");

// ---------- 假 fetch：记录顺序/并发，body 分块吐出，支持 HEAD ----------
function makeFake({ failOn = null, size = 1024, chunk = 256, headOk = true } = {}) {
  const calls = [];
  let open = 0, maxOpen = 0;
  const fakeFetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || "GET", opts });
    if (opts.method === "HEAD") {
      if (!headOk) return { ok: false, status: 405, headers: { get: () => null } };
      return { ok: true, status: 200, headers: { get: (k) => (k.toLowerCase() === "content-length" ? String(size) : null) } };
    }
    open++; maxOpen = Math.max(maxOpen, open);
    if (failOn && url.includes(failOn)) { open--; return { ok: false, status: 500, headers: { get: () => null } }; }
    let sent = 0;
    return {
      ok: true, status: 200,
      headers: { get: (k) => (k.toLowerCase() === "content-length" ? String(size) : null) },
      body: {
        getReader() {
          return {
            read: async () => {
              if (sent >= size) { open--; return { done: true }; }
              const n = Math.min(chunk, size - sent);
              sent += n;
              await new Promise((r) => setImmediate(r));
              return { done: false, value: new Uint8Array(n) };
            },
          };
        },
      },
    };
  };
  return { fakeFetch, calls, get maxOpen() { return maxOpen; } };
}

// ---------- 3. 正常流程 + 进度单调 ----------
{
  const SIZE = 4096;
  const f = makeFake({ size: SIZE });
  const logs = [];
  const prog = [];
  const r = await preloadAssets({
    base: "https://cdn/assets", manifest: PRELOAD_MANIFEST, fetchImpl: f.fakeFetch,
    delayMs: 0, log: (s) => logs.push(s), onProgress: (e) => prog.push({ ...e }),
  });
  must(r.ok === true, "全部成功时 ok=true");
  must(r.bytes === SIZE * PRELOAD_MANIFEST.length, `汇报总下载字节（${r.bytes}）`);
  must(r.total === SIZE * PRELOAD_MANIFEST.length, `总量来自 HEAD 的 content-length（${r.total}）`);
  must(f.maxOpen === 1, `严格串行（同时最多 1 个 GET，实际 ${f.maxOpen}）`);
  must(prog.length >= 2, `进度回调被多次调用（${prog.length} 次）`);
  let mono = true;
  for (let i = 1; i < prog.length; i++) if (prog[i].loaded < prog[i - 1].loaded) mono = false;
  must(mono, "进度里的 loaded 单调不减（进度条不会倒退）");
  must(prog[prog.length - 1].loaded === r.bytes, "最后一次进度的 loaded 等于总字节数");
  must(prog.some((p) => p.file), "进度里带了当前文件名（通知里能显示在下载哪个）");
  must(prog[prog.length - 1].done === true, "最后一次进度标记 done");
  must(logs.some((s) => /预加载完成/.test(s)), "结束时有一条汇总日志");
}

// ---------- 4. 单项失败：继续跑完，不抛错 ----------
{
  const f = makeFake({ failOn: "sysroot.tar.gz" });
  const r = await preloadAssets({ base: "https://cdn/assets", manifest: PRELOAD_MANIFEST, fetchImpl: f.fakeFetch, delayMs: 0 });
  must(r.ok === false, "有失败项时 ok=false");
  const bad = r.items.find((x) => x.rel === "sysroot.tar.gz");
  must(bad && bad.ok === false && /500/.test(bad.error), `失败项带原因（${bad && bad.error}）`);
  const okCount = r.items.filter((x) => x.ok).length;
  must(okCount === PRELOAD_MANIFEST.length - 1, `其余 ${okCount} 项照常完成`);
}

// ---------- 5. fetch 抛异常也不能崩 ----------
{
  const boom = async () => { throw new Error("network down"); };
  let threw = false, r = null;
  try { r = await preloadAssets({ base: "https://cdn/assets", manifest: ["a.gz", "b.gz"], fetchImpl: boom, delayMs: 0 }); }
  catch { threw = true; }
  must(!threw, "fetch 抛异常时 preloadAssets 也不抛");
  must(r && r.items.length === 2 && r.items.every((x) => !x.ok), "两项都标记为失败");
}

// ---------- 6. HEAD 不支持时总量未知，但功能照常 ----------
{
  const f = makeFake({ headOk: false, size: 1024 });
  const prog = [];
  const r = await preloadAssets({
    base: "https://cdn/assets", manifest: ["a.gz"], fetchImpl: f.fakeFetch, delayMs: 0,
    onProgress: (e) => prog.push({ ...e }),
  });
  must(r.ok === true, "HEAD 405 时仍然成功");
  must(r.bytes === 1024, `字节统计仍然正确（${r.bytes}）`);
  must(prog.some((p) => p.total > 0), "总量由 GET 的 content-length 补上");
}

// ---------- 7. 缓存命中识别 ----------
{
  const f = makeFake({ size: 2048 });
  const r = await preloadAssets({
    base: "https://cdn/assets", manifest: ["a.gz", "b.gz"], fetchImpl: f.fakeFetch, delayMs: 0,
    lookupTransferSize: (url) => (url.endsWith("a.gz") ? 0 : 2048),   // a.gz 来自缓存
  });
  must(r.cachedBytes === 2048, `缓存命中的字节单独统计（${r.cachedBytes}）`);
  must(r.items.find((x) => x.rel === "a.gz").fromCache === true, "a.gz 标记为缓存命中");
  must(r.items.find((x) => x.rel === "b.gz").fromCache === false, "b.gz 标记为真实下载");
}

// ---------- 8. 取消：不再发新请求 ----------
{
  const f = makeFake({ size: 1024 });
  const ac = new AbortController();
  const prog = [];
  let getCount = 0;
  // 第 2 个 GET 时用户点了"取消"（不依赖进度节流，避免测试跟限流赛跑）
  const wrapped = async (url, opts = {}) => {
    if ((opts.method || "GET") === "GET" && ++getCount === 2) ac.abort();
    return f.fakeFetch(url, opts);
  };
  const r = await preloadAssets({
    base: "https://cdn/assets", manifest: PRELOAD_MANIFEST, fetchImpl: wrapped, delayMs: 0,
    signal: ac.signal, onProgress: (e) => prog.push({ ...e }),
  });
  must(r.cancelled === true, "取消后返回 cancelled=true");
  must(f.calls.filter((c) => c.method === "GET").length < PRELOAD_MANIFEST.length,
    `取消后没有把清单跑完（GET 次数 ${f.calls.filter((c) => c.method === "GET").length}）`);
  must(prog[prog.length - 1].cancelled === true, "最后一条进度标记 cancelled");
}

// ---------- 9. 不该跑的情况 ----------
{
  const f = makeFake();
  const r1 = await preloadAssets({ base: "https://cdn/assets", manifest: PRELOAD_MANIFEST, fetchImpl: null, delayMs: 0 });
  must(r1.skipped === "no-fetch", "没有 fetch 实现时跳过");
  const r2 = await preloadAssets({ base: "", manifest: PRELOAD_MANIFEST, fetchImpl: f.fakeFetch, delayMs: 0 });
  must(r2.skipped === "no-base", "没有 assets 根时跳过");
  must(f.calls.length === 0, "跳过时一个请求都没发");
}

// ---------- 10. 超过 10s 才弹通知 ----------
{
  must(NOTIFY_AFTER_MS === 10000, `通知阈值是 10 秒（${NOTIFY_AFTER_MS}ms）`);
  must(!shouldShowProgress(0), "刚开始不弹");
  must(!shouldShowProgress(9999), "9999ms 还不弹（缓存全命中就该安静）");
  must(shouldShowProgress(10000), "10000ms 到点就弹");
  must(shouldShowProgress(60000), "慢网下持续显示");
}

// ---------- 11. 合计大小：不按文件分开 ----------
{
  const f = makeFake({ size: 1000 });
  const prog = [];
  await preloadAssets({
    base: "https://cdn/assets", manifest: ["a.gz", "b.gz", "c.gz"], fetchImpl: f.fakeFetch, delayMs: 0,
    onProgress: (e) => prog.push({ ...e }),
  });
  const last = prog[prog.length - 1];
  must(last.total === 3000, `总量是三个文件之和（${last.total}）`);
  must(last.loaded === 3000, `已下载量也是合计（${last.loaded}）`);
  const mids = prog.filter((p) => p.loaded > 0 && p.loaded < 3000);
  must(mids.every((p) => p.total === 3000), "中途上报的也是同一套合计口径（进度条不会跳变）");
}

// ---------- 10. 让路延迟生效 ----------
{
  let slept = null;
  const f = makeFake();
  await preloadAssets({
    base: "https://cdn/assets", manifest: ["a.gz"], fetchImpl: f.fakeFetch, delayMs: 1200,
    sleep: async (ms) => { slept = ms; },
  });
  must(slept === 1200, `开始前有让路延迟（${slept}ms）`);
}

console.log(pass ? "\n全部通过" : "\n存在失败项");
process.exit(pass ? 0 : 1);
