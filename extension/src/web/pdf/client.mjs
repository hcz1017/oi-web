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
//   2) 统一的保存按钮 / Ctrl+S（**不自动保存**），保存前由宿主留快照（VS Code 时间线）；
//   3) 截获它自带的下载动作（webview 里真下载会被沙箱拦掉）；
//   4) 支持"热重载"（恢复快照/外部改动）与"恢复前冲刷未保存批注"（flush）；
//   5) 错误提示、日志转发。
import EmbedPDF from "../embedpdf/embedpdf.js";

const A = window.__PDF_ASSETS || {};
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

const state = {
  name: "document.pdf",
  viewer: null, registry: null, srcUrl: null,
  saving: false, lastSaved: 0, dirty: false,
};

// ---------------------------------------------------------------- 启动
vscode.postMessage({ type: "ready" });
window.addEventListener("message", (ev) => {
  const m = ev.data || {};
  if (m.type === "load") onLoad(m).catch(fatal);
  if (m.type === "reload") reloadDoc(m).catch(fatal);
  if (m.type === "saved") onSaved(m);
  if (m.type === "error") { setStatus("打开失败", "error"); showError("打开这个 PDF 时出错了", m.text || ""); }
  if (m.type === "flush") onFlush(m);
  if (m.type === "flushDone") onFlushDone(m);
  if (m.type === "log") { const t = String(m.text || "").replace(/^\[pdf\]\s*/, ""); if (/快照|上限/.test(t)) toast(t, 4200); }
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
    // ⚠️ 关掉两个会联网的默认项（否则 CSP 里天天报 Refused to connect）：
    //    · fonts：UI 字体默认从 Google Fonts 拉
    //    · stamp.defaultLibrary：印章库默认从 jsDelivr 拉 manifest
    fonts: { ui: null, signature: null },
    stamp: { defaultLibrary: false },
  });
  state.viewer = viewer;
  if (!viewer) throw new Error("EmbedPDF 初始化失败（返回空）");

  try {
    state.registry = await viewer.registry;
  } catch (e) {
    throw new Error("EmbedPDF 插件注册失败：" + ((e && e.message) || e));
  }
  wireDirtyTracking();
  state.dirty = false;
  setStatus("已保存", "idle");
}

/** 订阅批注变更：让保存按钮能显示"有未保存改动"，避免用户以为已经写进文件了 */
function wireDirtyTracking() {
  const ann = pluginCap("annotation");
  const hook = ann && ann.onAnnotationEvent;
  if (!hook) return;                       // 拿不到事件就退化为"只在保存后改状态"
  const handler = () => {
    state.dirty = true;
    setStatus("未保存…", "dirty");
  };
  try {
    if (typeof hook === "function") hook(handler);
    else if (typeof hook.subscribe === "function") hook.subscribe(handler);
  } catch { /* 事件订阅失败不影响保存 */ }
}

function pluginCap(id) {
  try {
    const p = state.registry && state.registry.getPlugin(id);
    return p && typeof p.provides === "function" ? p.provides() : null;
  } catch { return null; }
}

/** 重新读入同一份 PDF（恢复快照、或文件被外部改动时用，不用关掉再开） */
async function reloadDoc({ bytes, name }) {
  // 重载期间可能正好有一次保存在飞行中：状态重置掉，否则 saving 永远为 true（保存按钮彻底失灵）
  state.saving = false;
  clearTimeout(state.saveWatchdog);
  try { state.viewer?.destroy?.(); } catch { }
  state.viewer = null;
  state.registry = null;
  const target = $("pdfViewer");
  if (target) target.innerHTML = "";
  if (state.srcUrl) { try { URL.revokeObjectURL(state.srcUrl); } catch { } state.srcUrl = null; }
  await onLoad({ bytes, name: name || state.name });
  hideError();
  state.dirty = false;
  setStatus("已重新载入", "info");
}

// ---------------------------------------------------------------- 保存条（统一入口）
function buildSaveBar() {
  if ($("saveBar")) return;
  const bar = document.createElement("div");
  bar.id = "saveBar";
  bar.innerHTML =
    '<span id="saveDrag" class="drag" title="拖动可移动（位置会记住）">⠿</span>' +
    '<button id="saveBtn" class="primary" title="保存到 PDF（Ctrl+S）">' +
    '<span class="ico">💾</span><span id="saveLabel">保存到 PDF</span>' +
    "</button>" +
    '<span id="saveStatus" class="status">已保存</span>';
  document.body.appendChild(bar);
  $("saveBtn").onclick = () => saveNow("manual");
  makeDraggable(bar, $("saveDrag"));
  restoreBarPos(bar);
  setStatus("已保存", "idle");
}

/** 保存条可以拖着走（默认右下角，位置记在 webview state 里） */
function makeDraggable(bar, handle) {
  let drag = null;
  handle.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    const r = bar.getBoundingClientRect();
    drag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top };
    bar.classList.add("dragging");
    handle.setPointerCapture?.(ev.pointerId);
  });
  handle.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const w = bar.offsetWidth, h = bar.offsetHeight;
    const x = Math.min(window.innerWidth - w - 4, Math.max(4, ev.clientX - drag.dx));
    const y = Math.min(window.innerHeight - h - 4, Math.max(4, ev.clientY - drag.dy));
    bar.style.left = x + "px";
    bar.style.top = y + "px";
    bar.style.right = "auto";
    bar.style.bottom = "auto";
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    bar.classList.remove("dragging");
    const r = bar.getBoundingClientRect();
    try { vscode.setState({ ...(vscode.getState() || {}), saveBar: { x: r.left, y: r.top } }); } catch { }
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

