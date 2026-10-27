// 后台预加载回归测试（纯逻辑 + 假 fetch，秒级，不需要网络和工具链）。
//
// 钉住的都是容易写坏的点：
//   · 清单里**绝不能**出现 clangd（26M，打开 cpp 时它自己会拉，塞进来只会拖慢首屏）；
//   · 必须真的**读掉 body**（只发请求不消费响应体，浏览器不保证写进 HTTP 缓存）；
//   · 严格串行（大文件并发互相抢带宽）；
//   · 单项失败不影响后续，且整体不抛异常（预加载绝不能把激活搞崩）；
//   · preload=false / 桌面版（不调用）→ 一个请求都不发。
import { PRELOAD_MANIFEST, preloadAssets, joinAssetUrl } from "../src/web/preload.js";

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

// ---------- 3. 假 fetch：记录顺序、body 是否被读、耗时是否重叠 ----------
function makeFake({ failOn = null, size = 1024 } = {}) {
  const calls = [];
  let open = 0, maxOpen = 0;
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts, t: Date.now() });
    open++; maxOpen = Math.max(maxOpen, open);
    const name = url.split("/").pop();
    if (failOn && url.includes(failOn)) {
      open--;
      return { ok: false, status: 500, headers: { get: () => null } };
    }
    let consumed = false;
    const res = {
      ok: true, status: 200,
      headers: { get: () => String(size) },
      body: {
        pipeTo: async (ws) => {          // 模拟流式消费
          await new Promise((r) => setImmediate(r));
          consumed = true;
          open--;
        },
      },
      arrayBuffer: async () => { consumed = true; open--; return new ArrayBuffer(size); },
      get consumed() { return consumed; },
    };
    return res;
  };
  return { fakeFetch, calls, get maxOpen() { return maxOpen; } };
}

// ---------- 4. 正常流程 ----------
{
  const f = makeFake({ size: 2048 });
  const logs = [];
  const r = await preloadAssets({
    base: "https://cdn/assets", manifest: PRELOAD_MANIFEST, fetchImpl: f.fakeFetch,
    delayMs: 0, log: (s) => logs.push(s),
  });
  must(r.ok === true, "全部成功时 ok=true");
  must(f.calls.length === PRELOAD_MANIFEST.length, `每个资产都请求了（${f.calls.length}/${PRELOAD_MANIFEST.length}）`);
  must(f.calls.every((c) => c.opts && c.opts.cache === "force-cache"), "都用 cache:force-cache（命中已有缓存）");
  must(f.calls.every((c, i) => c.url.endsWith(PRELOAD_MANIFEST[i])), "请求顺序 = 清单顺序");
  must(f.maxOpen === 1, `严格串行（同时最多 1 个请求，实际 ${f.maxOpen}）`);
  must(r.bytes === 2048 * PRELOAD_MANIFEST.length, `汇报总字节数（${r.bytes}）`);
  must(logs.some((s) => /预加载完成/.test(s)), "结束时有一条汇总日志");
}

// ---------- 5. 单项失败：继续跑完，不抛错 ----------
{
  const f = makeFake({ failOn: "sysroot.tar.gz" });
  const r = await preloadAssets({
    base: "https://cdn/assets", manifest: PRELOAD_MANIFEST, fetchImpl: f.fakeFetch, delayMs: 0,
  });
  must(r.ok === false, "有失败项时 ok=false");
  must(f.calls.length === PRELOAD_MANIFEST.length, "失败后仍然继续处理后续项");
  const bad = r.items.find((x) => x.rel === "sysroot.tar.gz");
  must(bad && bad.ok === false && /500/.test(bad.error), `失败项带原因（${bad && bad.error}）`);
}

// ---------- 6. fetch 抛异常也不能崩 ----------
{
  const boom = async () => { throw new Error("network down"); };
  let threw = false;
  let r = null;
  try {
    r = await preloadAssets({ base: "https://cdn/assets", manifest: ["a.gz", "b.gz"], fetchImpl: boom, delayMs: 0 });
  } catch { threw = true; }
  must(!threw, "fetch 抛异常时 preloadAssets 也不抛");
  must(r && r.items.length === 2 && r.items.every((x) => !x.ok), "两项都标记为失败");
}

// ---------- 7. 不该跑的情况 ----------
{
  const f = makeFake();
  const r1 = await preloadAssets({ base: "https://cdn/assets", manifest: PRELOAD_MANIFEST, fetchImpl: f.fakeFetch, delayMs: 0, ...{ fetchImpl: null } });
  must(r1.skipped === "no-fetch", "没有 fetch 实现时跳过");
  const r2 = await preloadAssets({ base: "", manifest: PRELOAD_MANIFEST, fetchImpl: f.fakeFetch, delayMs: 0 });
  must(r2.skipped === "no-base", "没有 assets 根时跳过");
  must(f.calls.length === 0, "跳过时一个请求都没发");
}

// ---------- 8. 让路延迟真的生效 ----------
{
  let slept = null;
  const f = makeFake();
  await preloadAssets({
    base: "https://cdn/assets", manifest: ["a.gz"], fetchImpl: f.fakeFetch, delayMs: 1500,
    sleep: async (ms) => { slept = ms; },
  });
  must(slept === 1500, `开始前有让路延迟（${slept}ms）`);
}

console.log(pass ? "\n全部通过" : "\n存在失败项");
process.exit(pass ? 0 : 1);
