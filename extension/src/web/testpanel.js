// 测试面板（仿 CPH 的最小版）：编辑用例 + 一键跑全部 + 逐例判定。
//
// 为什么用 webview：用例是**多行文本**（输入/期望输出），TreeView / QuickPick 都没法编辑，
// 这是 webview 唯一合理的场景（和"用 webview 顶替 clangd"那种做法不是一回事）。
//
// ============================ 协议 v2（重要） ============================
// 三份独立审查都指出：旧协议的消息**不带文件身份**，而 "webview 的 postMessage" 与
// "编辑器切换事件" 是两条不同的 IPC 路径，到达顺序不保证 —— 于是切文件的瞬间，
// 一条迟到的 save 会按新的 current 落盘，把 **A 的用例写进 B**（A 同时丢数据）。
// 现在：
//   · 每条 webview→宿主载荷都带 { file, rev }，宿主只接受"就是当前文件 + 当前版本"的；
//   · 宿主在切换/刷新/运行**之前**先要求 webview 冲刷未落盘编辑（flush/flushed 屏障）；
//   · 运行结果带 { gen, file }，切换文件后旧一轮的结果一律丢弃，不再污染新文件的横幅；
//   · 宿主回推 init 时带 rev，webview 遇到"同文件同版本"的 init 直接忽略（避免无谓重绘）；
//   · 用例按**文档 URI**分组（以前用文件名，不同目录的 main.cpp 会共用一份）。
// ========================================================================
import * as vscode from "vscode";
import {
  judgeCase, summarize, shouldAcceptCases, pickRunTarget, normalizeTimeout, shouldAcceptPayload,
} from "./testcases.js";

const VIEW_ID = "oiCpp.testsView";
/** 起始页文案（没有打开的 C/C++ 文件时显示） */
const START_TEXT = "打开一个 C/C++ 文件开始。每个文件的用例都会自动保存，关掉再打开还在。";
/** 等 webview 冲刷的最长时间（毫秒）。超时就不等了，宁可少存也不卡住操作。 */
const FLUSH_TIMEOUT_MS = 400;

/**
 * 侧栏（活动栏）里的测试视图：`WebviewViewProvider`。
 *
 * @param {object} deps
 * @param {import("./testcases.js").TestCaseStore} deps.store
 * @param {(args:object)=>Promise<{wasm:Uint8Array}>} deps.compile
 * @param {()=>Promise<object>} deps.getRunner
 * @param {(s:string)=>void} deps.log
 * @param {()=>{sourceUri:string,fileName:string,source:string,flags:string,opt:number}|null} deps.activeTarget
 * @param {()=>number} deps.getTimeoutMs
 */
