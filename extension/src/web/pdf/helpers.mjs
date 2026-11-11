// PDF 阅读器的纯计算部分（不碰 DOM、不碰 pdf.js，方便单测）。
//
// 坐标约定（全项目统一，别混）：
//   · **pt 坐标**：PDF 页面坐标，单位是 point（1/72 英寸），原点在页面左下角，
//     批注/OCR 结果一律用它存盘 —— 与屏幕缩放、旋转、DPR 全部解耦。
//   · **屏幕坐标**：CSS 像素，原点在页面元素左上角。
//   换算见 ptToCss / cssToPt（pdf.js 的 viewport 已经把旋转算进去了）。

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 6;

/** 缩放夹紧 + 保留两位小数 */
export function clampScale(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, n)) * 100) / 100;
}

/**
 * 计算"适应宽度 / 适应页面"的 scale。
 * @param {{pageWidth:number, pageHeight:number, boxWidth:number, boxHeight:number, mode:"width"|"page", padding?:number}} o
 *   pageWidth/pageHeight 是**未缩放**的 PDF 页面尺寸（pt）；box 是可视区尺寸（CSS px）。
 */
export function fitScale({ pageWidth, pageHeight, boxWidth, boxHeight, mode = "width", padding = 24 } = {}) {
  const w = Number(pageWidth) || 0, h = Number(pageHeight) || 0;
  const bw = Math.max(1, (Number(boxWidth) || 0) - padding * 2);
  const bh = Math.max(1, (Number(boxHeight) || 0) - padding * 2);
  if (w <= 0 || h <= 0) return 1;
  const sx = bw / w, sy = bh / h;
  return clampScale(mode === "page" ? Math.min(sx, sy) : sx);
}

/** 页码输入解析：支持 "3"、"3-5"、空 → 当前页；非法/越界一律夹到 1..total */
export function parsePageInput(input, total, current = 1) {
  const n = Number(total) || 0;
  if (n <= 0) return 1;
  const s = String(input == null ? "" : input).trim();
  if (!s) return clampPage(current, n);
  const m = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(s);
  if (!m) return clampPage(current, n);
  return clampPage(Number(m[1]), n);
}

export function clampPage(p, total) {
  const n = Math.max(1, Number(total) || 1);
  const v = Math.round(Number(p) || 1);
  return Math.min(n, Math.max(1, v));
}

/** 人类可读体积 */
export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v}B`;
  if (v < 1048576) return `${(v / 1024).toFixed(1)}KB`;
  return `${(v / 1048576).toFixed(1)}MB`;
}

/**
 * pt（PDF 页面坐标，原点左下）→ CSS 像素（页面元素坐标，原点左上）。
 * @param {{x:number,y:number}} pt
 * @param {{pageHeight:number, scale:number, rotation?:0|90|180|270}} vp
 */
export function ptToCss(pt, vp) {
  const s = Number(vp && vp.scale) || 1;
  const h = Number(vp && vp.pageHeight) || 0;
  const rot = ((Number(vp && vp.rotation) || 0) % 360 + 360) % 360;
  const x = Number(pt.x) || 0, y = Number(pt.y) || 0;
  if (rot === 90) return { x: y * s, y: x * s };
  if (rot === 180) return { x: (Number(vp.pageWidth) - x) * s, y: y * s };
  if (rot === 270) return { x: (h - y) * s, y: (Number(vp.pageWidth) - x) * s };
  return { x: x * s, y: (h - y) * s };      // 默认：y 轴翻转
}

/**
 * 把屏幕上的矩形（CSS px）换算回 pt 矩形。
 * ⚠️ 只支持 0°/90°… 也照实算：旋转时用 ptToCss 的逆变换即可，这里用"两角点再取 min/max"，
 *    对任意旋转都成立（矩形在旋转后仍是轴对齐矩形）。
 * @param {{x:number,y:number,w:number,h:number}} rect CSS px
 * @param {{pageWidth:number,pageHeight:number,scale:number,rotation?:number}} vp
 */
export function cssRectToPt(rect, vp) {
  const a = cssToPt({ x: rect.x, y: rect.y }, vp);
  const b = cssToPt({ x: rect.x + rect.w, y: rect.y + rect.h }, vp);
  return {
    x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y),
  };
}

/** CSS px → pt（ptToCss 的逆） */
export function cssToPt(pt, vp) {
  const s = Number(vp && vp.scale) || 1;
  const W = Number(vp && vp.pageWidth) || 0;
  const H = Number(vp && vp.pageHeight) || 0;
  const rot = ((Number(vp && vp.rotation) || 0) % 360 + 360) % 360;
  const x = Number(pt.x) || 0, y = Number(pt.y) || 0;
  if (rot === 90) return { x: y / s, y: x / s };
  if (rot === 180) return { x: W - x / s, y: y / s };
  if (rot === 270) return { x: W - y / s, y: H - x / s };
  return { x: x / s, y: H - y / s };
}

/** 两个 pt 矩形是否相交（批注命中测试用） */
export function rectsIntersect(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** 归一化拖拽出的矩形（拖左下→右上时 w/h 会是负数） */
export function normalizeRect(r) {
  return {
    x: Math.min(r.x, r.x + r.w), y: Math.min(r.y, r.y + r.h),
    w: Math.abs(r.w), h: Math.abs(r.h),
  };
}

/** 把搜索词切成小写子串（空词返回空数组） */
export function normalizeQuery(q) {
  return String(q == null ? "" : q).toLowerCase();
}

/**
 * 在一段文本里找所有命中的 [start,end)（大小写不敏感；不支持正则，避免用户输入炸）
 */
export function findAll(haystack, needle, limit = 500) {
  const h = String(haystack || "").toLowerCase();
  const n = normalizeQuery(needle);
  if (!n) return [];
  const out = [];
  let i = 0;
  while (out.length < limit) {
    const k = h.indexOf(n, i);
    if (k < 0) break;
    out.push([k, k + n.length]);
    i = k + Math.max(1, n.length);
  }
  return out;
}

/** 主题 → PDF 页面周围的背景色（页面本身保持白，避免颜色失真） */
export function themeBackdrop(kind) {
  switch (String(kind || "")) {
    case "light": return "#f3f3f3";
    case "high-contrast": return "#000000";
    case "high-contrast-light": return "#ffffff";
    default: return "#2b2b2b";
  }
}
