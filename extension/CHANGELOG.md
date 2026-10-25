## [0.2.0] - 2026-10-25

线上此前是 0.1.4，这一版把桌面版从"半残"做成"能用"，并修掉一批调试/补全问题。

### 新增：桌面版（Node 扩展宿主）
**目标：无需任何配置就能写 C++。** 同一个 VSIX 同时适用于网页版与桌面版：
`browser` 入口给网页版，`main` 入口给桌面版，平台差异全部收在
`src/platform-web.js` / `src/platform-node.js`，构建时按 esbuild alias 切换。

- **编译 / 运行 / 交互输入**：桌面版在 Node 宿主里跑，`SharedArrayBuffer` 与 `Atomics`
  原生可用（不需要跨源隔离），所以终端 stdin 与断点暂停都正常。
- **worker 复用同一份产物**：Node 侧用 `worker_threads` + 垫片（`src/node/worker-shim.cjs`）
  把 worker_threads 伪装成 Web Worker（`self` / `postMessage` / `importScripts` / `fetch(file://)`）。
- **clangd(WASM) 在桌面端跑通**（不依赖任何外部 clangd、不使用 webview）：
  clangd.wasm 是 emscripten 的浏览器构建，在 Node 里需要三处伪装 ——
  1. 载入 glue 时**文本改写** `ENVIRONMENT_IS_NODE=false`（否则断言
     "node environment detected but not enabled at build time"；不能全局删
     `process.versions.node`，Node 的 undici 会炸）；
  2. 伪造 `globalThis.WorkerGlobalScope`（`ENVIRONMENT_IS_WORKER` 靠它判断）；
  3. 全局 `Worker` → `worker_threads.Worker`，把 `name` 传成 `self.name="em-pthread-N"`
     （`ENVIRONMENT_IS_PTHREAD` 靠它判断），并让 `addEventListener("message")` 真正
     接到 `parentPort`（emscripten 的 pthread 主线程 mailbox 靠它）。
  另外补了：`Blob` 同步实现、`URL.createObjectURL` 落盘成 `.mjs`、`fetch(file://)`，
  以及**给 fd 0/1/2 装 `stream_ops`**（fd1/2 用 write/put_char 转发到 worker 的 stdout/stderr）。
  实测：`initialize` 6ms、`didOpen` 正常、`hover` 4.1s（首次建 preamble）、
  `completion` 首次 1.6s、之后约 180ms。
- **头文件虚拟 FS**：桌面版 `assetsBase()` 是文件路径，不能 `fetch` ——
  改为平台层 `readAssetGzText()`（web 用 fetch+DecompressionStream，桌面用 fs+gunzip），
  这样 `Ctrl+点击 #include <vector>` 能正常打开头文件。

### 新增：崩溃（trap）自动定位
以前程序越界 / `unreachable` / 除零 / 栈溢出，只有一个 `exit code`，看不出在哪炸。
现在调试器会捕获 wasm trap 并**停在崩溃处**：

- 终端里红字给出原因（`divide by zero` / `memory access out of bounds` / `unreachable` …）
  和「崩溃前最后执行的一句」`文件:行`；
- **影子实例重放**：崩溃后用同一份 wasm + 录制的 stdin 重跑一遍，停在"崩溃前最后那一句" ——
  于是「调用栈」是**完整真实**的（含调用链），变量面板里的 **locals 也是崩溃瞬间的值**
  （实测：除零崩溃 → 定位 `trap.cpp:7`、栈 2 帧、`z = 0`、`k = 2`）；
  重放失败（需要交互输入且输入不足 / 预算超限）时自动退回简版：只给原因 + 最后一句 + 全局/堆；
- 崩溃后会话保持暂停，等你按「停止」再结束，不会一闪而过；
- 单步在崩溃后无意义，统一按 continue 处理。

### 修复
- **断点"已验证但程序不停"**：VS Code 会为工作区里每个有断点的文件各发一次
  `setBreakpoints`，以前每次覆盖 `enabledSites`，最后一个文件（别的 `.cpp`）把集合清空。
  现在按来源文件分别保存取并集。
- **别的文件的断点导致乱停**：`_resolveLine` 只按行号在当前目标站点表里查，
  别的文件第 15 行会命中当前文件第 15 行站点并被标成"已验证"。
  现在校验来源文件（解码后 basename 比较），不匹配一律 `unverified` 且不启用站点。
- **中文文件名无法调试**：DWARF 引擎返回的源文件 URL 是 percent-encoded，断点查表用的是
  原始字符串 → 全部未验证。现在按解码后的文件名统一比较（断点表、栈帧 source、用户文件判定）。
