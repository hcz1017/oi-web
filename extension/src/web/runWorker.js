// 运行 worker：只负责执行一次编译产物。每次运行独立实例，所以 Ctrl+C 直接 terminate，
// 不会连带杀掉持有 28MB 工具链的编译 worker。
//
// stdin 协议（SharedArrayBuffer，与扩展侧约定）：
//   ctrl32 = Int32Array(sab, 0, 2)
//     ctrl[0] state: 0=空闲(宿主可写) 1=有数据(worker 可取) 3=EOF
//     ctrl[1] len：本批字节数
//   data = Uint8Array(sab, 8)
// 关键点（都是踩过的坑）：
//   · 宿主只在 state===0 时写，写完置 1 再 notify；worker 取完置 0 再 notify 回去
//     → 单槽也不丢数据（宿主持久队列，收到 consumed 后再冲刷）
//   · wasi-libc 的一次 refill 可能连调两次 fd_read（两个 iovec）。第一次若把数据取空，
//     第二次**绝不能阻塞等待新输入**，否则 scanf/getchar 要等用户第二次输入才返回。
//     所以用 _justServed 标记：同一轮里已交付过数据、且当前无数据 → 立即返回空。
import { Fd } from "@bjorn3/browser_wasi_shim";

const post = (m, transfer) => self.postMessage(m, transfer || []);

class TermStdin extends Fd {
  constructor(sab) {
    super();
    this.ctrl = new Int32Array(sab, 0, 2);
    this.buf = new Uint8Array(sab, 8);
    this._justServed = false;
  }
  fd_fdstat_get() {
    return { ret: 0, fdstat: { fs_filetype: 2, fs_flags: 0, fs_rights_base: 0xffffffffn, fs_rights_inheriting: 0xffffffffn } };
  }
  /** 由 runWasi 在【每个 wasi fd_read syscall 结束时】调用：
   *  Fd.fd_read 是逐 iovec 调的，_justServed 必须限制在"同一次 syscall 内"，
   *  否则短读之后的下一次 syscall 会看到残留标记 → 立刻返回空 → 假 EOF（cin 只读到第一行）。 */
  resetJustServed() { this._justServed = false; }

  fd_read(size) {
    const t0 = Date.now();
    for (;;) {
      const st = Atomics.load(this.ctrl, 0);
      if (st === 3) {                                   // EOF
        this._justServed = false;
        return { ret: 0, data: new Uint8Array(0) };
      }
      if (st === 1) {
        const len = Atomics.load(this.ctrl, 1);
        const n = Math.min(size, len);
        const data = this.buf.slice(0, n);
        const rest = len - n;
        if (rest > 0) this.buf.copyWithin(0, n, len);
        Atomics.store(this.ctrl, 1, rest);
        Atomics.store(this.ctrl, 0, rest > 0 ? 1 : 0);   // 交还所有权
        Atomics.notify(this.ctrl, 0);
        post({ type: "consumed" });                      // 让宿主冲刷队列
        this._justServed = true;
        return { ret: 0, data };
      }
      // 无数据：如果这一轮已经交付过字节（多 iovec 的第二次调用），立刻返回空而不是阻塞
      if (this._justServed) {
        this._justServed = false;
        return { ret: 0, data: new Uint8Array(0) };
      }
      // 注意：等待用户输入是【正常状态】，不能超时杀掉（学生会停下来思考）。
      // 只有真正没人 terminate 才会一直等，而页面关闭/终端关闭时 worker 会被 terminate。
      // 这里 30 分钟给一次提示（不中断），方便排查"宿主已死"的场景。
      const waited = Date.now() - t0;
      if (waited > 1800000 && !this._warnedIdle) {
        this._warnedIdle = true;
        post({ type: "out", stream: "stderr", bytes: new TextEncoder().encode("\n[oi] 已等待 stdin 30 分钟…\n").buffer });
      }
      Atomics.wait(this.ctrl, 0, 0, 30000);
    }
  }
}

/**
 * 一次性输入 Fd：对拍（测试用例）用。
 * 与 TermStdin 的区别：输入是**预置字符串**，读完直接 EOF，不阻塞、不等用户。
 */
class StringStdin extends Fd {
  constructor(text) {
    super();
    this.buf = new TextEncoder().encode(String(text ?? ""));
    this.off = 0;
  }
  fd_fdstat_get() {
    return { ret: 0, fdstat: { fs_filetype: 2, fs_flags: 0, fs_rights_base: 0xffffffffn, fs_rights_inheriting: 0xffffffffn } };
  }
  fd_read(size) {
    if (this.off >= this.buf.length) return { ret: 0, data: new Uint8Array(0) };   // EOF
    const n = Math.min(size, this.buf.length - this.off);
    const data = this.buf.slice(this.off, this.off + n);
    this.off += n;
    return { ret: 0, data };
  }
}

