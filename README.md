# oi-web —— 浏览器里的 C++（WASM 工具链 + 真终端 + clangd）

纯静态、零后端的 **VS Code for the Web** 环境：用 **WASM 版 Clang** 编译单文件 C++ 到
`wasm32-wasip1`，在**真实 VS Code 终端**里交互运行，并由 **clangd.wasm** 提供补全 / 悬浮 / 跳转 / 诊断。

> 历史：早期版本用 v86 模拟 Alpine x86 跑真 gcc/g++/gdb，已整体移除（本仓库只保留 WASM 方案）。

## 快速开始

```bash
npm install          # 只装 @vscode/test-web（依赖都在本仓库 node_modules）
npm run web          # 启动本地 VS Code Web（固定 8083，中文，空工作区）
```

打开 <http://127.0.0.1:8083/>。首次运行会自动补齐：扩展打包产物、中文 NLS、test-web 补丁。

### 打包（部署到 Cloudflare Pages）

```bash
npm run pack         # 生成 dist-cf/ 与 oi-web-cf.zip
```

- 产物带 `_headers`（COOP/COEP）与 `coi-serviceworker.js`（自动补响应头，最多刷新 3 次）
- 到 CF Pages → Create → Pages → Upload assets，上传 zip 即可
- 详见产物里的 `README-deploy.md`


### 打开本地文件夹（浏览器文件系统）

vscode-web 自带的「打开文件夹」在空窗口下是坏的（`FileDialogService.pickFolderAndOpen` 直接抛错），
本扩展用 File System Access API 自己实现了：

- 命令面板运行 **`OI C++: 打开本地文件夹（浏览器）`** → 选一个磁盘目录
- 该目录以 `oi-fs:` 协议挂进工作区 → 左侧文件树、编译、clangd、调试全部读写真实文件
- 目录句柄存 IndexedDB，刷新后仍在（Chrome 保留授权；未授权会提示重新选择）
- 需要 Chrome/Edge 桌面版 + https 或 localhost

### 其它脚本

```bash
npm run build          # 只打包扩展（esbuild）
npm run nls            # 用官方中文语言包重新生成中文 NLS
npm run patch:test-web # 给 test-web 页面注入中文自愈脚本（幂等）
npm run test:all       # 扩展的自动化测试
```

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

## 调试（源码级，WASM）

编辑器标题栏的 **🐞 按钮**（或命令面板 `OI C++: 开始调试（WASM）`）：

1. 打开要调试的 `.cpp`，点按钮
2. 首次会先编译调试版本（`-O0 -g` + 插桩），再启动会话
3. 在行号左侧下断点 → 命中断点/单步/看调用栈与输出

实现：DWARF 符号层用微软 `@vscode/dwarf-debugging` 的 `SymbolsBackend.wasm`（Chrome cxx_debugging，MIT），
执行控制用"编译期预置 import + 语句级插桩 + SharedArrayBuffer 暂停"，外壳是 VS Code 原生 DAP。

当前限制（MVP）：
- 只支持调试**当前打开的那个源文件**的断点；头文件/其它文件的断点显示为未绑定
- `stepOver` 用"同一函数体内的下一条语句"近似；步入库函数会直接落到下一条用户语句
- 变量面板：内存里的变量可读；`locals`/`globals` 依赖的暂停快照尚未实现，会显示不可用
- 调试会话的 stdin 暂为空（运行态的交互 stdin 不受影响）

## 状态

- ✅ WASM 编译（cc1 + wasm-ld，`bits/stdc++.h` 可用）、真实终端交互 stdin、多文件独立终端
- ✅ clangd：补全 / 诊断 / 符号 / 语义高亮 / 跳转（跳标准头文件走只读虚拟 FS `clangd-hdr:`）
- ⚠️ 已知问题：clangd(WASI) 的 **stdout 行缓冲**——响应要等下一次 stdin 输入才被 flush，
  表现为「悬浮/跳转偶尔要等下一条请求才出结果」。当前用传输层 flush pump 缓解，长期方案见下条。
- ✅ **调试 MVP**：行断点 / 继续 / stepIn / stepOut / 调用栈 / 输出 / 崩溃栈；变量为部分支持
- ⏭ 后续：`locals` 快照（完整变量面板）、条件断点、头文件断点、`stepOver` 精确化
- 规划与调研：[`oi-cpp-wasm/docs/WASM-GDB-PLAN.md`](oi-cpp-wasm/docs/WASM-GDB-PLAN.md)

## 许可

扩展代码 MIT。`oi-cpp-wasm/assets/` 下的工具链二进制来自 C++ Studio Web（Clang/LLVM、wasi-sdk、clangd），
许可证与来源见 `oi-cpp-wasm/notices/`。
