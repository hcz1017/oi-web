# WebC++ — 在浏览器里写、跑、调 C++

**不需要后端、不需要装编译器、不需要本机 CLI。** 打开一个网页版 VS Code，就能写 C++、在真实终端里交互运行、享受完整补全与诊断，还能下断点单步调试——全部跑在浏览器里（WebAssembly）。

适合：**竞赛编程（OI/ACM）练题、教学演示、在线判题前端、临时验证一段 C++**。

---

## 功能

| 功能 | 说明 |
|---|---|
| **编译** | Clang 22.1.8 编译到 WebAssembly（`wasm32-wasip1`），产物直接在浏览器里跑 |
| **交互终端** | 真终端：stdin/stdout 直连，`Ctrl+D` = EOF，`Ctrl+C` = 终止 |
| **补全 / 诊断** | 内置 clangd（WASM）：补全、悬浮、跳转、诊断、格式化，含参数名与推导类型的 inlay hints |
| **断点调试** | 源码级调试：断点、单步（`F10`/`F11`/`Shift+F11`）、调用栈、变量、watch（内核见 [wdb](https://github.com/hcz1017/wdb)） |
| **离线可用** | 首次加载后工具链全在本地，代码不出浏览器 |
| **中文界面** | 自带简体中文语言包与中文命令 |

## 怎么用（三种方式，别混淆）

| 方式 | 适用 | 说明 |
|---|---|---|
| **自托管静态站**（推荐/本项目主力） | 任何浏览器、可离线内网 | `npm run pack` 出 `dist-cf/`，一条 `wrangler pages deploy` 上线；扩展与 VS Code Web 一起分发，**用户什么都不用装** |
| **Marketplace 安装** | vscode.dev / github.dev | 只有发布到 Marketplace 的 **web 扩展**能在 vscode.dev 里用；本地 `.vsix` **不能**装进 vscode.dev |
| **VSIX** | 仅上传 Marketplace / 桌面版 VS Code 自用 | `npm run vsix` 生成的 `.vsix` 只是**上传物**，不是给最终用户的安装包 |

> 注意：VS Code for the Web（vscode.dev）不接受「从 VSIX 安装扩展」。想让用户在网页里用到它，
> 要么发布到 Marketplace，要么用上面的自托管静态站。

## 快速开始

1. 安装扩展，打开任意文件夹（或命令面板「WebC++: 打开文件夹」选本地目录）；
2. 新建 `main.cpp`：

```cpp
#include <bits/stdc++.h>
int main() {
    int n; scanf("%d", &n);
    printf("%d\n", n * 2);
}
```

3. `Ctrl+Shift+B`（或编辑器右上角 ▷）→ 编译并在终端里运行，直接打字输入；
4. 想调试：`F5`，在行号左边点红点下断点，右侧「运行和调试」面板看变量与调用栈。

> 页面需要**跨源隔离**（`crossOriginIsolated === true`）：clangd 的线程池与终端的交互 stdin 都依赖它。
> 自托管的配套网页已内置 COOP/COEP 与兜底 Service Worker，Marketplace 版在 `vscode.dev` 上同样是隔离环境。

## 操作

| 操作 | 说明 |
|---|---|
| `Ctrl+Shift+B` | 编译并运行当前文件 |
| 终端内输入 + Enter | 作为 stdin 送给程序 |
| `Ctrl+D` / `Ctrl+C` | EOF / 终止本次运行（不会丢工具链缓存） |
| `F5` | 调试当前文件 |
| 命令面板 `WebC++: 重启 clangd(WASM)` | clangd 出问题时重启 |

首次运行会下载约 **28MB** 工具链（clang/lld/sysroot），clangd 首次另需约 **27MB**；之后走浏览器缓存。

## 设置（`oiCpp.*`）

| 键 | 默认 | 说明 |
|---|---|---|
| `flags` | `-std=c++20 -DLOCAL` | 传给编译器的参数（clangd 也用同一份） |
| `opt` | `2` | 优化级别 0–3 |
| `debugInfo` | `true` | 生成 DWARF（调试与外部工具需要） |
| `verbose` | `false` | 终端里显示工具链加载日志 |
| `lsp` | `true` | 是否启用 clangd |

## 桌面版：**零配置**写 C++

**宗旨：不需要装 clang、gcc、CMake、任何语言服务器，装完扩展就能写 C++。**
编译器（Clang 22 编成 WASM）、标准库、clangd 全部随扩展内置，跑在扩展自己的 Worker 里，
对本机环境零依赖、零污染——不想为了跑一道题去配环境时，它就是平替。

同一个 VSIX 同时支持网页版和桌面版：

| 能力 | 网页版 | 桌面版 |
|---|---|---|
| 编译 / 运行 / 交互输入 | ✅ | ✅ |
| 补全 / 悬浮 / 跳转 / 诊断 / inlay hints | ✅ 内置 clangd(WASM) | ✅ 同样内置 clangd(WASM)，**不需要装 clangd** |
| 断点 / 单步 / 变量 / watch | ✅ | ✅ |
| 点进 `#include <vector>` 看头文件 | ✅ | ✅ |

桌面版说明：
- 不读写你的系统编译器，也不需要 `PATH` 里有任何 C++ 工具；卸载扩展即"清理干净"
- 首次加载要解压/编译内置工具链（几秒），之后走缓存
- 「打开本地文件夹」是网页版专属（File System Access API）；桌面版用 VS Code 自带的打开文件夹
- 排障：命令面板 `WebC++: 显示日志`，第一行是环境自述（uiKind / 跨源隔离 / SAB），
  以及 `[stage]` 阶段日志（解压 → glue 加载 → callMain → 已连接）

## ⚠️ 重要提示：clangd ≠ gcc，请只在日常练习时使用

本插件内置的是 **clangd / Clang 22**，而你比赛或 OJ 上用的多半是 **gcc/libstdc++**。
两者在下面这些地方**行为不同**，交卷前务必留个心眼：

- **clangd 可能"自动补"上没写的头文件**（include 建议 / 修复建议），编辑器里看着能编译，
  实际提交到 gcc 就 **CE**。**千万别靠提示补头文件，该 `#include` 的自己要写全。**
- 标准库实现不同：`bits/stdc++.h`、`__int128`、`pbds`（`ext/pb_ds`）在 gcc 上有、在 libc++ 上未必有
  （我们提供了兼容的 `bits/stdc++.h`，但 pdbs 之类不保证）。
- 一些 GCC 扩展（`__attribute__` 细节、`-fgnu89-inline`、变长数组的边界行为）与 Clang 不完全一致。
- 未定义行为（越界、溢出、求值顺序）在两边可能给出不同结果——本地过了不等于 OJ 过。

**结论：本插件定位是「随手练习 / 验证思路」，不作为比赛提交前的唯一验证环境。**
真正上场前，用你 OJ 对应的编译器（g++ / C++17 或 C++14）再过一遍。

## 已知限制（写前面，省得你踩）

- **单文件模型**：一个 `.cpp` 独立编译运行，不做多文件链接、不做 CMake；每个文件一个终端。
- **调试器不执行代码**：`std::vector` 的 `v[i]` 能看（按内存布局算），但 `v.size()`、`mp.count(x)`
  这类需要"真的调用函数"的表达式求不了值——纯 DWARF 引擎做不到。
- **语言子集**：无 C++ 异常、无线程、无宿主系统调用（wasi 限制）。
- **优化等级**：调试用 `-O0`；运行默认 `-O2`，更高级别会让调试信息退化（断点会变少）。
- **浏览器**：需要 Chromium 系（Chrome / Edge）。
- `Ctrl+Shift+B` 会顶掉内置的 "Run Build Task"。

## 自托管网页（可选）

扩展只是前端；配套的 VS Code Web 静态站也能自己部署：仓库里 `npm run pack` 生成 `dist-cf/`，
`wrangler pages deploy dist-cf` 一条命令上线（Cloudflare Pages）。

## 许可证

- 本扩展：**AGPL-3.0-or-later**（见 `LICENSE`）
- 调试器内核 `wdb`：AGPL-3.0-or-later；其中的 `wdb-stub.c` 带例外条款，
  **链接进你的程序不会让你的程序变成 AGPL**
- 第三方组件（LLVM / wasi-sdk / 微软 DWARF 引擎等）见 `notices/THIRD-PARTY-NOTICES.md`

> **你的代码归你。** 本扩展对编译产物不主张任何权利。

## 反馈

- 扩展问题：<https://github.com/hcz1017/oi-web/issues>
- 调试器问题（断点 / 单步 / 变量）：<https://github.com/hcz1017/wdb/issues>
