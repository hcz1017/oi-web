// 让 vscode-web 自带的「打开文件夹」真正可用（在页面里用 File System Access API）
//
// ⚠️ 踩坑：vscode-web 的扩展宿主跑在 **Web Worker** 里，那里没有
//    window.showDirectoryPicker，而且它的 globalThis 与页面是两个 JS 上下文——
//    所以"在扩展里挂个钩子让页面调用"永远不可能生效。
//    目录选择必须在**页面侧**完成（就是本补丁做的事）。
//
// 背景：这份构建里 FileDialogService 的
//   pickFileFolderAndOpen / pickFolderAndOpen
// 在 file 协议下是硬编码 throw 的；而扩展宿主跑在 **Web Worker** 里，
// 那里没有 window.showDirectoryPicker，所以只能把实现写在**页面侧**（本补丁）。
//
// 做法：把 throw 换成
//   1) window.showDirectoryPicker() 选目录（页面上下文，用户手势有效）
//   2) this.fileSystemProvider.registerDirectoryHandle(handle) 注册成内置 html 文件系统
//   3) this.commandService.executeCommand("vscode.openFolder", uri) 作为文件夹打开
//
// 用法：node scripts/patch-open-folder.mjs <bundle.js>
//       node scripts/patch-open-folder.mjs --restore <bundle.js>
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";

const MARK = "__oiPickFolder";
const NLS_FOLDER = "24557";        // "Can't open folders, try adding a folder to the workspace instead."

const args = process.argv.slice(2);
const restore = args.includes("--restore");
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("用法: node scripts/patch-open-folder.mjs <bundle.js>");
  process.exit(2);
}
const bak = file + ".oi-bak";
if (!existsSync(file)) { console.error("找不到文件: " + file); process.exit(2); }
if (restore) {
  if (!existsSync(bak)) { console.error("没有备份: " + bak); process.exit(2); }
  copyFileSync(bak, file);
  console.log("✓ 已还原 " + file);
  process.exit(0);
}

let src = readFileSync(file, "utf8");
if (src.includes(MARK)) { console.log("✓ 已打过补丁"); process.exit(0); }

// 目标：这两处 throw（同一句报错文案，仅"打开文件夹"相关入口使用）
const TARGET = 'throw new Error(d(24557,null))';

// oi: 页面侧 FSA 实现（挂在 globalThis，避免严格模式隐式全局）
const IMPL =
  `if(typeof globalThis.${MARK}!=="function"){globalThis.${MARK}=async function(svc){` +
  `const w=typeof window!=="undefined"?window:null;` +
  `if(!w||typeof w.showDirectoryPicker!=="function")throw new Error("当前浏览器不支持 File System Access API（需 Chrome/Edge + https）");` +
  `const h=await w.showDirectoryPicker({mode:"readwrite"});` +
  `const uri=await svc.fileSystemProvider.registerDirectoryHandle(h);` +
  `if(!uri)throw new Error("注册目录句柄失败");` +
  `await svc.commandService.executeCommand("vscode.openFolder",uri,{forceReuseWindow:false});` +
  `return true}}` +
  `try{await globalThis.${MARK}(this);return}catch(e){console.error("[oi openFolder]",e&&(e.name||""),e&&(e.message||e))}`;

let out = "";
let count = 0;
let idx = 0;
while (true) {
  const at = src.indexOf(TARGET, idx);
  if (at < 0) { out += src.slice(idx); break; }
  const before = src.slice(Math.max(0, at - 400), at);
  out += src.slice(idx, at);
  if (before.includes(MARK)) {
    out += TARGET;                        // 已经打过，保持原样
  } else {
    out += IMPL + ";" + TARGET;
    count++;
  }
  idx = at + TARGET.length;
}

if (count === 0 && !src.includes(MARK)) {
  console.error("✗ 找不到目标 throw（vscode-web 版本变了？）");
  process.exit(1);
}
if (!existsSync(bak)) copyFileSync(file, bak);
writeFileSync(file, out);
console.log(`✓ 已给 ${count} 处「打开文件夹」入口接上页面侧 FSA 实现${count === 0 ? "（此前已打过）" : ""}`);
