# Third-party notices / 第三方组件声明

本扩展自身的代码是 MIT（见 ../LICENSE）。下列第三方组件随包分发，各自许可见下。

## 1. WASM 工具链（assets/）

| 文件 | 内容 | 许可 |
|---|---|---|
| `assets/clang.wasm.gz` | Clang 22.1.8 编译到 WebAssembly（wasm-llvm 构建） | Apache-2.0 WITH LLVM-exception |
| `assets/lld.wasm.gz` | 同一 LLVM 构建的 `wasm-ld` | Apache-2.0 WITH LLVM-exception |
| `assets/sysroot.tar.gz` | wasi-sdk sysroot：libc++ 头文件 + wasi-libc（含 musl 派生代码） | Apache-2.0 WITH LLVM-exception；Apache-2.0；MIT；BSD-2/3-Clause；CC0-1.0 |
| `assets/clangd/clangd.wasm.gz` | clangd（LLVM 22.1.8）编译到 WebAssembly | Apache-2.0 WITH LLVM-exception |
| `assets/clangd/clangd.js` | 上述 wasm 的 Emscripten 生成胶水代码 | Apache-2.0 WITH LLVM-exception（Emscripten 胶水为 MIT/NCSA） |
| `assets/clangd/headers.json.gz` | 上述 sysroot 的路径→内容快照（供 clangd 虚拟文件系统） | 同 sysroot |
| `assets/compat/bits/stdc++.h` | 兼容聚合头（libc++ 的等价物，**非** GCC libstdc++/PBDS） | MIT（本仓库） |

LLVM 许可原文见 `notices/LLVM-LICENSE.txt`；WASI 相关许可见 `notices/licenses/WASI-Apache.txt`、`notices/licenses/WASI-MIT.txt`。

> 这些二进制不是本项目构建的，来源为 C++ Studio Web（MIT）随包分发的 wasm-llvm 工具链产物；
> 本项目仅原样再分发，未修改二进制。构建上游：LLVM 22.1.8 / wasi-sdk。

## 2. JavaScript 依赖（已 bundle 进 dist/web/*.js）

| 依赖 | 版本 | 许可 |
|---|---|---|
| `@bjorn3/browser_wasi_shim` | ^0.4.2 | MIT / Apache-2.0（双许可） |
| `vscode-languageclient` | ^10.1.2 | MIT |
| `vscode-jsonrpc`（由上一项引入） | 随版本 | MIT |
| `esbuild`（仅构建期，不随包） | ^0.28.2 | MIT |

## 3. 说明

- 本扩展不包含 GCC/libstdc++ 代码；`bits/stdc++.h` 是我们自写的 libc++ 聚合头。
- 编译产物（用户程序）链接的 `libc.a`/`libc++.a`/`libc++abi.a` 来自 wasi-sdk sysroot，其许可见上表；
  用户程序的分发不受本项目许可约束。

## @vscode/dwarf-debugging（DWARF 符号引擎）

- 用途：把源码行映射到 wasm 指令偏移、解析变量与表达式（调试功能的符号层）
- 来源：Microsoft，`@vscode/dwarf-debugging@0.0.2`
  - <https://github.com/microsoft/vscode-dwarf-debugging>
  - 其上游是 Chrome DevTools 的 C/C++ DWARF 调试扩展：
    <https://github.com/ChromeDevTools/devtools-frontend/tree/main/extensions/cxx_debugging>
- 许可证：MIT（Copyright (c) Microsoft Corporation）
- 本仓库里的产物：
  - `assets/dwarf/SymbolsBackend.wasm.gz`：原样取得的 DWARF 引擎（重新 gzip 压缩）
  - `assets/dwarf/worker.js`：上游 worker 的浏览器适配版（`scripts/build-dwarf-worker.mjs` 生成：
    仅在文件头注入 require/`parentPort`/`fs` shim，其余逻辑未改）
  - `assets/dwarf/LICENSE`：原许可证全文

## 中文语言包翻译数据（web/zh-main.i18n.json）

- 来源：Microsoft `MS-CEINTL.vscode-language-pack-zh-hans`（Visual Studio Code 官方简体中文语言包）
- 许可证：MIT（见 https://marketplace.visualstudio.com/items?itemName=MS-CEINTL.vscode-language-pack-zh-hans）
- 用途：构建时生成 vscode-web 的中文 `nls.messages.js`（仅包含翻译文本，不含代码）
