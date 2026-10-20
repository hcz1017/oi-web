# 在浏览器里给 WASM 版 C++ 做调试：方案调研与实施规划（仅规划）

> 目标：在 `oi-cpp-wasm`（VS Code **Web** 扩展）里给编译产物 `wasm32-wasip1` 提供**源码级**调试
> （断点、单步、变量、调用栈），尽量接近 gdb 体验。**本文只做规划，不含实现。**

---

## 0. 实现进展（2026-10-19）

| 规划项 | 状态 | 实现方式 |
|---|---|---|
| 符号层（DWARF） | ✅ 已接 | `@vscode/dwarf-debugging` 的 `SymbolsBackend.wasm`（MIT），宿主只实现 4 个 getter |
| 行断点 | ✅ | 引擎 `sourceLocationToRawLocation` → 语句起点 → 插桩 siteId |
| 暂停/继续 | ✅ | 插桩调用 `oi.probe(siteId)` + `Atomics.wait`（位图 SAB 传断点，ctrl SAB 恢复） |
| 调用栈 | ✅ | 探针里抓 JS 栈（`wasm-function[N]:0xNN`）→ 函数体起点 → 引擎映射 文件:行 |
| stepIn / stepOut | ✅ | 恢复模式：任意语句 / 离开当前函数体 |
| stepOver | ⚠️ 近似 | "同一函数体内的下一条语句" |
| 变量 / 求值 | ⚠️ 部分 | 线性内存快照已给引擎；`locals`/`globals` 快照未做 |
| 头文件断点 | ❌ | 目前只对当前调试的源文件建站点（避免给 165 个头文件插桩） |

Node 端验证：`npm run test:debug`（插桩正确性）、`npm run test:session`（暂停/继续/单步/栈/内存/退出码）。

---

## 1. 为什么 clangd 能跑、gdb 不能

| | clangd / clang | gdb |
|---|---|---|
| 本质 | **前端**（词法/语法/语义/AST/常量求值），不生成机器码 | **运行时调试器**：需要进程控制（ptrace/模拟）、目标架构描述（tdep/bfd/opcodes）、寄存器与栈模型 |
| wasm 适配难度 | 只要能把 C++ 编译成 wasm32-wasi 就能跑（纯计算，无系统调用除文件） | gdb **没有 WebAssembly target**（截至 gdb 15）；且浏览器里没有 ptrace / 没有"可 attach 的进程" |
| 结论 | 上游已有人编好（我们复用了 Clang 22.1.8 wasm） | **没有可用的 wasm 版 gdb** |

> `__int128`、`__builtin_*` 能出现，也正是因为它们是 clang 前端特性（Sema/AST/APInt 常量求值），与后端无关；
> 顺带：`__int128` 在 clang/GCC 里都是扩展，我们的编译链实测可编译并运行（`test/smoke.mjs` 已加用例）。

**已知硬尝试**：Wokwi 的《Running GDB in the Browser》把 gdb 用 Emscripten 编到 wasm —— 7 个补丁、产物 ~90MB、
必须开实验性 wasm 线程、Node 下直接退出、Chrome 加载失败，最终放弃，改为在浏览器里跑 Linux VM（v86/CheerpX 那一类）。
参考：<https://blog.wokwi.com/running-gdb-in-the-browser>

---

## 2. 生态现状：三条技术路线

### A. 原生调试器 + 运行时的 GDB RSP stub（**主流**）
- **LLDB 已支持 wasm**：`platform select wasm`、`process connect --plugin wasm connect://host:port`，
  能 `b 函数`、`bt`、`frame var`、单步。
  参考：<https://jonasdevlieghere.com/post/wasm-debugging-with-lldb-and-wamr>
