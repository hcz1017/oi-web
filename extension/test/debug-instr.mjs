// 调试插桩的端到端验证（Node，无需浏览器）：
//   编译（带 debug stub）→ 引擎给行→offset → 插桩 → 运行插桩后的模块
//   要求：① 程序输出与未插桩完全一致 ② 探针按行命中 ③ 命中站点能反查回正确源码行
import { readFileSync } from "fs";
import { gunzipSync } from "zlib";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
import { Toolchain } from "../src/core/toolchain.mjs";
import { parseWasm, instrumentWasm, firstInstrOffset } from "../src/core/wasm-bin.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, "..");
const A = (f) => path.join(EXT, "assets", f);
const require = createRequire(import.meta.url);

const SRC = `#include <cstdio>

struct Point { int x; int y; };

int add(int a, int b) {
  int sum = a + b;
  return sum;
}

int main() {
  Point p{1, 2};
  int n = 0;
  for (int i = 0; i < 3; i++) {
    n += add(i, p.x);
  }
  printf("%d\\n", n);
  return 0;
}
`;

const ok = (b, msg) => console.log(`${b ? "✓" : "✗"} ${msg}`) || b;
let pass = true;
const must = (cond, msg) => { if (!cond) pass = false; return ok(cond, msg); };

const tc = new Toolchain({
  clangWasm: gunzipSync(readFileSync(A("clang.wasm.gz"))),
  lldWasm: gunzipSync(readFileSync(A("lld.wasm.gz"))),
  sysrootTar: gunzipSync(readFileSync(A("sysroot.tar.gz"))),
  compatBits: readFileSync(A("compat/bits/stdc++.h")),
});

// ---------- 1. 编译（带调试桩）----------
const t0 = Date.now();
const r = await tc.compile({ source: SRC, fileName: "main.cpp", opt: 0, debug: true, debugStub: true });
must(!!r.wasm, `编译（debugStub）${Date.now() - t0}ms，wasm ${r.wasm ? (r.wasm.length / 1024).toFixed(0) + "KB" : "-"}`);
if (!r.wasm) { console.log(r.log.slice(-800)); process.exit(1); }
const orig = new Uint8Array(r.wasm);
const info = parseWasm(orig);
must(info.probeImportIndex >= 0, `产物里有 import "oi"."probe"（函数索引 ${info.probeImportIndex}）`);
must(info.code.bodies.length > 10, `函数体数量 ${info.code.bodies.length}`);

// ---------- 2. 基线输出 ----------
const runWith = async (wasm, onProbe) => {
  const out = [];
  const code = await tc.run(wasm, {
    onOut: (b) => out.push(Buffer.from(b)),
    extraImports: { oi: { probe: (id) => { onProbe(id); return 0; }, pause: () => {} } },
  });
  return { code, text: Buffer.concat(out).toString().trim() };
};
const hitsA = [];
const base = await runWith(orig, () => {});
const uninstrumented = await runWith(orig, (id) => hitsA.push(id));
must(base.code === 0 && uninstrumented.text === base.text, `未插桩基线输出 ${JSON.stringify(base.text)}`);

// ---------- 3. 引擎：行 → orig 模块偏移 ----------
const host = {
  getWasmLinearMemory() { throw new Error("unexpected"); },
  getWasmLocal() { throw new Error("unexpected"); },
  getWasmGlobal() { throw new Error("unexpected"); },
  getWasmOp() { throw new Error("unexpected"); },
};
// .dev/ 是本地开发脚手架（gitignore）：没准备好就跳过，而不是报错
let spawn;
try {
  ({ spawn } = require(path.join(EXT, ".dev/dwarf-pkg/node-test/index.js")));
} catch {
  console.log("跳过：缺少 .dev/dwarf-pkg（先跑 scripts/build-dwarf-worker.mjs，并把 @vscode/dwarf-debugging 解包到 .dev/dwarf-pkg/package）");
  process.exit(0);
}
const engine = spawn(host);
await engine.rpc.sendMessage("hello", [], false);
const MOD = "m0";
const code = orig.buffer.slice(orig.byteOffset, orig.byteOffset + orig.byteLength);
await engine.rpc.sendMessage("addRawModule", MOD, undefined, { url: "file:///workspace/main.wasm", code });
const srcUrl = "file:///workspace/main.cpp";
const zeroBasedLines = await engine.rpc.sendMessage("getMappedLines", MOD, srcUrl);
must(Array.isArray(zeroBasedLines) && zeroBasedLines.length > 0, `可断点行（0-based）: ${JSON.stringify(zeroBasedLines)}`);

