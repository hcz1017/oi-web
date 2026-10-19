// 只读虚拟文件系统：把 clangd 虚拟 FS 里的系统头文件（/compat、/include、/lib/clang…）
// 暴露给 VS Code，这样悬停/引用面板/跳转点进去能正常打开，而不是报
// "No file system handle registered (/compat)"。
// 内容来自扩展资产里的 headers.json.gz（clangd 的 VFS 快照），首次访问时懒加载。
import * as vscode from "vscode";
import { HEADER_SCHEME } from "./lsp.js";

const onDidChangeFileEvent = new vscode.EventEmitter().event;

class HeaderFsProvider {
  constructor(getBase) {
    this._getBase = getBase;     // () => assets base（支持 assetsBaseUrl 外置）
    this._files = null;          // Map<string, Uint8Array>
    // ⚠️ FileSystemProvider 约定：实例上必须有 onDidChangeFile（否则注册报
    //    "n.onDidChangeFile is not a function"）
    this.onDidChangeFile = onDidChangeFileEvent;
  }

  async _load() {
    if (this._files) return this._files;
    const base = String(this._getBase() || "").replace(/\/+$/, "");
    const r = await fetch(`${base}/clangd/headers.json.gz`);
    if (!r.ok) throw vscode.FileSystemError.Unavailable(`headers.json.gz: HTTP ${r.status}`);
    const txt = await new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).text();
    const json = JSON.parse(txt);
    const files = new Map();
    for (const [p, b64] of Object.entries(json)) {
      const bin = atob(b64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      files.set(p, u8);
    }
    this._files = files;
    return files;
  }

  watch() { return { dispose() {} }; }

  async stat(uri) {
    const files = await this._load();
    const data = files.get(uri.path);
    if (data) return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: data.length };
    // 目录：只要存在以 uri.path + "/" 开头的条目就算目录
    const prefix = (uri.path.endsWith("/") ? uri.path : uri.path + "/");
    for (const p of files.keys()) {
      if (p.startsWith(prefix)) return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }
    throw vscode.FileSystemError.FileNotFound(uri);
  }

  async readFile(uri) {
    const files = await this._load();
    const data = files.get(uri.path);
    if (!data) throw vscode.FileSystemError.FileNotFound(uri);
    return data;
  }

  async readDirectory(uri) {
    const files = await this._load();
    const prefix = uri.path.endsWith("/") ? uri.path : uri.path + "/";
    const seen = new Map();
    for (const p of files.keys()) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const seg = rest.split("/")[0];
      if (!seg) continue;
      seen.set(seg, rest.includes("/") ? vscode.FileType.Directory : vscode.FileType.File);
    }
    return [...seen.entries()];
  }

  createDirectory() { throw vscode.FileSystemError.NoPermissions("clangd 虚拟文件系统是只读的"); }
  writeFile() { throw vscode.FileSystemError.NoPermissions("clangd 虚拟文件系统是只读的"); }
  delete() { throw vscode.FileSystemError.NoPermissions("clangd 虚拟文件系统是只读的"); }
  rename() { throw vscode.FileSystemError.NoPermissions("clangd 虚拟文件系统是只读的"); }
}

/** 注册只读虚拟 FS；返回 Disposable */
export function registerHeaderFs(getBase) {
  return vscode.workspace.registerFileSystemProvider(
    HEADER_SCHEME,
    new HeaderFsProvider(getBase),
    { isReadonly: true },
  );
}
