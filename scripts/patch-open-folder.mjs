// 让 vscode-web 自带的「打开文件夹」按钮/菜单真正可用
//
// 这份 vscode-web 构建里，凡是"打开文件夹"相关的文件对话框入口在 file 协议下都是
// 硬编码 throw 的：
//   FileDialogService.pickFileFolderAndOpen   ← 「打开文件/文件夹」实际走这里
//   FileDialogService.pickFolderAndOpen       ← 「打开文件夹」
// 我们把这些 throw 换成调用扩展注册的全局钩子 globalThis.__oiOpenFolder
// （由 src/web/fsa-folder.js 在激活时挂上：优先转调原生的「添加文件夹到工作区」，
//   失败则用 File System Access API 自己选目录并挂载）。
//
// 用法：node scripts/patch-open-folder.mjs <workbench.web.main.internal.js>
//       node scripts/patch-open-folder.mjs --restore <file>   # 从 .oi-bak 还原
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";

const MARK = "__oiOpenFolder";
// 目标：这两函数体里的 throw new Error(d(<nls>,null))（该 nls 只被它们使用）
const THROW_RE = /throw new Error\(d\((\d+),null\)\)/g;

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
const already = (src.match(new RegExp(MARK, "g")) || []).length;
// 只替换"打开文件夹"两处的 nls（24557）；其它 nls 索引不动
const HOOK = (nls) =>
  `if(typeof globalThis.${MARK}==="function"){try{await globalThis.${MARK}();return}catch(e){console.error("[oi openFolder]",e)}}` +
  `throw new Error(d(${nls},null))`;

let count = 0;
let patched = src.replace(THROW_RE, (all, nls) => {
  if (all.includes(MARK)) return all;                 // 已打过
  if (nls !== "24557") return all;                    // 只处理"打不开文件夹"这条
  count++;
  return HOOK(nls);
});

if (count === 0) {
  if (already > 0) { console.log(`✓ 已打过补丁（${already} 处钩子）`); process.exit(0); }
  console.error("✗ 找不到 24557 的 throw 片段（vscode-web 版本变了？）");
  process.exit(1);
}
if (!existsSync(bak)) copyFileSync(file, bak);
writeFileSync(file, patched);
console.log(`✓ 已给 ${count} 处「打开文件夹」入口接上扩展钩子（含 pickFileFolderAndOpen / pickFolderAndOpen）`);
