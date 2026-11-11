// PDF 阅读器的 webview 端（ESM，构建时原样拷到 assets/pdf/app/client.mjs）。
//
// 组成：
//   · 渲染：pdf.js（`pdf.mjs`）逐页 canvas，**虚拟化**（只渲染视野附近的页）
//   · 文字：pdf.js 的 TextLayer（选择/复制）+ 自建搜索（子串匹配 → 高亮矩形 → 跳转）
//   · 批注：高亮/下划线/删除线/便签/自由文本/矩形/箭头 —— DOM 叠加层
//   · 板书：手写/荧光笔/橡皮 —— 每页一张 canvas（压感、颜色、粗细）
//   · 侧栏：缩略图 + 大纲
//   · 存盘：改完防抖 POST 给宿主，写到 PDF 同目录的 `*.pdf.annotations.json`
//   · OCR：接口已预留（`ocr.mjs`），当前按钮显示"后续版本"，接了就能用
//
// 坐标：批注/搜索一律用 **pt**（PDF 页面坐标，原点左下），渲染时按 viewport 换算成 CSS px。
import {
  clampScale, fitScale, parsePageInput, clampPage, formatBytes,
  ptToCss, cssRectToPt, normalizeRect, findAll, themeBackdrop,
} from "./helpers.mjs";
import { AnnotStore, parseSidecar, serializeSidecar, newId } from "./annot.mjs";
import { createOcrEngine, OCR_NOT_READY, mergeOcrText } from "./ocr.mjs";

const A = window.__PDF_ASSETS || {};
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

const state = {
  PDF: null, doc: null, numPages: 0,
  scale: 1, scaleMode: "width", rotation: 0,
  page: 1,
  tool: "select", color: "#ffd54f", inkWidth: 2,
  annots: new AnnotStore([]), ocr: {},
  selected: null,
  pages: [],                   // [{ el, canvas, textLayer, dom, ink, rendered, page, w, h, size }]
  textIndex: new Map(),        // page -> { text, items: [{ str, rect }] }
  find: { q: "", hits: [], idx: -1 },
  dirty: false, saveTimer: null,
  fileName: "", uri: "",
  passwordTries: 0,
  ocrAvailable: false,
};

const ocr = createOcrEngine({
  log: (m) => log(m),
  onProgress: (p) => { /* 预留：进度条 */ },
});

// ---------------------------------------------------------------- 小工具
function log(msg) { try { vscode.postMessage({ type: "log", text: String(msg) }); } catch { } }
function toast(text, ms = 2200) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), ms);
}
function fmtPage() { return `${state.page} / ${state.numPages || "?"}`; }

// ---------------------------------------------------------------- 启动
boot().catch((e) => fatal(e));

/** 加载 ESM 库：先用 asWebviewUri 直连，失败再走 fetch+blob */
async function importLib(url) {
  try { return await import(url); }
  catch (e) {
    log("[pdf] 直连 import 失败，改用 blob：" + (e && e.message));
    const r = await fetch(url);
    if (!r.ok) throw new Error(`取不到 ${url}: HTTP ${r.status}`);
    const code = await r.text();
    const blobUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    return await import(blobUrl);
  }
}

async function boot() {
  applyTheme();
  window.addEventListener("message", onHostMessage);
  bindToolbar();
  bindKeys();
  vscode.postMessage({ type: "ready" });
}

function applyTheme() {
  const kind = document.body.classList.contains("vscode-light") ? "light"
    : document.body.classList.contains("vscode-high-contrast-light") ? "high-contrast-light"
      : document.body.classList.contains("vscode-high-contrast") ? "high-contrast" : "dark";
  document.documentElement.style.setProperty("--pdf-backdrop", themeBackdrop(kind));
  // 主题切换时 VS Code 会改 body 的类，MutationObserver 兜一下
  if (!applyTheme._ob) {
    applyTheme._ob = new MutationObserver(() => applyTheme());
    applyTheme._ob.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  }
}

async function onHostMessage(ev) {
  const m = ev.data || {};
  try {
    if (m.type === "load") return await onLoad(m);
    if (m.type === "saved") {
      if (m.ok) { state.dirty = false; setSaveState("已保存"); }
      else { setSaveState("保存失败：" + (m.error || "未知原因")); toast("批注保存失败：" + (m.error || "")); }
      return;
    }
    if (m.type === "password") { pendingPassword?.(m.value || null); return; }
    if (m.type === "passwordCancel") { pendingPassword?.(null); return; }
  } catch (e) { fatal(e); }
}

let pendingPassword = null;
function askPassword() {
  return new Promise((resolve) => {
    pendingPassword = (v) => { pendingPassword = null; resolve(v); };
    vscode.postMessage({ type: "needPassword", tries: state.passwordTries });
  });
}

