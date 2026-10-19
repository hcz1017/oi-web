// Node 冒烟测试：用与浏览器完全相同的代码路径（browser_wasi_shim）编译并运行
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { gunzipSync } from "zlib";
import path from "path";
import { Toolchain } from "../src/core/toolchain.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const A = (f) => path.join(ROOT, "assets", f);

const t0 = Date.now();
const tc = new Toolchain({
  clangWasm: gunzipSync(readFileSync(A("clang.wasm.gz"))),
  lldWasm: gunzipSync(readFileSync(A("lld.wasm.gz"))),
  sysrootTar: gunzipSync(readFileSync(A("sysroot.tar.gz"))),
  compatBits: readFileSync(A("compat/bits/stdc++.h")),
});
console.log(`资产解析 ${Date.now() - t0}ms`);

const CASES = {
  "iostream + vector": `#include <iostream>
#include <vector>
#include <algorithm>
int main(){ std::vector<int> v{3,1,2}; std::sort(v.begin(),v.end());
  for(int x: v) std::cout << x << " "; std::cout << "\\n"; return 0; }`,
  "bits/stdc++.h": `#include <bits/stdc++.h>
using namespace std;
int main(){ vector<int> v{3,1,2}; sort(v.begin(),v.end());
  for(int x: v) cout << x << " "; cout << "\\n"; return 0; }`,
  "__int128 + builtins": `#include <cstdio>
using u128 = unsigned __int128;
int main(){
  u128 a = (u128)1 << 100;            // 128 位字面量/移位
  u128 b = a / 3u;                    // 128 位除法 → 需要 compiler-rt 的 __udivti3
  unsigned long long hi = (unsigned long long)(b >> 64);
  unsigned long long lo = (unsigned long long)b;
  int pc  = __builtin_popcount(0xF0F0u);
  int clz = __builtin_clz(1u);
  int ovf = 0;
  int carry = __builtin_add_overflow(2147483647, 1, &ovf);
  auto bits = __builtin_bit_cast(unsigned, 1.0f);
  printf("%llu %llu %d %d %d %d %u\n", hi, lo, pc, clz, carry, ovf, bits);
  return 0; }`,
  "交互 stdin": `#include <cstdio>
int main(){ int n; while (scanf("%d", &n) == 1) printf("%d\\n", n + 1); return 0; }`,
};

for (const [name, src] of Object.entries(CASES)) {
  const t = Date.now();
  const r = await tc.compile({ source: src, fileName: "main.cpp", opt: 2, debug: true });
  const ms = Date.now() - t;
  if (!r.wasm) { console.log(`✗ ${name}: 编译失败 (exit ${r.exit})\n${r.log.slice(-500)}`); continue; }
  console.log(`✓ ${name}: 编译 ${ms}ms, wasm ${(r.wasm.length / 1048576).toFixed(1)}MB`);
  if (name === "交互 stdin") continue;
  const out = [];
  const code = await tc.run(r.wasm, { onOut: (b) => out.push(b) });
  console.log(`   运行 exit=${code} 输出=${JSON.stringify(Buffer.concat(out.map((b) => Buffer.from(b))).toString().trim())}`);
}