- **WAMR（iwasm）**：编入调试支持后自带 **GDB RSP stub**（`iwasm -g=127.0.0.1:4567`），LLDB 连上去即可。
- **Wasmtime**：JIT 生成原生码 + 把 wasm DWARF 翻译成原生 DWARF，于是 **stock gdb / lldb 直接可用**
  （`gdb --args wasmtime run -D debug-info`）。注意：这只在 **Wasmtime 进程内**成立，浏览器里没有这条路径。
- **WasmKit(Swift)** 也实现了 GDB Remote Protocol。
- ⚠️ 关键结论：连 **gdb 也得靠"目标侧 stub + 原生 gdb"**，而 gdb 本身**没有 wasm target**，
  所以即便有 stub，gdb 也只能连 wasmtime 的 JIT 原生码；纯解释执行 wasm 时只有 **LLDB** 能连。

### B. 浏览器内 DWARF 调试（**唯一能在浏览器里达成源码级体验的路**）
- **Chrome DevTools 内置 C/C++ DWARF 调试**：V8 提供执行控制（CDP），Chrome 用 LLDB 的 DWARF 解析能力做符号层。
- **微软 `@vscode/dwarf-debugging` / `microsoft/vscode-dwarf-debugging`**：
  给 **js-debug** 用的 DWARF 插件模块，**浏览器（vscode.dev）环境也可用**。
  参考：<https://github.com/microsoft/vscode-dwarf-debugging>、<https://github.com/microsoft/vscode-dwarf-debugging-ext>
- 限制：它绑定 js-debug + V8 Debugger（CDP）上下文；我们的 debuggee 是**我们自己的 worker 里的 wasm 实例**，
  没有 CDP 端点可挂。

### C. 专用 wasm 调试器
- **wasminspect**（LLDB 库 + Rust 前端）：支持 DWARF、可看 wasm 反汇编、看线性内存；
  但**是原生程序**（依赖 liblldb），不能在浏览器里跑；也不支持 DAP。
  参考：<https://github.com/kateinoigakukun/wasminspect>
- VS Code 侧还有社区扩展 `KamenokoSoft.vscode-dwarf-debug`（同样需要能跑的调试后端）。

---

## 2.5 补充检索结果（`gh` CLI，2026-10-19）

用 `gh search repos` / `gh search code` 全量扫了一遍，**结论不变：浏览器里没有现成的完整 wasm 调试器**，
但挖到一个可以直接复用的关键组件，以及几个值得参考的实现。

| 项目 | 星 | 状态 | 对我们的价值 | 裁决 |
|---|---|---|---|---|
| **microsoft/vscode-dwarf-debugging**（npm `@vscode/dwarf-debugging`） | — | 活跃（2026-08） | **把 Chrome 的 C/C++ DWARF 调试扩展编译成了 wasm**，npm 包内直接带 `dist/SymbolsBackend.wasm`（56MB，MIT）。我们只需实现 **4 个 getter**（`getWasmLinearMemory/Local/Global/Op`），其余 DWARF/类型/表达式/pretty-printer 全在引擎里 | ✅ **直接复用（P0/P1/P3 都吃它）** |
| wasm3/wasm-debug | 54★ | 2020 停更 | `wasm2dbg.py` 把 wasm 里的 DWARF **重打包成 ELF**（让未改动的 gdb/lldb 能加载符号）；`gdb-stub.py` 用 GDB RSP 连 gdb/lldb，已做到"断点命中"原型 | 📚 桌面/lldb 路线参考 |
| hemashushu/practice-wasm（XiaoXuan VM） | 104★ | 活跃 | Rust 写的 wasm VM + **Web UI 调试界面**（断点/单步/看内存规划中，未完成） | 📚 浏览器 VM+DAP 参考 |
| zmr-233/MoonBit-WASM-Debugger | 17★ | 2024 | VSCode 扩展，**只做 "wasm stacktrace → 文件名+行号"** | ✅ 印证我们 P0 的形态与需求 |
| itszn/chrome-wasm-debugger | 101★ | 2018 | 基于 CDP 的 wasm 调试 UI（简化 DevTools 体验） | 📚 UI 参考 |
| daniel5151/gdbstub | 416★ | 活跃 | Rust 可嵌入的 **GDB RSP 实现** | 📚 仅桌面/gdb 兼容路线 |
| gimli-rs/gimli | 1018★ | 活跃 | 成熟 DWARF 读写库（可编到 wasm） | 🔁 备选符号层（引擎不可用时的退路） |
| floooh/vscode-emscripten-debugging | 26★ | 2023 | Emscripten + VSCode 调试示例 | 📚 参考 |
| GoogleChromeLabs / ChromeDevTools `extensions/cxx_debugging` | — | 上游 | 上面那个 wasm 的**源码**（C++/emscripten，CMake + 大量 TS） | 📚 需要魔改时才动 |