// 行 → 引擎 offset（扫列）→ orig 模块绝对偏移
const lineToOffset = new Map();
for (const line of zeroBasedLines) {
  let found = null;
  for (let col = 0; col <= 80 && !found; col++) {
    const rs = await engine.rpc.sendMessage("sourceLocationToRawLocation", {
      rawModuleId: MOD, sourceFileURL: srcUrl, lineNumber: line, columnNumber: col,
    });
    if (rs && rs.length) found = rs[0].startOffset;
  }
  if (found != null) lineToOffset.set(line, info.code.contentStart + found);
}
const missing = zeroBasedLines.filter((l) => !lineToOffset.has(l));
// 函数声明行（如 `int main() {`）在 DWARF 里通常没有独立行记录，gdb 的 "break main" 也是绑到函数入口；
// 这类行由适配器用"下一个可映射行"兜底，所以这里允许少量缺失。
must(missing.length <= 2 && lineToOffset.size >= zeroBasedLines.length - 2,
  `每行都拿到 offset（${lineToOffset.size}/${zeroBasedLines.length}，缺失 ${JSON.stringify(missing)} → 由声明行兜底）`);

// ---------- 4. 插桩（按行）----------
const sites = [...lineToOffset.entries()].map(([line, offset], i) => ({ id: i + 1, offset, line }));
const instr = instrumentWasm(orig, sites.map(({ id, offset }) => ({ id, offset })));
must(instr.dropped.length === 0, `没有被丢弃的插桩点（dropped=${instr.dropped.length}${instr.dropped.length ? ": " + JSON.stringify(instr.dropped.slice(0, 3)) : ""}）`);
must(instr.sites.length === sites.length, `插桩点 ${instr.sites.length}/${sites.length}`);
const idToLine = new Map(sites.map((s) => [s.line, s.id]));

// 插桩后仍应是合法模块
must(new WebAssembly.Module(instr.wasm) instanceof WebAssembly.Module, "插桩后模块可编译");

// ---------- 5. 运行插桩后的模块 ----------
const hits = [];
const got = await runWith(instr.wasm, (id) => hits.push(id));
must(got.code === 0 && got.text === base.text, `插桩后输出与基线一致（${JSON.stringify(got.text)}）`);
must(hits.length > 0, `探针命中 ${hits.length} 次，涉及 ${new Set(hits).size} 个不同站点`);
const hitLines = [...new Set(hits)].map((id) => [...idToLine.entries()].find(([, v]) => v === id)?.[0]).filter((x) => x != null).sort((a, b) => a - b);
must(hitLines.length > 0, `命中行（0-based）: ${JSON.stringify(hitLines)}`);

// 命中过的行应该就是 main/add 里真正执行到的行；用引擎反查校验一致性
let badBack = 0;
for (const id of new Set(hits)) {
  const site = instr.sites.find((s) => s.id === id);
  const line = [...idToLine.entries()].find(([, v]) => v === id)?.[0];
  const engineOff = site.origOffset - info.code.contentStart;
  const back = await engine.rpc.sendMessage("rawLocationToSourceLocation", {
    rawModuleId: MOD, codeOffset: engineOff, inlineFrameIndex: 0,
  });
  const backLine = (back || [])[0]?.lineNumber;
  if (backLine !== line) badBack++;
}
// 回退策略下，行首请求点若落在表达式中间，会回退到最近的栈空点；
// 跨行语句（如字符串字面量续行）反查可能落到前一条语句，允许极少量偏差
must(badBack <= 1, `站点反查行号一致（不一致 ${badBack} 个）`);

await engine.dispose();
console.log(pass ? "\n全部通过" : "\n存在失败项");
process.exit(pass ? 0 : 1);
