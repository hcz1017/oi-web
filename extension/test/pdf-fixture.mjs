// 测试样本 PDF 的健壮性检查（Node 里用 pdf.js 真解析一遍）。
//
// 目的：fixture 是我们手工生成的最小 PDF（scripts/make-pdf-fixture.mjs），
// 一旦生成脚本写坏（xref 偏移错、stream 长度错），浏览器里会白屏，而单测发现不了。
// 这里用 pdf.js 的 legacy 构建在 Node 里解析，断言页数/文字/大纲都对。
import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "sample.pdf");

let pass = true;
const must = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) pass = false; return c; };

must(existsSync(FIXTURE), "样本 PDF 存在（node scripts/make-pdf-fixture.mjs）");
if (!existsSync(FIXTURE)) { console.log("\n存在失败项"); process.exit(1); }

const data = new Uint8Array(readFileSync(FIXTURE));
const doc = await pdfjs.getDocument({ data, disableFontFace: true }).promise;

must(doc.numPages === 2, `样本共 2 页（实际 ${doc.numPages}）`);

const p1 = await doc.getPage(1);
const vp = p1.getViewport({ scale: 1 });
must(Math.round(vp.width) === 595 && Math.round(vp.height) === 842, `页面尺寸是 A4（${Math.round(vp.width)}×${Math.round(vp.height)}）`);

const tc = await p1.getTextContent();
const flat = (items) => items.map((i) => i.str).join("").replace(/\s+/g, " ").trim();
const text1 = flat(tc.items);
must(/Fixture PDF/.test(text1), "第 1 页能抽出标题文字");
must(/hello world/i.test(text1), "第 1 页含搜索用词 hello world");

const p2 = await doc.getPage(2);
const text2 = flat((await p2.getTextContent()).items);
must(/hello world/i.test(text2), "第 2 页也含 hello world（搜索要多页命中）");

const outline = await doc.getOutline();
must(!!outline && outline.length >= 1, "带大纲（侧栏要能显示）");
must(!!outline && /Page 1/.test(outline[0].title), "大纲标题正确");

// 文本坐标（批注框选依赖 transform 里的 e/f）
const item = tc.items.find((i) => /hello|world/i.test(i.str || ""));
must(!!item && Array.isArray(item.transform) && item.transform.length === 6, "文字项带 transform（计算批注矩形要用）");

await doc.destroy();
console.log(pass ? "\n全部通过" : "\n存在失败项");
process.exit(pass ? 0 : 1);