export function createTestViewProvider(deps) {
  let view = null;          // 当前 webviewView
  let current = null;       // { key, fileName, source, flags, opt }   key = 文档 URI（唯一身份）
  let rev = 0;              // 每次回推 init 递增，用来丢弃"上一版"的载荷
  let runGen = 0;           // 每次运行递增，用来丢弃上一轮的结果
  let running = false;
  let pendingRunAll = false;
  let webviewReady = false;
  const flushWaiters = new Map();   // id -> resolve（flush/flushed 屏障）

  const post = (m) => {
    try {
      const ok = view?.webview.postMessage(m);
      // 返回 false 说明消息没投递出去（webview 正在销毁等）—— 以前静默吞掉，
      // 于是面板会永久停在旧快照上。至少留一行日志方便排查。
      if (ok === false) deps.log(`[对拍] 消息未投递（${m && m.type}）`);
      return ok;
    } catch (e) {
      deps.log(`[对拍] 消息发送失败（${m && m.type}）: ${(e && e.message) || e}`);
      return false;
    }
  };

  /** 用例库的键：用文档 URI（不同目录的同名文件不会串台） */
  const keyOf = (t) => String((t && (t.sourceUri || t.fileName)) || "");

  /** 读该文件的用例；若只有旧版本按 basename 存的，顺手迁移一次 */
  function casesFor(t) {
    const key = keyOf(t);
    let list = deps.store.get(key);
    if (!list.length && t.fileName && deps.store.has(t.fileName)) {
      const legacy = deps.store.get(t.fileName);
      if (legacy.length) {
        deps.store.set(key, legacy);
        deps.store.set(t.fileName, []);      // 迁移后清掉旧键，避免两处都能读到
        deps.log(`[对拍] 已把用例从旧键（文件名）迁移到 URI：${key}`);
        list = legacy;
      }
    }
    return list;
  }

  function stateOf(t) {
    return {
      type: "init", file: keyOf(t), name: t.fileName, rev,
      cases: casesFor(t), timeoutMs: deps.getTimeoutMs(),
    };
  }

  /** 等 webview 把未落盘的编辑冲过来（屏障）。超时就继续，绝不阻塞操作。 */
  function askFlush(timeoutMs = FLUSH_TIMEOUT_MS) {
    return new Promise((resolve) => {
      if (!view || !webviewReady) { resolve(false); return; }
      const id = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const timer = setTimeout(() => { flushWaiters.delete(id); resolve(false); }, timeoutMs);
      flushWaiters.set(id, () => { clearTimeout(timer); flushWaiters.delete(id); resolve(true); });
      if (!post({ type: "flush", id })) { clearTimeout(timer); flushWaiters.delete(id); resolve(false); }
    });
  }

  /** 校验载荷身份（文件 + 版本） */
  function checkPayload(m) {
    const v = shouldAcceptPayload({
      msgFile: m.file, msgRev: m.rev,
      currentFile: keyOf(current), currentRev: rev,
    });
    if (!v.ok && v.reason !== "no-file") {
      // 过期/别的文件的载荷：不落盘（也**不**"修正"到当前文件上，那正是串写）
      deps.log(`[对拍] 丢弃过期载荷（${v.reason}，file=${m.file}）`);
    }
    return v;
  }

  /** 写回用例（含防误清空与形状校验） */
  function acceptCases(m) {
    if (!current) return false;
    if (!checkPayload(m).ok) return false;
    const existing = deps.store.get(keyOf(current));
    const v = shouldAcceptCases({ incoming: m.cases, existing, ready: webviewReady });
    if (!v.ok) { deps.log(`[对拍] 拒绝本次提交（${v.reason}），保留用户输入`); return false; }
    deps.store.set(keyOf(current), m.cases);
    return true;
  }

  async function pushInit() {
    if (!current) return;
    rev++;
    post(stateOf(current));
  }

  /** 把 current 同步到"当前活动编辑器"（没有就回起始页） */
  async function syncTarget() {
    const t = deps.activeTarget();
    if (!t) {
      await askFlush();
      current = null;
      rev++;
      post({ type: "noFile", text: START_TEXT });
      return false;
    }
    await askFlush();                 // 先让面板把编辑冲上来，再换
    const switched = !current || keyOf(current) !== keyOf(t);
    current = t;
    rev++;
    post(stateOf(t));
    return switched;
  }

  async function onMessage(m) {
    if (!m || !m.type) return;
    switch (m.type) {
      case "ready":
        webviewReady = true;
        await syncTarget();
        if (pendingRunAll) { pendingRunAll = false; await runAllNow(); }
        return;
      case "flushed": {
        const done = flushWaiters.get(m.id);
        if (done) done();
        return;
      }
      case "refresh":
        await syncTarget();
        return;
      case "setTimeout": {
        const ms = normalizeTimeout(m.ms, deps.getTimeoutMs());
        let ok = true, reason = "";
        try {
          await vscode.workspace.getConfiguration("oiCpp").update("testTimeout", ms, vscode.ConfigurationTarget.Global);
          // 回读：如果被工作区设置压住，这里能看出来（否则用户以为存了，其实没生效）
          const eff = normalizeTimeout(vscode.workspace.getConfiguration("oiCpp").get("testTimeout", ms), ms);
          if (eff !== ms) { ok = false; reason = `被工作区设置覆盖（实际 ${eff}ms）`; }
        } catch (e) {
          ok = false; reason = (e && e.message) || "写入失败";
        }
        deps.log(`[对拍] 超时设置为 ${ms}ms${ok ? "（已保存）" : "（失败：" + reason + "）"}`);
        post({ type: "timeout", ms: ok ? ms : deps.getTimeoutMs(), ok, reason });
        return;
      }
      case "save": {
        const ok = acceptCases(m);
        post({ type: "saved", ok });
        return;
      }
      case "add": {
        if (!current) { post({ type: "noFile", text: START_TEXT }); return; }
        if (!acceptCases(m)) { post({ type: "saved", ok: false }); return; }
        deps.store.add(keyOf(current), {});
        await pushInit();
        return;
      }
      case "delete": {
        if (!current) { post({ type: "noFile", text: START_TEXT }); return; }
        if (!acceptCases(m)) { post({ type: "saved", ok: false }); return; }
        deps.store.remove(keyOf(current), m.id);
        await pushInit();
        return;
      }
      case "clear": {
        if (!current) { post({ type: "noFile", text: START_TEXT }); return; }
        const yes = await vscode.window.showWarningMessage(
          `清空「${current.fileName}」的全部测试用例？`, { modal: true }, "清空");
        if (yes !== "清空") return;
        deps.store.clear(keyOf(current));
        await pushInit();
        return;
      }
      case "runOne": {
        if (!current) { post({ type: "noFile", text: START_TEXT }); return; }
        if (!acceptCases(m)) { post({ type: "saved", ok: false }); return; }
        const one = deps.store.get(keyOf(current)).find((c) => c.id === m.id);
        if (one) await execute([{ case: one }], true);
        return;
      }
      case "runAll": {
        if (!current) { post({ type: "noFile", text: START_TEXT }); return; }
        if (!acceptCases(m)) { post({ type: "saved", ok: false }); return; }
        await execute(deps.store.get(keyOf(current)).map((c) => ({ case: c })), false);
        return;
      }
    }
  }

  /** 编译一次，逐例跑。结果带 gen，切换文件后自动作废。 */
  async function execute(items, single) {
    if (running) { post({ type: "log", text: "正在运行，已忽略本次请求" }); return; }
    if (!current) { post({ type: "noFile", text: START_TEXT }); return; }

    // 运行前现读编辑器（面板里 current 是快照；改完代码不刷新会命中旧缓存）
    await askFlush();
    const pick = pickRunTarget(current, deps.activeTarget());
    if (!pick.target) { current = null; post({ type: "noFile", text: START_TEXT }); return; }
    if (pick.switched) {
      // 换文件了：用**那个文件**的用例重来，别拿旧列表跑新源码
      current = pick.target;
      await pushInit();
      items = deps.store.get(keyOf(current)).map((c) => ({ case: c }));
      if (!items.length) { post({ type: "log", text: "这个文件还没有用例" }); return; }
    } else {
      current = pick.target;               // 同文件：只更新源码/参数
    }

    running = true;
    const gen = ++runGen;
    const file = keyOf(current);
    post({ type: "runStart", gen, file, single, count: items.length });
    try {
      const t0 = Date.now();
      const r = await deps.compile({
        source: current.source, fileName: current.fileName,
        flags: current.flags, opt: current.opt,
      });
      if (!r || !r.wasm) {
        const text = stripAnsi(String((r && r.log) || "编译失败"));
        deps.log("[对拍] 编译失败：\n" + text);
        post({ type: "compileError", gen, file, text: text.slice(0, 8000) });
        return;
      }
      deps.log(`[对拍] 编译完成 ${(r.wasm.byteLength / 1024).toFixed(0)}KB / ${Date.now() - t0}ms`);
      const runner = await deps.getRunner();
      const results = [];
      for (const it of items) {
        if (gen !== runGen) return;                        // 已被新一轮/切换作废
        post({ type: "caseRunning", gen, id: it.case.id });
        const run = await runner.run(r.wasm, it.case.input, deps.getTimeoutMs());
        if (gen !== runGen) return;
        const j = judgeCase(run, it.case.expected);
        const res = {
          verdict: j.verdict, detail: j.detail, firstDiff: j.firstDiff,
          out: run.out || "", err: run.err || "", ms: run.ms || 0,
          timedOut: !!run.timedOut, code: run.code, truncated: !!run.truncated,
        };
        results.push({ verdict: j.verdict });
        post({ type: "result", gen, file, id: it.case.id, result: res });
        deps.log(`[对拍] ${it.case.name}: ${j.verdict}${j.detail ? "（" + j.detail + "）" : ""} ${res.ms}ms`);
      }
      const sum = summarize(results);
      post({ type: "summary", gen, file, text: sum.text, allPass: sum.allPass });
      deps.log(`[对拍] 完成：${sum.text}`);
    } catch (e) {
      const text = stripAnsi(String((e && (e.message || e)) || e));
      deps.log("[对拍] 运行环境错误：" + text);
      post({ type: "compileError", gen, file, text: text.slice(0, 8000) });
    } finally {
      running = false;
      post({ type: "runEnd", gen });
    }
  }

  async function runAllNow() {
    if (!current) { const ok = await syncTarget(); if (!ok) return; }
    await execute(deps.store.get(keyOf(current)).map((c) => ({ case: c })), false);
  }

  return {
    resolveWebviewView(webviewView) {
      // ⚠️ 只认"当前这个实例"：VS Code 可能先 resolve 新实例再 dispose 旧实例，
      //    无条件 view=null 会让之后所有消息都发不出去（面板变哑巴）。
      view = webviewView;
      webviewReady = false;
      webviewView.webview.options = { enableScripts: true };
      webviewView.webview.html = html();
      webviewView.onDidDispose(() => {
        if (view === webviewView) { view = null; webviewReady = false; current = null; }
      });
      webviewView.webview.onDidReceiveMessage((m) => {
        onMessage(m).catch((e) => deps.log("[对拍] 处理消息出错：" + ((e && e.message) || e)));
      });
    },
    /** 编辑器变化时调用：切文件 / 关光文件都走这里（会先 flush） */
    async syncIfNeeded() {
      if (!view) return false;
      const t = deps.activeTarget();
      if (!t) {
        if (current) { await askFlush(); current = null; rev++; post({ type: "noFile", text: START_TEXT }); }
        return false;
      }
      if (current && keyOf(current) === keyOf(t)) { current = t; return false; }   // 同文件：只更新源码
      await askFlush();
      current = t;
      rev++;
      post(stateOf(t));
      return true;
    },
    async open() {
      if (view) {
        try { view.show?.(true); } catch { }
        await this.syncIfNeeded();
        return;
      }
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    },
    async openAndRun() {
      if (!deps.activeTarget()) { vscode.window.showWarningMessage("先打开一个 C/C++ 源文件（.cpp/.cc/.cxx/.c）"); return; }
      if (view && webviewReady) { await this.open(); await runAllNow(); return; }
      pendingRunAll = true;
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    },
    /** 关窗口前把队列里的写盘冲掉（deactivate 调用） */
    async flush() { try { await deps.store.flush(); } catch { } },
    dispose() { if (view) { try { view.dispose?.(); } catch { } } view = null; webviewReady = false; current = null; },
  };
}