async function onLoad({ bytes, name, uri, sidecar }) {
  state.fileName = name || "document.pdf";
  state.uri = uri || "";
  $("docName").textContent = state.fileName;
  $("docMeta").textContent = formatBytes(bytes.byteLength || bytes.length);
  setSaveState("载入中…");

  // 批注 sidecar
  if (sidecar && sidecar.text) {
    const parsed = parseSidecar(sidecar.text, state.fileName);
    state.annots = new AnnotStore(parsed.annotations);
    state.ocr = parsed.ocr || {};
    state.annots.onChange(() => { markDirty(); rerenderAnnotsOnAllPages(); });
    if (parsed.dirty) toast("批注文件的版本/文件名与当前 PDF 不一致，已尽量兼容载入");
    setSaveState(`${parsed.annotations.length} 条批注`);
  } else {
    state.annots.onChange(() => { markDirty(); rerenderAnnotsOnAllPages(); });
    setSaveState("无批注");
  }

  // 加载 pdf.js（ESM）并把 worker 变成 blob（跨源/自定义 scheme 下都能用）
  // ⚠️ 直连 import 可能被 CORS/自定义 scheme 拦（网页版资源走 vscode-resource 代理）。
  //    兜底：fetch 文本 → Blob URL → import（ESM 可以从 blob 加载）。
  state.PDF = await importLib(A.lib);
  const pdfjs = state.PDF;
  try {
    const wres = await fetch(A.worker);
    const code = await wres.text();
    const blobUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    pdfjs.GlobalWorkerOptions.workerSrc = blobUrl;
  } catch (e) {
    log("[pdf] worker 换成 blob 失败，退回直连：" + (e && e.message));
    pdfjs.GlobalWorkerOptions.workerSrc = A.worker;
  }

  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const loadingTask = pdfjs.getDocument({
    data,
    cMapUrl: A.cMapUrl, cMapPacked: true,
    standardFontDataUrl: A.standardFontDataUrl,
    wasmUrl: A.wasmUrl,
    iccUrl: A.iccUrl,
    isEvalSupported: false,       // 不执行 PDF 里的脚本
    enableXfa: false,
  });
  loadingTask.onPassword = async (updatePassword, reason) => {
    state.passwordTries++;
    const pw = await askPassword();
    if (pw == null) { loadingTask.destroy(); return; }
    updatePassword(pw);
  };
  state.doc = await loadingTask.promise;
  // ⚠️ pdfjs-dist v5 起删掉了 PDFDocumentProxy.getNumPages()（只剩 numPages 属性）。
  //    我们装的是 6.5.438，调用旧方法会 TypeError: state.doc.getNumPages is not a function
  //    → 打开 PDF 直接报错。这里做一次兼容取值。
  state.numPages = typeof state.doc.getNumPages === "function"
    ? state.doc.getNumPages()
    : state.doc.numPages;
  setSaveState("就绪");
  $("pageTotal").textContent = "/ " + state.numPages;

  await buildPages();
  await restoreViewState();
  observePages();
  buildOutline().catch(() => { });
  renderThumbs().catch(() => { });

  // OCR：接口已预留
  state.ocrAvailable = !!ocr.available;
  $("btnOcr").title = state.ocrAvailable ? "对扫描页做 OCR" : "OCR（后续版本提供，接口已预留）";
  $("btnOcr").classList.toggle("unsupported", !state.ocrAvailable);
}

// ---------------------------------------------------------------- 页面骨架
function ptSizeOf(pageProxy) {
  const vp = pageProxy.getViewport({ scale: 1, rotation: 0 });
  return { w: vp.width, h: vp.height };
}