- **`F5` 调试的不是当前文件**：F5 走通用启动路径，不经过命令 → 目标为空退化成 `main.cpp`。
  现在命令与 F5 共用「取活动编辑器作为调试目标」，并且目标用掉即清。
- **调试构建 `wasm-ld: cannot open /workspace/dbgstub.o`**：compile worker 里只有一份
  Toolchain / 一份内存 FS，两条编译消息并发会互相删文件。现在 worker 内部串行排队。
- **桌面版 DWARF 引擎 `ENOENT …/SymbolsBackend.wasm`**：上游 node 引擎按自己所在目录找
  wasm，现在把引擎一起拷进临时目录。
- **`Cannot find package 'vscode-languageclient'` / `Worker is not defined`**：
  Node bundle 里内联 LSP 客户端（并加 `browser` 解析条件），并给 `Worker` 一个占位符
  （browser client 的 `instanceof Worker` 在 Node 里连标识符求值都会抛）。
- **`ioctl_tiocgwinsz` 崩溃**：把 `stream.tty` 设成 `true` 会让 emscripten 的 ioctl 读
  `stream.tty.ops` 时炸；改为不动 `tty`、只装 `stream_ops`。
- **`.clangd` 里的 `Tidy` 键不被识别**（报 `Unknown Config key 'Tidy'`）：已删除该键，
  clang-tidy 本来就用 `--clang-tidy=false` 关着。
- **激活失败排查**：去掉 `extensionKind`（桌面版等价于"必须跑 Node 宿主"，只有 `browser`
  入口时永远不会激活），激活流程分步 try/catch + 分环境自述日志，失败写进输出通道。

### 新增：RE 在 VS Code 里"像个异常"
- 调试器声明 `supportsExceptionInfoRequest`：程序崩溃暂停时，VS Code 的
  「调用堆栈」面板会显示**异常条目**，点开能看到 `exceptionInfo`——
  分类成用户能看懂的话（数组越界 / 除零 / 栈溢出 / unreachable）+ 崩溃前最后一句的 文件:行；
- 终端里红底白字横幅 `⚠ 运行时错误 (RE)`，不再像普通断点一样只有一条 stopped。

### 新增：编译缓存（代码没变就不编译）
- 终端 `Ctrl+Shift+B` 与 `F5` 调试共用一套缓存：按 `源码+文件名+参数+优化级` 做键，
  代码/参数没变就直接复用上一版产物，日志显示
  `[编译缓存命中，跳过编译（代码未变化）]`；
- 缓存放 `globalState`（重启 VS Code 也有效），LRU 最多 8 条、单条 ≤32MB；
- 调试版和运行版分开缓存（debugStub/优化级参与键）。

### 测试
- `dap-flow` 增加回归：别的文件的断点必须未验证，且目标文件断点仍能命中；
- `debug-vars` / `debug-eval` 修好（暂停快照早已改为分段 `memorySegments`，
  这两个测试还在用旧的整块 `memory`，导致 `no frame` 误导性报错）。

# Changelog — WebC++ (`web-cpp-tool`)

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-10-24

### 新增：桌面版（Node 扩展宿主）真正可用
桌面 VS Code 的 Web 扩展宿主没有跨源隔离 → 没有 `SharedArrayBuffer` → 交互 stdin 和断点调试都不可用。
0.2.0 增加 **Node 入口**（`main`），在 Node 宿主里跑同一份源码（平台差异全部收在
`src/platform-web.js` / `src/platform-node.js`，构建时用 esbuild alias 切换）：

- **worker**：Node 版用 `worker_threads` + 垫片（`src/node/worker-shim.cjs`）跑**同一份** IIFE 产物，
  垫片补齐 `self` / `postMessage` / `importScripts` / `fetch(file://)`；
- **交互 stdin / 断点暂停**：Node 里 `SharedArrayBuffer` 与 `Atomics` 原生可用，**无需跨源隔离** → 全部恢复；
- **DWARF 引擎**：桌面版用上游的 node 版引擎（Emscripten node 分支），
  wasm 从 `SymbolsBackend.wasm.gz` 首次运行解压到临时目录（`fs` 相对路径重定向，因为 worker 里不能 chdir）；
- **clangd**：桌面版暂不启动（`vscode-languageclient/browser` 与 emscripten 的 node 分支要另做），
  编译/运行/调试不受影响；日志里会说明。
- 宿主入口：`browser` → `dist/web/extension.js`，`main` → `dist/node/extension.js`；
  同一个 VSIX 两边都能装。

### 踩坑与修复（都记在这里，仍是 0.2.0）
- **VSIX 不能打 `--target web`**：那会把它标记成 web 专用 → 桌面只给 `LocalWebWorker` 宿主，
  而该宿主里 `fetch(vscode-file://…)` 悬挂 → `createWorker()` 不返回 → 报"工具链加载超时"。
  改为通用 target + `extensionKind: ["workspace"]`，桌面走 **Node 扩展宿主**。
