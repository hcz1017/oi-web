// 极简 ustar 解析 + browser_wasi_shim 内存 FS 构建。
// sysroot 实测：1343 文件 / 75 目录 / 无符号链接 / 无超长名，所以不需要 GNU/PAX 扩展；
// 但为了不"静默出错"，这里对 magic、size、边界都做校验。
import { File, Directory } from "@bjorn3/browser_wasi_shim";

const BLOCK = 512;
const str = (u8, off, len) => {
  let s = "";
  for (let i = 0; i < len; i++) { const c = u8[off + i]; if (!c) break; s += String.fromCharCode(c); }
  return s;
};
const oct = (u8, off, len) => {
  const s = str(u8, off, len).trim();
  if (!s) return 0;
  if (!/^[0-7]+$/.test(s)) throw new Error(`tar: 非法八进制字段 "${s}" (offset ${off})`);
  const n = parseInt(s, 8);
  if (!Number.isFinite(n) || n < 0) throw new Error("tar: 非法 size");
  return n;
};

/** 解析 ustar（已解压）→ [{path,type,data}] */
export function parseTar(u8) {
  const out = [];
  let off = 0;
  let pendingPath = null;   // GNU longname / PAX path 覆盖下一条
  while (off + BLOCK <= u8.length) {
    const name = str(u8, off, 100);
    if (name === "") break;               // 全 0 结束块
    // 注意：str() 遇 NUL 就停，"ustar\0" 会读成 "ustar"，所以这里按原始字节判断
    const m5 = String.fromCharCode(u8[off + 257], u8[off + 258], u8[off + 259], u8[off + 260], u8[off + 261]);
    const m6 = u8[off + 262];
    const isPosixUstar = m5 === "ustar" && m6 === 0;      // POSIX ustar：345 处是 prefix
    const isGnuTar = m5 === "ustar" && m6 === 32;         // GNU tar：345 处是 atime/ctime，不能当 prefix
    if (!isPosixUstar && !isGnuTar) throw new Error("tar: 不是 ustar/GNU 格式（magic 不匹配）");
    const size = oct(u8, off + 124, 12);
    const type = String.fromCharCode(u8[off + 156] || 48);
    const prefix = isPosixUstar ? str(u8, off + 345, 155) : "";
    const dataOff = off + BLOCK;
    if (dataOff + size > u8.length) throw new Error(`tar: 数据越界（${name}, size=${size}）`);

    if (type === "L") {            // GNU longname：内容就是下一条的路径
      pendingPath = str(u8, dataOff, size).replace(/\0+$/, "");
      off = dataOff + Math.ceil(size / BLOCK) * BLOCK;
      continue;
    }
    if (type === "x" || type === "g") {   // PAX 扩展：跳过
      off = dataOff + Math.ceil(size / BLOCK) * BLOCK;
      continue;
    }
    if (type === "0" || type === "\0" || type === " " || type === "7") {
      const path = (pendingPath || (prefix ? prefix + "/" + name : name)).replace(/\/+$/, "");
      out.push({ path, type: "file", data: u8.subarray(dataOff, dataOff + size) });
      pendingPath = null;
    } else if (type === "5") {
      const path = (pendingPath || (prefix ? prefix + "/" + name : name)).replace(/\/+$/, "");
      out.push({ path, type: "dir" });
      pendingPath = null;
    }
    off = dataOff + Math.ceil(size / BLOCK) * BLOCK;
  }
  if (!out.length) throw new Error("tar: 解析出 0 个条目（格式不支持？）");
  return out;
}

const isDir = (e) => e instanceof Directory;

/** 构建 Directory 树（可传额外文件，例如 /workspace/main.cpp） */
export function buildFs(entries, extra = []) {
  const root = new Directory(new Map());
  const ensureDir = (parts) => {
    let d = root;
    for (const p of parts) {
      let e = d.contents.get(p);
      if (e === undefined) { e = new Directory(new Map()); d.contents.set(p, e); }
      if (!isDir(e)) throw new Error(`tar: 路径冲突 "${parts.join("/")}"（同名项既是文件又是目录）`);
      d = e;
    }
    return d;
  };
  for (const e of [...entries, ...extra]) {
    const parts = e.path.split("/").filter(Boolean);
    if (!parts.length) continue;
    if (e.type === "dir") { ensureDir(parts); continue; }
    const dir = ensureDir(parts.slice(0, -1));
    const last = parts[parts.length - 1];
    if (isDir(dir.contents.get(last))) throw new Error(`tar: 路径冲突 "${e.path}"`);
    dir.contents.set(last, new File(e.data.slice()));
  }
  return root;
}

/** 从 FS 读回文件；返回【拷贝】，避免调用方篡改 FS 内部数据 */
export function readFsFile(root, path) {
  const parts = path.split("/").filter(Boolean);
  let d = root;
  for (const p of parts.slice(0, -1)) {
    const e = d.contents.get(p);
    if (!e || !isDir(e)) return null;
    d = e;
  }
  const f = d.contents.get(parts[parts.length - 1]);
  if (!f || f.data === undefined) return null;
  return f.data.slice();
}

/** FS 里是否存在某个文件 */
export function fsHas(root, path) {
  const parts = path.split("/").filter(Boolean);
  let d = root;
  for (const p of parts.slice(0, -1)) {
    const e = d.contents.get(p);
    if (!e || !isDir(e)) return false;
    d = e;
  }
  return d.contents.has(parts[parts.length - 1]);
}