/** 去掉编译日志里的 ANSI 色码（否则面板上一堆 \x1b[1m） */
function stripAnsi(s) {
  return String(s || "").replace(/\x1b\[[0-9;]*m/g, "").replace(/\r\n?/g, "\n");
}

// ---------------------------------------------------------------- 前端
function html() {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const csp = [
    "default-src 'none'",
    "img-src data:",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  return `<!DOCTYPE html><html lang="zh-CN"><head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { color-scheme: light dark; }
  body { font: 13px/1.45 var(--vscode-font-family); color: var(--vscode-foreground); padding: 10px 12px 40px; }
  .bar { position: sticky; top: 0; z-index: 5; display: flex; gap: 8px; align-items: center;
         padding: 8px 0 10px; background: var(--vscode-editor-background); flex-wrap: wrap; }
  .bar .file { font-family: var(--vscode-editor-font-family, monospace); opacity: .8; margin-right: auto; }
  button { font: inherit; padding: 4px 10px; border-radius: 4px; cursor: pointer;
           border: 1px solid var(--vscode-button-border, transparent);
           background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: .5; cursor: default; }
  .case { border: 1px solid var(--vscode-panel-border, #8884); border-radius: 6px; margin: 0 0 10px; overflow: hidden; }
  .case.run { border-color: var(--vscode-focusBorder); }
  .head { display: flex; gap: 8px; align-items: center; padding: 6px 8px;
          background: var(--vscode-editorWidget-background); }
  .head .name { font-weight: 600; }
  .badge { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; font-weight: 700;
           padding: 1px 6px; border-radius: 10px; border: 1px solid currentColor; margin-left: 6px; }
  .AC { color: var(--vscode-testing-iconPassed, #2ea043); }
  .WA { color: var(--vscode-testing-iconFailed, #f14c4c); }
  .TLE { color: var(--vscode-editorWarning-foreground, #cca700); }
  .RE { color: var(--vscode-errorForeground, #f14c4c); }
  .spacer { margin-left: auto; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
  @media (max-width: 430px) { .grid { grid-template-columns: 1fr; }
    .pane + .pane { border-left: 0; border-top: 1px solid var(--vscode-panel-border, #8884); } }
  .pane { padding: 6px 8px; }
  .pane + .pane { border-left: 1px solid var(--vscode-panel-border, #8884); }
  .pane label { display: block; font-size: 11px; opacity: .7; margin-bottom: 4px; }
  textarea { width: 100%; box-sizing: border-box; min-height: 74px; resize: vertical;
             font-family: var(--vscode-editor-font-family, monospace); font-size: 12px;
             color: var(--vscode-input-foreground); background: var(--vscode-input-background);
             border: 1px solid var(--vscode-input-border, #8884); border-radius: 4px; padding: 6px; }
  .out { border-top: 1px solid var(--vscode-panel-border, #8884); padding: 6px 8px;
         background: var(--vscode-textCodeBlock-background); }
  .out pre { margin: 4px 0 0; white-space: pre-wrap; word-break: break-all;
             font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
  .diff { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
  .diff .l { color: var(--vscode-testing-iconFailed, #f14c4c); }
  .diff .r { color: var(--vscode-testing-iconPassed, #2ea043); }
  .hint { opacity: .65; font-size: 12px; }
  .err { color: var(--vscode-errorForeground); }
  #banner { margin: 0 0 8px; font-weight: 600; }
  #errbox { display: none; margin: 0 0 10px; padding: 8px; border-radius: 6px;
            border: 1px solid var(--vscode-errorForeground, #f14c4c); }
  #errbox.show { display: block; }
  #errbox .t { color: var(--vscode-errorForeground); font-weight: 600; margin-bottom: 4px; }
  #errbox pre { margin: 0; max-height: 220px; overflow: auto; white-space: pre-wrap; word-break: break-all;
                font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
  .tout { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; opacity: .9; }
  .tout input { width: 68px; padding: 2px 4px; font: inherit;
                color: var(--vscode-input-foreground); background: var(--vscode-input-background);
                border: 1px solid var(--vscode-input-border, #8884); border-radius: 4px; }
  #start { padding: 28px 12px; text-align: center; }
  #start .icon { font-size: 34px; opacity: .5; margin-bottom: 8px; }
  #start .t { font-weight: 600; margin-bottom: 6px; }
  #start .d { opacity: .7; font-size: 12px; line-height: 1.6; }
</style></head><body>
<div class="bar">
  <span class="file" id="file">—</span>
  <button class="primary" id="runAll">▶ 运行全部</button>
  <button id="add">+ 用例</button>
  <button id="refresh" title="重新载入当前文件的用例">⟳</button>
  <button id="clear" title="清空当前文件的用例">清空</button>
  <label class="tout" title="单个用例的超时（毫秒），可直接改，改完立即保存">超时
    <input id="timeout" type="number" min="200" max="60000" step="100" />ms
  </label>
</div>
<div id="errbox"><div class="t">编译失败（详情见下图；完整日志在「WebC++ 调试」输出面板）</div><pre id="errtext"></pre></div>
<div id="banner"></div>
<div id="list"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const START_TEXT = ${JSON.stringify(START_TEXT)};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// 状态：file(URI) + rev 是"身份"，所有发往宿主的消息都必须带
let state = { file: "", rev: 0, name: "", timeoutMs: 2000, cases: [] };
const results = new Map();
let busy = false, runningId = null, startMode = false, dirty = false, gen = 0;

function payload(extra) { return Object.assign({ file: state.file, rev: state.rev }, extra || {}); }
function collect() {
  return state.cases.map((c) => ({ id: c.id, name: c.name, input: String(c.input ?? ""), expected: String(c.expected ?? "") }));
}

// ---------- 渲染：只在"结构变化"时重建；结果用增量 patch ----------
function render() {
  const focus = captureFocus();
  $("file").textContent = startMode ? "" : (state.name || "");
  const list = $("list");
  if (startMode) {
    list.innerHTML = '<div id="start"><div class="icon">🧪</div>' +
      '<div class="t">还没有打开 C/C++ 文件</div>' +
      '<div class="d">' + esc(START_TEXT) + '</div></div>';
    setButtonsEnabled(false);
    return;
  }
  list.innerHTML = "";
  if (!state.cases.length) {
    list.innerHTML = '<p class="hint">这个文件还没有用例。点「+ 用例」开始，或把题目样例粘进来。</p>';
  }
  for (const c of state.cases) {
    const el = document.createElement("div");
    el.className = "case";
    el.dataset.id = c.id;
    el.innerHTML =
      '<div class="head"><span class="name">' + esc(c.name) + '</span>' + badgeHTML(results.get(c.id)) +
        '<span class="spacer"></span><button data-act="run">▶ 运行</button><button data-act="del">删除</button></div>' +
      '<div class="grid">' +
        '<div class="pane"><label>输入</label><textarea class="in" spellcheck="false"></textarea></div>' +
        '<div class="pane"><label>期望输出</label><textarea class="exp" spellcheck="false"></textarea></div>' +
      '</div>' +
      '<div class="out" hidden></div>';
    const taIn = el.querySelector("textarea.in");
    const taExp = el.querySelector("textarea.exp");
    taIn.value = c.input;
    taExp.value = c.expected;
    taIn.addEventListener("input", () => { c.input = taIn.value; markDirty(); });
    taExp.addEventListener("input", () => { c.expected = taExp.value; markDirty(); });
    el.addEventListener("click", (ev) => {
      const act = ev.target && ev.target.dataset && ev.target.dataset.act;
      if (act === "run") vscode.postMessage(payload({ type: "runOne", id: c.id, cases: collect() }));
      if (act === "del") vscode.postMessage(payload({ type: "delete", id: c.id, cases: collect() }));
    });
    list.appendChild(el);
    if (results.has(c.id)) patchOut(el, results.get(c.id));
  }
  setButtonsEnabled(!busy && !startMode);
  restoreFocus(focus);
}

function badgeHTML(r) {
  if (!r) return "";
  const ms = r.ms ? " " + r.ms + "ms" : "";
  return '<span class="badge ' + r.verdict + '">' + r.verdict + ms + '</span>';
}

/** 只更新某个用例的徽章/输出，不重建 DOM（保住输入法、撤销栈、滚动位置） */
function patchCase(id, r) {
  const el = document.querySelector('.case[data-id="' + id + '"]');
  if (!el) return;
  const head = el.querySelector(".head");
  const old = head.querySelector(".badge");
  if (old) old.remove();
  const nameEl = head.querySelector(".name");
  if (r && nameEl) nameEl.insertAdjacentHTML("afterend", badgeHTML(r));
  el.classList.toggle("run", runningId === id);
  patchOut(el, r);
}

function patchOut(el, r) {
  const box = el.querySelector(".out");
  if (!box) return;
  if (!r) { box.hidden = true; box.innerHTML = ""; return; }
  box.hidden = false;
  let h = "";
  if (r.firstDiff) {
    h += '<div class="diff">第 ' + (r.firstDiff.index + 1) + ' 行不同：期望 ' +
      esc(JSON.stringify(r.firstDiff.expected)) + '　实际 ' + esc(JSON.stringify(r.firstDiff.actual)) + '</div>';
  }
  if (r.verdict === "TLE") h += '<div class="hint">超时（' + (r.ms || 0) + 'ms）：检查死循环，或调大上面的超时</div>';
  if (r.truncated) h += '<div class="hint">输出过多，已截断</div>';
  if (r.detail) h += '<div class="err">' + esc(r.detail) + '</div>';
  if (r.out) h += "<pre>" + esc(String(r.out).slice(0, 4000)) + "</pre>";
  if (r.err) h += '<pre class="err">' + esc(String(r.err).slice(0, 2000)) + "</pre>";
  box.innerHTML = h || '<div class="hint">（无输出）</div>';
}

function setButtonsEnabled(on) { for (const b of document.querySelectorAll(".bar button")) b.disabled = !on; }

function captureFocus() {
  const el = document.activeElement;
  if (!el || !el.classList || !(el.classList.contains("in") || el.classList.contains("exp"))) return null;
  const box = el.closest(".case");
  if (!box) return null;
  return { id: box.dataset.id, which: el.classList.contains("in") ? "in" : "exp", start: el.selectionStart, end: el.selectionEnd };
}
function restoreFocus(f) {
  if (!f) return;
  const box = document.querySelector('.case[data-id="' + f.id + '"]');
  const ta = box && box.querySelector("textarea." + f.which);
  if (!ta) return;
  try { ta.focus(); ta.setSelectionRange(f.start, f.end); } catch { }
}

// ---------- 保存：防抖 + 立即冲刷（都带身份） ----------
let saveTimer = null;
function markDirty() { dirty = true; clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 400); }
function flushSave() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!dirty) return;
  dirty = false;
  vscode.postMessage(payload({ type: "save", cases: collect() }));
}
window.addEventListener("blur", flushSave);
document.addEventListener("visibilitychange", () => { if (document.hidden) flushSave(); });

// ---------- 按钮 ----------
$("runAll").addEventListener("click", () => {
  const cases = collect();
  if (!cases.length) { banner("还没有用例"); return; }
  flushSave();
  vscode.postMessage(payload({ type: "runAll", cases }));
});
$("add").addEventListener("click", () => vscode.postMessage(payload({ type: "add", cases: collect() })));
$("refresh").addEventListener("click", () => { flushSave(); vscode.postMessage({ type: "refresh" }); });
$("clear").addEventListener("click", () => vscode.postMessage(payload({ type: "clear" })));
$("timeout").addEventListener("change", () => vscode.postMessage({ type: "setTimeout", ms: Number($("timeout").value) }));
$("timeout").addEventListener("keydown", (ev) => { if (ev.key === "Enter") $("timeout").blur(); });

function banner(text, color) { $("banner").textContent = text || ""; $("banner").style.color = color || ""; }
function showError(text) { $("errtext").textContent = text || ""; $("errbox").classList.add("show"); }

// ---------- 宿主消息 ----------
window.addEventListener("message", (ev) => {
  const m = ev.data || {};
  if (m.type === "init") {
    // 同文件同版本 → 什么都不做（避免用同一份数据重绘正在编辑的内容）
    if (!startMode && m.file === state.file && m.rev === state.rev) return;
    if (dirty && m.file === state.file) flushSave();    // 还有没落盘的编辑，先冲上去
    state = { file: m.file, rev: m.rev, name: m.name || m.file, timeoutMs: m.timeoutMs || state.timeoutMs, cases: m.cases || [] };
    const alive = new Set(state.cases.map((c) => c.id));
    for (const id of [...results.keys()]) if (!alive.has(id)) results.delete(id);
    startMode = false; dirty = false; busy = false; runningId = null;
    banner(""); $("errbox").classList.remove("show");
    if (document.activeElement !== $("timeout")) $("timeout").value = String(state.timeoutMs);
    render();
  } else if (m.type === "noFile") {
    startMode = true; busy = false; runningId = null; dirty = false;
    state = { file: "", rev: 0, name: "", timeoutMs: state.timeoutMs, cases: [] };
    results.clear();
    banner(""); $("errbox").classList.remove("show");
    render();
  } else if (m.type === "flush") {
    flushSave();
    vscode.postMessage({ type: "flushed", id: m.id });
  } else if (m.type === "runStart") {
    if (m.file !== state.file) return;
    gen = m.gen; busy = true; runningId = null;
    results.clear();
    $("errbox").classList.remove("show");
    banner("运行中… 0/" + (m.count || 0));
    for (const el of document.querySelectorAll(".case")) {
      const b = el.querySelector(".badge"); if (b) b.remove();
      const o = el.querySelector(".out"); if (o) { o.hidden = true; o.innerHTML = ""; }
    }
    setButtonsEnabled(false);
  } else if (m.type === "caseRunning") {
    if (m.gen !== gen) return;
    runningId = m.id;
    const el = document.querySelector('.case[data-id="' + m.id + '"]');
    if (el) el.classList.add("run");
  } else if (m.type === "result") {
    if (m.gen !== gen || m.file !== state.file) return;   // 过期结果直接丢
    runningId = null;
    results.set(m.id, m.result);
    patchCase(m.id, m.result);
  } else if (m.type === "summary") {
    if (m.gen !== gen || m.file !== state.file) return;
    banner(m.text, m.allPass ? "var(--vscode-testing-iconPassed,#2ea043)" : "var(--vscode-testing-iconFailed,#f14c4c)");
  } else if (m.type === "runEnd") {
    if (m.gen !== gen) return;
    busy = false; runningId = null;
    setButtonsEnabled(!startMode);
  } else if (m.type === "compileError") {
    if (m.gen !== gen || (m.file && m.file !== state.file)) return;
    banner("编译失败", "var(--vscode-errorForeground)");
    showError(m.text);
  } else if (m.type === "log") {
    banner(m.text || "");
  } else if (m.type === "saved") {
    if (!m.ok) banner("⚠ 这次编辑没有保存成功（内容还在，可以再改一下或点 ⟳）", "var(--vscode-errorForeground)");
  } else if (m.type === "timeout") {
    state.timeoutMs = m.ms;
    if (document.activeElement !== $("timeout")) $("timeout").value = String(m.ms);
    if (m.ok === false) banner("⚠ 超时没能保存：" + (m.reason || ""), "var(--vscode-errorForeground)");
    else banner("超时已保存：" + m.ms + "ms");
  }
});

render();
vscode.postMessage({ type: "ready" });
</script></body></html>`;
}
