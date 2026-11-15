// PDF 快照仓库的 **vscode 胶水层** + 时间线（Timeline）注册。
//
// 用户视角：改完批注 → 点保存 → 原 PDF 被更新，同时"时间线"里多出一条
// "批注保存前 23:29"，点它可以恢复；不再生成 xxx.pdf.bak。
//
// 快照放在扩展的 globalStorage 里（每用户一份，不污染工作区、不会被 git 同步）。
import * as vscode from "vscode";
import { createHistoryStore, keyOf } from "./history-core.mjs";
import { reloadPdfPanels } from "./provider.js";

export const PDF_TIMELINE_ID = "webcpp.pdf-history";
export const RESTORE_COMMAND = "oiCpp.pdf.restoreSnapshot";

/** vscode.workspace.fs 适配器（路径用字符串拼，这里转成 Uri） */
function fsAdapter(rootUri) {
  const uriOf = (p) => {
    const rel = String(p).slice(String(rootUri.path).length).replace(/^\/+/, "");
    return vscode.Uri.joinPath(rootUri, ...rel.split("/").filter(Boolean));
  };
  const text = (u) => u;
  return {
    async mkdir(p) { try { await vscode.workspace.fs.createDirectory(uriOf(p)); } catch { } },
    async writeFile(p, bytes) { await vscode.workspace.fs.writeFile(uriOf(p), toBytes(bytes)); },
    async readFile(p) { return vscode.workspace.fs.readFile(uriOf(p)); },
    async readDir(p) {
      try {
        const list = await vscode.workspace.fs.readDirectory(uriOf(p));
        return list.filter(([, type]) => type === vscode.FileType.File).map(([name]) => name);
      } catch { return []; }
    },
    async deleteFile(p) { try { await vscode.workspace.fs.delete(uriOf(p)); } catch { } },
  };
}

function toBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw new Error("快照数据不是二进制");
}

/**
 * 建一个快照仓库（每个扩展会话一个）。
 * @param {vscode.ExtensionContext} ctx
 */
export function createPdfHistory(ctx) {
  const root = vscode.Uri.joinPath(ctx.globalStorageUri, "pdf-history");
  return createHistoryStore(fsAdapter(root), root.path, { keep: 20 });
}

/**
 * 注册时间线提供者 + 恢复命令。
 * @param {vscode.ExtensionContext} ctx
 * @param {ReturnType<typeof createPdfHistory>} history
 * @returns {vscode.Disposable}
 */
export function registerPdfTimeline(ctx, history, log = () => { }) {
  const subs = [];

  // 恢复命令：把某个快照写回 PDF（恢复前先给"当前版本"再留一份快照，所以恢复也能反悔）
  subs.push(vscode.commands.registerCommand(RESTORE_COMMAND, async (fileUriStr, snapshotName) => {
    try {
      const uri = vscode.Uri.parse(String(fileUriStr));
      const bytes = await history.read(uri.toString(), snapshotName);
      const current = await vscode.workspace.fs.readFile(uri);
      await history.snapshot(uri.toString(), current);
      await vscode.workspace.fs.writeFile(uri, toBytes(bytes));
      // 打开着的阅读器直接热重载，不用关掉再开
      const n = await reloadPdfPanels(uri.toString());
      vscode.window.showInformationMessage(
        `已恢复到 ${snapshotName}（恢复前的版本也留在时间线里）` + (n ? "，已自动刷新阅读器" : ""),
      );
    } catch (e) {
      vscode.window.showErrorMessage("恢复失败：" + ((e && e.message) || e));
    }
  }));

  // 兜底入口：即使时间线视图不显示（宿主差异），也能从命令面板找到快照
  subs.push(vscode.commands.registerCommand("oiCpp.pdf.listSnapshots", async () => {
    const uri = pickPdfUri();
    if (!uri) { vscode.window.showInformationMessage("先打开或选中一个 .pdf 文件"); return; }
    const list = await history.list(uri.toString());
    if (!list.length) { vscode.window.showInformationMessage("这个 PDF 还没有快照（保存一次批注后就会有）"); return; }
    const pick = await vscode.window.showQuickPick(
      list.map((s) => ({ label: "批注保存前 " + new Date(s.ts).toLocaleString(), description: s.name, name: s.name })),
      { title: "PDF 快照（选一个恢复）", placeHolder: "越靠上越新" },
    );
    if (!pick) return;
    await vscode.commands.executeCommand(RESTORE_COMMAND, uri.toString(), pick.name);
  }));

  // 时间线提供者。
  //
  // ⚠️ 正确 API 是 **vscode.workspace.registerTimelineProvider**，签名：
  //      registerTimelineProvider(id, label, scheme, provider)
  //    之前写成 vscode.window.registerTimelineProvider(id, provider, options) ——
  //    那个函数根本不存在，typeof 判断直接走降级分支，于是"时间线永远是空的"。
  //    scheme 传 "" 表示支持所有 scheme（file / vscode-test-web / memfs 都能用）。
  const changeEmitter = typeof vscode.EventEmitter === "function" ? new vscode.EventEmitter() : null;
  const provider = {
    onDidChange: changeEmitter ? changeEmitter.event : undefined,
    async provideTimeline(uri) {
      if (!/\.pdf$/i.test(uri.path)) return { items: [] };
      const list = await history.list(uri.toString());
      log(`[timeline] ${uri.path.split("/").pop()} → ${list.length} 条快照`);
      return {
        items: list.map((s) => ({
          id: s.name,
          label: "批注保存前 " + new Date(s.ts).toLocaleString(),
          timestamp: s.ts,
          description: "写回前自动留的快照（点一下可恢复）",
          contextValue: "pdfSnapshot",
          command: {
            title: "恢复此版本",
            command: RESTORE_COMMAND,
            arguments: [uri.toString(), s.name],
          },
        })),
      };
    },
  };

  // 保存/恢复后通知时间线刷新（不然要多点一次才看到新条目）
  if (changeEmitter) history.notifyChanged = (uriString) => { try { changeEmitter.fire(vscode.Uri.parse(uriString)); } catch { } };

  const register = vscode.workspace && vscode.workspace.registerTimelineProvider;
  if (typeof register !== "function") {
    return { dispose() { for (const d of subs) try { d.dispose(); } catch { } }, supported: false, error: "workspace.registerTimelineProvider 不存在（宿主版本过老）" };
  }
  try {
    subs.push(register(PDF_TIMELINE_ID, "PDF 快照", "", provider));
  } catch (e) {
    return { dispose() { for (const d of subs) try { d.dispose(); } catch { } }, supported: false, error: String((e && e.message) || e) };
  }

  return { dispose() { for (const d of subs) try { d.dispose(); } catch { } }, supported: true };
}