async function buildPages() {
  const host = $("pages");
  host.innerHTML = "";
  state.pages = [];
  // 先用第 1 页的尺寸做占位；真实尺寸随后台任务补齐（避免 500 页时卡住）
  let first = { w: 595, h: 842 };
  try { first = ptSizeOf(await state.doc.getPage(1)); } catch { }
  const box = $("viewport").getBoundingClientRect();
  state.scale = fitScale({ pageWidth: first.w, pageHeight: first.h, boxWidth: box.width, boxHeight: box.height, mode: "width" });
  state.scaleMode = "width";

  for (let i = 1; i <= state.numPages; i++) {
    const el = document.createElement("div");
    el.className = "page";
    el.dataset.page = String(i);
    el.style.width = Math.round(first.w * state.scale) + "px";
    el.style.height = Math.round(first.h * state.scale) + "px";
    el.innerHTML =
      '<div class="pageInner">' +
      '<canvas class="pageCanvas"></canvas>' +
      '<div class="textLayer"></div>' +
      '<div class="annotLayer"></div>' +
      '<canvas class="inkCanvas"></canvas>' +
      '<div class="drawPreview"></div>' +
      "</div>" +
      '<div class="pageNo">' + i + "</div>";
    host.appendChild(el);
    const info = {
      el, page: null, rendered: false, rendering: false, size: { ...first },
      canvas: el.querySelector(".pageCanvas"),
      textLayer: el.querySelector(".textLayer"),
      dom: el.querySelector(".annotLayer"),
      ink: el.querySelector(".inkCanvas"),
      preview: el.querySelector(".drawPreview"),
    };
    info.innerWidth = first.w; info.innerHeight = first.h;
    state.pages.push(info);
    bindPagePointer(info);
  }

  // 后台补真实尺寸（并发 6），尺寸不同的页要更新占位与已渲染内容
  const jobs = [];
  for (let i = 2; i <= state.numPages; i++) jobs.push(i);
  const worker = async () => {
    while (jobs.length) {
      const i = jobs.shift();
      try {
        const p = await state.doc.getPage(i);
        const s = ptSizeOf(p);
        const info = state.pages[i - 1];
        if (Math.abs(s.w - info.size.w) > 0.5 || Math.abs(s.h - info.size.h) > 0.5) {
          info.size = s;
          layoutPage(info);
        }
      } catch { }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
}

function layoutPage(info) {
  const w = Math.round(info.size.w * state.scale);
  const h = Math.round(info.size.h * state.scale);
  info.el.style.width = w + "px";
  info.el.style.height = h + "px";
  if (info.rendered) renderPage(info).catch(() => { });
}

async function renderPage(info) {
  if (info.rendering) return;
  info.rendering = true;
  try {
    const page = info.page || (info.page = await state.doc.getPage(Number(info.el.dataset.page)));
    const vp = page.getViewport({ scale: state.scale, rotation: state.rotation });
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const cv = info.canvas;
    cv.width = Math.round(vp.width * dpr);
    cv.height = Math.round(vp.height * dpr);
    cv.style.width = Math.round(vp.width) + "px";
    cv.style.height = Math.round(vp.height) + "px";
    const ctx = cv.getContext("2d", { alpha: false });
    await page.render({ canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;

    // 文本层（选择/复制）
    const tl = info.textLayer;
    tl.innerHTML = "";
    tl.style.setProperty("--scale-factor", String(vp.scale));
    tl.style.width = Math.round(vp.width) + "px";
    tl.style.height = Math.round(vp.height) + "px";
    const TextLayer = state.PDF.TextLayer;
    if (TextLayer) {
      const layer = new TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: vp });
      await layer.render();
    }

    // 板书画布按视口重设（矢量重绘，不是位图缩放）
    const ink = info.ink;
    ink.width = Math.round(vp.width * dpr);
    ink.height = Math.round(vp.height * dpr);
    ink.style.width = Math.round(vp.width) + "px";
    ink.style.height = Math.round(vp.height) + "px";

    info.rendered = true;
    info.vp = vp;
    info.pt = { pageWidth: info.size.w, pageHeight: info.size.h, scale: state.scale, rotation: state.rotation };
    applyPointerMode(info);
    renderAnnots(info);
    renderFindHits(info);
  } finally {
    info.rendering = false;
  }
}

/** 释放离屏页的位图（虚拟化，避免几百页把内存吃光） */
function unloadPage(info) {
  if (!info.rendered) return;
  info.canvas.width = info.canvas.width;   // 保留尺寸会占内存 → 直接置 1
  info.canvas.width = 1; info.canvas.height = 1;
  info.textLayer.innerHTML = "";
  info.ink.width = 1; info.ink.height = 1;
  info.dom.innerHTML = "";
  info.rendered = false;
  info.page = null;
}

let io = null;
function observePages() {
  if (io) io.disconnect();
  io = new IntersectionObserver((entries) => {
    for (const ent of entries) {
      const info = state.pages[Number(ent.target.dataset.page) - 1];
      if (!info) continue;
      if (ent.isIntersecting) {
        if (!info.rendered) renderPage(info).catch(() => { });
      } else if (Math.abs(Number(ent.target.dataset.page) - state.page) > 6) {
        unloadPage(info);
      }
    }
  }, { root: $("viewport"), rootMargin: "150% 0px" });
  for (const info of state.pages) io.observe(info.el);
}

/** 当前页（滚动时更新） */
let scrollRaf = 0;
$("viewport").addEventListener("scroll", () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    const vt = $("viewport");
    const mid = vt.getBoundingClientRect().top + vt.clientHeight * 0.35;
    let best = state.page;
    for (const info of state.pages) {
      const r = info.el.getBoundingClientRect();
      if (r.top <= mid && r.bottom >= mid) { best = Number(info.el.dataset.page); break; }
      if (r.top > mid) { best = Number(info.el.dataset.page); break; }
    }
    if (best !== state.page) { state.page = best; syncToolbar(); }
    saveViewState();
  });
}, { passive: true });

// ---------------------------------------------------------------- 缩放 / 旋转 / 跳页
function setScale(next, mode = "custom") {
  const s = clampScale(next);
  if (Math.abs(s - state.scale) < 0.005) return;
  // 以视野中心为锚点，缩放后仍看同一处
  const vt = $("viewport");
  const r = vt.getBoundingClientRect();
  const anchorY = (r.top + r.height / 2 + vt.scrollTop) / state.scale;
  state.scale = s; state.scaleMode = mode;
  for (const info of state.pages) { layoutPage(info); if (info.rendered) renderPage(info).catch(() => { }); }
  vt.scrollTop = anchorY * s - r.height / 2;
  syncToolbar(); saveViewState();
}

function fitTo(mode) {
  const info = state.pages[state.page - 1] || state.pages[0];
  if (!info) return;
  const box = $("viewport").getBoundingClientRect();
  setScale(fitScale({ pageWidth: info.size.w, pageHeight: info.size.h, boxWidth: box.width, boxHeight: box.height, mode }), mode);
}

