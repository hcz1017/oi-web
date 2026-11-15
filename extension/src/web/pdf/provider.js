// PDF 阅读器的**宿主侧**：注册自定义编辑器、喂字节给 webview、把批注写回 PDF 文件。
//
// 引擎在 webview 里（EmbedPDF / PDFium WASM），批注是**标准 PDF 标注**；
// 宿主只做三件事：读文件、写回文件（先备份）、以及 webview 做不到的事（外部打开、日志）。
import * as vscode from "vscode";
import * as platform from "oi-platform";
import { looksLikePdf } from "./history-core.mjs";

export const PDF_VIEW_TYPE = "webcpp.pdf";

/** 打开着的 PDF 面板（uri 字符串 → { reload, flush }）。恢复快照/文件被外部改动时用它刷新 */
const panels = new Map();

/**
 * 每个文件一条写队列：保存、恢复、flush 都排队执行。
 * 不加队列时，"保存中紧接着恢复"会让两次写盘交错（后写的可能基于旧快照），
 * 表现为"恢复完又变回新版本"这类玄学 bug。
 */
const writeQueues = new Map();
function withWriteLock(uriString, fn) {
  const key = String(uriString);
  const prev = writeQueues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  // 队列尾部存一个"吞掉错误"的 promise，避免一次失败卡死后续所有操作
  writeQueues.set(key, next.catch(() => { }));
  return next;
}

/**
 * 让某个 PDF 的所有已打开面板**先把自己手上未保存的批注写回文件**。
 *
 * 恢复快照时必须先做这一步：否则阅读器里那些还没保存的批注会被旧字节直接覆盖掉（数据丢失）。
 * 返回已冲刷的面板数；超时/失败不阻塞恢复（但会记日志）。
 */
export async function flushPdfPanels(uriString, timeoutMs = 5000) {
  const set = panels.get(String(uriString));
  if (!set || !set.size) return 0;
  let n = 0;
  await Promise.all([...set].map(async (p) => {
    if (typeof p.flush !== "function") return;
    try { await p.flush(timeoutMs); n++; } catch { }
  }));
  return n;
}

/** 让某个 PDF 的所有已打开面板重新读取文件（不关编辑器也能看到新内容） */
export async function reloadPdfPanels(uriString) {
  const set = panels.get(String(uriString));
  if (!set) return 0;
  let n = 0;
  for (const p of [...set]) {
    try { await p.reload(); n++; } catch { }
  }
  return n;
}

class PdfDocument {
  constructor(uri) {
    this.uri = uri;
  }
  dispose() { }
}

/**
 * 注册 PDF 自定义编辑器。
 * @param {vscode.ExtensionContext} ctx
 * @returns {vscode.Disposable}
 */
