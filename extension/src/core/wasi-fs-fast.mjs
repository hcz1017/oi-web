// 给 @bjorn3/browser_wasi_shim 的内存 FS 打一个"写大文件"的补丁。
//
// 为什么需要它：
//   上游 `OpenFile.fd_write` 在写入超出当前长度时，会 **把整个文件重新分配成"刚好够"的大小并整份复制**：
//       const old = this.file.data;
//       this.file.data = new Uint8Array(Number(this.file_pos + data.byteLength));
//       this.file.data.set(old);
//   clang 写 .o 是很多次小块 write（8–64KB）。于是写一个 50MB 的 .o 就要复制
//   O(n²/B) 字节：实测 64MB、64KB 块 → **16.5 秒**；clang 块更小，实际会到十几分钟。
//   典型受害者：`bitset<70> fc[(int)(6.4e6)]`（≈51MB 静态数组）这类代码。
//
// 这个补丁做两件事：
//   1. 容量按 **2 倍**增长（至少 64KB 起），写入变成 amortized O(n)；
//   2. 引入"逻辑长度" `_len`，所有读取/stat 都按它截断（capacity 尾部不能漏给调用方）。
//
// 只 patch 运行时原型，不动 vendored 包；上游改实现时检测不到预期形状就**跳过并打日志**，不影响编译。

const MARK = Symbol.for("oi.fastWasiFs");

/** 创建时的最小容量（避免小文件也吃 64KB） */
const MIN_CAP = 64 * 1024;

function capOf(file) { return file && file.data ? file.data.byteLength : 0; }
function lenOf(file) {
  if (!file) return 0;
  if (typeof file._len === "number") return file._len;
  return capOf(file);            // 老对象（sysroot 里预置的文件）没有 _len
}
function ensureCapacity(file, need) {
  if (capOf(file) >= need) return;
  let cap = Math.max(capOf(file), MIN_CAP);
  while (cap < need) cap *= 2;
  const next = new Uint8Array(cap);
  const oldData = file.data;
  if (oldData && oldData.byteLength) next.set(oldData.subarray(0, lenOf(file)));
  file.data = next;
}

/**
 * 安装补丁（幂等）。
 * @param {{File:Function, OpenFile:Function}} mod browser_wasi_shim 的导出
 * @param {{log?:(s:string)=>void}} [opts]
 */
export function installFastWasiFs({ File, OpenFile }, opts = {}) {
  const log = opts.log || (() => {});
  if (!OpenFile || !OpenFile.prototype || !File || !File.prototype) { log("跳过：缺少 File/OpenFile"); return false; }
  if (OpenFile.prototype[MARK]) return true;
  const origWrite = OpenFile.prototype.fd_write;
  if (typeof origWrite !== "function") { log("跳过：fd_write 形状不符合预期（上游已改）"); return false; }
  if (typeof OpenFile.prototype.fd_pwrite !== "function") { log("跳过：缺少 fd_pwrite"); return false; }

  // ---- 逻辑长度 ----
  try {
    const sizeDesc = Object.getOwnPropertyDescriptor(File.prototype, "size");
    if (sizeDesc && sizeDesc.get) {
      Object.defineProperty(File.prototype, "size", {
        configurable: true,
        get() { return BigInt(lenOf(this)); },
      });
    }
    const origPathOpen = File.prototype.path_open;
    if (typeof origPathOpen === "function") {
      File.prototype.path_open = function (oflags, rights, fdFlags) {
        // OFLAGS_TRUNC(=1) 会清空内容：逻辑长度要一起归零
        if ((oflags & 1) === 1 && !this.readonly) this._len = 0;
        return origPathOpen.call(this, oflags, rights, fdFlags);
      };
    }
  } catch (e) { log("size/path_open 补丁失败（忽略）: " + ((e && e.message) || e)); }

  // ---- 写：容量倍增 ----
  OpenFile.prototype.fd_write = function (data) {
    const f = this.file;
    if (f.readonly) return { ret: 8 /* ERRNO_BADF */, nwritten: 0 };
    const pos = Number(this.file_pos);
    const need = pos + data.byteLength;
    const oldLen = lenOf(f);            // ⚠️ 必须在扩容**之前**取：扩容后 cap 变大，会把"旧长度"算错
    ensureCapacity(f, need);
    f.data.set(data, pos);
    if (need > oldLen) f._len = need;
    this.file_pos = BigInt(need);
    return { ret: 0, nwritten: data.byteLength };
  };
  OpenFile.prototype.fd_pwrite = function (data, offset) {
    const f = this.file;
    if (f.readonly) return { ret: 8, nwritten: 0 };
    const pos = Number(offset);
    const need = pos + data.byteLength;
    const oldLen = lenOf(f);
    ensureCapacity(f, need);
    f.data.set(data, pos);
    if (need > oldLen) f._len = need;
    return { ret: 0, nwritten: data.byteLength };
  };

  // ---- 读：按逻辑长度截断（不能把 capacity 尾部漏出去） ----
  OpenFile.prototype.fd_read = function (size) {
    const len = lenOf(this.file);
    const from = Math.min(Number(this.file_pos), len);
    const to = Math.min(from + Number(size), len);
    const slice = this.file.data.slice(from, to);
    this.file_pos = BigInt(to);
    return { ret: 0, data: slice };
  };
  OpenFile.prototype.fd_pread = function (size, offset) {
    const len = lenOf(this.file);
    const from = Math.min(Number(offset), len);
    const to = Math.min(from + Number(size), len);
    return { ret: 0, data: this.file.data.slice(from, to) };
  };

  // ---- 尺寸调整 ----
  const origSetSize = OpenFile.prototype.fd_filestat_set_size;
  if (typeof origSetSize === "function") {
    OpenFile.prototype.fd_filestat_set_size = function (size) {
      const f = this.file;
      const n = Number(size);
      if (n > lenOf(f)) ensureCapacity(f, n);
      f._len = n;
      return { ret: 0 };
    };
  }
  const origAlloc = OpenFile.prototype.fd_allocate;
  if (typeof origAlloc === "function") {
    OpenFile.prototype.fd_allocate = function (offset, len) {
      ensureCapacity(this.file, Number(offset) + Number(len));
      return { ret: 0 };
    };
  }

  OpenFile.prototype[MARK] = true;
  log("已启用：WASI 文件写入改为容量倍增（大对象不再 O(n²)）");
  return true;
}

/** 读一个 FS 内的 File 的逻辑内容（供 tarfs 用，避免带出 capacity 尾部） */
export function logicalBytes(file) {
  if (!file || !file.data) return null;
  return file.data.slice(0, lenOf(file));
}

export { lenOf as logicalLength };