function gotoPage(p, smooth = true) {
  const n = clampPage(p, state.numPages);
  const info = state.pages[n - 1];
  if (!info) return;
  info.el.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
  state.page = n; syncToolbar(); saveViewState();
}

function rotate(delta) {
  state.rotation = ((state.rotation + delta) % 360 + 360) % 360;
  for (const info of state.pages) { layoutPage(info); if (info.rendered) renderPage(info).catch(() => { }); }
  syncToolbar();
}

// ---------------------------------------------------------------- 批注渲染
function ptRectToCss(r, pt) { return ptToCss({ x: r.x, y: r.y + r.h }, pt); }   // 左下角 → 左上角

function renderAnnots(info) {
  const dom = info.dom;
  dom.innerHTML = "";
  if (!info.rendered) return;
  const pt = info.pt;
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  const inkCtx = info.ink.getContext("2d");
  inkCtx.setTransform(1, 0, 0, 1, 0, 0);
  inkCtx.clearRect(0, 0, info.ink.width, info.ink.height);
  inkCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  for (const a of state.annots.forPage(Number(info.el.dataset.page))) {
    if (a.type === "ink") {
      drawInk(inkCtx, a, pt);
      continue;
    }
    const wrap = document.createElement("div");
    wrap.className = "annot " + a.type + (state.selected === a.id ? " sel" : "");
    wrap.dataset.id = a.id;
    wrap.style.setProperty("--c", a.color);
    wrap.style.setProperty("--o", String(a.opacity));
    for (const r of a.rects) {
      const p = ptRectToCss(r, pt);
      const w = Math.max(1, r.w * pt.scale), h = Math.max(1, r.h * pt.scale);
      if (a.type === "highlight") {
        const d = document.createElement("div");
        d.className = "hl"; d.style.left = p.x + "px"; d.style.top = p.y + "px";
        d.style.width = w + "px"; d.style.height = h + "px";
        wrap.appendChild(d);
      } else if (a.type === "underline" || a.type === "strike") {
        const d = document.createElement("div");
        d.className = "line";
        d.style.left = p.x + "px"; d.style.top = (a.type === "underline" ? p.y + h - 2 : p.y + h / 2) + "px";
        d.style.width = w + "px";
        wrap.appendChild(d);
      } else if (a.type === "rect") {
        const d = document.createElement("div");
        d.className = "box";
        d.style.left = p.x + "px"; d.style.top = p.y + "px";
        d.style.width = w + "px"; d.style.height = h + "px";
        wrap.appendChild(d);
      } else if (a.type === "arrow") {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("class", "arrow");
        svg.setAttribute("width", w); svg.setAttribute("height", h);
        svg.style.left = p.x + "px"; svg.style.top = p.y + "px";
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", 0); line.setAttribute("y1", 0);
        line.setAttribute("x2", w); line.setAttribute("y2", h);
        svg.appendChild(line);
        wrap.appendChild(svg);
      } else if (a.type === "note") {
        const d = document.createElement("div");
        d.className = "note";
        d.style.left = p.x + "px"; d.style.top = p.y + "px";
        d.title = a.text || "（空便签）";
        d.textContent = "📝";
        wrap.appendChild(d);
      } else if (a.type === "freetext") {
        const d = document.createElement("div");
        d.className = "free";
        d.style.left = p.x + "px"; d.style.top = p.y + "px";
        d.style.width = Math.max(40, w) + "px";
        d.style.fontSize = Math.max(9, Math.min(36, (r.h || 12) * pt.scale)) + "px";
        d.textContent = a.text || "";
        wrap.appendChild(d);
      }
    }
    dom.appendChild(wrap);
  }
}

function drawInk(ctx, a, pt) {
  const s = pt.scale;
  ctx.save();
  ctx.strokeStyle = a.color;
  ctx.globalAlpha = a.type === "ink" ? Math.max(0.25, a.opacity) : 1;
  ctx.lineWidth = Math.max(0.5, (a.ink.width || 2) * s);
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  for (const stroke of a.ink.strokes) {
    ctx.beginPath();
    stroke.points.forEach((p, i) => {
      const c = ptToCss({ x: p[0], y: p[1] }, pt);
      if (i === 0) ctx.moveTo(c.x, c.y); else ctx.lineTo(c.x, c.y);
    });
    ctx.stroke();
  }
  ctx.restore();
}

function rerenderAnnotsOnAllPages() {
  for (const info of state.pages) if (info.rendered) renderAnnots(info);
}

// ---------------------------------------------------------------- 批注交互
function pageInfoFromEvent(ev) {
  const el = ev.target.closest && ev.target.closest(".page");
  if (!el) return null;
  const info = state.pages[Number(el.dataset.page) - 1];
  return info && info.rendered ? info : null;
}

function evToPt(ev, info) {
  const r = info.el.getBoundingClientRect();
  const css = { x: ev.clientX - r.left, y: ev.clientY - r.top };
  const a = cssToPtHelper(css, info.pt);
  return { x: a.x, y: a.y, css };
}