let running = false;

self.onmessage = async (ev) => {
  const m = ev.data || {};
  try {
    if (m.type === "run") {
      if (running) throw new Error("already running");
      running = true;
      const { bytes, stdinSAB } = m;
      const stdin = stdinSAB ? new TermStdin(stdinSAB) : undefined;
      const onOut = (b) => { const c = b.slice(); post({ type: "out", stream: "stdout", bytes: c.buffer }, [c.buffer]); };
      const onErr = (b) => { const c = b.slice(); post({ type: "out", stream: "stderr", bytes: c.buffer }, [c.buffer]); };
      const code = await runWasi(bytes, { stdin, onOut, onErr });
      post({ type: "exited", code });
      running = false;
      return;
    }
    if (m.type === "runTest") {
      // 对拍用：一次性把 stdin 喂完，收集 stdout/stderr，跑完回一条 testDone。
      // 超时由宿主决定（worker 里 wasm 是同步执行，JS 定时器插不进去 → 宿主直接 terminate）。
      if (running) throw new Error("already running");
      running = true;
      const t0 = Date.now();
      const decOut = new TextDecoder("utf-8", { fatal: false });
      const decErr = new TextDecoder("utf-8", { fatal: false });
      let out = "", err = "";
      const stdin = new StringStdin(m.input);
      // ⚠️ 输出必须设上限：死循环里 `while(1) cout<<1;` 在 2 秒内能产出上百 MB 字符串，
      //    整份 structured-clone 回宿主再发给 webview，会把标签页/面板撑爆（那就不叫 TLE 了）。
      //    超过上限就停止累积并标记 truncated；运行本身仍由宿主的超时去打断。
      const OUT_CAP = Number(m.outCap) > 0 ? Number(m.outCap) : 1024 * 1024;   // 1MB
      let truncated = false, outLen = 0, errLen = 0;
      const push = (isErr, chunk) => {
        if (truncated) return;
        if (isErr) {
          if (errLen + chunk.length > OUT_CAP) { truncated = true; return; }
          errLen += chunk.length; err += chunk;
        } else {
          if (outLen + chunk.length > OUT_CAP) { truncated = true; return; }
          outLen += chunk.length; out += chunk;
        }
      };
      let code = 0, trap = null;
      try {
        code = await runWasi(m.bytes, {
          stdin,
          onOut: (b) => push(false, decOut.decode(b, { stream: true })),
          onErr: (b) => push(true, decErr.decode(b, { stream: true })),
        });
      } catch (e) {
        trap = String((e && (e.message || e)) || e);
        code = -1;
      }
      if (!truncated) { push(false, decOut.decode()); push(true, decErr.decode()); }
      post({ type: "testDone", out, err, code, trap, truncated, ms: Date.now() - t0 });
      running = false;
      return;
    }
    if (m.type === "ping") { post({ type: "pong" }); return; }
    throw new Error("未知消息 " + m.type);
  } catch (e) {
    running = false;
    post({ type: "error", message: (e && (e.stack || e.message)) || String(e) });
  }
};

async function runWasi(bytes, { stdin, onOut, onErr }) {
  const { WASI, WASIProcExit, ConsoleStdout, PreopenDirectory, File, Directory, OpenFile } = await import("@bjorn3/browser_wasi_shim");
  const root = new Directory(new Map());
  // 没有 SAB 时必须给一个"读即 EOF"的真 fd，不能留 undefined（否则 libc 拿到 ERRNO_BADF）
  const fd0 = stdin ?? new OpenFile(new File(new Uint8Array(0)));
  const fds = [fd0, new ConsoleStdout(onOut), new ConsoleStdout(onErr), new PreopenDirectory("/", root.contents)];
  const wasi = new WASI(["program"], [], fds);
  // 包一层 wasiImport.fd_read：一次 syscall 内的多个 iovec 共享标记，出 syscall 就复位
  const origFdRead = wasi.wasiImport.fd_read;
  wasi.wasiImport.fd_read = (...args) => {
    try { return origFdRead(...args); }
    finally { try { stdin?.resetJustServed?.(); } catch {} }
  };
  const mod = await WebAssembly.compile(bytes);
  const inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: wasi.wasiImport });
  try { return wasi.start(inst) ?? 0; }
  catch (e) { if (e instanceof WASIProcExit) return e.code; throw e; }
}
