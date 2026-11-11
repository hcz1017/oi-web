// PDF 阅读器的纯逻辑测试：缩放/适配/页码/坐标换算/搜索切词。
// 这些函数在 client.mjs 里直接用来算布局和批注坐标，算错会"批注整体偏移"。
import {
  clampScale, fitScale, parsePageInput, clampPage, formatBytes,
  ptToCss, cssToPt, cssRectToPt, normalizeRect, rectsIntersect, findAll, themeBackdrop,
  MIN_SCALE, MAX_SCALE,
} from "../src/web/pdf/helpers.mjs";

let pass = true;
const must = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) pass = false; return c; };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---------- 缩放 ----------
must(clampScale(1) === 1, "clampScale: 1 → 1");
must(clampScale(0.001) === MIN_SCALE, `clampScale: 太小夹到 ${MIN_SCALE}`);
must(clampScale(999) === MAX_SCALE, `clampScale: 太大夹到 ${MAX_SCALE}`);
must(clampScale("abc") === 1, "clampScale: 垃圾输入 → 1");
must(clampScale(1.23456) === 1.23, "clampScale: 保留两位");

// ---------- 适应宽度 / 适应页面 ----------
{
  // A4：595×842pt，容器 1000×800（padding 24 → 可用 952×752）
  const w = fitScale({ pageWidth: 595, pageHeight: 842, boxWidth: 1000, boxHeight: 800, mode: "width" });
  must(near(w, 952 / 595, 0.01), `适应宽度 = 可用宽/页宽（${w.toFixed(3)}）`);
  const p = fitScale({ pageWidth: 595, pageHeight: 842, boxWidth: 1000, boxHeight: 800, mode: "page" });
  must(near(p, Math.min(952 / 595, 752 / 842), 0.01), `适应页面取两方向较小者（${p.toFixed(3)}）`);
  must(fitScale({ pageWidth: 0, pageHeight: 0, boxWidth: 100, boxHeight: 100 }) === 1, "页面尺寸为 0 → 1（别除零）");
}

// ---------- 页码 ----------
must(parsePageInput("3", 10) === 3, "页码 3 → 3");
must(parsePageInput("3-5", 10) === 3, "页码 3-5 → 取起始页 3");
must(parsePageInput("", 10, 7) === 7, "空输入 → 当前页");
must(parsePageInput("99", 10) === 10, "超出总数 → 夹到最后一页");
must(parsePageInput("0", 10) === 1, "0 → 1");
must(parsePageInput("abc", 10, 4) === 4, "非法 → 当前页");
must(clampPage(5, 3) === 3 && clampPage(-2, 3) === 1, "clampPage 双向夹紧");

// ---------- 体积 ----------
must(formatBytes(999) === "999B", "formatBytes: B");
must(formatBytes(2048) === "2.0KB", "formatBytes: KB");
must(formatBytes(5 * 1048576) === "5.0MB", "formatBytes: MB");

// ---------- 坐标换算（最容易算错、且错了批注就飘） ----------
{
  const vp = { pageWidth: 600, pageHeight: 800, scale: 2, rotation: 0 };
  // 默认朝向：pt 原点左下 → CSS 原点左上，y 翻转
  const a = ptToCss({ x: 0, y: 0 }, vp);
  must(a.x === 0 && a.y === 1600, `pt(0,0) → css(0, ${a.y})（左下角到底部）`);
  const b = ptToCss({ x: 10, y: 790 }, vp);
  must(b.x === 20 && b.y === 20, `pt(10,790) → css(${b.x},${b.y})（接近左上角）`);

  // 往返：pt → css → pt 必须一致
  for (const rot of [0, 90, 180, 270]) {
    const v2 = { pageWidth: 600, pageHeight: 800, scale: 1.5, rotation: rot };
    const pt = { x: 123.4, y: 567.8 };
    const css = ptToCss(pt, v2);
    const back = cssToPt(css, v2);
    must(near(back.x, pt.x, 0.01) && near(back.y, pt.y, 0.01),
      `旋转 ${rot}°：pt→css→pt 往返一致（${back.x.toFixed(2)},${back.y.toFixed(2)}）`);
  }

  // 拖拽矩形换算：竖直反向拖（h<0）也要得到正的 pt 矩形
  const r = cssRectToPt({ x: 100, y: 300, w: 50, h: -40 }, vp);
  must(r.w > 0 && r.h > 0, "cssRectToPt: 反向拖拽得到正尺寸");
  must(near(r.x, 50) && near(r.w, 25), `cssRectToPt: x 换算正确（x=${r.x}, w=${r.w}）`);
}

// ---------- 矩形工具函数 ----------
must(normalizeRect({ x: 10, y: 10, w: -5, h: -5 }).x === 5, "normalizeRect: 负宽高归一化");
must(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }) === true, "rectsIntersect: 相交");
must(rectsIntersect({ x: 0, y: 0, w: 5, h: 5 }, { x: 6, y: 6, w: 5, h: 5 }) === false, "rectsIntersect: 不相交");

// ---------- 搜索切词 ----------
{
  const hits = findAll("abcABCabc", "abc");
  must(hits.length === 3, `findAll: 大小写不敏感、非重叠（${hits.length} 处）`);
  must(hits[0][0] === 0 && hits[1][0] === 3, "findAll: 位置正确");
  must(findAll("aaa", "aa").length === 1, "findAll: 非重叠匹配（aaa 里 aa 命中 1 次，和浏览器查找一致）");
  must(findAll("abc", "").length === 0, "findAll: 空词 → 无匹配");
  must(findAll("abc", "zzz").length === 0, "findAll: 未命中 → 空");
}

// ---------- 主题 ----------
must(themeBackdrop("light") === "#f3f3f3", "主题: 浅色背景");
must(themeBackdrop("high-contrast") === "#000000", "主题: 高对比度");
must(/^#/.test(themeBackdrop(undefined)), "主题: 未知也给出合法颜色");

console.log(pass ? "\n全部通过" : "\n存在失败项");
process.exit(pass ? 0 : 1);
