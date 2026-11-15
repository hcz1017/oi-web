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
  // 每个文件只保留最近 10 份快照（用户要求；更早的自动淘汰）
  return createHistoryStore(fsAdapter(root), root.path, { keep: 10 });
}

/**
 * 注册时间线提供者 + 恢复命令。
 * @param {vscode.ExtensionContext} ctx
 * @param {ReturnType<typeof createPdfHistory>} history
 * @returns {vscode.Disposable}
 */
export function registerPdfTimeline(ctx, history, log = () => { }) {
  const subs = [];

  // 恢复命令：把某个快照写回 PDF。
  //
  // ⚠️ 恢复是个"读快照 → 备份当前 → 写文件 → 刷新阅读器"的串行流程，中途再点一次会：
  //    · 用同一个快照重复写，浪费时间；
  //    · 更糟：第二份"当前版本快照"可能落在半写状态上。
  //    所以用 restoring 标志做**重入保护**，同时用 withProgress 明确告诉用户"正在恢复"。
  let restoring = false;
  subs.push(vscode.commands.registerCommand(RESTORE_COMMAND, async (fileUriStr, snapshotName) => {
    if (restoring) {
      vscode.window.setStatusBarMessage("$(sync~spin) 正在恢复快照，请稍候…", 2500);
      return;
    }
    restoring = true;
    try {
      const uri = vscode.Uri.parse(String(fileUriStr));
      const name = String(snapshotName || "");
      const n = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "正在恢复 PDF 快照", cancellable: false },
        async (progress) => {
          progress.report({ message: "读取快照…" });
          const bytes = await history.read(uri.toString(), name);

          progress.report({ message: "备份当前版本…" });
          const current = await vscode.workspace.fs.readFile(uri);
          await history.snapshot(uri.toString(), current);

          progress.report({ message: "写回 PDF…" });
          await vscode.workspace.fs.writeFile(uri, toBytes(bytes));
          try { history.notifyChanged?.(uri.toString()); } catch { }

          progress.report({ message: "刷新阅读器…" });
          return reloadPdfPanels(uri.toString());
        },
      );
      vscode.window.showInformationMessage(
        `已恢复到 ${name}（恢复前的版本也留在时间线里）` + (n ? "，已自动刷新阅读器" : ""),
      );
    } catch (e) {
      vscode.window.showErrorMessage("恢复失败：" + ((e && e.message) || e));
    } finally {
      restoring = false;
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
  //    scheme 必须传 **"*"** 才表示"所有 scheme"。官方文档写的是 `""`，但 workbench 里的
  //    实际过滤逻辑是：`if (scheme !== "*" && scheme !== uri.scheme) return;`
  //    —— 传 "" 会让所有查询直接 return，表现就是"时间线永远空着"。
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
    subs.push(register(PDF_TIMELINE_ID, "PDF 快照", "*", provider));
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
