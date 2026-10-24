// 编译 worker（常驻）：只负责编译。运行在独立的 runWorker 里做，
// 这样 Ctrl+C 只杀运行实例，不会连带丢掉 28MB 工具链（以前那样每次 Ctrl+C 都要重下）。
import { Toolchain } from "../core/toolchain.mjs";

const post = (m, transfer) => self.postMessage(m, transfer || []);

self.onerror = (e) => post({ type: "error", message: "compile worker 内部错误: " + (e.message || e) });
self.addEventListener("unhandledrejection", (e) => {
  const r = e && e.reason;
  post({ type: "error", message: "compile worker 未捕获异常: " + ((r && (r.stack || r.message)) || r) });
});

async function fetchGz(url) {
  const r = await fetch(url, { cache: "force-cache" });
  if (!r.ok) throw new Error(`取不到 ${url}: HTTP ${r.status}`);
  const ds = new DecompressionStream("gzip");
  return new Uint8Array(await new Response(r.body.pipeThrough(ds)).arrayBuffer());
}
async function fetchRaw(url) {
  const r = await fetch(url, { cache: "force-cache" });
  if (!r.ok) throw new Error(`取不到 ${url}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

let tc = null;

// ⚠️ 编译必须**串行**：整个 worker 只有一个 Toolchain、一份内存 FS，
//    tc.compile 内部会在 /workspace 里删/写 out.o、dbgstub.o。
//    两条消息并发（例如"调试构建"和终端里 Ctrl+Shift+B 同时触发）就会互相删文件，
//    表现为 wasm-ld: error: cannot open /workspace/dbgstub.o: No such file or directory。
let compileChain = Promise.resolve();
const enqueue = (fn) => (compileChain = compileChain.then(fn, () => {}));

self.onmessage = async (ev) => {
  const m = ev.data || {};
  try {
    if (m.type === "init") {
      const b = String(m.assetsBase).replace(/\/+$/, "");
      post({ type: "log", message: "加载工具链（clang 15MB + lld 7.5MB + sysroot 5.2MB）…" });
      const [clangWasm, lldWasm, sysrootTar] = await Promise.all([
        fetchGz(`${b}/clang.wasm.gz`), fetchGz(`${b}/lld.wasm.gz`), fetchGz(`${b}/sysroot.tar.gz`),
      ]);
      const compatBits = await fetchRaw(`${b}/compat/bits/stdc++.h`).catch(() => null);
      tc = new Toolchain({ clangWasm, lldWasm, sysrootTar, compatBits });
      post({ type: "ready" });
      return;
    }
    if (m.type === "compile") {
      if (!tc) throw new Error("工具链未就绪");
      enqueue(async () => {
      try {
      const t0 = performance.now();
      const r = await tc.compile({
        source: m.source, fileName: m.fileName, flags: m.flags || [],
        opt: m.opt ?? 2, debug: m.debugInfo !== false,
        // 调试构建：先链接 wdb-stub，预置 import "wdb"."probe"（插桩需要）
        debugStub: !!m.debugStub,
      });
      const ms = Math.round(performance.now() - t0);
      if (!r.wasm) { post({ type: "compiled", id: m.id, ok: false, log: r.log, ms, exit: r.exit }); return; }
      // readFsFile 返回的就是拷贝（byteOffset 恒为 0），直接 transfer，别再 slice 一次
      post({ type: "compiled", id: m.id, ok: true, log: r.log, ms, size: r.wasm.length, wasm: r.wasm.buffer }, [r.wasm.buffer]);
      } catch (e) { post({ type: "error", id: m.id, message: (e && (e.stack || e.message)) || String(e) }); }
      });
      return;
    }
    throw new Error("未知消息 " + m.type);
  } catch (e) {
    post({ type: "error", id: m.id, message: (e && (e.stack || e.message)) || String(e) });
  }
};
post({ type: "log", message: "compile worker 就绪" });
