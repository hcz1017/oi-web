# clangd(WASM) 踩坑记录

> 这份文件记录"为什么会这样写"，改动前请先读。
> 参考实现：`yqloss.cpp-studio-web`（只借鉴逻辑，代码自写）。

## 1. glue 必须用 ESM 动态 `import()` 加载

**症状**：clangd 启动后一敲 `#include <iostream>` 就永久卡死，控制台刷屏
`Tried to spawn a new thread, but the thread pool is exhausted`，主线程栈里反复出现
`checkMailbox → _emscripten_thread_mailbox → Promise.then`。

**原因**：clangd 的 wasm 是 **pthreads 构建**。emscripten 在 `callMain()` 之前会预建
8 个 pthread 子 worker；子 worker 要加载同一份 glue。glue 是 **ESM**（`export default Module`），
而 emscripten 创建子 worker 时用的是
`new Worker(url, { type: "module", name: "em-pthread-…" })`。

我们早期为了"兼容经典 worker"，把 glue 抓下来做字符串改造：
* 把 `import.meta.url` 换掉；
* **把 `{type:"module",name:"em-pthread-"}` 里的 `type:"module"` 删掉**；
* `export default Module` 改成 `self.Module = Module`；
* 用 `importScripts(blob)` 加载。

于是子 worker 变成**经典 worker**，去 `importScripts` 一个 ESM 文件 → 直接失败。
子 worker 起不来 → 父线程在 asyncify 睡眠里死等 → 表现为"卡死 + 刷屏 + CPU 拉满"。

**正确做法**（与参考实现一致）：
```js
const mod = await import(glueUrl);      // glue 保持 ESM
const M = await mod.default({
  thisProgram: "/usr/bin/clangd",
  wasmBinary: wasm,                     // 主线程直接给字节，省一次 fetch
  mainScriptUrlOrBlob: glueUrl,         // 子 worker 用同一个 ESM
  locateFile: f => /\.wasm$/.test(f) ? wasmBlobUrl : `${base}/clangd/${f}`,
});
```
外层 worker 也必须用 `new Worker(url, { type: "module" })` 创建，否则 worker 里
用不了动态 `import()`。

## 2. 不要为了省内存把 `pthreadPoolSize` 改成 0

预创建的 8 个 worker 必须在 `callMain()` **之前**就 ready（emscripten 用
`addOnPreRun` + `addRunDependency("loading-workers")` 保证）。
改成"按需创建"后，创建过程需要主线程处理 worker 消息，而主线程此时正卡在
asyncify 睡眠里 → 必然死锁。内存问题用"只允许一个 clangd 实例 + 关闭即释放"解决。

## 3. 子 worker 也要能拿到 wasm

我们只发布 `clangd.wasm.gz`，解压后的 wasm 在内存里、**没有 URL**。
子 worker 若需要 fetch wasm 会 404 → 挂住。所以 `locateFile` 把 `*.wasm`
指向解压字节的 blob URL。

## 4. `#include` 慢/卡的另一个来源：诊断开关

`include-cleaner` / `missing-includes` 会为每个 `#include` 反复解析头文件，
在 wasm 里非常贵（日志里的 `IncludeCleaner: Failed to get an entry...`）。
因此 worker 会在虚拟 FS 里写 `/workspace/.clangd`：

```yaml
Diagnostics: { UnusedIncludes: None, MissingIncludes: None }
Index: { Background: Skip }
InlayHints: { Enabled: No }
Tidy: { Enabled: No }
```

## 5. `callMain()` 是同步阻塞的

调用后本函数不会再往下走（clangd 主循环）。所以必须**在 callMain 之前**把客户端
已排队的 LSP 消息灌进 stdin（`drainPending()`），否则双方互等。

## 6. 线程池耗尽要"止血"而不是硬扛

worker 里拦截 `thread pool is exhausted` 警告：去重，累计到阈值后上报 `__oiFatal`，
扩展侧自动 `stopClangd()` 并提示。否则主线程空转会烧满 CPU、拖死编辑器。

## 7. 一个 clangd 实例就够，别让它泄漏

* 只在"有打开着的 C/C++ 文档"时启动（`openCppCount()`）；
* 关闭最后一个 cpp 文档 → `stopClangd()`（worker + 121MB wasm 一起回收）；
* 工作区文件夹变化 → 先 `stopClangd()` 再按需重启。
早期每次切换工作区都留一个旧实例，叠加到 5G+ 内存、线程池耗尽后再也起不来。

## 8. 部署缓存会把新版代码"藏起来"

CF Pages 的 `_headers` 里 `/static/devextensions/*` **只匹配一层**：
`package.json` 命中 no-cache，但 `dist/web/extension.js` 仍被缓存 4 小时，
于是出现"命令面板有命令、点了 `command not found`"。
现在打包时给主 bundle 与全部 worker 加**内容哈希**（文件名变化即绕过缓存），
并补充 `dist/*`、`dist/web/*` 的 no-cache 规则。
