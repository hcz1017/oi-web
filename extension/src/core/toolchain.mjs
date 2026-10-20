// 复用 C++ Studio Web 的 WASM 工具链（Clang 22.1.8 / wasm-ld / wasi-sdk sysroot），
import { DBG_STUB_SOURCE } from "./dbg-stub.mjs";
// 驱动完全自己写：WASI 不能 fork，所以直接以 -cc1 模式调用 clang，再调 wasm-ld 链接。
// 产物是 wasm32-wasip1 模块。
import {
  WASI, WASIProcExit, File, Directory, PreopenDirectory, ConsoleStdout, OpenFile,
} from "@bjorn3/browser_wasi_shim";
import { parseTar, buildFs, readFsFile } from "./tarfs.mjs";
import { TRIPLE, RESOURCE_DIR, LIBDIR, ISYS, filterUserFlags } from "./flags.mjs";

export class Toolchain {
  /**
   * @param {{clangWasm: Uint8Array, lldWasm: Uint8Array, sysrootTar: Uint8Array, compatBits?: Uint8Array}} assets
   */
  constructor({ clangWasm, lldWasm, sysrootTar, compatBits }) {
    this.clangWasm = clangWasm;
    this.lldWasm = lldWasm;
    this.sysrootTar = sysrootTar;
    this.entries = parseTar(sysrootTar);
    if (compatBits) this.entries.push({ path: "compat/bits/stdc++.h", type: "file", data: compatBits });
    this._clangMod = null;
    this._lldMod = null;
    this._root = null;
  }

  async _clang() { this._clangMod ??= await WebAssembly.compile(this.clangWasm); return this._clangMod; }
  async _lld() { this._lldMod ??= await WebAssembly.compile(this.lldWasm); return this._lldMod; }

  /** 根 FS 只建一次（1343 个文件，每次重建代价明显）；每次编译只在 /workspace 里动文件 */
  _fs() {
    if (!this._root) this._root = buildFs(this.entries);
    return this._root;
  }
  _workspace() {
    const root = this._fs();
    let ws = root.contents.get("workspace");
    if (!ws) { ws = new Directory(new Map()); root.contents.set("workspace", ws); }
    return ws;
  }
  _put(name, bytes) { this._workspace().contents.set(name, new File(bytes.slice())); }
  _del(name) { this._workspace().contents.delete(name); }

  async _run(mod, argv, root, { stdin, onOut, onErr, extraImports } = {}) {
    const fds = [
      stdin ?? new OpenFile(new File(new Uint8Array(0))),
      new ConsoleStdout((b) => onOut && onOut(b)),
      new ConsoleStdout((b) => onErr && onErr(b)),
      new PreopenDirectory("/", root.contents),
    ];
    const wasi = new WASI([argv[0], ...argv.slice(1)], [], fds);
    const inst = await WebAssembly.instantiate(mod, {
      wasi_snapshot_preview1: wasi.wasiImport,
      ...(extraImports || {}),
    });
    try { return wasi.start(inst) ?? 0; }
    catch (e) { if (e instanceof WASIProcExit) return e.code; throw e; }
  }

