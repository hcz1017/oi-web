// PDF 阅读器的 webview 端：**EmbedPDF（PDFium WASM）** 的薄壳。
//
// 为什么用 EmbedPDF 而不是 pdf.js：
//   · 引擎是 PDFium —— Chrome/Edge 用的同一个渲染引擎，保真度最高；
//   · 批注/板书是**标准 PDF 标注**（/Highlight /Ink /Text /Square …），直接写进 PDF 文件，
//     Acrobat、Edge、福昕都能看见，不需要我们自己维护外观流（/AP）；
//   · 自带成熟 UI：工具栏、缩略图、搜索、缩放、旋转、批注工具（含 ink 手写）、撤销重做。
//
// 这一层负责：
//   1) 字节 → blob URL 交给 EmbedPDF；
//   2) **统一的保存按钮 + 自动保存**（批注一改就防抖写回原 PDF，先 .bak 备份）；
//   3) 截获它自带的下载动作（webview 里真下载会被沙箱拦掉）；
//   4) Ctrl+S、切走前保存、错误提示、日志转发。
import EmbedPDF from "../embedpdf/embedpdf.js";

const A = window.__PDF_ASSETS || {};
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

/** 批注停手多久后自动保存（毫秒）。太短会让每次拖拽都写盘，太长则容易丢最后几笔 */
const AUTOSAVE_DELAY = 1600;

const state = {
  name: "document.pdf",
  viewer: null, registry: null, srcUrl: null,
  saving: false, dirty: false, lastSaved: 0,
  saveTimer: 0, docId: null,
};

// ---------------------------------------------------------------- 启动
vscode.postMessage({ type: "ready" });
window.addEventListener("message", (ev) => {
  const m = ev.data || {};
  if (m.type === "load") onLoad(m).catch(fatal);
  if (m.type === "saved") onSaved(m);
});

async function onLoad({ bytes, name }) {
  state.name = name || "document.pdf";
  document.title = state.name;
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  state.srcUrl = URL.createObjectURL(new Blob([data], { type: "application/pdf" }));

  patchDownloadInterception();
  buildSaveBar();

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
  wireAutosave();
  setStatus("已保存", "idle");
}

// ---------------------------------------------------------------- 保存条（统一入口）
function buildSaveBar() {
  if ($("saveBar")) return;
  const bar = document.createElement("div");
  bar.id = "saveBar";
  bar.innerHTML =
    '<button id="saveBtn" class="primary" title="保存到 PDF（Ctrl+S）">' +
    '<span class="ico">💾</span><span id="saveLabel">保存到 PDF</span>' +
    "</button>" +
    '<span id="saveStatus" class="status">已保存</span>';
  document.body.appendChild(bar);
  $("saveBtn").onclick = () => saveNow("manual");
  setStatus("已保存", "idle");
}

function setStatus(text, kind) {
  const el = $("saveStatus");
  if (!el) return;
  el.textContent = text;
  el.dataset.kind = kind || "idle";
}

function markDirty(reason) {
  state.dirty = true;
  setStatus("未保存…", "dirty");
  // 防抖：连续拖拽/书写时只在停手后写一次盘
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => saveNow(reason || "auto"), AUTOSAVE_DELAY);
}

/** 保存入口：manual = 点按钮/Ctrl+S；auto = 防抖/切走 */
async function saveNow(kind) {
  clearTimeout(state.saveTimer);
  state.saveTimer = 0;
  if (state.saving) return;
  if (!state.dirty && kind === "auto") return;      // 没改动就不写盘
  state.saving = true;
  setStatus("保存中…", "saving");
  try {
    const plugin = state.registry && state.registry.getPlugin("export");
    const cap = plugin && typeof plugin.provides === "function" ? plugin.provides() : null;
    if (!cap || typeof cap.saveAsCopy !== "function") throw new Error("没有可用的导出能力（export 插件未就绪）");
    const task = cap.saveAsCopy();
    const buf = await (task && typeof task.toPromise === "function" ? task.toPromise() : task);
    postPdf(buf);
  } catch (e) {
    state.saving = false;
    setStatus("保存失败", "error");
    fatal(e);
  }
}