### 关键组件细节：`@vscode/dwarf-debugging@0.0.2`（MIT）

包内容：
```
dist/index.js          5.3K   Node 侧胶水（worker_threads）
dist/worker.js         356K   Worker 主体（parentPort + postMessage，逻辑与浏览器 Worker 同构）
dist/SymbolsBackend.wasm 56M  ★ Chrome cxx_debugging 引擎（DWARF 解析 + 变量 + 表达式 + formatters）
chrome-cxx/mnt/extension/*.d.ts  TypeScript 接口定义
```

引擎对外实现的是 **DevTools 的 `LanguageExtensionPlugin`**，我们要接到 DAP 上的方法就这些：

```ts
addRawModule(rawModuleId, symbolsUrl, rawModule)        // 传入 wasm 字节（含 .debug_* 段）
sourceLocationToRawLocation({file, line, col})          // 断点：源码行 → wasm 内 raw offset 区间
rawLocationToSourceLocation({rawOffset})                // 栈帧/单步：offset → 源码位置
getFunctionInfo(rawLocation)                            // 函数名/内联帧 → backtrace
listVariablesInScope(rawLocation) + getProperties(id)   // 作用域变量
evaluate(expr, rawLocation, stopId)                     // 表达式求值（= watch/条件断点）
getMappedLines(rawModuleId, fileURL)                    // 该文件哪些行可下断点
```

**宿主侧只需实现 4 个方法**（其余都在引擎内）：
```ts
getWasmLinearMemory(offset, length, stopId): Promise<ArrayBuffer>
getWasmLocal(local, stopId): Promise<WasmValue>
getWasmGlobal(global, stopId): Promise<WasmValue>
getWasmOp(op, stopId): Promise<WasmValue>
```
> `stopId` 是"暂停快照"的句柄 —— 正好对应我们 SAB 暂停协议里的"当前停顿点"。
> 内部同步调用用 `SharedArrayBuffer` 信号量（Node 与浏览器一致，我们已有 COI 环境）。

移植工作量（估计）：把 `dist/index.js` 的 `worker_threads`/`require("path")` 换成浏览器 `Worker`/`fetch`，
`dist/worker.js` 的 `parentPort` 换成 `self`，`ResourceLoader.createSymbolsBackendModulePromise()` 返回我们
打包的 `WebAssembly.Module`。**预计 0.5–1 天**（README 也说明该架构 95% 逻辑本来就在 Worker 里）。

---

## 3. 我们的约束（决定方案）

1. **纯 Web 扩展**：没有本地进程、不能 spawn、不能 ptrace，`chrome.debugger` 也不可用（我们就是页面本身）。
2. **debuggee 完全由我们托管**：`browser_wasi_shim` + 自建 `runWorker` 执行 wasm；我们**可以让它停下、可以让它插桩**。
3. **工具链自产**：clang/lld 都在我们手里，**可以控制产物**（`-O0 -g -dwarf-version=4`，甚至自定义链接脚本/导出）。
4. **VS Code 侧现成**：DAP 就是 JSON + `vscode.debug.registerDebugAdapterDescriptorFactory`，
   Web 扩展可以用 **`vscode.DebugAdapterInlineImplementation`** 在扩展内部直接实现适配器 ——
   即"gdb 接入 vscode 的现成方案"在我们这里可以直接换成**自建 DAP**，不需要 cpptools。