  /**
   * 编译一个源文件 → wasm 字节
   * @returns {{wasm: Uint8Array|null, log: string, exit: number}}
   */
  async compile({ source, fileName = "main.cpp", flags = [], opt = 2, debug = true, debugStub = false } = {}) {
    const lang = /\.c$/i.test(fileName) ? "c" : "c++";
    const dec = new TextDecoder("utf-8", { fatal: false });
    let log = "";
    const collect = (b) => { log += dec.decode(b, { stream: true }); };

    // 用户 flags 里若含 -o/-c/-S/-E 等会破坏输出约定，必须过滤（否则"编译失败但没日志"）
    const { kept, dropped } = filterUserFlags(flags);
    if (dropped.length) log += `[oi] 已忽略不支持的编译参数: ${dropped.join(" ")}\n`;

    const root = this._fs();
    this._del("out.o");
    this._del("out.wasm");
    // ⚠️ 桩对象必须每次删掉重建：WASI FS 里上一次编译写出的文件是只读的，
    //    第二次调试时 clang 再写会报 "unable to open output file '/workspace/dbgstub.o': Operation not permitted"
    this._del("dbgstub.o");
    this._del("dbgstub.c");
    this._put(fileName, new TextEncoder().encode(source));

    const cc1 = [
      "-cc1", "-triple", TRIPLE, "-emit-obj", "-disable-free",
      "-isysroot", "/", "-resource-dir", RESOURCE_DIR,
      ...ISYS.flatMap((d) => ["-internal-isystem", d]),
      "-ferror-limit", "19", "-fcolor-diagnostics",
      `-O${opt}`,
      "-o", "/workspace/out.o", "/workspace/" + fileName, "-x", lang,
      ...kept,
      // ⚠️ 这里是 -cc1 模式：不认 -fno-exceptions/-nostdinc/-g 这类 driver 参数。
      //    -cc1 下等价物是：-fexceptions=0（默认即关）+ 通过 -internal-isystem 控制 include
      //    + -debug-info-kind=standalone。clangd 侧（driver 模式）才用 SHARED_FLAGS/-g。
      ...(debug
        ? ["-debug-info-kind=standalone", "-dwarf-version=4", "-debugger-tuning=gdb", "-fdebug-compilation-dir=/workspace"]
        : []),
    ];
    const c = await this._clang();
    const ec = await this._run(c, ["clang", ...cc1], root, { onErr: collect, onOut: collect });
    const obj = readFsFile(root, "/workspace/out.o");
    if (ec !== 0 || !obj || !obj.length) {
      log += dec.decode();
      return { wasm: null, log, exit: ec };
    }

    let stubObj = null;
    if (debugStub) {
      // 调试构建：先把桩编译成独立对象（同一个 cc1 路径，保证 ABI/编址一致）
      this._put("dbgstub.c", new TextEncoder().encode(DBG_STUB_SOURCE));
      const stubArgs = [
        "-cc1", "-triple", TRIPLE, "-emit-obj", "-disable-free",
        "-isysroot", "/", "-resource-dir", RESOURCE_DIR,
        ...ISYS.flatMap((d) => ["-internal-isystem", d]),
        "-ferror-limit", "19", "-fcolor-diagnostics",
        "-o", "/workspace/dbgstub.o", "/workspace/dbgstub.c", "-x", "c",
        // ⚠️ 不要带用户 flags：桩是 C 文件，-std=c++20 之类会直接报
        //    "invalid argument '-std=c++20' not allowed with 'C'"
      ];
      const ec2 = await this._run(c, ["clang", ...stubArgs], root, { onErr: collect, onOut: collect });
      stubObj = readFsFile(root, "/workspace/dbgstub.o");
      if (ec2 !== 0 || !stubObj || !stubObj.length) {
        log += dec.decode();
        return { wasm: null, log, exit: ec2 };
      }
    }

    const link = [
      "--export-dynamic", "-z", "stack-size=1048576",
      `-L${LIBDIR}/noeh`, `-L${LIBDIR}`, `${LIBDIR}/crt1.o`,
      ...(stubObj ? ["/workspace/dbgstub.o"] : []),
      "/workspace/out.o",
      // wasi-sdk 顺序：libc++ → libc++abi → libc → libm（静态库单趟扫描，顺序反了会缺符号）
      ...(lang === "c" ? [] : ["-lc++", "-lc++abi"]),
      "-lc", "-lm",
      `-L${RESOURCE_DIR}/lib/wasi`, "-lclang_rt.builtins-wasm32",
      "-o", "/workspace/out.wasm",
    ];
    const l = await this._lld();
    const el = await this._run(l, ["wasm-ld", ...link], root, { onErr: collect, onOut: collect });
    log += dec.decode();
    const wasm = readFsFile(root, "/workspace/out.wasm");
    if (el !== 0 || !wasm || !wasm.length) return { wasm: null, log, exit: el };
    return { wasm, log, exit: 0 };
  }

  /** 仅 Node 侧冒烟用；浏览器里运行走 runWorker.js */
  async run(wasmBytes, { args = [], stdin, onOut, onErr, extraImports } = {}) {
    const root = this._fs();
    const mod = await WebAssembly.compile(wasmBytes);
    return this._run(mod, ["program", ...args], root, { onOut, onErr, stdin, extraImports });
  }
}
