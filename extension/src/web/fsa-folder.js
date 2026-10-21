// 浏览器本地文件夹（File System Access API）
//
// vscode-web 自带的"打开文件夹"在空窗口下是硬编码抛错的（见 FileDialogService.pickFolderAndOpen），
// 所以这里自己实现：把用户选的目录句柄包成 FileSystemProvider 注册到 oi-fs: 协议，
// 再挂进工作区 → 左侧文件树、编译、clangd、调试都直接读写磁盘上的真实文件。
//
// 目录句柄存在 IndexedDB 里，刷新后仍然可用（Chrome 会保留授权；未授权时命令会重新请求）。
import * as vscode from "vscode";

export const SCHEME = "oi-fs";

const IDB_NAME = "oi-cpp-wasm";
const IDB_STORE = "dirHandles";

// ---------------------------------------------------------------- IndexedDB
function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("当前环境不支持 IndexedDB"));
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

async function idbGetAll() {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const store = tx.objectStore(IDB_STORE);
      const keysReq = store.getAllKeys();
      const valsReq = store.getAll();
      tx.oncomplete = () => {
        const keys = keysReq.result || [], vals = valsReq.result || [];
        resolve(keys.map((k, i) => ({ key: k, value: vals[i] })));
      };
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

async function idbDelete(key) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

// ---------------------------------------------------------------- provider
/** 把 FileSystemDirectoryHandle 暴露成 vscode.FileSystemProvider */
class FsaFolderProvider {
  constructor() {
    this.roots = new Map();                     // 根名 -> FileSystemDirectoryHandle
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeFile = this._emitter.event;
  }

  addRoot(name, handle) { this.roots.set(name, handle); }
  hasRoot(name) { return this.roots.has(name); }
  removeRoot(name) { this.roots.delete(name); }

  /** 解析 uri：oi-fs:/<根名>/a/b.txt → { dirHandle, name, root } */
  async _resolve(uri, { create = false } = {}) {
    const parts = String(uri.path || "").split("/").filter(Boolean);
    const rootName = parts.shift();
    const root = this.roots.get(rootName);
    if (!root) throw vscode.FileSystemError.FileNotFound(uri);
    const name = parts.pop();
    let dir = root;
    for (const part of parts) {
      try {
        dir = await dir.getDirectoryHandle(part, { create });
      } catch {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
    }
    return { dir, name, root };
  }

  watch() { return new vscode.Disposable(() => {}); }

  async stat(uri) {
    const parts = String(uri.path || "").split("/").filter(Boolean);
    if (parts.length <= 1) {
      // 根目录本身
      if (!this.roots.has(parts[0])) throw vscode.FileSystemError.FileNotFound(uri);
      return { type: vscode.FileType.Directory, ctime: 0, mtime: Date.now(), size: 0 };
    }
    const { dir, name } = await this._resolve(uri);
    try {
      const fh = await dir.getFileHandle(name);
      const f = await fh.getFile();
      return { type: vscode.FileType.File, ctime: f.lastModified, mtime: f.lastModified, size: f.size };
    } catch {
      try {
        await dir.getDirectoryHandle(name);
        return { type: vscode.FileType.Directory, ctime: 0, mtime: Date.now(), size: 0 };
      } catch {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
    }
  }

  async readDirectory(uri) {
    const parts = String(uri.path || "").split("/").filter(Boolean);
    const rootName = parts[0];
    let dir;
    if (parts.length <= 1) {
      dir = this.roots.get(rootName);
      if (!dir) throw vscode.FileSystemError.FileNotFound(uri);
    } else {
      ({ dir } = await this._resolve(uri));
    }
    const out = [];
    for await (const [name, handle] of dir.entries()) {
      out.push([name, handle.kind === "directory" ? vscode.FileType.Directory : vscode.FileType.File]);
    }
    return out;
  }

  async readFile(uri) {
    const { dir, name } = await this._resolve(uri);
    let fh;
    try {
      fh = await dir.getFileHandle(name);
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    const f = await fh.getFile();
    return new Uint8Array(await f.arrayBuffer());
  }

  async writeFile(uri, content) {
    const { dir, name } = await this._resolve(uri, { create: true });
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(content);
    await w.close();
    this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  async createDirectory(uri) {
    const { dir, name } = await this._resolve(uri, { create: true });
    await dir.getDirectoryHandle(name, { create: true });
    this._emitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
  }

  async delete(uri, options) {
    const { dir, name } = await this._resolve(uri);
    await dir.removeEntry(name, { recursive: !!(options && options.recursive) }).catch((e) => {
      throw vscode.FileSystemError.NoPermissions(String(e));
    });
    this._emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  async rename(from, to, options) {
    const data = await this.readFile(from);
    await this.writeFile(to, data);
    if (!(options && options.overwrite)) {
      try { await this.stat(to); } catch { /* 目标不存在，正常 */ }
    }
    await this.delete(from, { recursive: false });
    this._emitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: from },
      { type: vscode.FileChangeType.Created, uri: to },
    ]);
  }
}

// ---------------------------------------------------------------- 命令
function hasFsa() {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

function folderUriFor(name) {
  return vscode.Uri.from({ scheme: SCHEME, path: "/" + name });
}

/** 把根句柄挂进工作区（已挂则跳过） */
async function mountFolder(name) {
  const uri = folderUriFor(name);
  const existing = vscode.workspace.workspaceFolders || [];
  if (existing.some((f) => f.uri.scheme === SCHEME && f.uri.path === uri.path)) return false;
  const ok = vscode.workspace.updateWorkspaceFolders(existing.length, 0, { uri, name });
  return ok;
}

/**
 * 注册 oi-fs 文件系统 + 打开文件夹命令。
 * @param {vscode.ExtensionContext} context
 */
export function registerLocalFolder(context) {
  const provider = new FsaFolderProvider();

  const pickAndMount = async () => {
    if (!hasFsa()) {
      vscode.window.showErrorMessage(
        "当前浏览器不支持 File System Access API（需要 Chrome/Edge 桌面版 + https/localhost）",
      );
      return null;
    }
    let handle;
    try {
      handle = await window.showDirectoryPicker({ mode: "readwrite" });
    } catch (e) {
      // 用户取消（AbortError）不当成错误
      if (e && e.name !== "AbortError") vscode.window.showErrorMessage("打开文件夹失败：" + (e && (e.message || e.name)));
      return null;
    }
    provider.addRoot(handle.name, handle);
    try { await idbPut(handle.name, handle); } catch (e) { /* 存不下也能用，只是刷新后要重选 */ }
    const mounted = await mountFolder(handle.name);
    if (!mounted) vscode.window.showInformationMessage(`已打开文件夹：${handle.name}`);
    return handle;
  };

  // 「打开文件夹」：扩展宿主在 Web Worker 里，没有 window.showDirectoryPicker，
  // 所以真正的目录选择必须由**页面侧**完成（构建产物补丁 scripts/patch-open-folder.mjs
  // 已把 FileDialogService 的 throw 换成页面侧 FSA 实现）。
  // 这里只是把命令转发给那个已被修好的入口。
  const openFolder = async () => {
    try {
      await vscode.commands.executeCommand("workbench.action.files.openFolder");
      return;
    } catch (e) {
      console.warn("[oi] 打开文件夹失败:", e && (e.message || e));
    }
    // 兜底：本扩展自己的 oi-fs 挂载（页面侧方案不可用时）
    const before = (vscode.workspace.workspaceFolders || []).length;
    try {
      await vscode.commands.executeCommand("workbench.action.addRootFolder");
      if ((vscode.workspace.workspaceFolders || []).length > before) return;
    } catch (e) {
      console.warn("[oi] 原生添加文件夹也失败:", e && (e.message || e));
    }
    await pickAndMount();
  };

  // 命令先注册，保证命令面板里始终可用（provider 注册失败也不影响）
  context.subscriptions.push(
    vscode.commands.registerCommand("oiCpp.openFolder", openFolder),
  );

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SCHEME, provider, {
      isCaseSensitive: true,
      isReadonly: false,
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("oiCpp.refreshFolder", () => {
      provider._emitter.fire([{ type: vscode.FileChangeType.Changed, uri: folderUriFor("") }]);
    }),
  );

  // 启动时恢复上次打开的目录（授权还在就直接挂上，否则给个提示命令）
  (async () => {
    let saved = [];
    try { saved = await idbGetAll(); } catch { return; }
    for (const { key, value } of saved) {
      if (!value || typeof value.queryPermission !== "function") continue;
      let perm = "prompt";
      try { perm = await value.queryPermission({ mode: "readwrite" }); } catch { /* ignore */ }
      provider.addRoot(key, value);
      if (perm === "granted") {
        await mountFolder(key);
      } else {
        vscode.window.setStatusBarMessage(
          `OI C++: 上次打开的文件夹「${key}」需要重新授权（命令面板运行 "OI C++: 打开本地文件夹"）`, 8000,
        );
      }
    }
  })();

  return provider;
}
