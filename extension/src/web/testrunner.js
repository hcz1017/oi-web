// 对拍运行器：复用一个 runWorker 顺序跑用例；超时只能杀 worker（wasm 是同步执行的）。
//
// ⚠️ 为什么每次超时都要重建 worker：`wasi.start()` 在 worker 线程里同步跑到底，
//    JS 的定时器插不进去，宿主不 terminate 就永远卡住。所以超时 = terminate + 下次懒重建。
export function createRunner({ createWorker, log = () => { } }) {
  let w = null;
  let cur = null;     // { resolve, timer }

  const kill = () => {
    if (w) { try { w.terminate(); } catch { } }
    w = null;
  };

  const settle = (r) => {
    if (!cur) return;
    const { resolve, timer } = cur;
    cur = null;
    clearTimeout(timer);
    resolve(r);
  };

  const onMessage = (ev) => {
    const m = (ev && ev.data) || {};
    if (m.type === "testDone") {
      settle({
        out: m.out || "", err: m.err || "", code: m.code || 0,
        trap: m.trap || null, ms: m.ms || 0, truncated: !!m.truncated,
      });
    } else if (m.type === "error") {
      settle({ out: "", err: m.message || "运行出错", code: -1, trap: m.message || "运行出错" });
    }
  };

  const onError = (e) => {
    settle({ out: "", err: String((e && e.message) || e), code: -1, trap: String((e && e.message) || e) });
    kill();
  };

  return {
    /**
     * @param {Uint8Array} wasm 编译产物
     * @param {string} input 用例输入
     * @param {number} timeoutMs 超时（毫秒）
     */
    async run(wasm, input, timeoutMs = 2000) {
      if (!w) {
        w = await createWorker();
        w.onmessage = onMessage;
        w.onerror = onError;
        log("对拍: 已创建运行 worker");
      }
      // ⚠️ wasm 的**类型不固定**：编译（缓存未命中）回来的是 ArrayBuffer
      //    （compileWorker 里 `wasm: r.wasm.buffer`），缓存命中回来的是 Uint8Array。
      //    以前直接 `wasm.slice(0).buffer`：ArrayBuffer 没有 .buffer → 得到 undefined
      //    → postMessage 抛 "Failed to convert value to 'object'"（面板上全变 RE）。
      //    另外 postMessage 转移所有权会把缓冲区拿走，所以要**拷一份**。
      let buf;
      const u8 = wasm instanceof Uint8Array ? wasm : new Uint8Array(wasm);
      buf = u8.slice(0).buffer;
      if (!(buf instanceof ArrayBuffer)) {
        return { out: "", err: "", code: -1, trap: "内部错误：编译产物的类型不对" };
      }
      return await new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (!cur) return;
          cur = null;
          log(`对拍: 超时 ${timeoutMs}ms，结束该 worker`);
          kill();                                   // 只能杀线程打断它
          resolve({ out: "", err: "", code: -1, timedOut: true, ms: timeoutMs });
        }, Math.max(200, timeoutMs));
        cur = { resolve, timer };
        try {
          w.postMessage({ type: "runTest", bytes: buf, input }, [buf]);
        } catch (e) {
          clearTimeout(timer);
          cur = null;
          resolve({ out: "", err: "", code: -1, trap: String((e && e.message) || e) });
        }
      });
    },
    dispose() {
      settle({ out: "", err: "", code: -1, trap: "已取消" });
      kill();
    },
  };
}
