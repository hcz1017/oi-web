// 极简 DAP（Debug Adapter Protocol）适配器：给 VS Code 的调试 UI 提供 wasm 源码级调试。
//
// 设计取舍（MVP，可靠优先）：
//   · 断点：源码行 → DWARF 行表 → wasm 语句起点 → 插桩 siteId（不支持的行返回 unverified）
//   · 暂停：插桩探针命中 + SharedArrayBuffer/Atomics.wait 阻塞
//   · 调用栈：探针里抓 JS 栈（V8 会给 wasm-function[N]:0xNNN + 函数名），再用 DWARF 映射成 文件:行
//   · 变量：暂停时把线性内存快照给 DWARF 引擎；引擎读 locals/globals 时我们暂无快照 → 显示为不可用
import * as vscode from "vscode";
import { instrumentWasm, firstInstrOffset, parseWasm } from "../core/wasm-bin.mjs";

let MOD_ID = "oi-debug";   // 每次会话重新赋值，避免重复 launch 冲突

export class WasmDebugAdapter {
  /**
   * @param {object} o
   * @param {{source:string,fileName:string,flags:string}} o.target 要调试的源码
   * @param {() => Promise<any>} o.getEngine  返回 DWARF 引擎（已 start）
   * @param {(args:object)=>Promise<{wasm:Uint8Array,log:string,exit:number}>} o.compile 编译成调试产物
   * @param {string} o.workerUrl   dist/web/debugWorker.js
   * @param {(s:string)=>void} [o.log]
   */
  constructor({ target, getEngine, compile, workerUrl, log, onSnapshot }) {
    this.target = target;
    this.getEngine = getEngine;
    this.compile = compile;
    this.workerUrl = workerUrl;
    this.log = log || (() => {});
    this.onSnapshot = onSnapshot || (() => {});   // 把暂停时的内存快照交给符号引擎宿主
    this._seq = 1;
    this._emitter = new vscode.EventEmitter();
    this.onDidSendMessage = this._emitter.event;

    this.session = null;        // { engine, orig, instr, sites, sitesByLine, codeBase, importCount, bodies }
    this.worker = null;
    this.sab = null;
    this.ctrl = null;
    this.paused = null;         // { siteId, frames, memory, site }
    this.enabledSites = new Set();
    this.terminated = false;
    this.memory = null;         // 暂停时的内存快照
    this._configured = false;
  }

  dispose() { this._kill(); try { this._emitter.dispose(); } catch {} }

  // ---------------------------------------------------------------- DAP 入口
  handleMessage(msg) {
    const fn = this[`on_${msg.type}`];
    if (!fn) { if (msg.type === "request") this._respond(msg, undefined); return; }
    Promise.resolve()
      .then(() => fn.call(this, msg))
      .catch((e) => {
        this._error(msg, String((e && e.message) || e));
      });
  }

  _send(m) { m.seq = this._seq++; this._emitter.fire(m); }
  _respond(req, body) { this._send({ seq: 0, type: "response", request_seq: req.seq, success: true, command: req.command, body }); }
  _error(req, message) { this._send({ seq: 0, type: "response", request_seq: req.seq, success: false, command: req.command, message }); }
  _event(event, body) { this._send({ seq: 0, type: "event", event, body }); }

  async on_initialize(req) {
    this._respond(req, {
      supportsConfigurationDoneRequest: true,
      supportsEvaluateForHovers: true,
      supportsTerminateRequest: true,
      supportsRestartRequest: false,
      supportsSetVariable: false,
      supportsStepBack: false,
    });
  }

  async on_launch(req) {
    this._event("output", { category: "console", output: "正在构建调试版本（-O0 -g，带插桩桩）…\n" });
    await this._prepare();
    this._event("output", { category: "console", output: "调试准备完成，等待断点配置…\n" });
    this._respond(req, {});
    // 告诉 VS Code：可以发断点了
    this._event("initialized", {});
  }

