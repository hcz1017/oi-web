// PDF 阅读器的 webview 端：**EmbedPDF（PDFium WASM）** 的薄壳。
//
// 为什么用 EmbedPDF 而不是 pdf.js：
//   · 引擎是 PDFium —— Chrome/Edge 用的同一个渲染引擎，保真度最高；
//   · 批注/板书是**标准 PDF 标注**（/Highlight /Ink /Text /Square …），直接写进 PDF 文件，
//     Acrobat、Edge、福昕都能看见，不需要我们自己维护外观流（/AP）；
//   · 自带成熟 UI：工具栏、缩略图、搜索、缩放、旋转、批注工具（含 ink 手写）、撤销重做。
//
// 这里只做三件事：
//   1) 把宿主传来的字节 → blob URL 交给 EmbedPDF；
//   2) 把它的 **下载/保存** 动作截获，改成"写回原 PDF"（webview 里下载会被沙箱拦掉）；
//   3) Ctrl+S 主动保存 + 错误提示 + 日志转发。
import EmbedPDF from "../embedpdf/embedpdf.js";

const A = window.__PDF_ASSETS || {};
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

const state = { name: "document.pdf", viewer: null, registry: null, srcUrl: null, saving: false };

// ---------------------------------------------------------------- 启动
vscode.postMessage({ type: "ready" });
window.addEventListener("message", (ev) => {
  const m = ev.data || {};
  if (m.type === "load") onLoad(m).catch(fatal);
  if (m.type === "saved") {
    state.saving = false;
    if (m.ok) toast(m.backup ? `已写回 PDF（原文件备份为 ${m.backup}）` : "已写回 PDF");
    else { toast("保存失败：" + (m.error || ""), 5000); showError("保存失败", m.error || ""); }
  }
});

async function onLoad({ bytes, name }) {
  state.name = name || "document.pdf";
  document.title = state.name;
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // EmbedPDF 的 src 只接受 URL，用 blob 把内存里的 PDF 交进去
  state.srcUrl = URL.createObjectURL(new Blob([data], { type: "application/pdf" }));

  // ⚠️ 下载拦截：它的"保存/下载"会建 blob + <a download> + click()，
  //    webview 里真下载会被沙箱拦掉（或存进浏览器下载目录，用户根本找不到）。
  //    我们把它改成 postMessage 给宿主，由宿主写回工作区里的 PDF。
  patchDownloadInterception();

  const dark = document.body.classList.contains("vscode-dark") || document.body.classList.contains("vscode-high-contrast");
  const viewer = EmbedPDF.init({
    type: "container",
    target: $("pdfViewer"),
    src: state.srcUrl,
    wasmUrl: A.pdfiumWasm,           // 用打包进去的 pdfium.wasm（不联网）
    worker: true,                     // PDFium 跑在 worker 里，不卡 UI
    fontFallback: null,               // 关掉默认的 jsDelivr 字体回退：离线也要能用
    theme: { preference: dark ? "dark" : "light" },
    i18n: { defaultLocale: "zh-CN" },
  });
  state.viewer = viewer;
  if (!viewer) throw new Error("EmbedPDF 初始化失败（返回空）");

  try {
    state.registry = await viewer.registry;
  } catch (e) {
    throw new Error("EmbedPDF 插件注册失败：" + ((e && e.message) || e));
  }
}

// ---------------------------------------------------------------- 保存
/** 截获 <a download> 的点击：拿到 PDF 字节 → 交给宿主写回文件 */
function patchDownloadInterception() {
  if (patchDownloadInterception._done) return;
  patchDownloadInterception._done = true;
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function patchedClick() {
    try {
      const href = this.getAttribute("href") || "";
      if (this.hasAttribute("download") && /^blob:/i.test(href)) {
        fetch(href)
          .then((r) => r.arrayBuffer())
          .then((buf) => saveToFile(buf))
          .catch((e) => fatal(e));
        return;                       // 不真的触发浏览器下载
      }
    } catch { /* 落到原生行为 */ }
    return origClick.call(this);
  };
}

/** 主动保存：优先用 export 插件拿"带批注的 PDF 字节"，拿不到再退到下载拦截 */
async function saveToFile(bufMaybe) {
  if (state.saving) return;
  state.saving = true;
  toast("正在写回 PDF…", 1200);
  try {
    let buf = bufMaybe;
    if (!buf) {
      const plugin = state.registry && state.registry.getPlugin("export");
      const cap = plugin && typeof plugin.provides === "function" ? plugin.provides() : null;
      if (!cap || typeof cap.saveAsCopy !== "function") throw new Error("没有可用的导出能力（export 插件未就绪）");
      const task = cap.saveAsCopy();
      buf = await (task && typeof task.toPromise === "function" ? task.toPromise() : task);
    }
    vscode.postMessage({ type: "savePdf", bytes: buf });
  } catch (e) {
    state.saving = false;
    fatal(e);
  }
}

window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveToFile();
  }
});

// ---------------------------------------------------------------- 提示 / 错误
let toastTimer = 0;
function toast(text, ms = 2200) {
  const el = $("toast");
  if (!el) return;
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

function showError(title, text) {
  const box = $("error");
  if (!box) return;
  $("errorTitle").textContent = title || "出错了";
  $("errorText").textContent = String(text || "");
  box.classList.add("show");
}

function fatal(e) {
  const text = String((e && (e.message || e)) || e);
  vscode.postMessage({ type: "log", text: "[pdf] " + text });
  showError("打开这个 PDF 时出错了", text);
}

window.addEventListener("unhandledrejection", (e) => {
  const t = String((e && e.reason && (e.reason.message || e.reason)) || "");
  if (t) vscode.postMessage({ type: "log", text: "[pdf] 未处理异常: " + t });
});

$("errorClose").onclick = () => $("error").classList.remove("show");
$("errorOpen").onclick = () => vscode.postMessage({ type: "openExternal" });
