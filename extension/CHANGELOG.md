# Changelog — WebC++ (`web-cpp-tool`)

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
