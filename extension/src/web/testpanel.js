// 测试面板（仿 CPH 的最小版）：编辑用例 + 一键跑全部 + 逐例判定。
//
// 为什么用 webview：用例是**多行文本**（输入/期望输出），TreeView / QuickPick 都没法编辑，
// 这是 webview 唯一合理的场景（和"用 webview 顶替 clangd"那种做法不是一回事）。
//
// 交互（都尽量少点几下）：
//   · 打开面板即显示当前 .cpp 的历史用例；
//   · 【运行全部】跑一遍，逐例出 AC/WA/TLE/RE 徽章；WA 时给出"第几行不同"；
//   · 每个用例可以单独【运行】或【删除】；头部的【+ 新用例】追加空用例；
//   · 文本改动自动保存（防抖），关掉面板再打开还在（按文件名持久化）。
import * as vscode from "vscode";
import { VERDICT, judgeCase, nextCaseName, newCaseId, summarize } from "./testcases.js";

const PANEL_TITLE = "WebC++ 测试";

/**
 * @param {object} deps
 * @param {import("./testcases.js").TestCaseStore} deps.store
 * @param {(args:{source:string,fileName:string,flags:string,opt:number})=>Promise<{wasm:Uint8Array}>} deps.compile
 * @param {()=>object} deps.getRunner            惰性拿运行器（createRunner 的返回值）
 * @param {(s:string)=>void} deps.log
 * @param {()=>{source:string,fileName:string,flags:string,opt:number}|null} deps.activeTarget
 * @param {()=>number} deps.getTimeoutMs
 */
export function createTestPanel(deps) {
  let panel = null;
  let current = null;      // { fileName, target }
  let running = false;

  const post = (m) => { try { panel?.webview.postMessage(m); } catch { } };

  function stateOf(fileName) {
    const cases = deps.store.get(fileName);
    return { type: "init", fileName, cases, timeoutMs: deps.getTimeoutMs() };
  }

  async function ensurePanel() {
    if (panel) { panel.reveal(undefined, true); return panel; }
    panel = vscode.window.createWebviewPanel(
      "oiCpp.testPanel", PANEL_TITLE,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
    );
    panel.webview.html = html(panel.webview);
    panel.onDidDispose(() => { panel = null; current = null; });
    panel.webview.onDidReceiveMessage((m) => onMessage(m));
    return panel;
  }

  async function openAndShow(runAll = false) {
    const t = deps.activeTarget();
    if (!t) { vscode.window.showWarningMessage("先打开一个 C/C++ 源文件（.cpp/.cc/.cxx/.c）"); return; }
    current = t;
    const p = await ensurePanel();
    const s = stateOf(t.fileName);
    // 第一次打开没有用例 → 直接给一个空用例，省一次点击
    if (!s.cases.length) s.cases = [deps.store.add(t.fileName, {})];
    post(s);
    if (runAll) await runAll(s.cases);
    return p;
  }

  async function onMessage(m) {
    if (!m || !m.type) return;
    if (m.type === "ready") { if (current) post(stateOf(current.fileName)); return; }
    if (m.type === "save") {
      if (!current) return;
      deps.store.set(current.fileName, m.cases || []);
      return;
    }
    if (m.type === "add") {
      if (!current) return;
      const c = deps.store.add(current.fileName, {});
      post({ type: "added", case: c });
      return;
    }
    if (m.type === "delete") {
      if (!current) return;
      deps.store.remove(current.fileName, m.id);
      return;
    }
    if (m.type === "clear") {
      if (!current) return;
      deps.store.clear(current.fileName);
      post({ type: "cleared" });
      return;
    }
    if (m.type === "runOne") {
      if (!current) return;
      deps.store.set(current.fileName, m.cases || []);
      const one = (m.cases || []).find((c) => c.id === m.id);
      if (one) await execute([{ case: one }], true);
      return;
    }
    if (m.type === "runAll") {
      if (!current) return;
      deps.store.set(current.fileName, m.cases || []);
      await execute((m.cases || []).map((c) => ({ case: c })), false);
      return;
    }
  }

  /** 编译一次，然后逐例跑 */
  async function execute(items, single) {
    if (running) { post({ type: "log", text: "正在运行，已忽略本次请求" }); return; }
    if (!current) return;
    running = true;
    post({ type: "running", single });
    try {
      post({ type: "log", text: `编译 ${current.fileName}…` });
      const t0 = Date.now();
      const r = await deps.compile({
        source: current.source, fileName: current.fileName,
        flags: current.flags, opt: current.opt,
      });
      if (!r || !r.wasm) {
        post({ type: "compileError", text: String((r && r.log) || "编译失败").slice(0, 4000) });
        return;
      }
      post({ type: "log", text: `编译完成 ${(r.wasm.byteLength / 1024).toFixed(0)}KB / ${Date.now() - t0}ms` });
      const runner = await deps.getRunner();
      const results = [];
      for (const it of items) {
        post({ type: "caseRunning", id: it.case.id });
        const run = await runner.run(r.wasm, it.case.input, deps.getTimeoutMs());
        const j = judgeCase(run, it.case.expected);
        const res = { verdict: j.verdict, detail: j.detail, firstDiff: j.firstDiff, out: run.out || "", err: run.err || "", ms: run.ms || 0 };
        results.push({ case: it.case, ...res });
        post({ type: "result", id: it.case.id, result: res });
        deps.log(`对拍 ${it.case.name}: ${j.verdict}${j.detail ? "（" + j.detail + "）" : ""} ${res.ms}ms`);
      }
      const sum = summarize(results.map((x) => ({ verdict: x.verdict })));
      post({ type: "summary", text: sum.text, allPass: sum.allPass });
      deps.log(`对拍完成：${sum.text}`);
    } catch (e) {
      post({ type: "compileError", text: String((e && (e.message || e)) || e).slice(0, 4000) });
    } finally {
      running = false;
      post({ type: "idle" });
    }
  }

  const runAll = async (cases) => { await execute((cases || []).map((c) => ({ case: c })), false); };

  return {
    open: () => openAndShow(false),
    openAndRun: () => openAndShow(true),
    /** 面板开着且是同一个文件时，重跑全部（保存时自动跑用） */
    rerunIfOpen(fileName) {
      if (!panel || !current || current.fileName !== fileName || running) return;
      execute(deps.store.get(fileName).map((c) => ({ case: c })), false);
    },
    dispose() { try { panel?.dispose(); } catch { } panel = null; },
  };
}

