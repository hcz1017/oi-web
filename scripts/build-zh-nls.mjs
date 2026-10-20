// 把官方简体中文语言包编译成 vscode-web 的 nls.messages.js（中文界面核心）
//
// 原理：
//   out/nls.messages.js  = globalThis._VSCODE_NLS_MESSAGES = [英文串, ...]（顺序固定）
//   out/nls.keys.json    = 按同样顺序的 [[模块路径, [key...]], ...]
//   语言包 main.i18n.json = { contents: { 模块路径: { key: 中文 } } }
// 因此可以逐下标把英文替换成中文；没有翻译的条目保留英文。
//
// 用法：node scripts/build-zh-nls.mjs [--restore]
//   默认：生成中文 bundle（原英文备份为 nls.messages.en.js）
//   --restore：恢复英文
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(ROOT, ".vscode-test-web");
const dirs = readdirSync(CACHE).filter((d) => d.startsWith("vscode-web-stable"));
if (!dirs.length) throw new Error("找不到 .vscode-test-web/vscode-web-stable-*");
const W = path.join(CACHE, dirs.sort().pop());
const OUT = path.join(W, "out");
const NLS = path.join(OUT, "nls.messages.js");
const EN_BACKUP = path.join(OUT, "nls.messages.en.js");
// 语言包翻译数据随仓库提交（web/zh-main.i18n.json，MS-CEINTL 官方包，MIT）
const PACK_CANDIDATES = [
  path.join(ROOT, "web/zh-main.i18n.json"),
  path.join(ROOT, ".dev-zh/zh-pack/translations/main.i18n.json"),
];
const PACK = PACK_CANDIDATES.find((p) => existsSync(p));
if (!PACK) throw new Error("缺少中文翻译数据（web/zh-main.i18n.json）");

if (process.argv.includes("--restore")) {
  if (!existsSync(EN_BACKUP)) throw new Error("没有英文备份（nls.messages.en.js）");
  writeFileSync(NLS, readFileSync(EN_BACKUP));
  console.log("✓ 已恢复英文 nls.messages.js");
  process.exit(0);
}

if (!existsSync(EN_BACKUP)) writeFileSync(EN_BACKUP, readFileSync(NLS));

const keys = JSON.parse(readFileSync(path.join(OUT, "nls.keys.json"), "utf8"));
const pack = JSON.parse(readFileSync(PACK, "utf8"));
const contents = pack.contents || {};

// 解析英文数组：文件是 globalThis._VSCODE_NLS_MESSAGES=[...]; 用 JSON.parse 取数组部分
const raw = readFileSync(EN_BACKUP, "utf8");
const start = raw.indexOf("[");
const end = raw.lastIndexOf("]");
const english = JSON.parse(raw.slice(start, end + 1));

const zh = [];
let hit = 0, miss = 0;
let idx = 0;
for (const [module, moduleKeys] of keys) {
  const table = contents[module] || {};
  for (const key of moduleKeys) {
    const en = english[idx];
    const tr = table[key];
    if (typeof tr === "string" && tr.length) { zh.push(tr); hit++; }
    else { zh.push(en); miss++; }
    idx++;
  }
}
if (idx !== english.length) {
  console.warn(`⚠ 下标数不一致：keys=${idx}, messages=${english.length}（按较小者对齐，尾部保留英文）`);
  for (let i = idx; i < english.length; i++) zh.push(english[i]);
}

const header = `/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
/* oi-web: 由 MS-CEINTL 简体中文语言包生成的 zh-cn NLS bundle */
`;
const zhBundle = header + "globalThis._VSCODE_NLS_MESSAGES=" + JSON.stringify(zh) + ";\n";
writeFileSync(NLS, zhBundle);
writeFileSync(path.join(OUT, "nls.messages.zh-cn.js"), zhBundle);   // 客户端兜底用
console.log(`✓ 中文 NLS 已写入: ${NLS}`);
console.log(`  条目 ${zh.length}：已翻译 ${hit}（${((hit / zh.length) * 100).toFixed(1)}%），回退英文 ${miss}`);
console.log("  恢复英文: node scripts/build-zh-nls.mjs --restore");