export function registerPdfViewer(ctx, deps = {}) {
  const history = deps.history || null;
  const provider = {
    async openCustomDocument(uri) {
      return new PdfDocument(uri);
    },

    async resolveCustomEditor(document, panel) {
      const webview = panel.webview;
      webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, "assets", "pdf")],
      };
      webview.html = buildHtml(webview, ctx.extensionUri);

      const fileName = String(document.uri.path.split("/").pop() || "document.pdf");
      const send = (m) => { try { webview.postMessage(m); } catch { } };

      let bytes = null;
      let loadError = null;
      /** 我们自己上一次写盘的时间（用来忽略"自己触发"的 watcher 事件） */
      let lastSelfWrite = 0;
      try {
        bytes = await vscode.workspace.fs.readFile(document.uri);
      } catch (e) {
        loadError = String((e && e.message) || e);
      }

      // 登记面板：供"恢复快照 / 外部改动"时热重载
      /** 发起一次"把未保存批注写回文件"，等客户端回 flushSave */
      let flushSeq = 0;
      const flushWaiters = new Map();
      const flush = (timeoutMs = 5000) => new Promise((resolve, reject) => {
        const id = `f${Date.now().toString(36)}${++flushSeq}`;
        const timer = setTimeout(() => { flushWaiters.delete(id); reject(new Error("冲刷超时")); }, timeoutMs);
        flushWaiters.set(id, { resolve: () => { clearTimeout(timer); flushWaiters.delete(id); resolve(); }, reject: (e) => { clearTimeout(timer); flushWaiters.delete(id); reject(e); } });
        send({ type: "flush", id });
      });

      const reload = async () => {
        try {
          const fresh = await vscode.workspace.fs.readFile(document.uri);
          bytes = fresh;
          send({ type: "reload", bytes: fresh, name: fileName });
        } catch (e) {
          send({ type: "error", text: "重新读取失败：" + ((e && e.message) || e) });
        }
      };
      const key = document.uri.toString();
      if (!panels.has(key)) panels.set(key, new Set());
      const panelRef = { reload, flush };
      panels.get(key).add(panelRef);

      // 文件被外部改动（比如用系统阅读器另存）时也自动刷新
      let watcher = null;
      try {
        const dirUri = document.uri.with({ path: document.uri.path.replace(/\/[^/]*$/, "") });
        watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dirUri, fileName));
        watcher.onDidDelete((u) => {
          if (u.toString() !== key) return;
          send({ type: "error", text: "这个 PDF 已被删除或移走（编辑器里的内容可能已过期）" });
        });
        watcher.onDidCreate(() => { /* 同路径被重新创建：下次保存会重建，忽略 */ });
        watcher.onDidChange((u) => {
          if (u.toString() !== key) return;
          // ⚠️ 保存时我们自己写盘也会触发 watcher：以前这里无脑 reload，
          //    结果"每存一次就整页重新载入"（滚动位置、选中、缩放全丢）。
          //    只对真正的外部改动刷新。
          if (Date.now() - lastSelfWrite < 4000) return;
          reload();
        });
      } catch { /* 虚拟工作区不支持 watcher 就跳过 */ }

      const sub = webview.onDidReceiveMessage(async (m) => {
        if (!m || !m.type) return;

        if (m.type === "ready") {
          if (loadError) { send({ type: "error", text: "读不到这个文件：" + loadError }); return; }
          send({ type: "load", bytes: bytes || new Uint8Array(0), name: fileName });
          return;
        }

        // 把（带批注的）PDF 写回原文件。
        // ⚠️ 写之前先把"当前版本"存成快照（出现在 VS Code 的"时间线"里），
        //    这样不需要 .bak 文件也能回滚；快照存不下就不写 —— 绝不冒险覆盖原件。
        if (m.type === "savePdf") {
          try {
            const data = toBytes(m.bytes);
            // 写盘前先确认这真的是 PDF：挡住"导出插件返回了一段空/JSON"这类异常
            if (!looksLikePdf(data)) throw new Error("要写入的数据不是有效的 PDF，已放弃");
            let snapshot = null;
            await withWriteLock(key, async () => {
              if (history) {
                const old = bytes || await vscode.workspace.fs.readFile(document.uri);
                snapshot = await history.snapshot(document.uri.toString(), old);
                if (snapshot === null) send({ type: "log", text: "[pdf] 文件超过快照体积上限，本次未留快照" });
              }
              lastSelfWrite = Date.now();
              await vscode.workspace.fs.writeFile(document.uri, data);
              bytes = data;                   // 后续再次保存时用最新内容
              try { history && history.notifyChanged?.(document.uri.toString()); } catch { }
            });
            send({ type: "saved", ok: true, snapshot });
          } catch (e) {
            send({ type: "saved", ok: false, error: String((e && e.message) || e) });
          }
          return;
        }

        // 恢复快照前的"冲刷未保存批注"应答：写盘（含快照）后回复
        if (m.type === "flushSave") {
          const waiter = flushWaiters.get(m.id);
          try {
            if (m.error) throw new Error(m.error);
            const data = toBytes(m.bytes);
            if (!looksLikePdf(data)) throw new Error("冲刷的数据不是有效的 PDF");
            await withWriteLock(key, async () => {
              if (history) {
                try {
                  const old = bytes || await vscode.workspace.fs.readFile(document.uri);
                  await history.snapshot(document.uri.toString(), old);
                  try { history && history.notifyChanged?.(document.uri.toString()); } catch { }
                } catch { /* 快照失败不阻塞冲刷 */ }
              }
              lastSelfWrite = Date.now();
              await vscode.workspace.fs.writeFile(document.uri, data);
              bytes = data;
            });
            send({ type: "flushDone", id: m.id, ok: true });
            waiter?.resolve();
          } catch (e) {
            send({ type: "flushDone", id: m.id, ok: false, error: String((e && e.message) || e) });
            waiter?.reject(e);
          }
          return;
        }

        if (m.type === "openExternal") {
          if (platform.isWeb) {
            vscode.window.showInformationMessage("网页版无法交给系统打开；可以用资源管理器把 .pdf 下载下来。");
          } else {
            try { await vscode.env.openExternal(document.uri); } catch (e) {
              vscode.window.showErrorMessage("打开失败：" + ((e && e.message) || e));
            }
          }
          return;
        }

        if (m.type === "log") {
          try { console.log("[pdf]", String(m.text || "")); } catch { }
          return;
        }
      });

      panel.onDidDispose(() => {
        try { sub.dispose(); } catch { }
        try { watcher && watcher.dispose(); } catch { }
        const s = panels.get(key);
        if (s) { s.delete(panelRef); if (!s.size) panels.delete(key); }
        for (const [, w] of flushWaiters) { try { w.reject(new Error("面板已关闭")); } catch { } }
        flushWaiters.clear();
      });
    },
  };

  return vscode.window.registerCustomEditorProvider(PDF_VIEW_TYPE, provider, {
    webviewOptions: { retainContextWhenHidden: true },
    // ⚠️ 关闭"同一文档多编辑器"：两个视图各持一份字节，保存会互相覆盖（后写赢），
    //    而且每份都是整份 PDF 的内存副本。要并排看就分别打开不同文件。
    supportsMultipleEditorsPerDocument: false,
  });
}

