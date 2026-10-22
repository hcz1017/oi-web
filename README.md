# oi-web —— WebC++：浏览器里的 C++ 编译、运行、补全、调试

纯静态、零后端的 **VS Code for the Web** 环境：**WASM 版 Clang** 把单文件 C++ 编译成
`wasm32-wasip1`，在**真实终端**里交互运行，**clangd.wasm** 提供补全 / 诊断 / 跳转，
**wdb**（独立项目）提供源码级断点调试。全部跑在浏览器里，代码不离开页面。

```
┌──────────────────────────────────────────────────────────────┐
│  VS Code Web（静态站，固定 8083 本地 / CF Pages 线上）        │
│   ├─ 扩展 web-cpp-tool（WebC++）：编译 · 终端 · clangd · 调试宿主        │
│   └─ wdb：插桩 · 暂停运行时 · DWARF 符号引擎 · DAP 适配器     │
└──────────────────────────────────────────────────────────────┘
```

## 两个仓库

| 仓库 | 内容 | 位置 |
|---|---|---|
| **oi-web**（本仓库） | VS Code Web 静态站、扩展本体、clangd、编译工具链、部署脚本 | 当前目录 |
| **wdb** | 通用的浏览器内 WebAssembly 源码级调试器（AGPL-3.0-or-later） | `./wdb` —— **git submodule** |

`wdb` 是独立仓库（<https://github.com/hcz1017/wdb>），本仓库以 **submodule** 方式挂在 `./wdb`。
构建时把它 bundle 进 `dist/web/*.js`，并把 `wdb/assets/dwarf/` 同步到 `extension/assets/dwarf/`。

```bash
# 克隆时带上 submodule（推荐）
git clone --recurse-submodules https://github.com/hcz1017/oi-web.git

# 已经克隆了但忘了 submodule
git submodule update --init --recursive
```

## 快速开始

```bash
npm install          # @vscode/test-web + wrangler
npm run web          # 启动本地 VS Code Web（固定 8083，中文）
```

打开 <http://127.0.0.1:8083/>。首次运行会自动补齐扩展产物、中文 NLS、test-web 补丁。

| 操作 | 说明 |
|---|---|
| `Ctrl+Shift+B` | 编译并运行当前 `.cpp`（终端里直接打字输入） |
| `Ctrl+D` / `Ctrl+C` | EOF / 终止本次运行 |
| 命令面板 `WebC++: 打开本地文件夹` | 用 File System Access API 打开真实磁盘目录 |
| 命令面板 `WebC++: 显示日志` / `复制日志` | 排查 clangd / 调试问题 |

## 打包与部署

```bash
npm run pack                                        # dist-cf/ + oi-web-cf.zip
npx wrangler pages deploy dist-cf --project-name vscode
```

- **这是本项目的分发方式**：扩展和 VS Code Web 一起打包静态站，用户打开网址即用，什么都不用装
- 说明：`vscode.dev` 不接受「从 VSIX 安装扩展」，所以 `.vsix`（`npm run vsix`）**只是 Marketplace 的上传物**，不是给用户的安装包
- 产物带 `_headers`（COOP/COEP、各资源缓存策略）与 `coi-serviceworker.js`（自动补跨源隔离头，最多刷新 3 次）
- 详见产物里的 `README-deploy.md`
- **所有构建产物都用固定文件名**（不做内容哈希），靠 `_headers` 的 `Cache-Control: no-cache` 保证更新生效

## 其它脚本

```bash
npm run build          # 只打包扩展（esbuild，含从 wdb 同步资产）
npm run nls            # 用官方中文语言包重新生成中文 NLS
npm run patch:test-web # 给 test-web 页面注入中文自愈脚本（幂等）
npm run test:all       # 扩展的自动化测试（含调试全流程，Node 里跑，不需要浏览器）
npm run wdb            # wdb 的自检
```

## 仓库结构

```
run-web.sh                 启动脚本（打包扩展 + 起 @vscode/test-web，必须 --coi）
extension/                 扩展本体
  src/core/                工具链抽象：flags / tar 解析 / clang+wasm-ld 调用
  src/web/                 extension / compileWorker / runWorker / clangd.worker / lsp / fsa-folder
  assets/                  工具链资产（clang/lld/sysroot/clangd）；dwarf/ 由 wdb 同步而来
  docs/CLANGD-WASM-PITFALLS.md   clangd WASM 的 8 个坑（改之前先看）
  notices/                 第三方许可（LLVM / wasi-sdk / 微软 DWARF 引擎）
  test/                    自动化测试（node 直接跑，覆盖编译/终端/调试/DAP）
scripts/                   构建与部署脚本（CF 静态包、中文 NLS、test-web 补丁、open-folder 补丁）
web/                       index 模板、中文 NLS 数据、COI Service Worker
wdb/                       （gitignore）调试器仓库，见上表
```

## 关键设计（踩坑结论，别改回去）

1. **编译 worker 常驻**（持有 28MB 工具链），**运行 worker 每次新建**：`Ctrl+C` 只杀运行实例，不必重下工具链。
2. **一个源文件一个终端**，各自独立的编译/运行实例。
3. **stdin 交互**走 `SharedArrayBuffer` 单槽 + 宿主队列 + consumed 握手（主线程不能 `Atomics.wait`）。
4. **clangd 是 pthreads 构建**：worker 必须是**经典脚本**，glue 用运行时动态 `import()` 加载；
   `callMain` 会返回（Asyncify），必须在它之前把线程池预建好。
5. 需要 **COOP/COEP**（`--coi`）：pthreads 与 SharedArrayBuffer 都要求跨源隔离。
6. **栈统一 512MB**（普通与调试构建一致），深递归不再爆栈；调试暂停只做分段快照。
7. **wasi-shim 的 argv 缓冲区必须按 UTF-8 字节算**（上游 0.4.2 的 bug，`scripts/patch-wasi-shim.mjs` 修）。

## 调试（源码级）

`F5` 或命令面板 `WebC++: 调试当前文件`：源码级断点、单步（next / step in / step out）、
调用栈、变量、watch 表达式。调试器内核是独立项目 **wdb**：

- 原理：编译期链入 `wdb-stub.c`（预置 `wdb.probe` / `wdb.pause` 两个 import）→ 语句级插桩 →
  运行时命中探针后 `Atomics.wait` 冻结 → 快照栈与内存 → DWARF 引擎翻译回源码行
- 已知限制：不执行用户代码（`v.size()` 这类调用式表达式求不了值）；仅当前文件断点；
  优化级别过高会减少可断点行

## 测试

```bash
npm run test:all   # 编译 / 终端行编辑 / 调试插桩 / 会话 / 求值 / 变量 / STL / DAP 全流程 / DWARF 引擎
```

## 许可证

- 本仓库：**AGPL-3.0-or-later**（见 `LICENSE`）
- `wdb`：AGPL-3.0-or-later；其 `wdb-stub.c` 带例外条款，**链接进用户程序不会传染 AGPL**
- 工具链二进制（Clang/LLVM、wasi-sdk、clangd、微软 DWARF 引擎）来源与许可见
  `extension/notices/THIRD-PARTY-NOTICES.md`

**你的程序归你**：本仓库对编译/插桩产物不主张任何权利。