- **Node 端 worker 包装必须支持 `onmessage` 属性**：只实现 `addEventListener` 时消息收不到，
  同样表现为"工具链加载超时"。新增 `src/node/wrap-worker.js` 两种订阅都支持。
- `createWorker()` 的 fetch 加 15s 超时，避免宿主静默悬挂。

### 桌面版 clangd：**内置 wasm clangd 跑通了（不依赖外部 clangd）**
clangd.wasm 是 emscripten 的浏览器构建，在 Node 里需要三处伪装（都在
`src/node/worker-shim.cjs` 的 `browserEmulation` 模式里，默认关闭，只有 clangd 用）：

1. 载入 glue 时**文本改写** `ENVIRONMENT_IS_NODE=false`（否则运行时断言
   "node environment detected but not enabled at build time"；不能全局删
   `process.versions.node`，Node 的 undici 会炸）；
2. 伪造 `globalThis.WorkerGlobalScope`（`ENVIRONMENT_IS_WORKER` 靠它判断）；
3. 全局 `Worker` 映射到 `worker_threads.Worker`，并把 `name` 传成 `self.name="em-pthread-N"`
   （`ENVIRONMENT_IS_PTHREAD` 靠它判断），同时 `parentPort → self.onmessage` 转发，
   且 `addEventListener("message")` 必须真的接上（emscripten 的 pthread 主线程 mailbox 用它）。

另外补了：`Blob` 同步实现、`URL.createObjectURL` 落盘成 `.mjs`、
`fetch(file://)` 支持、fd1/fd2 强制 TTY（`put_char`）。

实测（Node，走桌面版真实代码路径）：
`pthread #1..#4 loaded` → `callMain` → 发 `initialize` → **5.2s 收到完整 capabilities**
（completion / hover / definition / semanticTokens / inlayHint / documentSymbol …）。

### 旧的原生 clangd 方案（已删除）
wasm 版 clangd 是 emscripten 的浏览器构建（pthread 用 `new Worker(...,{type:'module'})`），
Node 里没有对应构建。桌面版改为：从 `PATH`（或设置 `oiCpp.clangdPath`）找原生 `clangd`，
用 `vscode-languageclient/node` 走 stdio 连接，编译参数通过临时目录里的 `.clangd` 传入。
找不到 clangd 时只提示、不影响编译运行调试。

### 修复：断点"已验证但程序不停"
VS Code 会为**每个有断点的文件**各发一次 `setBreakpoints`。以前每次都用本次结果覆盖
`enabledSites`，于是最后一个文件（通常是别的 `.cpp`，在当前调试目标里查不到站点）
把集合清空 → 日志里能看到「断点 1/1 已验证」但「启动调试运行 worker（…，断点 0 个）」。
现在按来源文件分别保存取并集。

### 修复：并发编译导致 `wasm-ld: cannot open /workspace/dbgstub.o`
compile worker 里只有一个 Toolchain、一份内存 FS，之前两条 compile 消息可以并发
（例如"调试构建"和终端里的 `Ctrl+Shift+B` 同时触发）→ 互相删掉 out.o/dbgstub.o。
现在 worker 内部**串行排队**，并且排队任务里的异常也会回报给宿主。

### 验证
- Node 链路：垫片里 compile worker `ready`、调试版（debugStub）编译成功、node 版 DWARF 引擎 `hello` 成功。
- Web 链路回归：冒烟 + DAP 全流程（ASCII / 中文文件名）全绿。

## [0.1.5] - 2026-10-24

### 修复
- **移除 `extensionKind: ["workspace"]`**：按 VS Code 的映射规则，桌面版里这个值等价于
  "跑在唯一的 Nodejs 扩展宿主"；而本扩展只有 `browser` 入口，Node 宿主加载不了它
  → 表现为"装了但永远不激活"。
- **激活过程加固 + 分步日志**：
  - 模块加载时先打 `[WebC++] bundle loaded`（区分"bundle 没跑"与"activate 内某步挂了"）；
  - `ensureBreakpointsEnabled()`（改配置，虚拟工作区里会抛）、头文件虚拟 FS、本地文件夹、
    clangd 启动各自独立 try/catch —— 以前任何一处抛错都会中断后续注册，
    看起来就像"扩展没激活"；
  - 失败写进「WebC++」输出通道，不再只进 devtools console。

### 说明
- 桌面版仍需要 VS Code 的 **Web 扩展宿主**；若你的 VS Code 在本地文件夹下只提供 Nodejs 宿主，
  本扩展无法激活（这不是 bug，是 web 扩展的宿主限制）。

