// PDF 阅读器的**宿主侧**：注册自定义编辑器、读文件字节、读写批注 sidecar、CSP/资源 URI。
//
// 渲染/交互全在 webview（src/web/pdf/client.mjs）；这里只做"宿主才能做的事"：
//   · vscode.workspace.fs.readFile（网页版走 FSA/虚拟 FS，桌面版走 fs）
//   · 批注 sidecar（与 PDF 同目录的 `xxx.pdf.annotations.json`）读写
//   · 密码框（webview 里 window.prompt/confirm 被 sandbox 禁用，必须宿主弹）
//   · asWebviewUri + localResourceRoots + CSP（wasm 需要 'wasm-unsafe-eval'）
import * as vscode from "vscode";
import * as platform from "oi-platform";

export const PDF_VIEW_TYPE = "webcpp.pdf";
const SIDECAR_SUFFIX = ".annotations.json";

/** 自定义文档：只记 uri（PDF 内容按需读，避免常驻大 buffer） */
class PdfDocument {
  constructor(uri) {
    this.uri = uri;
    this._disposables = [];
  }
  dispose() {
    for (const d of this._disposables) { try { d.dispose(); } catch { } }
    this._disposables = [];
  }
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

      const name = String(document.uri.path.split("/").pop() || "document.pdf");
      const sidecarUri = sidecarOf(document.uri);

      let bytes = null;
      let loadError = null;
      try {
        bytes = await vscode.workspace.fs.readFile(document.uri);
      } catch (e) {
        loadError = String((e && e.message) || e);
      }

      let sidecarText = null;
      try {
        const raw = await vscode.workspace.fs.readFile(sidecarUri);
        sidecarText = new TextDecoder("utf-8").decode(raw);
      } catch { /* 没有 sidecar 是正常情况 */ }

      const send = (m) => { try { webview.postMessage(m); } catch { } };

