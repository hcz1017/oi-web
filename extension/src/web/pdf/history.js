// PDF 快照仓库的 **vscode 胶水层** + 时间线（Timeline）注册。
//
// 用户视角：改完批注 → 点保存 → 原 PDF 被更新，同时"时间线"里多出一条
// "批注保存前 23:29"，点它可以恢复；不再生成 xxx.pdf.bak。
//
// 快照放在扩展的 globalStorage 里（每用户一份，不污染工作区、不会被 git 同步）。
import * as vscode from "vscode";
import { createHistoryStore, keyOf } from "./history-core.mjs";

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
export function registerPdfTimeline(ctx, history) {
  const subs = [];

  // 恢复命令：把某个快照写回 PDF（恢复前先给"当前版本"再留一份快照，所以恢复也能反悔）
  subs.push(vscode.commands.registerCommand(RESTORE_COMMAND, async (fileUriStr, snapshotName) => {
    try {
      const uri = vscode.Uri.parse(String(fileUriStr));
      const bytes = await history.read(uri.toString(), snapshotName);
      const current = await vscode.workspace.fs.readFile(uri);
      await history.snapshot(uri.toString(), current);
      await vscode.workspace.fs.writeFile(uri, toBytes(bytes));
      vscode.window.showInformationMessage(`已恢复到 ${snapshotName}（恢复前的版本也留在时间线里）`);
    } catch (e) {
      vscode.window.showErrorMessage("恢复失败：" + ((e && e.message) || e));
    }
  }));

  // 时间线提供者：不同 VS Code 版本/宿主的支持情况不同，这里做能力探测
  const register = vscode.window.registerTimelineProvider;
  if (typeof register !== "function") {
    return { dispose() { for (const d of subs) try { d.dispose(); } catch { } }, supported: false };
  }
  try {
    subs.push(register(PDF_TIMELINE_ID, {
      async provideTimeline(uri) {
        if (!/\.pdf$/i.test(uri.path)) return { items: [] };
        const list = await history.list(uri.toString());
        return {
          items: list.map((s) => ({
            id: s.name,
            label: "批注保存前 " + new Date(s.ts).toLocaleString(),
            timestamp: s.ts,
            description: "写回前自动留的快照",
            contextValue: "pdfSnapshot",
            command: {
              title: "恢复此版本",
              command: RESTORE_COMMAND,
              arguments: [uri.toString(), s.name],
            },
          })),
        };
      },
    }, { supportsResolving: false }));
  } catch (e) {
    // 老版本 VS Code 没有这个 API：功能降级（保存照常，只是没有时间线条目）
    return { dispose() { for (const d of subs) try { d.dispose(); } catch { } }, supported: false, error: String((e && e.message) || e) };
  }

  return { dispose() { for (const d of subs) try { d.dispose(); } catch { } }, supported: true };
}

/** 供日志/诊断用：某文件在仓库里的目录名 */
export function historyKey(uri) { return keyOf(uri.toString()); }