// ---------------------------------------------------------------- 前端
function html(webview) {
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
           padding: 1px 6px; border-radius: 10px; border: 1px solid currentColor; }
  .AC { color: var(--vscode-testing-iconPassed, #2ea043); }
  .WA { color: var(--vscode-testing-iconFailed, #f14c4c); }
  .TLE { color: var(--vscode-editorWarning-foreground, #cca700); }
  .RE { color: var(--vscode-errorForeground, #f14c4c); }
  .CE { color: var(--vscode-errorForeground, #f14c4c); }
  .spacer { margin-left: auto; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
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
</style></head><body>
<div class="bar">
  <span class="file" id="file">—</span>
  <button class="primary" id="runAll">▶ 运行全部</button>
  <button id="add">+ 新用例</button>
  <button id="clear">清空</button>
</div>
<div id="banner"></div>
<div id="list"></div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let state = { fileName: "", timeoutMs: 2000, cases: [] };
const results = new Map();      // id -> {verdict,detail,firstDiff,out,err,ms}
let runningId = null, busy = false;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function collect() {
  return [...document.querySelectorAll(".case")].map((el) => ({
    id: el.dataset.id,
    name: el.dataset.name,
    input: el.querySelector("textarea.in").value,
    expected: el.querySelector("textarea.exp").value,
  }));
}

function render() {
  $("file").textContent = state.fileName + "（超时 " + state.timeoutMs + "ms）";
  const list = $("list");
  list.innerHTML = "";
  if (!state.cases.length) {
    list.innerHTML = '<p class="hint">还没有用例。粘贴题目样例到下面，或点「+ 新用例」。</p>';
  }
  for (const c of state.cases) {
    const r = results.get(c.id);
    const el = document.createElement("div");
    el.className = "case" + (runningId === c.id ? " run" : "");
    el.dataset.id = c.id;
    el.dataset.name = c.name;
    const badge = r ? '<span class="badge ' + r.verdict + '">' + r.verdict + (r.ms ? " " + r.ms + "ms" : "") + "</span>" : "";
    el.innerHTML =
      '<div class="head"><span class="name">' + esc(c.name) + "</span>" + badge +
        '<span class="spacer"></span>' +
        '<button data-act="run">▶ 运行</button>' +
        '<button data-act="del">删除</button>' +
      "</div>" +
      '<div class="grid">' +
        '<div class="pane"><label>输入</label><textarea class="in" spellcheck="false"></textarea></div>' +
        '<div class="pane"><label>期望输出</label><textarea class="exp" spellcheck="false"></textarea></div>' +
      "</div>" +
      (r ? '<div class="out">' + outHTML(r) + "</div>" : "");
    el.querySelector("textarea.in").value = c.input;
    el.querySelector("textarea.exp").value = c.expected;
    el.querySelector("textarea.in").addEventListener("input", saveSoon);
    el.querySelector("textarea.exp").addEventListener("input", saveSoon);
    el.addEventListener("click", (ev) => {
      const act = ev.target && ev.target.dataset && ev.target.dataset.act;
      if (!act) return;
      if (act === "run") vscode.postMessage({ type: "runOne", id: c.id, cases: collect() });
      if (act === "del") { vscode.postMessage({ type: "delete", id: c.id }); state.cases = state.cases.filter((x) => x.id !== c.id); results.delete(c.id); render(); }
    });
    list.appendChild(el);
  }
  const btns = document.querySelectorAll("button");
  btns.forEach((b) => { b.disabled = busy; });
}

function outHTML(r) {
  let h = "";
  if (r.firstDiff) {
    h += '<div class="diff">第 ' + (r.firstDiff.index + 1) + ' 行不同：<span class="l">期望 ' + esc(JSON.stringify(r.firstDiff.expected)) +
         '</span>　<span class="r">实际 ' + esc(JSON.stringify(r.firstDiff.actual)) + "</span></div>";
  }
  if (r.verdict === "TLE") h += '<div class="hint">超时：检查死循环，或在设置里调大 oiCpp.testTimeout</div>';
  if (r.detail) h += '<div class="err">' + esc(r.detail) + "</div>";
  if (r.out) h += "<pre>" + esc(r.out.slice(0, 4000)) + "</pre>";
  if (r.err) h += '<pre class="err">' + esc(r.err.slice(0, 2000)) + "</pre>";
  return h;
}

let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => vscode.postMessage({ type: "save", cases: collect() }), 400);
}

$("runAll").addEventListener("click", () => {
  results.clear();
  vscode.postMessage({ type: "runAll", cases: collect() });
});
$("add").addEventListener("click", () => vscode.postMessage({ type: "add" }));
$("clear").addEventListener("click", () => {
  if (!confirm("清空这个文件的所有用例？")) return;
  results.clear();
  state.cases = [];
  render();
  vscode.postMessage({ type: "clear" });
});

window.addEventListener("message", (ev) => {
  const m = ev.data || {};
  if (m.type === "init") {
    state = { fileName: m.fileName, timeoutMs: m.timeoutMs || 2000, cases: m.cases || [] };
    results.clear();
    render();
  } else if (m.type === "added") {
    state.cases.push(m.case);
    render();
  } else if (m.type === "cleared") {
    state.cases = []; results.clear(); render();
  } else if (m.type === "running") {
    busy = true; runningId = null; $("banner").textContent = "运行中…"; render();
  } else if (m.type === "caseRunning") {
    runningId = m.id; $("banner").textContent = "运行中…"; render();
  } else if (m.type === "result") {
    results.set(m.id, m.result); render();
  } else if (m.type === "summary") {
    $("banner").textContent = m.text;
    $("banner").style.color = m.allPass ? "var(--vscode-testing-iconPassed,#2ea043)" : "var(--vscode-testing-iconFailed,#f14c4c)";
  } else if (m.type === "compileError") {
    $("banner").textContent = "编译失败";
    $("banner").style.color = "var(--vscode-errorForeground)";
    const list = $("list");
    const pre = document.createElement("pre");
    pre.className = "err";
    pre.textContent = m.text;
    list.prepend(pre);
  } else if (m.type === "log") {
    $("banner").textContent = m.text;
  } else if (m.type === "idle") {
    busy = false; runningId = null; render();
  }
});

vscode.postMessage({ type: "ready" });
</script></body></html>`;
}
