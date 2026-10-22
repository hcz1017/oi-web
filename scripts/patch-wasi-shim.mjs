// 修复 @bjorn3/browser_wasi_shim@0.4.2 的 argv 缓冲区大小计算 bug。
// ⚠️ 症状：中文文件名编译时，clang 驱动打印 "OVERVIEW: llvm toolchain driver" 的
//    usage 然后退出 1（英文名正常）。
// 根因：args_sizes_get 里按 JS 字符串 .length（UTF-16 个数）累加 argv 缓冲区大小，
// 而 args_get 写入的是 UTF-8 字节（中文每字 3 字节）。实际写入超出申报大小，
// libc 读到的 argv 越界/被截 → clang 认为没传子命令。
// env 那套原版就是按 TextEncoder 算的，只有 args 这一处是坏的。
// （0.4.2 之后的上游版本已改用 UTF-8 统计，升级依赖后本补丁会因精确匹配失败而
//  安全跳过。）
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const candidates = [
  resolve(here, "../extension/node_modules/@bjorn3/browser_wasi_shim/dist/wasi.js"),
  resolve(here, "../node_modules/@bjorn3/browser_wasi_shim/dist/wasi.js"),
];

const BAD = "for(const arg of self.args){buf_size+=arg.length+1}";
const GOOD =
  "// [oi patch] buf_size 必须按 UTF-8 字节数算（原版用 JS .length；中文文件名时 argv 超写 → clang 打印 llvm usage）\n" +
  'for(const arg of self.args){buf_size+=new TextEncoder().encode(arg).length+1}';

let patched = false;
for (const f of candidates) {
  let text;
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  if (text.includes("[oi patch]")) { patched = true; console.log(`[patch-wasi-shim] 已打过: ${f}`); continue; }
  if (!text.includes(BAD)) { console.log(`[patch-wasi-shim] 跳过（模式不匹配，可能已升级上游）: ${f}`); continue; }
  writeFileSync(f, text.replace(BAD, GOOD));
  patched = true;
  console.log(`[patch-wasi-shim] 已修复: ${f}`);
}
if (!patched) {
  console.error("[patch-wasi-shim] 未找到 browser_wasi_shim/dist/wasi.js，中文文件名编译会失败");
  process.exit(1);
}
