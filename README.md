# oi-web —— 浏览器里的 C++（WASM 工具链 + 真终端 + clangd）

纯静态、零后端的 **VS Code for the Web** 环境：用 **WASM 版 Clang** 编译单文件 C++ 到
`wasm32-wasip1`，在**真实 VS Code 终端**里交互运行，并由 **clangd.wasm** 提供补全 / 悬浮 / 跳转 / 诊断。

> 历史：早期版本用 v86 模拟 Alpine x86 跑真 gcc/g++/gdb，已整体移除（本仓库只保留 WASM 方案）。

## 快速开始

```bash
npm install            # 只需 @vscode/test-web（用于起官方预构建的 VS Code Web）
./run-wasm-web.sh      # 默认 http://127.0.0.1:8083
```

- 打开 `main.cpp`（`oi-cpp-wasm/sample/` 是默认工作区）
- `Ctrl+Shift+B`：编译并在终端运行（可交互 stdin；每个 `.cpp` 一个独立终端）
- 首次启动会加载 24MB 的 clangd.wasm；状态栏显示「clangd 就绪」后补全/悬浮可用

环境变量：`PORT=9000`、`SAMPLE=/path/to/dir`、`HOST=0.0.0.0`。

## 仓库结构

```
run-wasm-web.sh            启动脚本（打包扩展 + 起 @vscode/test-web，必须 --coi）
oi-cpp-wasm/               扩展本体（VS Code Web 扩展，entry: dist/web/extension.js）
  src/core/                工具链抽象：flags / tar 解析 / clang+wasm-ld 调用
  src/web/                 extension / compileWorker / runWorker / clangd.worker / lsp
  assets/                  工具链资产（clang.wasm.gz、lld.wasm.gz、sysroot.tar.gz、
                           clangd/{clangd.js,clangd.wasm.gz,headers.json.gz}）
  notices/                 第三方许可证（工具链来自 C++ Studio Web，见 THIRD-PARTY-NOTICES）
  docs/WASM-GDB-PLAN.md    **调试（断点/单步/变量）方案调研与分阶段规划**
  test/smoke.mjs           Node 冒烟测试（用浏览器同一条编译/运行代码路径）
```

## 关键设计（踩坑结论，别改回去）

1. **编译 worker 常驻**（持有 28MB 工具链），**运行 worker 每次新建**：Ctrl+C 只杀运行实例，不必重下工具链。
2. **一个源文件一个终端**，各自独立的编译/运行实例，互不干扰。
3. **stdin 交互**走 `SharedArrayBuffer` 单槽 + 宿主队列 + consumed 握手（主线程不能 `Atomics.wait`）；
   emscripten 的 `stdin()/stdout()` 都是**按字节**回调。
4. **clangd 是 pthreads 构建**：worker 必须是**经典脚本**（IIFE），glue 需运行时把 ESM 转经典脚本；
   `callMain` 会返回（Asyncify），必须在它之前 `drainPending()`。
5. 需要 **COOP/COEP**（`--coi`）：pthreads 与 SharedArrayBuffer 都要求跨源隔离。

## 状态

- ✅ WASM 编译（cc1 + wasm-ld，`bits/stdc++.h` 可用）、真实终端交互 stdin、多文件独立终端
- ✅ clangd：补全 / 诊断 / 符号 / 语义高亮 / 跳转（跳标准头文件走只读虚拟 FS `clangd-hdr:`）
- ⚠️ 已知问题：clangd(WASI) 的 **stdout 行缓冲**——响应要等下一次 stdin 输入才被 flush，
  表现为「悬浮/跳转偶尔要等下一条请求才出结果」。当前用传输层 flush pump 缓解，长期方案见下条。
- ⏭ 下一步：**调试能力**（断点 / 单步 / 变量 / 栈）——规划见
  [`oi-cpp-wasm/docs/WASM-GDB-PLAN.md`](oi-cpp-wasm/docs/WASM-GDB-PLAN.md)。

## 许可

扩展代码 MIT。`oi-cpp-wasm/assets/` 下的工具链二进制来自 C++ Studio Web（Clang/LLVM、wasi-sdk、clangd），
许可证与来源见 `oi-cpp-wasm/notices/`。
