// PDF 阅读器的**宿主侧**：注册自定义编辑器、喂字节给 webview、把批注写回 PDF 文件。
//
// 引擎在 webview 里（EmbedPDF / PDFium WASM），批注是**标准 PDF 标注**；
// 宿主只做三件事：读文件、写回文件（先备份）、以及 webview 做不到的事（外部打开、日志）。
import * as vscode from "vscode";
import * as platform from "oi-platform";

export const PDF_VIEW_TYPE = "webcpp.pdf";

/** 打开着的 PDF 面板（uri 字符串 → 重载函数）。恢复快照/文件被外部改动时用它刷新 */
const panels = new Map();

/** 让某个 PDF 的所有已打开面板重新读取文件（不关编辑器也能看到新内容） */
export async function reloadPdfPanels(uriString) {
  const set = panels.get(String(uriString));
  if (!set) return 0;
  let n = 0;
  for (const reload of [...set]) {
    try { await reload(); n++; } catch { }
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
      const reload = async () => {
        try {
          const fresh = await vscode.workspace.fs.readFile(document.uri);
          bytes = fresh;
          send({ type: "reload", bytes: fresh, name: fileName });
        } catch (e) {
          send({ type: "saved", ok: false, error: "重新读取失败：" + ((e && e.message) || e) });
        }
      };
      const key = document.uri.toString();
      if (!panels.has(key)) panels.set(key, new Set());
      panels.get(key).add(reload);

      // 文件被外部改动（比如用系统阅读器另存）时也自动刷新
      let watcher = null;
      try {
        const dirUri = document.uri.with({ path: document.uri.path.replace(/\/[^/]*$/, "") });
        watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dirUri, fileName));
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
            let snapshot = null;
            if (history) {
              try {
                const old = bytes || await vscode.workspace.fs.readFile(document.uri);
                snapshot = await history.snapshot(document.uri.toString(), old);
              } catch (e) {
                send({ type: "saved", ok: false, error: "快照失败，已放弃写入：" + ((e && e.message) || e) });
                return;
              }
            }
            lastSelfWrite = Date.now();
            await vscode.workspace.fs.writeFile(document.uri, data);
            bytes = data;                     // 后续再次保存时用最新内容
            try { history.notifyChanged?.(document.uri.toString()); } catch { }
            send({ type: "saved", ok: true, snapshot });
          } catch (e) {
            send({ type: "saved", ok: false, error: String((e && e.message) || e) });
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
        if (s) { s.delete(reload); if (!s.size) panels.delete(key); }
      });
    },
  };

  return vscode.window.registerCustomEditorProvider(PDF_VIEW_TYPE, provider, {
    webviewOptions: { retainContextWhenHidden: true },
    supportsMultipleEditorsPerDocument: true,
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
