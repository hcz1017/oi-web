# Changelog — WebC++ (`web-cpp-tool`)

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。


## [0.2.5] - 2026-10-27

### 新增：首次启动后台预加载（第一次编译/调试不再等下载）
- 激活后 **1.5s 起**，在后台把编译/调试要用的资产按清单逐个 `fetch` 一遍，灌进浏览器
  HTTP 缓存：`clang.wasm.gz`(15M) → `lld.wasm.gz`(7.5M) → `sysroot.tar.gz`(5.2M) →
  `compat/bits/stdc++.h` → `dwarf/worker.js` → `dwarf/SymbolsBackend.wasm.gz`(13M)，
  **共约 41MB**。第一次按 `Ctrl+Shift+B` / `F5` 就不用再等这几段下载了。
- **不含 clangd**（26M）：打开 `.cpp` 时 clangd 自己会加载，塞进来只会拖慢首屏。
- 纯预热、**完全不参与功能**：fire-and-forget，不 `await`、不阻塞任何命令、**不设超时**、
  单个文件失败只记日志；预加载期间照常编译运行（同一 URL 的请求会被 HTTP 缓存复用）。
- 几个细节：必须把 response body **读完**（只发请求不消费响应体，浏览器不保证写进缓存）；
  用 `pipeTo(WritableStream())` 流式丢弃，不让 15M 驻留内存；严格**串行**，不互相抢带宽。
- 日志（输出面板「WebC++」，不弹通知）：每项一行 + 结尾汇总
  `预加载完成 41.4MB / 12.4s（编译与调试首次使用不再等待下载）`。
- 开关：`oiCpp.preload`（默认 `true`）；桌面版自动跳过（资产在本地磁盘）。

### 测试
- 新增 `test/preload.mjs`（假 fetch，26 项断言）：清单**不得含 clangd**、顺序=清单顺序、
  严格串行、每项都真的读了 body、单项失败/抛异常不影响后续且整体不抛、跳过条件、
  让路延迟生效。

## [0.2.4] - 2026-10-27

### 修复：断点又停不下来（0.2.2 那次修复的反向过头）
上一版为了修「别的目录的同名文件把断点串过来」，把判定改成了**完整路径全等**——
结果同一文件的另一种写法永远对不上，断点全变灰、程序根本不停。真实日志：

```
DAP ← setBreakpoints {"source":{"name":"a.cpp","path":"\\ws\\sub\\a.cpp"},"lines":[10]}
断点 \ws\sub\a.cpp: 忽略（不是当前调试目标 a.cpp）     ← 明明是同一个文件
```

宿主给的 path 是「工作区根名 + 反斜杠、没有 scheme」，而我们手里是
`file:///ws/sub/a.cpp`，字符串比较必然失败。

**改成三层判定，任一层成立即认为是同一文件**（`sameSourceFile`）：
1. 归一化后完全相等；
2. **路径部分**相等（去掉 scheme://authority 之后）；
3. 按路径分量**从尾部逐级**比较，以较短者为准（兼容工作区相对路径 / 只剩文件名）。

同时保留硬性否决：**文件名不同就一定不是同一文件**——这一条挡住"别的文件的断点命中同号行"。
percent-encoded 与原始中文名的差异也在归一化层解决。

### 测试
- 新增 `wdb/test/same-source.mjs`（20 条断言，纯函数）：同一文件的 9 种写法都判「是」，
  不同文件的 6 种情形都判「否」（含同名前缀、同目录不同文件、同名不同目录）；
- `dap-flow` 增补 DAP 层回归：同一文件用 `\\mount\\a.cpp` 这种反斜杠写法发来的断点，
  也必须验证通过。

## [0.2.3] - 2026-10-26

### 新增：调试启动横幅（仿 gdb 起手那几行）
开始编译前，调试终端先打印一段出处信息——第一次用的人能立刻知道这是自己写的调试器、
什么许可证、源码在哪：

```
wdb 0.1.3 —— WebAssembly 源码级调试器（gdb 的 w 版）｜WebC++ 0.2.3
Copyright (C) 2026 hcz1017 及贡献者
License AGPL-3.0-or-later：GNU Affero 通用公共许可证第 3 版或更新 <https://www.gnu.org/licenses/agpl-3.0.html>
桩文件（wdb-stub.c / LICENSE.exception）另有链接例外，随作品分发不受 AGPL 传染。
这是自由软件：你可以自由修改与再分发；不提供任何担保。
源码与反馈：https://github.com/hcz1017/wdb　｜　WebC++ 扩展：https://github.com/hcz1017/oi-web
```

- 版本、许可证、仓库地址统一放在 `wdb/src/version.js`，宿主扩展版本由 WebC++ 传入（不硬编码）；
- 新增 `wdb/test/version-banner.mjs`：钉住 `version.js` 与 `wdb/package.json` 一致，并用假终端
  真跑一次 `_banner()` 断言六项关键内容都在、换行是 CRLF（VS Code 终端要求）。

### 修复：中文文件名在终端/调用栈里显示成 `%E4%B8%AD%E6%96%87.cpp`
- DWARF 里的文件名是 **percent-encoded** 的（`中文.cpp` → `%E4%B8%AD%E6%96%87.cpp`）。之前只有
  「路径比较」走了 `sourceBaseName()`（会解码），**显示**却直接 `split("/").pop()`，
  于是 RE 横幅写成「崩溃前最后执行的一句：%E4%B8%AD%E6%96%87.cpp:7」、调用栈帧名也是乱码。