function postPdf(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  // ⚠️ 结构化克隆会复制一份；PDF 大时内存会短暂翻倍，所以用完就把引用丢掉
  vscode.postMessage({ type: "savePdf", bytes });
}

function onSaved(m) {
  state.saving = false;
  if (m.ok) {
    state.dirty = false;
    state.lastSaved = Date.now();
    setStatus("已保存 " + new Date(state.lastSaved).toLocaleTimeString(), "saved");
    toast(m.backup ? "已写回 PDF（原文件备份为 " + m.backup + "）" : "已写回 PDF");
  } else {
    setStatus("保存失败", "error");
    toast("保存失败：" + (m.error || ""), 5000);
    showError("保存失败", m.error || "");
  }
}

// ---------------------------------------------------------------- 自动保存的触发源
function wireAutosave() {
  const ann = pluginCap("annotation");
  // 批注事件（新增/修改/删除/选中都会来）→ 标脏
  const hook = ann && ann.onAnnotationEvent;
  if (hook) {
    const handler = () => markDirty("annotation-event");
    try {
      if (typeof hook === "function") hook(handler);
      else if (typeof hook.subscribe === "function") hook.subscribe(handler);
    } catch { /* 事件订阅失败就靠下面的轮询兜底 */ }
  }

  // 兜底轮询：文档管理器里"有未保存更改"标志（不同版本字段名不一样，逐个认）
  const dm = pluginCap("document-manager");
  const hasDmState = !!(dm && typeof dm.getDocumentState === "function");
  state.docId = (dm && typeof dm.getActiveDocumentId === "function" ? dm.getActiveDocumentId() : null) || null;
  if (hasDmState) {
    setInterval(() => {
      try {
        const id = state.docId || (dm.getActiveDocumentId && dm.getActiveDocumentId());
        const st = id ? dm.getDocumentState(id) : null;
        if (!st) return;
        if (st.isDirty || st.hasUnsavedChanges || st.dirty || st.unsaved || st.modified) {
          if (!state.dirty) markDirty("poll");
        }
      } catch { /* 忽略 */ }
    }, 1500);
  }

  // 指针/键盘兜底：**只在完全拿不到信号时**才用（否则滚动一下就会白写一次盘）。
  const hasSignal = !!hook || hasDmState;
  if (!hasSignal) {
    log("没有可用的变更事件/状态，退化为输入兜底（可能多存几次）");
    const bump = () => { if (!state.saving) markDirty("pointer"); };
    document.addEventListener("pointerup", bump, true);
    document.addEventListener("keyup", (e) => {
      // 只关心可能改内容的键（打字/删除），避免翻页滚动也触发
      if (/^(Backspace|Delete|Enter)$/.test(e.key) || e.key.length === 1) bump();
    }, true);
  }

  // 切走/隐藏前保存（webview 被 dispose 时来不及拦截，只能提前）
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveNow("hidden"); });
  window.addEventListener("blur", () => saveNow("blur"));
}

/** 取插件能力（拿不到就返回 null，所有调用点都要能容错） */
function pluginCap(id) {
  try {
    const p = state.registry && state.registry.getPlugin(id);
    return p && typeof p.provides === "function" ? p.provides() : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- 截获自带下载
function patchDownloadInterception() {
  if (patchDownloadInterception._done) return;
  patchDownloadInterception._done = true;
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function patchedClick() {
    try {
      const href = this.getAttribute("href") || "";
      if (this.hasAttribute("download") && /^blob:/i.test(href)) {
        // 它自带的"保存/下载"也走我们的保存通道，保证只有一条写盘路径
        fetch(href).then((r) => r.arrayBuffer()).then((buf) => {
          state.dirty = true;
          state.saving = false;
          postPdf(buf);
          state.saving = true;
          setStatus("保存中…", "saving");
        }).catch(fatal);
        return;
      }
    } catch { /* 落到原生行为 */ }
    return origClick.call(this);
  };
}

// ---------------------------------------------------------------- 快捷键
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    state.dirty = true;
    saveNow("manual");
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