// helpers.mjs 的 cssToPt 需要 pageWidth/pageHeight，这里补一层
function cssToPtHelper(css, pt) {
  // 直接用 helpers 的逆变换：借助 ptToCss 二分不划算，这里按同一套公式反解
  const { scale, rotation, pageWidth, pageHeight } = pt;
  const x = css.x / scale, y = css.y / scale;
  const H = pageHeight, W = pageWidth;
  if (rotation === 90) return { x: y, y: x };
  if (rotation === 180) return { x: W - x, y: y };
  if (rotation === 270) return { x: W - y, y: H - x };
  return { x, y: H - y };
}

function bindPagePointer(info) {
  const layer = info.dom;
  const down = (ev) => {
    if (ev.button !== 0) return;
    const tool = state.tool;
    const info2 = pageInfoFromEvent(ev);
    if (!info2) return;
    if (tool === "select") return;                 // 交给文本层做选择
    const start = evToPt(ev, info2);
    if (tool === "eraser") {
      const hit = state.annots.hitTest(Number(info2.el.dataset.page), start);
      if (hit) { state.annots.remove(hit.id); toast("已删除一条批注"); }
      return;
    }
    if (tool === "note") {
      const a = state.annots.add({
        page: Number(info2.el.dataset.page), type: "note", color: state.color,
        rects: [{ x: start.x, y: start.y - 12, w: 24, h: 24 }], text: "",
      });
      if (a) editText(a, info2, start);
      return;
    }
    if (tool === "freetext") {
      const a = state.annots.add({
        page: Number(info2.el.dataset.page), type: "freetext", color: state.color, opacity: 1,
        rects: [{ x: start.x, y: start.y - 14, w: 160, h: 16 }], text: "",
      });
      if (a) editText(a, info2, start);
      return;
    }
    if (tool === "pen" || tool === "marker") {
      drawStroke(info2, tool, ev);
      return;
    }
    // 矩形类：拖拽
    ev.preventDefault();
    layer.setPointerCapture?.(ev.pointerId);
    const preview = info2.preview;
    preview.style.display = "block";
    const move = (e2) => {
      const cur = evToPt(e2, info2);
      const r = normalizeRect({ x: start.css.x, y: start.css.y, w: cur.css.x - start.css.x, h: cur.css.y - start.css.y });
      preview.style.left = r.x + "px"; preview.style.top = r.y + "px";
      preview.style.width = r.w + "px"; preview.style.height = r.h + "px";
    };
    const up = (e2) => {
      layer.removeEventListener("pointermove", move);
      layer.removeEventListener("pointerup", up);
      preview.style.display = "none";
      const cur = evToPt(e2, info2);
      const cssRect = normalizeRect({ x: start.css.x, y: start.css.y, w: cur.css.x - start.css.x, h: cur.css.y - start.css.y });
      if (cssRect.w < 3 && cssRect.h < 3) return;         // 误点
      const ptRect = cssRectToPt(cssRect, info2.pt);
      let rects = [ptRect];
      if (["highlight", "underline", "strike"].includes(tool)) {
        const lines = textRectsIn(info2, ptRect);
        if (lines.length) rects = lines;
      }
      state.annots.add({
        page: Number(info2.el.dataset.page), type: tool, color: state.color,
        opacity: tool === "highlight" ? 0.35 : 1, rects,
      });
      setTool("select");
    };
    layer.addEventListener("pointermove", move);
    layer.addEventListener("pointerup", up);
  };
  layer.addEventListener("pointerdown", down);

  // 选中/删除/双击编辑（选择模式下）
  layer.addEventListener("click", (ev) => {
    if (state.tool !== "select") return;
    const wrap = ev.target.closest(".annot");
    state.selected = wrap ? wrap.dataset.id : null;
    rerenderAnnots(info);
  });
  layer.addEventListener("dblclick", (ev) => {
    if (state.tool !== "select") return;
    const wrap = ev.target.closest(".annot");
    if (!wrap) return;
    const a = state.annots.get(wrap.dataset.id);
    if (a && (a.type === "note" || a.type === "freetext")) editText(a, info, evToPt(ev, info));
  });
}

/** 拖拽出来的矩形里，把命中的文字行转成若干条矩形（高亮更贴字） */
function textRectsIn(info, ptRect) {
  const idx = state.textIndex.get(Number(info.el.dataset.page));
  const out = [];
  const src = idx ? idx.items : [];
  for (const it of src) {
    const r = it.rect;
    if (r.x < ptRect.x + ptRect.w && ptRect.x < r.x + r.w && r.y < ptRect.y + ptRect.h && ptRect.y < r.y + r.h) {
      out.push({ x: r.x, y: r.y, w: r.w, h: r.h });
    }
  }
  return out;
}