---

## 4. 推荐方案：自建 DAP 适配器 + DWARF 符号层 + 插桩式执行控制

> 代号 **oi-gdb-wasm**。核心思想：**不追求真的 gdb**，而是用"DWARF + 插桩 + 自有运行时"复现 gdb 的
> 用户可见能力（断点/单步/变量/栈），全部在浏览器里、零本地依赖。

### 架构

```
┌──────────────── VS Code Web (extension host) ────────────────┐
│  DebugAdapter (InlineImplementation)  ← DAP JSON             │
│    · launch/attach, setBreakpoints, continue, next/stepIn    │
│    · stackTrace, scopes, variables, evaluate                 │
│         │                                                    │
│         ├── SymbolLayer = SymbolsBackend.wasm（复用微软 wasm）│
│         │     宿主只实现 4 个 getter：linear memory/local/    │
│         │     global/op + stopId；DWARF/类型/表达式在引擎内    │
│         │                                                    │
│         └── Session: 与 DebugWorker 的暂停/继续协议 (SAB)      │
└───────────────────────┬──────────────────────────────────────┘
                        │ postMessage + SharedArrayBuffer(暂停/唤醒)
┌───────────────────────▼───────── DebugWorker ────────────────┐
│  运行【插桩后的】wasm：browser_wasi_shim + 新增 import 钩子    │
│    __oi_probe(kind, id, localsPtr?)  → 命中断点则 Atomics.wait │
│  内存/全局/表访问 → 变量读取（由 SymbolLayer 解释 DW_OP 子集） │
└──────────────────────────────────────────────────────────────┘
```

### 分阶段（每阶段都可独立交付、可回退）

#### P0 — 骨架 + 崩溃回溯（0.5–1 天，风险低；接引擎后仍在这个量级）
- 注册 DAP 工厂 + `DebugAdapterInlineImplementation`；`launch` 复用现有编译 → 在 DebugWorker 跑。
- **不做断点**，但实现：
  - `output` 事件转发（stdout/stderr）
  - `terminated` / `exited`
  - **trap/abort 时输出源码级 backtrace**：V8 的 `WebAssembly.RuntimeError().stack` 里有
    `wasm-function[i]+0xNN`，先用 `rawLocationToSourceLocation`/`getFunctionInfo`（引擎）映射成
    `func(a,b) at file.cpp:line`，再逐帧拼 `bt`
- 验收：故意 `*(int*)0=1` / `abort()`，控制台打印带文件名行号的调用栈。

#### P1 — 行断点 + continue（3–5 天，风险中；引擎提供映射，比自写快）
- **插桩**：链接后用 `binaryen`（npm 版有 wasm 构建，浏览器可用）重写模块：
  在每个"行首指令"之前插入 `call $__oi_probe(i32 line_id, i32 func_id)`。
  插入点直接问引擎：`sourceLocationToRawLocation` 给出的 raw offset 区间（无需自己解析 line table）。
- 新增 import `__oi_probe`，命中已启用断点 → 通过 **SharedArrayBuffer + `Atomics.wait`** 阻塞 debuggee 线程，
  宿主侧（adapter）收到 stop 事件并返回 `stopped{reason:breakpoint}`。
- 需要新增的调试产物：`main.debug.wasm`（插桩）+ 保留未插桩版本给普通运行（性能不退化）。
- 验收：源码里 F9 下断点 → 运行 → 停住 → 继续能过。

#### P2 — 单步 / 步入 / 步过 / 跳出（1–2 周，风险中高）
- 只靠 P1 的探针即可实现：
  - `stepIn`：任意探针命中即停
  - `stepOver`：记录起点的调用深度，命中**同级或更浅**探针时停
  - `stepOut`：命中更浅层级时停
  - 需要在探针里带上 `funcDepth`（宿主维护调用栈）
