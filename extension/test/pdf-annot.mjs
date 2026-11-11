// 批注模型测试：增删改 / 撤销重做 / 命中测试 / sidecar 往返 / 坏数据容错。
// 批注存错会让用户"费半天画的板书丢一半"，所以这块的边界要钉死。
import {
  AnnotStore, normalizeAnnotation, parseSidecar, serializeSidecar,
  SIDECAR_VERSION, newId, ANNOT_TYPES,
} from "../src/web/pdf/annot.mjs";

let pass = true;
const must = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) pass = false; return c; };

// ---------- 规范化 ----------
{
  must(ANNOT_TYPES.includes("ink") && ANNOT_TYPES.includes("highlight"), "支持 ink/highlight 等类型");
  const a = normalizeAnnotation({ type: "highlight", page: 2, rects: [{ x: 1, y: 2, w: 3, h: 4 }] });
  must(a && a.page === 2 && a.rects.length === 1, "normalize: 正常批注");
  must(a.color === "#ffd54f" && Math.abs(a.opacity - 0.35) < 1e-9, "normalize: 默认颜色/透明度");
  must(normalizeAnnotation({ type: "nope" }) === null, "normalize: 未知类型 → null");
  must(normalizeAnnotation(null) === null, "normalize: null → null");

  const r = normalizeAnnotation({ type: "rect", page: 0, rect: { x: 1, y: 2, w: 3, h: 4 } });
  must(r.page === 1, "normalize: 页码 0 夹到 1");
  must(r.rects.length === 1, "normalize: 单个 rect 也转成 rects 数组");

  const ink = normalizeAnnotation({
    type: "ink", page: 1,
    ink: { width: 999, strokes: [{ points: [[1.2345, 2.3456], [3, 4], ["bad", 1]] }] },
  });
  must(ink.ink.width === 24, "normalize: 笔宽夹到上限 24");
  must(ink.ink.strokes[0].points.length === 2, "normalize: 非法点被丢弃");
  must(ink.ink.strokes[0].points[0][0] === 1.23, "normalize: 点坐标压到两位小数（sidecar 体积）");
  must(newId() !== newId(), "id 不重复");
}

// ---------- 增删改 + 撤销重做 ----------
{
  const s = new AnnotStore();
  let changes = 0;
  s.onChange(() => changes++);

  const a = s.add({ type: "highlight", page: 1, rects: [{ x: 0, y: 0, w: 10, h: 10 }] });
  must(s.size === 1 && changes === 1, "add: 入库并通知");
  must(s.forPage(1).length === 1 && s.forPage(2).length === 0, "forPage: 按页过滤");

  s.update(a.id, { color: "#00ff00" });
  must(s.get(a.id).color === "#00ff00", "update: 改颜色");
  must(s.canUndo === true, "update: 有撤销栈");

  s.undo();
  must(s.get(a.id).color === "#ffd54f", "undo: 颜色回到原值");
  s.redo();
  must(s.get(a.id).color === "#00ff00", "redo: 颜色又变回去");

  s.remove(a.id);
  must(s.size === 0, "remove: 删除");
  s.undo();
  must(s.size === 1, "undo: 删除可撤销（板书不能一删就没）");

  s.clearPage(1);
  must(s.size === 0, "clearPage: 清空该页");
  s.undo();
  must(s.size === 1, "undo: clearPage 也可撤销");
}

// ---------- 命中测试（橡皮/选中用） ----------
{
  const s = new AnnotStore([
    { id: "h1", type: "highlight", page: 1, rects: [{ x: 10, y: 10, w: 100, h: 20 }] },
    { id: "i1", type: "ink", page: 1, ink: { width: 3, strokes: [{ points: [[200, 200], [210, 210]] }] } },
  ]);
  must(s.hitTest(1, { x: 50, y: 20 })?.id === "h1", "hitTest: 命中高亮");
  must(s.hitTest(1, { x: 205, y: 205 })?.id === "i1", "hitTest: 命中手写笔迹");
  must(s.hitTest(1, { x: 500, y: 500 }) === null, "hitTest: 空白处不命中");
  must(s.hitTest(2, { x: 50, y: 20 }) === null, "hitTest: 别的页不命中");
  // 容差：稍微点偏也能选中（橡皮要好用）
  must(s.hitTest(1, { x: 50, y: 33 })?.id === "h1", "hitTest: 容差内仍命中");
}

// ---------- sidecar 往返 ----------
{
  const s = new AnnotStore([
    { id: "a1", type: "highlight", page: 1, rects: [{ x: 1, y: 2, w: 3, h: 4 }] },
    { id: "a2", type: "ink", page: 2, ink: { width: 2, strokes: [{ points: [[1, 2], [3, 4]] }] } },
    { id: "a3", type: "note", page: 2, rects: [{ x: 5, y: 6, w: 24, h: 24 }], text: "这里是关键" },
  ]);
  const text = serializeSidecar(s.all(), "题面.pdf", { 7: { lang: "chi_sim", text: "OCR 预留" } });
  must(text.includes('"version": 1') && text.includes("题面.pdf"), "serialize: 带版本与文件名");

  const back = parseSidecar(text, "题面.pdf");
  must(back.annotations.length === 3, "parse: 三条批注都回来");
  must(back.annotations[2].text === "这里是关键", "parse: 便签文本保留");
  must(back.annotations[1].ink.strokes[0].points.length === 2, "parse: 手写点保留");
  must(back.dirty === false, "parse: 同版本同文件名 → 不算脏");
  must(back.ocr["7"].text === "OCR 预留", "parse: OCR 字段原样透传（将来接 OCR 不能丢）");
}

// ---------- 坏数据容错 ----------
{
  must(parseSidecar("不是 JSON").annotations.length === 0, "parse: 坏 JSON → 空而不抛");
  must(parseSidecar("[]").annotations.length === 0, "parse: 顶层是数组 → 空");
  const dirty = parseSidecar(JSON.stringify({ version: 99, pdf: "别.pdf", annotations: [] }), "本.pdf");
  must(dirty.dirty === true, "parse: 版本/文件名不符 → 标记 dirty（上层会提示）");
  const junk = parseSidecar(JSON.stringify({ annotations: [null, 1, { type: "?" }, { type: "note", page: 1 }] }), "x.pdf");
  must(junk.annotations.length === 1, "parse: 丢弃垃圾项，保留合法的");
  must(SIDECAR_VERSION === 1, "sidecar 版本号是 1");
}

// ---------- 大文档性能（别在渲染循环里做 O(n²)） ----------
{
  const many = [];
  for (let i = 0; i < 2000; i++) many.push({ type: "highlight", page: (i % 50) + 1, rects: [{ x: i, y: i, w: 5, h: 5 }] });
  const t0 = Date.now();
  const s = new AnnotStore(many);
  for (let p = 1; p <= 50; p++) s.forPage(p);
  const ms = Date.now() - t0;
  must(s.size === 2000, "2000 条批注都能入库");
  must(ms < 300, `50 页各查一次 forPage 足够快（${ms}ms）`);
}

console.log(pass ? "\n全部通过" : "\n存在失败项");
process.exit(pass ? 0 : 1);