  async on_setBreakpoints(req) {
    const args = req.arguments || {};
    const bps = [];
    const s = this.session;
    const enabled = new Set();
    for (const b of args.breakpoints || []) {
      const line = b.line | 0;                       // DAP 1-based
      const siteIds = s ? this._resolveLine(line) : [];
      if (!siteIds.length) {
        bps.push({ verified: false, line, message: "没有可下断点的语句（空行/注释/头文件/未被行表覆盖）" });
        continue;
      }
      for (const id of siteIds) enabled.add(id);
      bps.push({ verified: true, line });
    }
    this.enabledSites = enabled;
    this._syncBreakpointsToWorker();
    this.log(`断点 ${(args.source && args.source.path) || "?"}: ${bps.filter((x) => x.verified).length}/${bps.length} 已验证`);
    this._respond(req, { breakpoints: bps });
  }

  async on_configurationDone(req) {
    this._configured = true;
    this._respond(req, {});
    await this._startProgram();
  }

  async on_threads(req) { this._respond(req, { threads: [{ id: 1, name: "main (wasm)" }] }); }

  async on_stackTrace(req) {
    const frames = [];
    const p = this.paused;
    const s = this.session;
    if (p && s) {
      const engine = s.engine;
      for (let i = 0; i < p.frames.length; i++) {
        const f = p.frames[i];
        const bodyIdx = f.funcIndex - s.importCount;
        const body = s.bodies[bodyIdx];
        let file = "", line = 0, name = f.name || ("wasm-function[" + f.funcIndex + "]");
        if (body) {
          // 用函数体第一个语句定位（比 V8 的 offset 基准更稳）
          const orig = firstInstrOffset(s.orig, body);
          const locs = await engine.rawLocationToSourceLocation({
            rawModuleId: MOD_ID, codeOffset: orig - s.codeBase, inlineFrameIndex: 0,
          }).catch(() => null);
          const l0 = (locs || [])[0];
          if (l0) { file = l0.sourceFileURL; line = l0.lineNumber + 1; }
          try {
            const info = await engine.getFunctionInfo({ rawModuleId: MOD_ID, codeOffset: orig - s.codeBase, inlineFrameIndex: 0 });
            const fname = info && info.frames && info.frames[0] && info.frames[0].name;
            if (fname) name = fname;
          } catch {}
        }
        const isUserFile = file && file.endsWith("/" + this.target.fileName);
        frames.push({
          id: i + 1, name,
          source: file
            ? { name: file.split("/").pop(), path: isUserFile && this.target.sourceUri ? this.target.sourceUri : file }
            : undefined,
          line, column: 1,
        });
      }
    }
    this._respond(req, { stackFrames: frames, totalFrames: frames.length });
  }

  async on_scopes(req) {
    this._respond(req, { scopes: [{ name: "Locals", variablesReference: 1, expensive: false }] });
  }

  async on_variables(req) {
    // MVP：变量读取依赖 locals/global 快照，目前只保证内存里的变量能被引擎解析；失败就返回空
    try {
      const s = this.session, p = this.paused;
      if (!s || !p) return this._respond(req, { variables: [] });
      const loc = this._currentRawLocation();
      const vars = await s.engine.listVariablesInScope(loc);
      const out = [];
      for (let i = 0; i < vars.length; i++) {
        const info = vars[i];
        let value = "";
        try {
          const vi = await s.engine.getValueInfo(info.name, loc, p.stopId);
          value = (vi && (vi.displayValue ?? vi.data)) != null ? String(vi.displayValue ?? JSON.stringify(vi.data)) : "";
        } catch (e) { value = "<unavailable>"; }
        out.push({
          name: info.name,
          value: value === "" ? "<unavailable>" : value,
          type: info.type,
          variablesReference: 0,
        });
      }
      this._respond(req, { variables: out });
    } catch (e) {
      this._respond(req, { variables: [] });
    }
  }

  async on_evaluate(req) {
    try {
      const s = this.session, p = this.paused;
      if (!s || !p) return this._respond(req, { result: "<no active stop>", variablesReference: 0 });
      const loc = this._currentRawLocation();
      const vi = await s.engine.getValueInfo(String(req.arguments && req.arguments.expression), loc, p.stopId);
      const text = vi ? String(vi.displayValue ?? (vi.data != null ? JSON.stringify(vi.data) : "(no value)")) : "(not found)";
      this._respond(req, { result: text, variablesReference: 0 });
    } catch (e) {
      this._respond(req, { result: "<unavailable: " + ((e && e.message) || e) + ">", variablesReference: 0 });
    }
  }