/** 供日志/诊断用：某文件在仓库里的目录名 */
export function historyKey(uri) { return keyOf(uri.toString()); }

/** 找一个可用于 PDF 快照操作的 Uri（当前编辑器 / 资源管理器选中项） */
function pickPdfUri() {
  const ed = vscode.window.activeTextEditor;
  if (ed && /\.pdf$/i.test(ed.document.uri.path)) return ed.document.uri;
  const sel = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup
    ? vscode.window.tabGroups.activeTabGroup.activeTab : null;
  const input = sel && sel.input;
  if (input && input.uri && /\.pdf$/i.test(input.uri.path)) return input.uri;
  return null;
}

/**
 * 「PDF 快照」树视图（活动栏里，和测试面板在同一容器）。
 *
 * 为什么除了时间线还要这个：Timeline 是宿主提供的视图，网页版/不同版本行为不一致
 * （实测在某些 web 宿主里注册成功但列表不显示）。树视图完全由我们控制，
 * 一定能看见、一定能点，作为"能回滚"的兜底入口。
 */
export function registerPdfSnapshotsView(ctx, history, log = () => { }) {
  const emitter = new vscode.EventEmitter();
  const tree = {
    onDidChangeTreeData: emitter.event,
    async getChildren(el) {
      if (el) return [];
      const uri = pickPdfUri();
      if (!uri) return [{ kind: "hint", label: "打开一个 .pdf 文件后，这里会列出它的快照" }];
      const list = await history.list(uri.toString());
      if (!list.length) return [{ kind: "hint", label: "还没有快照（保存一次批注后就会出现）" }];
      return list.map((s) => ({ kind: "snap", name: s.name, ts: s.ts, uri }));
    },
    getTreeItem(node) {
      if (node.kind === "hint") {
        const t = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        t.iconPath = new vscode.ThemeIcon("info");
        return t;
      }
      const t = new vscode.TreeItem("批注保存前 " + new Date(node.ts).toLocaleString(), vscode.TreeItemCollapsibleState.None);
      t.description = true;
      t.iconPath = new vscode.ThemeIcon("history");
      t.tooltip = "点一下恢复这个版本（恢复前会先给当前版本留快照）";
      t.command = { command: RESTORE_COMMAND, title: "恢复此版本", arguments: [node.uri.toString(), node.name] };
      return t;
    },
  };
  const view = vscode.window.createTreeView(SNAPSHOTS_VIEW_ID, { treeDataProvider: tree, showCollapseAll: false });
  const refresh = () => { try { emitter.fire(); } catch { } };
  const prevNotify = history.notifyChanged;
  history.notifyChanged = (uriString) => {
    try { prevNotify && prevNotify(uriString); } catch { }
    refresh();
  };
  const tabSub = vscode.window.tabGroups.onDidChangeTabs ? vscode.window.tabGroups.onDidChangeTabs(refresh) : null;
  log("PDF 快照视图已注册（活动栏「WebC++ 测试」容器里的第二个视图）");
  return {
    dispose() {
      try { tabSub && tabSub.dispose(); } catch { }
      try { view.dispose(); } catch { }
      try { emitter.dispose(); } catch { }
    },
  };
}

export const SNAPSHOTS_VIEW_ID = "oiCpp.pdfSnapshots";
