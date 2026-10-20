// 编译参数唯一来源：真编译（toolchain.mjs）与 clangd 诊断（clangd.worker.js）都用它，
// 否则会出现"编辑器不报错、真编译失败"的系统性不一致。
export const TRIPLE = "wasm32-wasip1";
export const RESOURCE_DIR = "/lib/clang/22";
export const LIBDIR = "/lib/wasm32-wasi";

// 注意 /compat 必须最前：sysroot 里没有 bits/stdc++.h，它由我们补
export const ISYS = ["/compat", "/include/c++/v1", "/include/wasm32-wasi", "/include", `${RESOURCE_DIR}/include`];

export const SHARED_FLAGS = ["-fno-exceptions", "-nostdinc", "-nostdinc++"];

export const splitFlags = (s) => String(s || "").split(/\s+/).filter(Boolean);

/** clangd 的 compile_commands 用 driver 风格参数（-isystem 分开写） */
export function clangdArgs(userFlags, filePath, { opt = 2, debug = true } = {}) {
  const { kept } = filterUserFlags(splitFlags(userFlags));
  return [
    "clang++", `--target=${TRIPLE}`,
    `-O${opt}`,
    ...(debug ? ["-g", "-debug-info-kind=standalone", "-dwarf-version=4", "-debugger-tuning=gdb"] : []),
    ...kept,
    "-isysroot", "/",
    ...SHARED_FLAGS,
    ...ISYS.flatMap((d) => ["-isystem", d]),
    filePath,
  ];
}

/** 会破坏我们输出约定的 flag（用户配置里写了就必须过滤掉） */
// 无参数（直接丢）、带参数（连它的值一起丢）
const FORBIDDEN_BARE = [/^-c$/, /^-S$/, /^-E$/, /^-fsyntax-only$/, /^-emit-llvm$/, /^-emit-ast$/];
const FORBIDDEN_WITH_VALUE = [/^-o$/, /^-x$/];
const FORBIDDEN_INLINE = [/^-o./, /^--output=/, /^-x./, /^-emit-/];
export function filterUserFlags(flags) {
  // 用户配置里是字符串（"-std=c++20 -DLOCAL"），也可能有人传数组：
  // 这里统一成数组，否则字符串会被按字符遍历（曾导致调试构建拿不到 -std=）
  const list = Array.isArray(flags) ? flags : splitFlags(flags);
  const kept = [], dropped = [];
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    if (FORBIDDEN_WITH_VALUE.some((r) => r.test(f))) {
      dropped.push(f);
      if (i + 1 < list.length) dropped.push(list[++i]);   // 连值一起丢，避免留成"游离输入文件"
      continue;
    }
    if (FORBIDDEN_BARE.some((r) => r.test(f)) || FORBIDDEN_INLINE.some((r) => r.test(f))) { dropped.push(f); continue; }
    kept.push(f);
  }
  return { kept, dropped };
}