      const sub = webview.onDidReceiveMessage(async (m) => {
        if (!m || !m.type) return;
        if (m.type === "ready") {
          if (loadError) { send({ type: "error", text: "读不到这个文件：" + loadError }); return; }
          send({
            type: "load",
            bytes: bytes || new Uint8Array(0),
            name,
            uri: document.uri.toString(),
            sidecar: { text: sidecarText },
            debug: { isWeb: !!platform.isWeb },
          });
          return;
        }
        if (m.type === "save") {
          try {
            const data = new TextEncoder().encode(String(m.json || ""));
            // 目录不存在会抛 → 交给 webview 提示（只读工作区就是这条路径）
            await vscode.workspace.fs.writeFile(sidecarUri, data);
            send({ type: "saved", ok: true, uri: sidecarUri.toString() });
          } catch (e) {
            send({ type: "saved", ok: false, error: String((e && e.message) || e) });
          }
          return;
        }
        if (m.type === "needPassword") {
          const v = await vscode.window.showInputBox({
            title: `${name} 需要密码`,
            prompt: m.tries > 1 ? `密码不正确，请重试（第 ${m.tries} 次）` : "这个 PDF 已加密",
            password: true,
            ignoreFocusOut: true,
          });
          send(v == null ? { type: "passwordCancel" } : { type: "password", value: v });
          return;
        }
        if (m.type === "openExternal") {
          // 桌面版直接交给系统阅读器；网页版没这个能力，给个明确说法
          if (platform.isWeb) {
            vscode.window.showInformationMessage("网页版无法交给系统打开；可以用左侧资源管理器把 .pdf 下载下来。");
          } else {
            try { await vscode.env.openExternal(document.uri); } catch (e) {
              vscode.window.showErrorMessage("打开失败：" + ((e && e.message) || e));
            }
          }
          return;
        }
        if (m.type === "log") {
          // webview 的日志也进扩展输出通道，便于用户排查（不写 console，避免吃内存）
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

/** PDF → 批注文件（同目录、同名前缀） */
function sidecarOf(uri) {
  return uri.with({ path: uri.path + SIDECAR_SUFFIX });
}

function buildHtml(webview, extensionUri) {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const asset = (rel) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "assets", "pdf", rel)).toString();
  const assets = {
    lib: asset("build/pdf.min.mjs"),
    worker: asset("build/pdf.worker.min.mjs"),
    cMapUrl: asset("cmaps/"),
    standardFontDataUrl: asset("standard_fonts/"),
    wasmUrl: asset("wasm/"),
    iccUrl: asset("iccs/"),
  };
  const csp = [
    "default-src 'none'",
    `img-src data: blob: ${webview.cspSource}`,
    `style-src 'unsafe-inline' ${webview.cspSource}`,
    // ⚠️ 'wasm-unsafe-eval' 是 PDFium/pdf.js 解码必需的，缺了直接编译不了 wasm
    `script-src 'nonce-${nonce}' 'wasm-unsafe-eval' ${webview.cspSource}`,
    `worker-src blob: ${webview.cspSource}`,
    `font-src data: ${webview.cspSource}`,
    `connect-src ${webview.cspSource}`,
  ].join("; ");

  return `<!DOCTYPE html><html lang="zh-CN"><head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="stylesheet" href="${asset("app/client.css")}" />
<title>PDF</title>
</head><body class="pdfbody">
<div id="toolbar">
  <span id="docName">—</span><span id="docMeta"></span>
  <span class="sep"></span>
  <div class="group">
    <button id="btnThumbs" title="缩略图">▤</button>
    <button id="btnOutline" title="大纲">☰</button>
  </div>
  <span class="sep"></span>
  <div class="group">
    <button id="btnPrev" title="上一页 (PageUp)">‹</button>
    <input id="pageInput" type="text" value="1" title="页码（可输入 3 或 3-5）" />
    <span id="pageTotal">/ ?</span>
    <button id="btnNext" title="下一页 (PageDown)">›</button>
  </div>
  <span class="sep"></span>
  <div class="group">
    <button id="btnZoomOut" title="缩小 (Ctrl+-)">−</button>
    <span id="zoomValue">100%</span>
    <button id="btnZoomIn" title="放大 (Ctrl+=)">+</button>
    <button id="btnFitWidth" title="适应宽度">↔</button>
    <button id="btnFitPage" title="适应页面">⤢</button>
    <button id="btnRotate" title="旋转 90°">⟳</button>
  </div>
  <span class="sep"></span>
  <div class="group">
    <button class="toolBtn" data-tool="select" title="选择 / 文本选择">✥</button>
    <button class="toolBtn" data-tool="highlight" title="高亮（拖选文字）">▮</button>
    <button class="toolBtn" data-tool="underline" title="下划线">_</button>
    <button class="toolBtn" data-tool="strike" title="删除线">S̶</button>
    <button class="toolBtn" data-tool="note" title="便签">📝</button>
    <button class="toolBtn" data-tool="freetext" title="自由文本">T</button>
    <button class="toolBtn" data-tool="rect" title="矩形">▭</button>
    <button class="toolBtn" data-tool="arrow" title="箭头">↗</button>
    <button class="toolBtn" data-tool="pen" title="手写（板书）">✎</button>
    <button class="toolBtn" data-tool="marker" title="荧光笔">🖍</button>
    <button class="toolBtn" data-tool="eraser" title="橡皮（点一下删除）">⌫</button>
    <input id="color" type="color" value="#ffd54f" title="颜色" />
    <input id="inkWidth" type="number" min="1" max="24" step="1" value="2" title="笔宽" />
  </div>
  <span class="sep"></span>
  <div class="group">
    <button id="btnUndo" title="撤销 (Ctrl+Z)">↶</button>
    <button id="btnRedo" title="重做 (Ctrl+Y)">↷</button>
    <button id="btnSave" title="立即保存批注 (Ctrl+S)">保存</button>
    <button id="btnOcr" title="OCR（后续版本提供，接口已预留）" class="unsupported">OCR</button>
    <span id="saveState"></span>
  </div>
</div>

<div id="findBar">
  <input id="findInput" type="text" placeholder="在文档中搜索…（Ctrl+F）" />
  <span id="findCount"></span>
  <button id="findPrev" title="上一个 (Shift+F3)">↑</button>
  <button id="findNext" title="下一个 (F3)">↓</button>
  <button id="findClose" title="关闭">✕</button>
</div>

<div id="main">
  <aside id="sidebar">
    <div id="thumbs"></div>
    <div id="outline"></div>
  </aside>
  <div id="viewport"><div id="pages"></div></div>
</div>

<div id="editor">
  <textarea id="editorText" placeholder="输入内容…（Ctrl+Enter 保存，Esc 取消）"></textarea>
  <div class="row">
    <button id="editorCancel">取消</button>
    <button id="editorOk" class="primary">保存</button>
  </div>
</div>

<div id="error">
  <div><strong>打开这个 PDF 时出错了</strong></div>
  <div id="errorText"></div>
  <div class="row">
    <button id="errorClose">关闭</button>
    <button id="errorOpen" class="primary">用外部阅读器打开</button>
  </div>
</div>

<div id="toast"></div>

<svg width="0" height="0" style="position:absolute"><defs>
  <marker id="arrowHead" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
    <path d="M0,0 L8,4 L0,8 z" fill="context-stroke" />
  </marker>
</defs></svg>

<script nonce="${nonce}">window.__PDF_ASSETS = ${JSON.stringify(assets)};</script>
<script type="module" src="${asset("app/client.mjs")}"></script>
</body></html>`;
}
