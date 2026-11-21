// 回归：WASI 内存 FS 的"写大文件"必须是 O(n)，不能是 O(n²)。
// 背景：上游 fd_write 每次越界都"整份重新分配 + 复制"，写 64MB 的 .o 要 16.5s（clang 块更小 → 十几分钟），
//       典型受害者是 bitset<70> fc[6.4e6] 这类约 51MB 静态数组。
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const fs = require("../node_modules/@bjorn3/browser_wasi_shim/dist/fs_mem.js");
const { installFastWasiFs, logicalLength } = require("../src/core/wasi-fs-fast.mjs");

let pass = true;
const must = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) pass = false; return c; };

const ok = installFastWasiFs({ File: fs.File, OpenFile: fs.OpenFile }, { log: () => {} });
must(ok === true, "补丁安装成功（幂等）");
must(installFastWasiFs({ File: fs.File, OpenFile: fs.OpenFile }) === true, "重复安装返回成功（幂等）");

// ---- 吞吐：64MB / 64KB 块应当远快于 1s（修复前 16.5s） ----
{
  const CH = 64 * 1024;
  const f = new fs.File(new ArrayBuffer(0));
  const of = new fs.OpenFile(f);
  const chunk = new Uint8Array(CH);
  const n = (64 * 1048576) / CH;
  const t0 = Date.now();
  for (let i = 0; i < n; i++) of.fd_write(chunk);
  const ms = Date.now() - t0;
  must(ms < 1000, `写 64MB（${n} 次 64KB）耗时 ${ms}ms < 1000ms`);
  must(Number(f.size) === 64 * 1048576, `逻辑长度正确（${f.size}）`);
  must(f.data.byteLength >= Number(f.size), "底层容量 ≥ 逻辑长度（容量倍增）");
}

// ---- 正确性：内容、逻辑长度、读回截断、TRUNC ----
{
  const f = new fs.File(new ArrayBuffer(0));
  const of = new fs.OpenFile(f);
  of.fd_write(new Uint8Array([1, 2, 3]));
  of.fd_write(new Uint8Array([4, 5]));
  must(Number(f.size) === 5, "两次写入后长度 = 5");
  must(logicalLength(f) === 5, "logicalLength 与 size 一致");
  must(Buffer.compare(Buffer.from(f.data.slice(0, 5)), Buffer.from([1, 2, 3, 4, 5])) === 0, "内容正确");
  of.fd_seek(0n, 0);
  const r = of.fd_read(1000);
  must(r.data.length === 5, `fd_read 只返回逻辑长度（${r.data.length}），不会漏出 capacity 尾部`);
  must(Number(f.size) === 5, "读不会改变长度");

  // pwrite 中间覆盖
  of.fd_pwrite(new Uint8Array([9]), 2n);
  must(Buffer.compare(Buffer.from(f.data.slice(0, 5)), Buffer.from([1, 2, 9, 4, 5])) === 0, "fd_pwrite 覆盖正确");
  must(Number(f.size) === 5, "pwrite 不改变长度");
}

// ---- TRUNC 打开要清零逻辑长度 ----
{
  const f = new fs.File(new Uint8Array([7, 7, 7, 7]));
  f.path_open(1 /* OFLAGS_TRUNC */, 0n, 0);
  must(Number(f.size) === 0, "OFLAGS_TRUNC 后长度为 0");
}

// ---- 显式 set_size ----
{
  const f = new fs.File(new ArrayBuffer(0));
  const of = new fs.OpenFile(f);
  of.fd_filestat_set_size(1024n);
  must(Number(f.size) === 1024, "fd_filestat_set_size 生效");
  must(f.data.byteLength >= 1024, "容量足够");
}

console.log(pass ? "\n全部通过" : "\n存在失败项");
if (!pass) process.exit(1);