- 现在 4 处显示（RE 横幅 / 异常详情 / 普通暂停横幅 / 调用栈帧名）统一解码。
- 回归：`dap-trap-flow` 支持 `DAP_TRAP_FILE` 覆盖文件名，`test:all` 会额外用
  `中文名.cpp` 再跑一趟，断言栈帧名与终端横幅都是解码后的名字、横幅里没有 `%XX`。

## [0.2.2] - 2026-10-26

**修 0.2.1 的三个真 bug：缓存从来没生效过、RE 停了但 VS Code 不知道、以及那个"神秘代码提示"。**

### 修复：编译缓存（三处断点，缺一不可）
1. **终端运行只写不读**：`runSource` 只在 `compiled` 后写缓存，开头从不查 → `Ctrl+Shift+B`
   反复跑同一个文件永远全量重编。现在开头就查，命中直接跑；
2. **终端运行根本没写进去**：`_msg` 里用 `this.cacheKey`，但 `runSource` 忘了赋值 →
   永远是 `undefined`，`put` 直接被跳掉；
3. **网页端存了个空对象**：缓存原来把 `ArrayBuffer` 塞进 `globalState`，而 Memento 只保证
   **JSON 可序列化**——`JSON.stringify(ArrayBuffer) === "{}"`，读回来 wasm 长度 0。
   改为 base64 字符串存储（key 升到 `compileCache.v2`，旧的坏数据自动丢弃）。
   同时 `compileForDebug`（F5 路径）以前**只读不写**，现在编译成功也会落缓存。
   LRU 4 条、单条 ≤12MB；写入失败（配额）静默忽略，不影响编译。

### 修复：RE 后 VS Code 一直显示"运行中"、无调用栈、变量面板空
- 真因是 `trap` 分支里引用了一个**未定义的变量 `short`**（人类可读原因只在
  `exceptionInfo` 处理器里定义过）→ 抛 `ReferenceError` → **`stopped` 事件根本没发出去**。
  终端横幅照旧打印（所以看着"提示了 RE 但没停"），编辑器侧完全没收到停止通知。
- 现在崩溃原因在 trap 分支里统一定义一次，`stopped`（`reason:"exception"`）正常送达，
  于是：编辑器停在崩溃行并高亮、调用堆栈有帧、变量面板可读崩溃瞬间的 locals、
  调试工具条显示"整数除零 / 数组越界 / 栈溢出 / unreachable"。

### 修复：`int` 触发满屏"工作区里所有声明"的补全
- 那不是 clangd。vscode.dev / Web 版**内置** `ms-vscode.anycode`——基于 tree-sitter 的
  近似语言服务，官方说明是「Any identifier of the current document and the names of all
  known declarations are always suggested as completions」，于是敲 `int` 就冒出整个工作区
  出现过的声明。它在扩展宿主启动时就已经加载，看起来像本扩展的问题。
- **不擅自改设置**：第一次打开 C/C++ 文件时用 VS Code 官方弹窗（`showInformationMessage`
  + `MessageOptions.modal`）询问一次「要关闭 anycode 的 C/C++ 代码补全吗？」，
  按钮为 `关闭 anycode 补全（推荐）` / `保持原样`。选了什么就记住什么（存 `globalState`），
  **只问一次**，之后不再打扰；不想要这个询问就设 `oiCpp.anycodePrompt: false`。
- 选择关闭时写入的只是一条语言级设置：
  `"[cpp]"/"[c]": { "anycode.language.features": { "completions": false } }`。
  合并写入、保留你 `[cpp]` 段里已有的其它设置；恢复时只删这一个键。
- **只关补全，其它一律不动**：`definitions`/`references`/`highlights`/`outline`/
  `workspaceSymbols`/`folding`/`diagnostics` 全部保持 anycode 默认——它们不吵人，而且
  clangd 首次 preamble（约 5s）期间大纲/面包屑还能顶着用。也不禁用扩展本身（那会连带
  失去这些功能）。代码高亮与本项无关：anycode 的 package.json 连 `languages`/`grammars`
  都没贡献，高亮来自内置 cpp 语言基础（TextMate `source.cpp`），完全不受影响。
- **随时可改**：命令面板 `WebC++: 处理 anycode 补全（网页版）`（同样走官方弹窗），
  可关闭也可**恢复** anycode 默认补全。
- **没打开工作区也没问题**：写的是用户（Global）设置，不是工作区设置，空窗口下同样可写；
  万一被宿主拒绝，不抛错、不阻塞激活，只在输出面板给一次手工写法提示（不弹窗打扰）。

### 回归测试
- 新增 `test/dap-trap-flow.mjs`：除零程序走**完整 DAP 链**（initialize → launch →
  stopped → stackTrace → scopes → variables → exceptionInfo），断言 `stopped.reason ===
  "exception"`、顶帧在除零行且 `source.path` 映射回文档 URI、locals 里 `z === 0`。
  之前的 trap 测试只测裸 worker，正好漏掉了 `stopped` 发不出去这类适配器层 bug。

## [0.2.1] - 2026-10-25

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

## [0.2.0] - 2026-10-25

**桌面版（Node 宿主）与调试/补全修复。** 线上此前是 0.1.4，这一版把桌面版从"半残"做成"能用"，并修掉一批调试/补全问题。

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
