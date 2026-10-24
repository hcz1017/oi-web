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

### 验证
- Node 链路已跑通：垫片里 compile worker `ready`、编译成功；node 版 DWARF 引擎 `hello` 成功。
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
