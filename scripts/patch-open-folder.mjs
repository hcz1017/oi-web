// 让 vscode-web 自带的「打开文件夹」按钮/菜单真正可用
//
// 这份 vscode-web 构建里 FileDialogService.pickFolderAndOpen 在 file 协议下是
// 硬编码 throw 的（空窗口必然走到这里）。我们把它替换成调用扩展注册的全局钩子
// globalThis.__oiOpenFolder（由 src/web/fsa-folder.js 在激活时挂上，内部用
// File System Access API 选目录 + 挂进工作区）。
//
// 用法：node scripts/patch-open-folder.mjs <workbench.web.main.internal.js>
//       node scripts/patch-open-folder.mjs --restore <file>   # 从 .oi-bak 还原
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";

const MARK = "__oiOpenFolder";
// 目标片段（minified）：pickFolderAndOpen 里 throw new Error(d(<nls>,null))
const PATTERN = /async pickFolderAndOpen\(o\)\{([\s\S]{0,400}?)throw new Error\(d\(\d+,null\)\)\}/;

const args = process.argv.slice(2);
const restore = args.includes("--restore");
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("用法: node scripts/patch-open-folder.mjs <workbench.web.main.internal.js>");
  process.exit(2);
}
const bak = file + ".oi-bak";
if (!existsSync(file)) {
  console.error("找不到文件: " + file);
  process.exit(2);
}

if (restore) {
  if (!existsSync(bak)) { console.error("没有备份可还原: " + bak); process.exit(2); }
  copyFileSync(bak, file);
  console.log("✓ 已还原 " + file);
  process.exit(0);
}

const src = readFileSync(file, "utf8");
if (src.includes(MARK)) {
  console.log("✓ 已打过补丁（自带打开文件夹 → 扩展 FSA 流程）");
  process.exit(0);
}
const m = src.match(PATTERN);
if (!m) {
  console.error("✗ 找不到 pickFolderAndOpen 的 throw 片段（vscode-web 版本变了？）");
  process.exit(1);
}
const patched = src.replace(PATTERN, (all, head) =>
  `async pickFolderAndOpen(o){${head}` +
  `if(typeof globalThis.${MARK}==="function"){try{await globalThis.${MARK}();return}catch(e){console.error("[oi openFolder]",e)}}` +
  `throw new Error(d(${all.match(/d\((\d+),null\)/)[1]},null))}`);
if (!existsSync(bak)) copyFileSync(file, bak);
writeFileSync(file, patched);
console.log("✓ 已让自带「打开文件夹」走扩展的 FSA 流程");