  async on_continue(req) { this._resume(req, 1); }
  async on_next(req) { this._resume(req, 3); }
  async on_stepIn(req) { this._resume(req, 2); }
  async on_stepOut(req) { this._resume(req, 4); }
  async on_pause(req) {
    // 运行期主动暂停：下次探针命中即停（把模式设成"任意语句"）
    if (this.worker) this.worker.postMessage({ type: "resume", mode: 2 });
    this._respond(req, {});
  }
  async on_disconnect(req) { this._kill(); this._respond(req, {}); this._event("terminated", {}); }
  async on_terminate(req) { this._kill(); this._respond(req, {}); this._event("terminated", {}); }

  // ---------------------------------------------------------------- 内部
  _resume(req, mode) {
    if (!this.worker || !this.ctrl) { this._respond(req, {}); return; }
    this._lastMode = mode;
    this.paused = null;
    this._event("continued", { threadId: 1, allThreadsContinued: true });
    // ⚠️ 必须由宿主直接写 SAB：worker 正在 Atomics.wait，收不到 postMessage
    Atomics.store(this.ctrl, 1, mode);
    Atomics.store(this.ctrl, 0, 1);
    Atomics.notify(this.ctrl, 0);
    this._respond(req, { allThreadsContinued: true });
  }

  async _prepare() {
    const t0 = Date.now();
    MOD_ID = "oi-debug-" + Date.now();
    const r = await this.compile({ source: this.target.source, fileName: this.target.fileName, flags: this.target.flags, opt: 0, debugInfo: true, debugStub: true });
    if (!r || !r.wasm) throw new Error("调试构建失败: " + String((r && r.log) || "").split("\n").slice(0, 6).join(" | "));
    const orig = new Uint8Array(r.wasm);
    const engine = await this.getEngine();
    const info = parseWasm(orig);
    if (info.probeImportIndex < 0) throw new Error("调试构建缺少 oi.probe import（桩没链上）");
    const codeBase = info.code.contentStart;
    const importCount = info.funcImports.length;

    // 只给"用户工作区文件"生成语句站点（避免把 165 个头文件全插桩：体积/速度都吃不消）
    const wasmUrl = "file:///workspace/" + this.target.fileName;
    const sources = await engine.addRawModule(MOD_ID, wasmUrl, r.wasm);
    const userFiles = (sources || []).filter((u) => /^file:\/\/\/workspace\//.test(u));
    const sites = [];
    const siteByLine = new Map();   // `${file}:${line0}` -> [siteId]
    let nextId = 1;
    for (const file of userFiles) {
      let lines = [];
      try { lines = (await engine.getMappedLines(MOD_ID, file)) || []; } catch { lines = []; }
      for (const line0 of lines) {
        let rangeStart = null;
        for (let col = 0; col <= 200 && rangeStart == null; col++) {
          const rs = await engine.sourceLocationToRawLocation({
            rawModuleId: MOD_ID, sourceFileURL: file, lineNumber: line0, columnNumber: col,
          }).catch(() => null);
          if (rs && rs.length) rangeStart = rs[0].startOffset;
        }
        if (rangeStart == null) continue;
        const origOffset = codeBase + rangeStart;
        const bodyIdx = info.code.bodies.findIndex((b) => origOffset >= b.bodyStart && origOffset < b.end);
        if (bodyIdx < 0) continue;
        const id = nextId++;
        sites.push({ id, line: line0 + 1, file, body: bodyIdx, origOffset });
        const key = `${file}:${line0}`;
        if (!siteByLine.has(key)) siteByLine.set(key, []);
        siteByLine.get(key).push(id);
      }
    }
    if (!sites.length) throw new Error("没有生成任何语句站点（DWARF 行表为空？）");

    const instr = instrumentWasm(orig, sites.map((s) => ({ id: s.id, offset: s.origOffset })));
    this.session = {
      engine, orig, instr, sites, siteByLine, codeBase, importCount,
      bodies: info.code.bodies,
      fileOfInterest: "file:///workspace/" + this.target.fileName,
      fileName: this.target.fileName,
      siteById: new Map(sites.map((s) => [s.id, s])),
      siteIdToBody: new Map(sites.map((s) => [s.id, s.body])),
    };
    this.log(`调试准备完成：${sites.length} 个语句站点 / ${userFiles.length} 个用户文件 / ${Date.now() - t0}ms`);
  }

  /** DAP 1-based line → 该行（或邻近声明行）的 siteId 列表 */
  _resolveLine(line1) {
    const s = this.session;
    if (!s) return [];
    const line0 = line1 - 1;
    const tryLines = [line0, line0 + 1, line0 + 2, line0 + 3];
    for (const l of tryLines) {
      const ids = s.siteByLine.get(`${s.fileOfInterest}:${l}`);
      if (ids && ids.length) return ids;
    }
    return [];
  }
  _linesOfSite(id) {
    const s = this.session;
    const site = s && s.siteById.get(id);
    return site ? [site.line] : [];
  }

  _currentRawLocation() {
    const s = this.session, p = this.paused;
    const site = p && s && s.siteById.get(p.siteId);
    const origOffset = site ? site.origOffset : 0;
    return { rawModuleId: MOD_ID, codeOffset: origOffset - (s ? s.codeBase : 0), inlineFrameIndex: 0 };
  }

  _syncBreakpointsToWorker() {
    if (!this.bp) return;
    this.bp.fill(0);
    for (const id of this.enabledSites) {
      const w = id >>> 5, m = 1 << (id & 31);
      Atomics.store(this.bp, w, Atomics.load(this.bp, w) | m);
    }
  }

  async _startProgram() {
    const s = this.session;
    if (!s) { this._event("terminated", {}); return; }
    this.sab = new SharedArrayBuffer(8);
    this.ctrl = new Int32Array(this.sab);
    // 断点位图（按最大 siteId 分配；宿主可随时改，worker 无需收消息）
    const words = Math.ceil(Math.max(1, ...s.sites.map((x) => x.id)) / 32) + 1;
    this.bpSab = new SharedArrayBuffer(words * 4);
    this.bp = new Int32Array(this.bpSab);
    this._syncBreakpointsToWorker();
    this.worker = new Worker(this.workerUrl);
    this.worker.onmessage = (ev) => this._onWorkerMessage(ev.data);
    this.worker.onerror = (e) => { this._error2("debug worker 崩溃: " + ((e && e.message) || e)); };
    this.worker.postMessage({
      type: "init",
      wasm: s.instr.wasm.buffer,
      sites: s.sites,
      breakpointSab: this.bpSab,
      sab: this.sab,
      fileName: s.fileName,
    }, [s.instr.wasm.buffer]);
    // 注意：instr.wasm 的 buffer 被转移走了，后面不要再读它
    s.instr = null;
  }

  _onWorkerMessage(m) {
    if (!m || typeof m !== "object") return;
    if (m.type === "stdout" || m.type === "stderr") {
      this._event("output", { category: m.type === "stderr" ? "stderr" : "stdout", output: m.text });
      return;
    }
    if (m.type === "started") { this._event("process", { name: "wasm program", isLocalProcess: true, systemProcessId: 0, startMethod: "launch" }); return; }
    if (m.type === "error") { this._error2(m.message); return; }
    if (m.type === "exit") {
      this._event("exited", { exitCode: m.code || 0 });
      this._event("terminated", {});
      this._kill();
      return;
    }
    if (m.type === "paused") {
      this.paused = { siteId: m.siteId, frames: m.frames || [], memory: m.memory, stopId: { siteId: m.siteId } };
      this.memory = m.memory || null;
      this.onSnapshot(this.memory);
      const site = m.site;
      const line = site ? site.line : 1;
      this._event("stopped", {
        reason: (this._lastMode && this._lastMode !== 1) ? "step" : "breakpoint",
        threadId: 1,
        allThreadsStopped: true,
        text: site ? `${site.file.split("/").pop()}:${site.line}` : "",
        description: `暂停在 ${site ? site.file + ":" + site.line : "?"}`,
      });
      void line;
    }
  }

  _error2(message) {
    this._event("output", { category: "stderr", output: String(message) + "\n" });
    this._event("terminated", {});
    this._kill();
  }

  _kill() {
    if (this.terminated) return;
    this.terminated = true;
    try {
      if (this.session && this.session.engine) this.session.engine.removeRawModule(MOD_ID).catch(() => {});
    } catch {}
    if (this.worker) { try { this.worker.postMessage({ type: "shutdown" }); } catch {} try { this.worker.terminate(); } catch {} this.worker = null; }
    this.paused = null;
    this.memory = null;
  }

  // ---- 供宿主（extension.js）注入：DWARF 引擎的宿主 getter 需要读暂停快照 ----
  getLinearMemorySnapshot() { return this.memory; }
}
