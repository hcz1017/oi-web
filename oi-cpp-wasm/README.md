# OI C++ (WASM) — VS Code Web 里写、跑、补全 C++

在 **VS Code for the Web**（vscode.dev / 自托管 web 版）里：

- 用 **WASM Clang** 编译单文件 C++（产物 wasm32-wasip1，无需任何后端）
- 在 **真实终端**里交互运行：stdin/stdout 直连，`Ctrl+D` = EOF，`Ctrl+C` = 终止
- **clangd(WASM)** 提供补全 / 悬浮 / 跳转 / 诊断 / 格式化
- 一个 `.cpp` 一个终端，多文件各自独立运行

## 安装

- Marketplace 安装，或 `npx @vscode/vsce package` 得到 VSIX。
- 在 vscode.dev 里也可用 **Developer: Install Extension From Location...** 指向一个支持 CORS 的静态目录。
- 需要页面**跨源隔离**（COOP/COEP，即 `crossOriginIsolated === true`）：clangd 的多线程与交互 stdin 都依赖它。

## 用法

| 操作 | 说明 |
|---|---|
| `Ctrl+Shift+B` / 编辑器右上角 ▷ | 编译并运行当前文件 |
| 终端里输入 + Enter | 送给程序 stdin |
| `Ctrl+D` | EOF |
| `Ctrl+C` | 终止本次程序（不会丢工具链缓存） |
| 命令面板 `OI C++: 重启 clangd(WASM)` | clangd 出问题时重启 |

首次运行会下载约 **28MB** 工具链（clang/lld/sysroot），clangd 首次另需约 **27MB**；之后走浏览器缓存。

## 设置（`oiCpp.*`）

| 键 | 默认 | 说明 |
|---|---|---|
| `flags` | `-std=c++20 -DLOCAL` | 传给编译器的参数（clangd 也用同一份） |
| `opt` | `2` | 优化级别 0–3 |
| `debugInfo` | `true` | 生成 DWARF（可用 Chrome DevTools 调试） |
| `verbose` | `false` | 终端里显示工具链加载日志 |
| `lsp` | `true` | 是否启用 clangd |

## 已知限制

- 单文件编译（不做多文件链接）；每个 `.cpp` 独立运行
- 无 C++ 异常、无线程、无宿主系统 API（wasi 限制）
- `Ctrl+Shift+B` 会顶掉内置 "Run Build Task"

## 构建

```bash
cd <repo>/oi-cpp-wasm
node esbuild.mjs      # 需要仓库根的 node_modules（esbuild / browser_wasi_shim / vscode-languageclient）
```

工具链资产来源与许可见 `notices/THIRD-PARTY-NOTICES.md`。
