# Changelog — WebC++ (`web-cpp-tool`)

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