function drawStroke(info, tool, ev) {
  const pageNo = Number(info.el.dataset.page);
  const pts = [];
  info.dom.setPointerCapture?.(ev.pointerId);
  ev.preventDefault();
  const collect = (e2) => {
    const p = evToPt(e2, info);
    const pressure = e2.pressure && e2.pressure > 0 ? e2.pressure : 0.5;
    pts.push([p.x, p.y, pressure]);
    // 实时预览：直接画在 ink canvas 上（提交时整体重绘）
    const ctx = info.ink.getContext("2d");
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = state.color;
    ctx.globalAlpha = tool === "marker" ? 0.35 : 1;
    ctx.lineWidth = state.inkWidth;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (pts.length >= 2) {
      const a = ptToCss({ x: pts[pts.length - 2][0], y: pts[pts.length - 2][1] }, info.pt);
      const b = ptToCss({ x: p.x, y: p.y }, info.pt);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
  };
  const up = () => {
    info.dom.removeEventListener("pointermove", collect);
    info.dom.removeEventListener("pointerup", up);
    if (pts.length < 2) return;
    state.annots.add({
      page: pageNo, type: "ink",
      color: state.color,
      opacity: tool === "marker" ? 0.35 : 1,
      ink: { width: state.inkWidth, strokes: [{ points: pts.map(([x, y]) => [x, y]) }] },
      rects: [],
    });
    renderAnnots(info);
  };
  info.dom.addEventListener("pointermove", collect);
  info.dom.addEventListener("pointerup", up);
}

/** 便签/自由文本的编辑框（webview 里 window.prompt 被 sandbox 禁用） */
function editText(a, info, at) {
  const box = $("editor");
  box.classList.add("show");
  const ta = $("editorText");
  ta.value = a.text || "";
  const r = info.el.getBoundingClientRect();
  box.style.left = Math.min(window.innerWidth - 300, Math.max(8, r.left + (at ? at.css.x : 20))) + "px";
  box.style.top = Math.max(8, Math.min(window.innerHeight - 160, r.top + (at ? at.css.y : 20))) + "px";
  ta.focus();
  const done = (save) => {
    box.classList.remove("show");
    ta.onkeydown = null; $("editorOk").onclick = null; $("editorCancel").onclick = null;
    if (save) state.annots.update(a.id, { text: ta.value });
    else if (!String(ta.value || "").trim()) state.annots.remove(a.id);
  };
  ta.onkeydown = (e) => {
    if (e.key === "Escape") done(false);
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) done(true);
  };
  $("editorOk").onclick = () => done(true);
  $("editorCancel").onclick = () => done(false);
}

// ---------------------------------------------------------------- 搜索
async function ensureTextIndex(pageNo) {
  if (state.textIndex.has(pageNo)) return state.textIndex.get(pageNo);
  const info = state.pages[pageNo - 1];
  let items = [];
  try {
    const page = info.page || await state.doc.getPage(pageNo);
    const tc = await page.getTextContent();
    items = tc.items
      .filter((it) => typeof it.str === "string" && it.str.length)
      .map((it) => {
        const tr = it.transform || [1, 0, 0, 1, 0, 0];
        // transform: [a,b,c,d,e,f]，e/f 是文字基线位置（pt，原点左下）
        const h = Math.max(6, it.height || Math.hypot(tr[2], tr[3]) || 10);
        const w = Math.max(1, it.width || 0);
        return { str: it.str, eol: !!it.hasEOL, rect: { x: tr[4], y: tr[5] - h * 0.25, w, h } };
      });
  } catch (e) { log("[pdf] 取文字失败 p" + pageNo + ": " + (e && e.message)); }
  // 拼整页文本，并记录每个字符对应的 item 下标（高亮用）
  let text = "";
  const spans = [];     // [{start,end,rect}]
  for (const it of items) {
    const start = text.length;
    text += it.str;
    spans.push({ start, end: text.length, rect: it.rect });
    if (it.eol) text += "\n"; else text += " ";
  }
  const rec = { text, items, spans };
  state.textIndex.set(pageNo, rec);
  return rec;
}

async function runSearch(q) {
  state.find.q = q;
  state.find.hits = [];
  state.find.idx = -1;
  clearFindHits();
  if (!q.trim() || !state.doc) { syncFindBar(); return; }
  for (let p = 1; p <= state.numPages; p++) {
    const rec = await ensureTextIndex(p);
    const found = findAll(rec.text, q);
    for (const [s, e] of found) {
      const rects = [];
      for (const sp of rec.spans) {
        if (sp.end <= s || sp.start >= e) continue;
        // 命中落在该 item 里：按比例切矩形（近似，够用）
        const l = Math.max(0, s - sp.start) / Math.max(1, sp.end - sp.start);
        const r2 = Math.max(0, e - sp.start) / Math.max(1, sp.end - sp.start);
        rects.push({
          x: sp.rect.x + sp.rect.w * l, y: sp.rect.y,
          w: Math.max(1, sp.rect.w * (Math.min(1, r2) - l)), h: sp.rect.h,
        });
      }
      state.find.hits.push({ page: p, rects });
      if (state.find.hits.length >= 500) break;
    }
    if (state.find.hits.length >= 500) break;
  }
  syncFindBar();
  if (state.find.hits.length) { state.find.idx = 0; focusHit(0); }
}

function focusHit(i) {
  const h = state.find.hits[i];
  if (!h) return;
  state.find.idx = i;
  gotoPage(h.page);
  // 高亮在所有已渲染页上刷新
  for (const info of state.pages) if (info.rendered) renderFindHits(info);
  syncFindBar();
}