## [0.1.4] - 2026-10-24

### 新增
- **同一个 VSIX 兼顾网页版与桌面版**：worker 创建统一走 `createWorker()`
  —— 同源直接建，跨源 CDN 或桌面 `vscode-file://` 时自动 fetch 成 blob 再建。
  之前只有 clangd 有这层兜底，编译/运行/调试/符号引擎四个 worker 在桌面宿主里会直接失败。
- 激活时输出**环境自述**一行日志（uiKind / crossOriginIsolated / SharedArrayBuffer /
  extensionUri scheme），桌面端排障靠它。

### 说明
- 桌面端依赖 VS Code 的 **Web 扩展宿主**；终端交互输入与断点调试需要 SharedArrayBuffer，
  若该环境不提供，会明确提示而不是静默失败。
- 仍然只有一个制品：`web-cpp-tool-web-<版本>.vsix`，不再区分 web/桌面两套。

## [0.1.3] - 2026-10-24

### 修复
- **`.clangd` 里的 `Tidy` 键不被这版 clangd 识别**，会报
  `Unknown Config key 'Tidy'`（clangd-config 诊断）。已删除该键；
  clang-tidy 本来就在启动参数里用 `--clang-tidy=false` 关着，行为不变。
- 保留**跨文件补全**（用户反馈好用，`Completion.AllScopes` 保持 clangd 默认值）。

## [0.1.2] - 2026-10-23

### 修复
- **按 F5 调试的不是当前文件**：F5 走的是通用启动路径，不经过「WebC++: 调试当前文件」命令，
  于是调试目标为空，适配器退化成硬编码的 `main.cpp` —— 结果编译的是一个不存在的空文件，
  断点自然全部无法验证。现在「取活动编辑器作为调试目标」抽成公共函数，
  命令与 F5 共用；活动文件不是 C/C++ 时明确提示并中止启动。
- 调试目标「用掉即清」：避免上一次会话的目标被下一次 F5 复用（切了文件还能调试"上一个文件"）。
- `uri.path` 若是 percent-encoded 会先解码，再用作编译文件名。
- 版本号说明：`0.1.1.2` 不符合 Marketplace 的 semver 校验（实测报
  `Invalid extension "version"`），按语义发成 `0.1.2`。

## [0.1.1] - 2026-10-23

### 修复
- **中文文件名无法调试**：文件名含中文时，DWARF 引擎返回的源文件 URL 是 percent-encoded
  （`%E4%BA%8C…`），而断点查表用的是原始字符串 → 断点全部显示为「未验证」、程序停不下来。
  现在统一按「解码后的文件名」比较来源 URL（断点查表、栈帧 source、用户文件判定四处）。
  中文**目录**一直没问题，只有文件名受影响。
- 目录/文件名混合中文、含空格的情形同样受益。

### 工程
- 调试器内核 wdb 升到 0.1.1（同一处修复）。
- CI（GitHub Actions）：checkout 带 `submodules: recursive`（wdb 是 submodule，否则构建直接失败）；
  Node 升到 22；未配置 Cloudflare secrets 时跳过部署步骤而不是报红。

## [0.1.0] - 2026-10-22

首个可用版本。

### 新增
- **WASM 编译运行**：Clang 22.1.8（`wasm32-wasip1`）在浏览器内编译单文件 C++，
  真实终端交互运行（`Ctrl+Shift+B` / `Ctrl+D` EOF / `Ctrl+C` 终止）。
- **clangd 智能提示**：补全、悬浮、跳转、诊断、格式化；含参数名与推导类型的 inlay hints。
- **源码级断点调试**：断点、单步（next / step in / step out）、调用栈、变量、watch 表达式。
  单步语义对齐 gdb：断点优先、`next` 不越帧、`stepOut` 以栈深度变浅为准。
- **打开本地文件夹**：基于 File System Access API（`oiCpp.openFolder`）。
- **日志通道**：「WebC++」输出通道，命令 `显示日志` / `复制日志`。
- **中文界面**：内置简体中文语言包与中文命令文案。
- **自托管打包**：`npm run pack` 产出可直接部署 Cloudflare Pages 的静态站。

### 调试器内核
- 调试能力已抽成独立项目 **[wdb](https://github.com/hcz1017/wdb)**（AGPL-3.0-or-later，
  stub 带例外条款），本扩展作为其中一个 DAP 宿主。

### 说明
- 栈统一 512MB，深递归不再爆栈（调试与普通构建一致）。
- 调试栈大，但暂停只做分段快照（低区 + 实际用到的栈），不会因为栈大而卡顿。