function restoreBarPos(bar) {
  let pos = null;
  try { pos = (vscode.getState() || {}).saveBar || null; } catch { }
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return;
  const x = Math.min(window.innerWidth - 40, Math.max(4, pos.x));
  const y = Math.min(window.innerHeight - 30, Math.max(4, pos.y));
  bar.style.left = x + "px";
  bar.style.top = y + "px";
  bar.style.right = "auto";
  bar.style.bottom = "auto";
}

function setStatus(text, kind) {
  const el = $("saveStatus");
  if (!el) return;
  el.textContent = text;
  el.dataset.kind = kind || "idle";
}

/** 保存入口：只由"点按钮 / Ctrl+S"触发（**不自动保存**，用户明确要求） */
async function saveNow(_kind) {
  if (state.saving) return;
  state.saving = true;
  setStatus("保存中…", "saving");
  // 看门狗：宿主没回消息（面板被销毁 / 消息丢了）时不能把 saving 永久卡在 true
  clearTimeout(state.saveWatchdog);
  state.saveWatchdog = setTimeout(() => {
    if (!state.saving) return;
    state.saving = false;
    setStatus("保存超时", "error");
    toast("保存没有响应，请重试", 4000);
  }, 15000);
  try {
    // 5) 刚打开就按保存时 registry 可能还没就绪：等一会儿而不是直接报错
    if (!state.registry) await waitForRegistry(2500);
    const plugin = state.registry && state.registry.getPlugin("export");
    const cap = plugin && typeof plugin.provides === "function" ? plugin.provides() : null;
    if (!cap || typeof cap.saveAsCopy !== "function") throw new Error("没有可用的导出能力（export 插件未就绪）");
    const task = cap.saveAsCopy();
    const buf = await (task && typeof task.toPromise === "function" ? task.toPromise() : task);
    postPdf(buf);
  } catch (e) {
    state.saving = false;
    clearTimeout(state.saveWatchdog);
    setStatus("保存失败", "error");
    saveFailed(e);
  }
}

/** 等 registry 就绪（最多 ms 毫秒） */
function waitForRegistry(ms) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (state.registry || Date.now() - t0 > ms) return resolve(!!state.registry);
      setTimeout(tick, 100);
    };
    tick();
  });
}

function postPdf(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  // ⚠️ 结构化克隆会复制一份；PDF 大时内存会短暂翻倍，所以用完就把引用丢掉
  try {
    vscode.postMessage({ type: "savePdf", bytes });
  } catch (e) {
    state.saving = false;
    clearTimeout(state.saveWatchdog);
    setStatus("保存失败", "error");
    saveFailed(e);
  }
}

/** 保存失败：标题要写对（以前误用"打开这个 PDF 时出错了"） */
function saveFailed(e) {
  const text = String((e && (e.message || e)) || e);
  vscode.postMessage({ type: "log", text: "[pdf] 保存失败: " + text });
  showError("保存失败", text);
}

function onSaved(m) {
  state.saving = false;
  clearTimeout(state.saveWatchdog);
  if (m.ok) {
    hideError();
    state.dirty = false;
    state.lastSaved = Date.now();
    setStatus("已保存 " + new Date(state.lastSaved).toLocaleTimeString(), "saved");
    toast("已写回 PDF（写前的版本在「时间线」里，可回滚）");
  } else {
    setStatus("保存失败", "error");
    toast("保存失败：" + (m.error || ""), 5000);
    showError("保存失败", m.error || "");
  }
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
        if (state.saving) { toast("正在保存，请稍候…", 2000); return; }
        state.saving = true;
        clearTimeout(state.saveWatchdog);
        state.saveWatchdog = setTimeout(() => { state.saving = false; setStatus("保存超时", "error"); }, 15000);
        setStatus("保存中…", "saving");
        fetch(href).then((r) => r.arrayBuffer()).then((buf) => postPdf(buf)).catch((e) => {
          state.saving = false;
          clearTimeout(state.saveWatchdog);
          setStatus("保存失败", "error");
          saveFailed(e);
        });
        return;
      }
    } catch { /* 落到原生行为 */ }
    return origClick.call(this);
  };
}

// ---------------------------------------------------------------- 恢复前冲刷（flush）
// 为什么要 flush：批注在阅读器里是**未保存**状态时，宿主恢复快照会直接用旧字节覆盖文件，
// 用户手上这批批注就凭空没了。所以恢复前先让阅读器把当前批注写一遍（宿主会顺便留快照）。
function onFlush(m) {
  const id = m && m.id;
  if (!id) return;
  (async () => {
    try {
      // 正在保存就先等它落地，避免"导出两份、后写的赢"
      for (let i = 0; i < 50 && state.saving; i++) await new Promise((r) => setTimeout(r, 100));
      if (!state.registry) await waitForRegistry(2500);
      const plugin = state.registry && state.registry.getPlugin("export");
      const cap = plugin && typeof plugin.provides === "function" ? plugin.provides() : null;
      if (!cap || typeof cap.saveAsCopy !== "function") throw new Error("导出能力未就绪");
      const task = cap.saveAsCopy();
      const buf = await (task && typeof task.toPromise === "function" ? task.toPromise() : task);
      vscode.postMessage({ type: "flushSave", id, bytes: buf instanceof Uint8Array ? buf : new Uint8Array(buf) });
    } catch (e) {
      vscode.postMessage({ type: "flushSave", id, error: String((e && e.message) || e) });
    }
  })();
}

function onFlushDone(m) {
  if (m && m.ok) setStatus("已保存 " + new Date().toLocaleTimeString(), "saved");
}

// ---------------------------------------------------------------- 快捷键
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
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

function hideError() {
  const box = $("error");
  if (box) box.classList.remove("show");
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