/** webview 传来的字节可能是 ArrayBuffer / Uint8Array（结构化克隆），统一成 Uint8Array */
function toBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (Array.isArray(v)) return new Uint8Array(v);          // 兜底：极端情况会退化成普通数组
  throw new Error("收到的 PDF 数据不是二进制");
}

function buildHtml(webview, extensionUri) {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const asset = (rel) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "assets", "pdf", rel)).toString();
  const assets = { pdfiumWasm: asset("embedpdf/pdfium.wasm") };
  const csp = [
    "default-src 'none'",
    `img-src data: blob: ${webview.cspSource}`,
    `style-src 'unsafe-inline' ${webview.cspSource}`,
    // 'wasm-unsafe-eval' 是 PDFium 编译 wasm 必需的；缺了直接白屏
    `script-src 'nonce-${nonce}' 'wasm-unsafe-eval' ${webview.cspSource}`,
    // EmbedPDF 的 pdfium worker 走 blob；主线程 chunk 走 cspSource
    `worker-src blob: ${webview.cspSource}`,
    `font-src data: ${webview.cspSource}`,
    // 印章库清单默认从 jsDelivr 拉（可选功能）：放行它，避免控制台一直报 CSP
    `connect-src blob: data: https://cdn.jsdelivr.net ${webview.cspSource}`,
  ].join("; ");

  return `<!DOCTYPE html><html lang="zh-CN"><head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="stylesheet" href="${asset("app/client.css")}" />
<title>PDF</title>
</head><body>
<div id="pdfViewer"></div>

<div id="error">
  <div><strong id="errorTitle">出错了</strong></div>
  <div id="errorText"></div>
  <div class="row">
    <button id="errorClose">关闭</button>
    <button id="errorOpen" class="primary">用外部阅读器打开</button>
  </div>
</div>

<div id="toast"></div>

<script nonce="${nonce}">window.__PDF_ASSETS = ${JSON.stringify(assets)};</script>
<script type="module" src="${asset("app/client.mjs")}"></script>
</body></html>`;
}
