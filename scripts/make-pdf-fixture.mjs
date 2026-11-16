#!/usr/bin/env node
// 生成 PDF 阅读器的测试样本（ASCII 文本 + 两页 + 大纲 + 一个内部链接）。
//
// 为什么要自己造：仓库里不能塞来源不明的 PDF；而手写 PDF 的 xref 偏移必须精确，
// 所以用脚本算偏移生成，保证文件严格合法（pdf.js 对 xref 很敏感）。
//
// 用法：node scripts/make-pdf-fixture.mjs [输出路径]
// 默认输出 extension/test/fixtures/sample.pdf
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || path.join(HERE, "..", "extension", "test", "fixtures", "sample.pdf");

const PAGE_W = 595, PAGE_H = 842;

function content(lines, title) {
  const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  let y = PAGE_H - 80;
  let s = "BT\n/F1 20 Tf\n72 " + y + " Td\n(" + esc(title) + ") Tj\nET\n";
  y -= 40;
  s += "BT\n/F2 12 Tf\n";
  for (const line of lines) {
    s += "1 0 0 1 72 " + y + " Tm\n(" + esc(line) + ") Tj\n";
    y -= 20;
  }
  s += "ET\n";
  // 一个可见的图元，方便肉眼确认"渲染真的发生了"
  s += "0.9 0.9 0.2 rg\n72 " + (y - 10) + " 150 8 re f\n0 0 0 rg\n";
  return s;
}

const page1Lines = [
  "WebC++ PDF viewer fixture - page 1",
  "",
  "Search for: hello world, annotation, ink.",
  "The quick brown fox jumps over the lazy dog.",
];
const page2Lines = [
  "Second page: annotations and ink should survive saving.",
  "",
  "Try: highlight this line, draw a stroke, then Ctrl+S.",
  "hello world appears again here.",
];

const contents = [content(page1Lines, "Fixture PDF"), content(page2Lines, "Page two")];

// object 编号规划
// 1 Catalog, 2 Pages, 3 Page1, 4 Page2, 5 Contents1, 6 Contents2, 7 Font Helvetica, 8 Font Helvetica-Bold,
// 9 Outlines, 10 Outline item -> page1
const objs = [];
objs[1] = "<< /Type /Catalog /Pages 2 0 R /Outlines 9 0 R /PageMode /UseOutlines >>";
objs[2] = "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>";
const pageObj = (contentId) =>
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
  `/Resources << /Font << /F1 7 0 R /F2 8 0 R >> >> /Contents ${contentId} 0 R >>`;
objs[3] = pageObj(5);
objs[4] = pageObj(6);
const streamObj = (text) => ({ stream: text });
objs[5] = streamObj(contents[0]);
objs[6] = streamObj(contents[1]);
objs[7] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
objs[8] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
objs[9] = "<< /Type /Outlines /First 10 0 R /Last 10 0 R /Count 1 >>";
objs[10] = "<< /Title (Page 1 - Fixture) /Parent 9 0 R /Dest [3 0 R /XYZ 0 842 0] >>";

let pdf = "%PDF-1.7\n%\xE2\xE3\xCF\xD3\n";
const offsets = [];
for (let i = 1; i < objs.length; i++) {
  const o = objs[i];
  if (o == null) continue;
  offsets[i] = Buffer.byteLength(pdf, "latin1");
  if (typeof o === "string") {
    pdf += `${i} 0 obj\n${o}\nendobj\n`;
  } else {
    const body = o.stream;
    pdf += `${i} 0 obj\n<< /Length ${Buffer.byteLength(body, "latin1")} >>\nstream\n${body}endstream\nendobj\n`;
  }
}
const xrefStart = Buffer.byteLength(pdf, "latin1");
const maxObj = objs.length - 1;
pdf += `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
for (let i = 1; i <= maxObj; i++) {
  pdf += String(offsets[i] || 0).padStart(10, "0") + " 00000 n \n";
}
pdf += `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, Buffer.from(pdf, "latin1"));
console.log(`已生成 ${out}（${Buffer.byteLength(pdf, "latin1")} 字节，2 页，带大纲）`);
