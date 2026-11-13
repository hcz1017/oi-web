// PDF 阅读器的**宿主侧**：注册自定义编辑器、喂字节给 webview、把批注写回 PDF 文件。
//
// 引擎在 webview 里（EmbedPDF / PDFium WASM），批注是**标准 PDF 标注**；
// 宿主只做三件事：读文件、写回文件（先备份）、以及 webview 做不到的事（外部打开、日志）。
import * as vscode from "vscode";
import * as platform from "oi-platform";

export const PDF_VIEW_TYPE = "webcpp.pdf";
const BACKUP_SUFFIX = ".bak";

class PdfDocument {
  constructor(uri) {
    this.uri = uri;
    /** 本次会话是否已经备份过（同一份 PDF 只备份一次，别把 .bak 刷成最新批注版本） */
    this.backedUp = false;
  }
  dispose() { }
}

/**
 * 注册 PDF 自定义编辑器。
 * @param {vscode.ExtensionContext} ctx
 * @returns {vscode.Disposable}
 */
export function registerPdfViewer(ctx) {
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
      try {
        bytes = await vscode.workspace.fs.readFile(document.uri);
      } catch (e) {
        loadError = String((e && e.message) || e);
      }

      const sub = webview.onDidReceiveMessage(async (m) => {
        if (!m || !m.type) return;

        if (m.type === "ready") {
          if (loadError) { send({ type: "error", text: "读不到这个文件：" + loadError }); return; }
          send({ type: "load", bytes: bytes || new Uint8Array(0), name: fileName });
          return;
        }

        // 把（带批注的）PDF 写回原文件。⚠️ 先备份：网页版没有原子替换，写一半失败就毁了原件
        if (m.type === "savePdf") {
          try {
            const data = toBytes(m.bytes);
            let backup = null;
            if (!document.backedUp) {
              try {
                const old = bytes || await vscode.workspace.fs.readFile(document.uri);
                await vscode.workspace.fs.writeFile(backupOf(document.uri), old);
                backup = fileName + BACKUP_SUFFIX;
                document.backedUp = true;
              } catch (e) {
                // 备份失败就不写了 —— 宁可让用户看到错误，也不能冒险覆盖原件
                send({ type: "saved", ok: false, error: "备份失败，已放弃写入：" + ((e && e.message) || e) });
                return;
              }
            }
            await vscode.workspace.fs.writeFile(document.uri, data);
            bytes = data;                     // 后续再次保存时用最新内容
            send({ type: "saved", ok: true, backup });
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

      panel.onDidDispose(() => { try { sub.dispose(); } catch { } });
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

function backupOf(uri) {
  return uri.with({ path: uri.path + BACKUP_SUFFIX });
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
    `connect-src blob: data: ${webview.cspSource}`,
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