- 调用栈：debuggee 侧维护一个 JS 数组的"逻辑栈"（探针 enter/exit 时 push/pop）——
  比解析 wasm 栈更可靠，代价是只在插桩版本可用。
- 验收：单步一行一行走，能步入函数、步出。

#### P3 — 变量 / 作用域 / 表达式（**改动后：3–5 天**，风险中）
- **不再自写 DWARF 解析**：直接调引擎的
  `listVariablesInScope(rawLocation)` / `getProperties(objectId)` / `getScopeInfo(type)`；
  变量值经 4 个 getter 从**暂停快照**取（linear memory / locals / globals / operand stack）。
- 需要我们在插桩侧配合的只有一件事：**暂停时把当前函数的 locals 存进 shadow 内存**
  （`local.get N` + `i32.store`），让 `getWasmLocal` 有东西可读；operand stack 同理可选。
- `evaluate`（watch / 条件断点）直接用引擎 `evaluate(expr, rawLocation, stopId)` —— 免费获得
  类型感知的表达式求值，比"自写表达式编译"强一个档位。
- 若某天想换掉引擎：`gimli`(Rust→wasm) + 自写 DAP 侧映射，作为 Plan B。
- 验收：`std::vector<int> v` 能看到 `v`、`v._M_impl...`（结构体展开）、`p v.size()` 暂不支持也可接受。

#### P4 — 体验补齐（按需）
- 数据断点（watch）：对线性内存做"影子页"比较（性能差，仅小范围）
- 条件断点：探针里跑表达式（用 P3 的求值器）
- 内存视图 / 反汇编（`webassembly.disassemble`）：用 binaryen 或自写解码
- 多线程（`-pthread` 产物）：需要每个线程一份暂停协议
- **不做**：GDB RSP 兼容（浏览器里没有能连的 gdb；收益≈0）

---

## 5. 关键选型建议

| 关注点 | 建议 | 理由 |
|---|---|---|
| 调试协议 | **DAP（自建）** | Web 扩展唯一可行；VSCode 侧零成本 |
| 符号层 | **自写 DWARF v4 子集** 优先；备选评估 `@vscode/dwarf-debugging` | 后者绑定 js-debug/V8，接口不一定暴露"按任意地址查变量" |
| 执行控制 | **binaryen 插桩 + 探针** | 我们控制产物；不需要 wasm 解释器；性能可控（仅 debug 产物插桩） |
| 暂停机制 | **SharedArrayBuffer + `Atomics.wait`**（复用现有 stdin 那套思路） | 已验证可行 |
| 产物策略 | `main.wasm`（正常）/ `main.debug.wasm`（插桩，-O0 -g） | 不牺牲日常运行速度 |
| 编译 flags | 调试时 `-O0 -g -fno-omit-frame-pointer -dwarf-version=4` | LLVM wasm 后端对 CFI/frame pointer 支持有限，先不依赖 |

---

## 6. 风险清单

1. **DWARF 解析量**：`.debug_info` 类型图 + `DW_OP` 表达式是最容易低估的部分（gdb 这一块是几十万行）。
   缓解：只支持 `-O0` 生成的最常见形态；表达不了就显示 `<unavailable>`。
2. **栈回溯**：wasm 没有统一 frame pointer/CFI 约定，LLVM 的 `.debug_frame` 对 wasm 支持不完整。
   缓解：靠插桩维护逻辑栈（P1/P2），CFI 仅作 P3 增强。
3. **插桩体积/性能**：每行一个探针会让 debug 产物膨胀数倍。
   缓解：只在断点启用的文件/函数插入；或做两级映射（行表 + 稀疏探针 + 单步时动态插桩不可行，先接受）。