function nextHit(dir) {
  const n = state.find.hits.length;
  if (!n) return;
  const i = ((state.find.idx + dir) % n + n) % n;
  focusHit(i);
}

function clearFindHits() { for (const info of state.pages) if (info.rendered) renderFindHits(info); }

function renderFindHits(info) {
  const layer = info.dom;
  for (const el of [...layer.querySelectorAll(".findHit")]) el.remove();
  if (!state.find.q) return;
  const pageNo = Number(info.el.dataset.page);
  const hits = state.find.hits.filter((h) => h.page === pageNo);
  hits.forEach((h) => {
    const isCur = state.find.hits[state.find.idx] === h;
    for (const r of h.rects) {
      const p = ptRectToCss(r, info.pt);
      const d = document.createElement("div");
      d.className = "findHit" + (isCur ? " cur" : "");
      d.style.left = p.x + "px"; d.style.top = p.y + "px";
      d.style.width = Math.max(2, r.w * info.pt.scale) + "px";
      d.style.height = Math.max(2, r.h * info.pt.scale) + "px";
      layer.appendChild(d);
    }
  });
}

// ---------------------------------------------------------------- 侧栏
async function renderThumbs() {
  const box = $("thumbs");
  box.innerHTML = "";
  const scale = 0.18;
  for (let i = 1; i <= state.numPages; i++) {
    const d = document.createElement("div");
    d.className = "thumb";
    d.dataset.page = String(i);
    d.innerHTML = '<div class="thumbBox"></div><div class="thumbNo">' + i + "</div>";
    d.addEventListener("click", () => gotoPage(i));
    box.appendChild(d);
  }
  // 懒渲染：进入可视区才画
  const tio = new IntersectionObserver(async (entries) => {
    for (const ent of entries) {
      if (!ent.isIntersecting) continue;
      const d = ent.target;
      if (d.dataset.done) continue;
      d.dataset.done = "1";
      const p = Number(d.dataset.page);
      try {
        const page = await state.doc.getPage(p);
        const vp = page.getViewport({ scale });
        const cv = document.createElement("canvas");
        cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
        await page.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
        d.querySelector(".thumbBox").appendChild(cv);
      } catch { }
    }
  }, { root: box, rootMargin: "200px" });
  for (const el of box.children) tio.observe(el);
}

async function buildOutline() {
  const box = $("outline");
  box.innerHTML = "";
  const outline = await state.doc.getOutline();
  if (!outline || !outline.length) { box.innerHTML = '<p class="hint">这个 PDF 没有大纲</p>'; return; }
  const render = (items, depth) => {
    for (const it of items) {
      const d = document.createElement("div");
      d.className = "outlineItem";
      d.style.paddingLeft = 8 + depth * 12 + "px";
      d.textContent = it.title || "(无标题)";
      d.title = it.title || "";
      d.addEventListener("click", async () => {
        try {
          let dest = it.dest;
          if (typeof dest === "string") dest = await state.doc.getDestination(dest);
          if (Array.isArray(dest) && dest.length) {
            const idx = await state.doc.getPageIndex(dest[0]);
            gotoPage(idx + 1);
          }
        } catch (e) { log("[pdf] 大纲跳转失败: " + (e && e.message)); }
      });
      box.appendChild(d);
      if (it.items && it.items.length) render(it.items, depth + 1);
    }
  };
  render(outline, 0);
}

function setSidebar(which) {
  state.sidebar = which;
  $("thumbs").classList.toggle("show", which === "thumbs");
  $("outline").classList.toggle("show", which === "outline");
  $("sidebar").classList.toggle("open", !!which);
  $("btnThumbs").classList.toggle("on", which === "thumbs");
  $("btnOutline").classList.toggle("on", which === "outline");
}

// ---------------------------------------------------------------- 工具栏
/** 选择模式：文本层收事件（选字）；画图模式：批注层收事件（文本层让位） */
function applyPointerMode(info) {
  const select = state.tool === "select";
  if (info.textLayer) info.textLayer.style.pointerEvents = select ? "auto" : "none";
  if (info.dom) info.dom.style.pointerEvents = select ? "none" : "auto";
}

function setTool(tool) {
  state.tool = tool;
  for (const b of document.querySelectorAll(".toolBtn")) b.classList.toggle("on", b.dataset.tool === tool);
  document.body.classList.toggle("drawing", tool !== "select");
  for (const info of state.pages) if (info.rendered) applyPointerMode(info);
}

function syncToolbar() {
  $("pageInput").value = String(state.page);
  $("pageTotal").textContent = "/ " + state.numPages;
  $("zoomValue").textContent = Math.round(state.scale * 100) + "%";
  $("btnUndo").disabled = !state.annots.canUndo;
  $("btnRedo").disabled = !state.annots.canRedo;
}

function syncFindBar() {
  const n = state.find.hits.length;
  $("findCount").textContent = state.find.q ? (n ? `${state.find.idx + 1}/${n}` : "无结果") : "";
}

