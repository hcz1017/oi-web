// 批注 / 板书的模型层：增删改 + 撤销重做 + sidecar 序列化。
//
// 纯逻辑（不碰 DOM），由 client.mjs 和测试共同使用。
//
// 存盘格式（sidecar：与 PDF 同目录的 xxx.pdf.annotations.json）：
//   { version: 1, pdf: "xxx.pdf", updatedAt: "...", annotations: [...] }
// 坐标一律 **pt**（PDF 页面坐标，原点左下），见 helpers.mjs 里的说明。

export const SIDECAR_VERSION = 1;
export const ANNOT_TYPES = ["highlight", "underline", "strike", "note", "freetext", "rect", "arrow", "ink"];

let seq = 0;
export function newId() {
  seq = (seq + 1) % 1e6;
  return `a${Date.now().toString(36)}${seq.toString(36)}`;
}

/** 一条批注的形状（多余字段丢弃，缺的补默认） */
export function normalizeAnnotation(a) {
  if (!a || typeof a !== "object") return null;
  const type = ANNOT_TYPES.includes(a.type) ? a.type : null;
  if (!type) return null;
  const page = Math.max(1, Math.round(Number(a.page) || 1));
  const out = {
    id: typeof a.id === "string" && a.id ? a.id : newId(),
    page, type,
    color: typeof a.color === "string" && a.color ? a.color : "#ffd54f",
    opacity: Number.isFinite(Number(a.opacity)) ? Math.min(1, Math.max(0.05, Number(a.opacity))) : 0.35,
    createdAt: Number(a.createdAt) || Date.now(),
  };
  if (Array.isArray(a.rects)) {
    out.rects = a.rects
      .filter((r) => r && Number.isFinite(Number(r.x)) && Number.isFinite(Number(r.y)))
      .map((r) => ({ x: +r.x, y: +r.y, w: Math.max(0, +r.w || 0), h: Math.max(0, +r.h || 0) }));
  } else if (a.rect) {
    const r = a.rect;
    out.rects = [{ x: +r.x || 0, y: +r.y || 0, w: Math.max(0, +r.w || 0), h: Math.max(0, +r.h || 0) }];
  } else out.rects = [];
  if (typeof a.text === "string") out.text = a.text;
  if (type === "ink") {
    const ink = a.ink || {};
    const strokes = Array.isArray(ink.strokes) ? ink.strokes : [];
    out.ink = {
      width: Number.isFinite(Number(ink.width)) ? Math.max(0.5, Math.min(24, Number(ink.width))) : 2,
      strokes: strokes
        .map((s) => ({
          // 点压缩：每点 [x,y]，都四舍五入到 0.01pt，sidecar 体积能小一个数量级
          points: (Array.isArray(s && s.points) ? s.points : [])
            .filter((p) => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
            .map((p) => [Math.round(Number(p[0]) * 100) / 100, Math.round(Number(p[1]) * 100) / 100]),
        }))
        .filter((s) => s.points.length > 0),
    };
  }
  return out;
}

/** 解析 sidecar JSON（坏数据一律丢掉，不抛） */
export function parseSidecar(text, expectedName) {
  let raw = null;
  try { raw = typeof text === "string" ? JSON.parse(text) : text; } catch { return { version: SIDECAR_VERSION, annotations: [], ocr: {}, dirty: false }; }
  if (!raw || typeof raw !== "object") return { version: SIDECAR_VERSION, annotations: [], ocr: {}, dirty: false };
  const list = Array.isArray(raw.annotations) ? raw.annotations : [];
  const annotations = list.map(normalizeAnnotation).filter(Boolean);
  return {
    version: SIDECAR_VERSION,
    pdf: typeof raw.pdf === "string" ? raw.pdf : (expectedName || ""),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    annotations,
    // 🔌 OCR 结果预留位：将来 { "3": {lang, text, words} }，现在原样透传，保证不被批注保存覆盖
    ocr: raw.ocr && typeof raw.ocr === "object" && !Array.isArray(raw.ocr) ? raw.ocr : {},
    // 版本不符或 pdf 名对不上 → 让上层提示"可能是别的文件的批注"
    dirty: Number(raw.version) !== SIDECAR_VERSION || (!!expectedName && !!raw.pdf && raw.pdf !== expectedName),
  };
}

/**
 * 生成 sidecar 文本。
 * @param {Array} annotations
 * @param {string} pdfName
 * @param {object} [ocr]  OCR 结果（预留）：{ "3": {lang,text,words} }，原样写回
 */
export function serializeSidecar(annotations, pdfName, ocr = {}) {
  return JSON.stringify({
    version: SIDECAR_VERSION,
    pdf: String(pdfName || ""),
    updatedAt: new Date().toISOString(),
    annotations: (annotations || []).map(normalizeAnnotation).filter(Boolean),
    ocr: ocr && typeof ocr === "object" && !Array.isArray(ocr) ? ocr : {},
  }, null, 2) + "\n";
}

/**
 * 批注仓库：按页索引 + 撤销重做。
 * 所有改动都走这里，方便统一触发"标脏"和重绘。
 */
export class AnnotStore {
  constructor(initial = []) {
    this.items = (initial || []).map(normalizeAnnotation).filter(Boolean);
    this.undoStack = [];
    this.redoStack = [];
    this._listeners = new Set();
  }
  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _emit(reason) { for (const fn of [...this._listeners]) { try { fn(reason); } catch { } } }

  /** 某页的所有批注（渲染用，按创建时间排序保证层级稳定） */
  forPage(page) {
    return this.items.filter((a) => a.page === page).sort((x, y) => x.createdAt - y.createdAt);
  }
  all() { return this.items.slice(); }
  get size() { return this.items.length; }
  get(id) { return this.items.find((a) => a.id === id) || null; }

  add(a) {
    const n = normalizeAnnotation(a);
    if (!n) return null;
    this.undoStack.push({ op: "add", item: n });
    this.redoStack.length = 0;
    this.items.push(n);
    this._emit("add");
    return n;
  }
  update(id, patch) {
    const i = this.items.findIndex((a) => a.id === id);
    if (i < 0) return null;
    const before = this.items[i];
    const merged = normalizeAnnotation({ ...before, ...patch, id: before.id, createdAt: before.createdAt });
    if (!merged) return null;
    this.undoStack.push({ op: "update", before, after: merged });
    this.redoStack.length = 0;
    this.items[i] = merged;
    this._emit("update");
    return merged;
  }
  remove(id) {
    const i = this.items.findIndex((a) => a.id === id);
    if (i < 0) return false;
    const before = this.items[i];
    this.undoStack.push({ op: "remove", item: before, index: i });
    this.redoStack.length = 0;
    this.items.splice(i, 1);
    this._emit("remove");
    return true;
  }
  /** 清空某一页（右键菜单用） */
  clearPage(page) {
    const removed = this.items.filter((a) => a.page === page);
    if (!removed.length) return 0;
    this.undoStack.push({ op: "clearPage", items: removed });
    this.redoStack.length = 0;
    this.items = this.items.filter((a) => a.page !== page);
    this._emit("clearPage");
    return removed.length;
  }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  undo() {
    const op = this.undoStack.pop();
    if (!op) return false;
    if (op.op === "add") this.items = this.items.filter((a) => a.id !== op.item.id);
    else if (op.op === "update") {
      const i = this.items.findIndex((a) => a.id === op.before.id);
      if (i >= 0) this.items[i] = op.before;
    } else if (op.op === "remove") this.items.splice(Math.min(op.index, this.items.length), 0, op.item);
    else if (op.op === "clearPage") this.items.push(...op.items);
    this.redoStack.push(op);
    this._emit("undo");
    return true;
  }
  redo() {
    const op = this.redoStack.pop();
    if (!op) return false;
    if (op.op === "add") this.items.push(op.item);
    else if (op.op === "update") {
      const i = this.items.findIndex((a) => a.id === op.after.id);
      if (i >= 0) this.items[i] = op.after;
    } else if (op.op === "remove") this.items = this.items.filter((a) => a.id !== op.item.id);
    else if (op.op === "clearPage") this.items = this.items.filter((a) => !op.items.some((x) => x.id === a.id));
    this.undoStack.push(op);
    this._emit("redo");
    return true;
  }
  /** 命中测试：pt 点落在哪条批注上（后加的优先，方便选中/擦除） */
  hitTest(page, pt, tolerance = 4) {
    const list = this.forPage(page).slice().reverse();
    for (const a of list) {
      if (a.type === "ink") {
        // ⚠️ 必须算"点到线段的距离"，不能只比端点：
        //    两点之间隔得远时端点判定会让笔画中间"点不中"（橡皮擦不动）。
        const w = Math.max(tolerance, (a.ink.width || 2) / 2 + 1);
        const q = [pt.x, pt.y];        // 点存的是数组，这里把 {x,y} 转过去
        for (const s of a.ink.strokes) {
          for (let i = 1; i < s.points.length; i++) {
            if (distToSegment(q, s.points[i - 1], s.points[i]) <= w) return a;
          }
          if (s.points.length === 1 && dist(q, s.points[0]) <= w) return a;
        }
        continue;
      }
      for (const r of a.rects || []) {
        if (pt.x >= r.x - tolerance && pt.x <= r.x + r.w + tolerance && pt.y >= r.y - tolerance && pt.y <= r.y + r.h + tolerance) return a;
      }
    }
    return null;
  }
}

/** 点到点的距离 */
function dist(p, q) {
  return Math.hypot(p[0] - q[0], p[1] - q[1]);
}
/** 点到线段的最短距离（2D） */
function distToSegment(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const wx = p[0] - a[0], wy = p[1] - a[1];
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2)) : 0;
  const cx = a[0] + t * vx, cy = a[1] + t * vy;
  return Math.hypot(p[0] - cx, p[1] - cy);
}