4. **多线程**（`-pthread` 产物）：暂停需要 stop-the-world，复杂度跳一档。P4 再说。
5. **与 clangd 共存**：调试会话和 clangd 各自跑自己的 worker，注意内存（clangd 121MB + 工具链 28MB + 调试实例）。
6. **性能**：`-O0` 产物在 wasm 里可能比 `-O2` 慢 5–10 倍，交互式调试可接受（原生也如此）。

---

## 7. 可选/兜底路线（如果 P1–P3 推进受阻）

- **桌面版专用**：VSCode Desktop 场景下走 **LLDB + Wasmtime/WAMR**（原生已成熟），我们把产物与
  `launch.json` 生成好，用户在本地装 lldb/wasmtime 即可 —— 但**与 Web 扩展的"随处随地"目标冲突**，
  只能作为"高级用户可选增强"。
- **浏览器内 Linux VM（CheerpX/v86）+ 原生 gdb**：可行但 gdb **仍不支持 wasm target**，
  只能在 VM 里用 x86 工具链编译调试（等于放弃 wasm 产物），与本项目目标不符（我们已退掉 v86 栈）。
- **等生态**：LLDB 的 wasm 平台支持在推进（D78978/D78801），若未来有 **lldb.wasm** 出现，
  可切到"自建 DAP → 转发 LLDB RSP"。现阶段不值得等。

---

## 8. 参考链接

- wasm DWARF 调试综述（Wasmtime / Chrome / WAMR 三条路对比）：<https://jonasdevlieghere.com/post/wasm-debugging>
- LLDB + WAMR 实战：<https://jonasdevlieghere.com/post/wasm-debugging-with-lldb-and-wamr>
- Wasmtime 原生调试（gdb/lldb）：<https://docs.wasmtime.dev/examples-debugging-native-debugger.html>
- wasminspect（LLDB 系专用 wasm 调试器）：<https://github.com/kateinoigakukun/wasminspect>
- 微软 DWARF 调试模块（js-debug 插件，浏览器可用）：<https://github.com/microsoft/vscode-dwarf-debugging>
- 微软 DWARF 调试扩展（VSCode）：<https://github.com/microsoft/vscode-dwarf-debugging-ext>
- 把 gdb 编到 wasm 的失败记录（Wokwi）：<https://blog.wokwi.com/running-gdb-in-the-browser>
- Wasm DWARF 与执行的约束说明：<https://wiki.freepascal.org/WebAssembly/Debugging>

---

### gh 检索补充链接

- `@vscode/dwarf-debugging`（含 `SymbolsBackend.wasm`，MIT）：<https://github.com/microsoft/vscode-dwarf-debugging>
- Chrome cxx_debugging 源码（该 wasm 的上游）：<https://github.com/ChromeDevTools/devtools-frontend/tree/main/extensions/cxx_debugging>
- wasm3/wasm-debug（wasm2dbg.py + gdb-stub.py 原型）：<https://github.com/wasm3/wasm-debug>
- XiaoXuan VM（Rust wasm VM + Web UI 调试器）：<https://github.com/hemashushu/practice-wasm>
- MoonBit WASM Debugger（stacktrace→行号，印证 P0）：<https://github.com/zmr-233/MoonBit-WASM-Debugger>
- gimli（DWARF 库，备选符号层）：<https://github.com/gimli-rs/gimli>
- gdbstub（Rust RSP 实现，桌面路线用）：<https://github.com/daniel5151/gdbstub>

---

## 9. 建议的推进顺序

1. **P0 立刻做**（1 天内可验证）：崩溃源码级回溯 —— 用户马上有感，且为后续所有阶段铺好 DWARF 读取骨架。
2. **P1 断点**：把"能停"做出来（产品形态成立）。
3. **P2 单步**：达成"类 gdb"最小闭环。
4. **P3 变量**：接 `SymbolsBackend.wasm`（4 个 getter + 上面 12 个方法），此时可对外称"可用的 wasm 调试"。
5. P4 按用户反馈挑（数据断点/条件断点/反汇编/多线程）。