function setSaveState(t) { $("saveState").textContent = t; }

function markDirty() {
  state.dirty = true;
  setSaveState("未保存…");
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveNow, 600);
}

function saveNow() {
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  if (!state.dirty) return;
  try {
    vscode.postMessage({
      type: "save",
      json: serializeSidecar(state.annots.all(), state.fileName, state.ocr),
    });
    setSaveState("保存中…");
  } catch (e) { setSaveState("保存失败"); log("[pdf] 序列化失败: " + (e && e.message)); }
}

function bindToolbar() {
  $("btnThumbs").onclick = () => setSidebar(state.sidebar === "thumbs" ? null : "thumbs");
  $("btnOutline").onclick = () => setSidebar(state.sidebar === "outline" ? null : "outline");
  $("btnPrev").onclick = () => gotoPage(state.page - 1);
  $("btnNext").onclick = () => gotoPage(state.page + 1);
  $("pageInput").addEventListener("change", () => gotoPage(parsePageInput($("pageInput").value, state.numPages, state.page)));
  $("btnZoomOut").onclick = () => setScale(state.scale / 1.2);
  $("btnZoomIn").onclick = () => setScale(state.scale * 1.2);
  $("btnFitWidth").onclick = () => fitTo("width");
  $("btnFitPage").onclick = () => fitTo("page");
  $("btnRotate").onclick = () => rotate(90);
  for (const b of document.querySelectorAll(".toolBtn")) b.onclick = () => setTool(b.dataset.tool);
  $("color").oninput = (e) => { state.color = e.target.value; };
  $("inkWidth").oninput = (e) => { state.inkWidth = Number(e.target.value) || 2; };
  $("btnUndo").onclick = () => state.annots.undo();
  $("btnRedo").onclick = () => state.annots.redo();
  $("btnSave").onclick = () => { state.dirty = true; saveNow(); };
  $("btnOcr").onclick = async () => {
    if (!state.ocrAvailable) { toast(OCR_NOT_READY, 3200); return; }
    toast("OCR 已接入（此处应出现识别流程）");
  };
  $("findInput").addEventListener("input", (e) => { clearTimeout(bindToolbar._t); bindToolbar._t = setTimeout(() => runSearch(e.target.value), 250); });
  $("findInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); nextHit(e.shiftKey ? -1 : 1); }
    if (e.key === "Escape") { $("findBar").classList.remove("show"); runSearch(""); }
  });
  $("findNext").onclick = () => nextHit(1);
  $("findPrev").onclick = () => nextHit(-1);
  $("findClose").onclick = () => { $("findBar").classList.remove("show"); runSearch(""); };
  setTool("select");
  syncToolbar();
  setSidebar("thumbs");
  $("viewport").style.background = "var(--pdf-backdrop)";
}

function bindKeys() {
  window.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    const typing = /^(INPUT|TEXTAREA)$/.test(tag);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault(); $("findBar").classList.add("show"); $("findInput").focus(); $("findInput").select(); return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); state.dirty = true; saveNow(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); state.annots.undo(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) { e.preventDefault(); state.annots.redo(); return; }
    if (e.key === "F3") { e.preventDefault(); nextHit(e.shiftKey ? -1 : 1); return; }
    if (typing) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === "=" || e.key === "+")) { e.preventDefault(); setScale(state.scale * 1.2); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === "-") { e.preventDefault(); setScale(state.scale / 1.2); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === "0") { e.preventDefault(); setScale(1); return; }
    if (e.key === "PageDown" || (e.key === " " && !e.shiftKey)) { /* 交给浏览器原生滚动 */ }
    if (e.key === "Delete" || e.key === "Backspace") {
      if (state.selected) { e.preventDefault(); state.annots.remove(state.selected); state.selected = null; }
      return;
    }
    if (e.key === "Escape") { setTool("select"); state.selected = null; rerenderAnnotsOnAllPages(); }
  });
}

// ---------------------------------------------------------------- 视图状态
function saveViewState() {
  try { vscode.setState({ scale: state.scale, scaleMode: state.scaleMode, page: state.page, rotation: state.rotation, sidebar: state.sidebar }); } catch { }
}
async function restoreViewState() {
  let s = null;
  try { s = vscode.getState(); } catch { }
  if (s && s.rotation) { state.rotation = s.rotation; rotate(0); }
  if (s && s.sidebar !== undefined) setSidebar(s.sidebar);
  if (s && s.page) gotoPage(s.page, false);
  syncToolbar();
}

// ---------------------------------------------------------------- 错误
function fatal(e) {
  const text = String((e && (e.message || e)) || e);
  log("[pdf] 失败: " + text);
  const box = $("error");
  $("errorText").textContent = text;
  box.classList.add("show");
  setSaveState("出错");
}
$("errorClose").onclick = () => $("error").classList.remove("show");
$("errorOpen").onclick = () => vscode.postMessage({ type: "openExternal" });
window.addEventListener("unhandledrejection", (e) => {
  const t = String((e && e.reason && (e.reason.message || e.reason)) || "");
  if (!/PasswordException/.test(t)) log("[pdf] 未处理异常: " + t);
});
