// 极简 DAP（Debug Adapter Protocol）适配器：给 VS Code 的调试 UI 提供 wasm 源码级调试。
//
// 设计取舍（MVP，可靠优先）：
//   · 断点：源码行 → DWARF 行表 → wasm 语句起点 → 插桩 siteId（不支持的行返回 unverified）
//   · 暂停：插桩探针命中 + SharedArrayBuffer/Atomics.wait 阻塞
//   · 调用栈：探针里抓 JS 栈（V8 会给 wasm-function[N]:0xNNN + 函数名），再用 DWARF 映射成 文件:行
//   · 变量：暂停时把线性内存快照给 DWARF 引擎；引擎读 locals/globals 时我们暂无快照 → 显示为不可用
import * as vscode from "vscode";
import { instrumentWasm, firstInstrOffset, parseWasm } from "../core/wasm-bin.mjs";

let MOD_ID = "oi-debug";

/** 引擎 evaluate 的返回格式 → 给人看的字符串 */
function formatValue(vi) {
  if (vi == null) return "<no value>";
  if (typeof vi === "string") return vi;
  if (vi.description != null) return String(vi.description);   // 引擎给的展示串（BigInt 友好）
  if (vi.displayValue != null) return String(vi.displayValue);
  if (vi.value != null) return typeof vi.value === "bigint" ? vi.value.toString() : String(vi.value);
  if (vi.data != null) return typeof vi.data === "string" ? vi.data : JSON.stringify(vi.data);
  return JSON.stringify(vi);
}   // 每次会话重新赋值，避免重复 launch 冲突

export class WasmDebugAdapter {
  /**
   * @param {object} o
   * @param {{source:string,fileName:string,flags:string}} o.target 要调试的源码
   * @param {() => Promise<any>} o.getEngine  返回 DWARF 引擎（已 start）
   * @param {(args:object)=>Promise<{wasm:Uint8Array,log:string,exit:number}>} o.compile 编译成调试产物
   * @param {string} o.workerUrl   dist/web/debugWorker.js
   * @param {(s:string)=>void} [o.log]
   */
  constructor({ target, getEngine, compile, workerUrl, log, onSnapshot, onFrame, terminal }) {
    this.target = target;
    this.getEngine = getEngine;
    this.compile = compile;
    this.workerUrl = workerUrl;
    this.log = log || (() => {});
    this.onSnapshot = onSnapshot || (() => {});   // 把暂停时的内存快照交给符号引擎宿主
    this.onFrame = onFrame || (() => {});         // locals 快照位置 + 类型表（引擎读局部变量用）
    this.terminal = terminal || null;             // { write(text), onInput(cb), dispose() }
    this._seq = 1;
    this._emitter = new vscode.EventEmitter();
    this.onDidSendMessage = this._emitter.event;

    this.session = null;        // { engine, orig, instr, sites, sitesByLine, codeBase, importCount, bodies }
    this.worker = null;
    this.sab = null;
    this.ctrl = null;
    this.stdinSab = null;
    this.stdinCtrl = null;
    this.stdinBuf = null;
    this._inputQueue = [];      // 终端输入缓冲（宿主只能在工作线程空闲时写单槽）
    this.paused = null;         // { siteId, frames, memory, site }
    this.enabledSites = new Set();
    this.terminated = false;
    this.memory = null;         // 暂停时的内存快照
    this._configured = false;
    this._status = null;
    this.stats = { t0: 0, pauses: 0, sites: 0, files: 0, exit: null };
  }

  /** 写终端（把 \n 统一成终端需要的 \r\n）；同时不影响 Debug Console 的 output 事件 */
  _term(text) {
    if (!this.terminal) return;
    const s = String(text).replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
    try { this.terminal.write(s); } catch {}
  }
  _statusMsg(text) {
    try {
      this._status?.dispose();
      this._status = vscode.window.setStatusBarMessage(text, 600000);
    } catch {}
  }

  dispose() { this._kill(); try { this._emitter.dispose(); } catch {} }

  // ---------------------------------------------------------------- DAP 入口
  // ⚠️ DAP 请求的形状是 { type:"request", command:"launch", ... }：
  //    分发表必须用 command（之前用 msg.type 去找 on_request，导致每个请求都被当成
  //    未知命令回了个空成功 → VS Code 以为 launch 完成、永远等不到 initialized → 卡死）
  handleMessage(msg) {
    if (!msg || msg.type !== "request") return;
    const command = msg.command;
    this.log(`DAP ← ${command}${msg.arguments ? " " + JSON.stringify(msg.arguments).slice(0, 120) : ""}`);
    const fn = this[`on_${command}`];
    if (!fn) { this._respond(msg, undefined); return; }
    Promise.resolve()
      .then(() => fn.call(this, msg))
      .catch((e) => {
        const text = String((e && (e.stack || e.message)) || e);
        this.log(`✗ ${command} 失败: ${text}`);
        this._error(msg, text);
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
    this.stats.t0 = Date.now();
    this._statusMsg("$(sync~spin) OI C++ 调试：准备中…");
    this._term("\x1b[36m== OI C++ 调试（WASM）==\x1b[0m\r\n");
    this._term(`源文件: ${this.target.fileName}\r\n`);
    this._event("output", { category: "console", output: "正在构建调试版本（-O0 -g，带插桩桩）…\n" });
    await this._prepare();
    this._term("\x1b[36m[4/4] 启动程序…\x1b[0m\r\n");
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
        // 栈顶帧用「暂停点」的精确行号，而不是函数入口行（否则调用栈里显示的行号会偏）
        const site = p.site;
        if (i === 0 && site) { file = site.file; line = site.line; }
        // 只给"用户源文件"挂 source：sysroot 里的 crt1-command.c 之类是 wasisdk: 虚拟路径，
        // 挂上去会让 VS Code 尝试打开它并弹 "Unable to resolve resource wasisdk:..." 错误。
        const isUserFile = !!file && file.endsWith("/" + this.target.fileName);
        frames.push({
          id: i + 1, name,
          source: isUserFile
            ? { name: file.split("/").pop(), path: this.target.sourceUri || file }
            : undefined,
          line: isUserFile ? line : 0,
          column: 1,
        });
      }
    }
    this._respond(req, { stackFrames: frames, totalFrames: frames.length });
  }

  async on_scopes(req) {
    const frameId = (req.arguments && req.arguments.frameId) || 1;
    // WASM 只能读"当前帧"的 wasm local（浏览器没有提供读外层帧 local 的 API），
    // 所以外层栈帧给一个说明性 scope，而不是假装有值或直接空白。
    if (frameId !== 1) {
      return this._respond(req, {
        scopes: [{ name: `Locals（第 ${frameId} 帧）`, variablesReference: 2, expensive: false }],
      });
    }
    this._respond(req, { scopes: [{ name: "Locals", variablesReference: 1, expensive: false }] });
  }

  async on_variables(req) {
    // MVP：变量读取依赖 locals/global 快照，目前只保证内存里的变量能被引擎解析；失败就返回空
    try {
      const s = this.session, p = this.paused;
      const ref = req.arguments && req.arguments.variablesReference;
      if (ref === 2) {
        return this._respond(req, {
          variables: [{
            name: "（说明）",
            value: "外层栈帧的局部变量暂不支持：WASM 只允许读当前帧的 local。用「继续」回到该帧后可查看。",
            type: "info",
            variablesReference: 0,
          }],
        });
      }
      if (!s || !p) return this._respond(req, { variables: [] });
      const loc = this._currentRawLocation();
      const vars = await s.engine.listVariablesInScope(loc);
      const out = [];
      for (let i = 0; i < vars.length; i++) {
        const info = vars[i];
        let value = "";
        try {
          // ⚠️ 宿主→引擎的 RPC 只暴露 evaluate，没有 getValueInfo（后者只是插件内部方法）
          const vi = await s.engine.evaluate(info.name, loc, p.stopId);
          value = formatValue(vi);
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
    const args = req.arguments || {};
    const ctx = args.context || "repl";
    const isHover = ctx === "hover";
    try {
      const frameId = args.frameId || 1;
      const s = this.session, p = this.paused;
      if (!s || !p) return this._respond(req, { result: "", variablesReference: 0 });
      if (frameId !== 1) {
        return this._respond(req, {
          result: "外层栈帧暂不支持求值（WASM 只能读当前帧 local）", variablesReference: 0,
        });
      }
      const loc = this._currentRawLocation();
      const vi = await s.engine.evaluate(String(args.expression || ""), loc, p.stopId);
      this._respond(req, { result: formatValue(vi), variablesReference: 0 });
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (isHover) return this._respond(req, { result: "", variablesReference: 0 });
      // 把引擎的 EvalError 前缀剥掉，只留诊断本身（调试控制台里更好读）
      const short = msg.replace(/^EvalError: /, "").replace(/<expr>:\d+:\d+: /, "");
      this._respond(req, { result: "错误: " + short, variablesReference: 0 });
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
    this._statusMsg("$(debug-alt) OI C++ 调试：运行中");
    // ⚠️ 必须由宿主直接写 SAB：worker 正在 Atomics.wait，收不到 postMessage
    Atomics.store(this.ctrl, 1, mode);
    Atomics.store(this.ctrl, 0, 1);
    Atomics.notify(this.ctrl, 0);
    this._respond(req, { allThreadsContinued: true });
  }

  async _prepare() {
    const t0 = Date.now();
    MOD_ID = "oi-debug-" + Date.now();
    this.log("① 开始编译调试版本…");
    this._term("[1/4] 编译调试版本（-O0 -g + 插桩桩）…\r\n");
    const tCompile = Date.now();
    const r = await this.compile({ source: this.target.source, fileName: this.target.fileName, flags: this.target.flags, opt: 0, debugInfo: true, debugStub: true });
    this.log("① 编译完成 " + ((r && r.wasm) ? (r.wasm.byteLength / 1024).toFixed(0) + "KB" : "失败"));
    if (!r || !r.wasm) {
      this._term("\x1b[31m      编译失败\x1b[0m\r\n");
      throw new Error("调试构建失败: " + String((r && r.log) || "").split("\n").slice(0, 6).join(" | "));
    }
    this._term(`      \x1b[32m✓\x1b[0m ${(r.wasm.byteLength / 1024).toFixed(0)}KB，${Date.now() - tCompile}ms\r\n`);
    const orig = new Uint8Array(r.wasm);
    this.log("② 取 DWARF 引擎…");
    this._term("[2/4] 启动 DWARF 符号引擎（首次约 12.7MB）…\r\n");
    const tEngine = Date.now();
    const engine = await this.getEngine();
    this.log("② 引擎就绪");
    this._term(`      \x1b[32m✓\x1b[0m 就绪，${Date.now() - tEngine}ms\r\n`);
    const info = parseWasm(orig);
    if (info.probeImportIndex < 0) throw new Error("调试构建缺少 oi.probe import（桩没链上）");
    const codeBase = info.code.contentStart;
    const importCount = info.funcImports.length;

    // 只给"用户工作区文件"生成语句站点（避免把 165 个头文件全插桩：体积/速度都吃不消）
    const wasmUrl = "file:///workspace/" + this.target.fileName;
    this.log(`③ addRawModule…（url=${wasmUrl}，code=${r.wasm ? (r.wasm.byteLength / 1024).toFixed(0) + "KB" : "无"}）`);
    this._term("[3/4] 解析 DWARF 符号…\r\n");
    let sources;
    try {
      sources = await engine.addRawModule(MOD_ID, wasmUrl, r.wasm);
    } catch (e) {
      // 引擎内部错误的可见性：把上下文拼进错误消息（URL 相关的异常尤其需要）
      throw new Error(`addRawModule 失败（url=${wasmUrl}）: ${(e && e.message) || e}`);
    }
    this.log("③ 源文件 " + ((sources && sources.length) || 0) + " 个");
    this._term(`      \x1b[32m✓\x1b[0m 源文件 ${(sources || []).length} 个\r\n`);
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
    this.log(`④ 语句站点 ${sites.length} 个`);
    if (!sites.length) throw new Error("没有生成任何语句站点（DWARF 行表为空？）");
    this._term(`      \x1b[32m✓\x1b[0m 可断点语句 ${sites.length} 个（用户文件 ${userFiles.length} 个）\r\n`);

    const instr = instrumentWasm(orig, sites.map((s) => ({ id: s.id, offset: s.origOffset })));
    if (instr.dropped && instr.dropped.length) this.log(`插桩丢弃 ${instr.dropped.length} 个点`);
    this.session = {
      engine, orig, instr, sites, siteByLine, codeBase, importCount,
      bodies: info.code.bodies,
      fileOfInterest: "file:///workspace/" + this.target.fileName,
      fileName: this.target.fileName,
      siteById: new Map(sites.map((s) => [s.id, s])),
      siteIdToBody: new Map(sites.map((s) => [s.id, s.body])),
      bodyLocals: instr.bodyLocals || [],
    };
    this.stats.sites = sites.length;
    this.stats.files = userFiles.length;
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

    // stdin：真终端输入（协议与 runWorker 完全一致）
    this.stdinSab = new SharedArrayBuffer(8 + 65536);
    this.stdinCtrl = new Int32Array(this.stdinSab, 0, 2);
    this.stdinBuf = new Uint8Array(this.stdinSab, 8);
    this._inputQueue = [];
    if (this.terminal && typeof this.terminal.onInput === "function") {
      this.terminal.onInput((bytes) => this._queueInput(bytes));
    }

    this.log(`启动调试运行 worker（${s.sites.length} 个站点，断点 ${this.enabledSites.size} 个）`);
    this._term("程序即将运行。\r\n\x1b[90m· 输入直接在本终端键入（和平时运行一样）\r\n· 命中断点会在左侧停住，可看调用栈/单步\r\n· 停止会话请按调试工具条的 ⏹ 或 Ctrl+Shift+F5\x1b[0m\r\n\r\n");
    // 把焦点切到这个终端：否则用户会在"调试控制台"里输入（那里是 REPL，不喂 stdin）
    try { this.terminal?.show?.(); } catch {}
    this.worker = new Worker(this.workerUrl);
    this.worker.onmessage = (ev) => this._onWorkerMessage(ev.data);
    this.worker.onerror = (e) => { this._error2("debug worker 崩溃: " + ((e && e.message) || e)); };
    this.worker.postMessage({
      type: "init",
      wasm: s.instr.wasm.buffer,
      sites: s.sites,
      breakpointSab: this.bpSab,
      sab: this.sab,
      stdinSAB: this.stdinSab,
      bodyLocals: s.bodyLocals || [],
      fileName: s.fileName,
    }, [s.instr.wasm.buffer]);
    // 注意：instr.wasm 的 buffer 被转移走了，后面不要再读它
    s.instr = null;
  }

  /** 终端输入：宿主只能在 state===0（worker 空闲）时写单槽，其余排队等 consumed */
  _queueInput(bytes) {
    if (!bytes || !bytes.length) return;
    this._inputQueue.push(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    this._flushInput();
  }
  _flushInput() {
    const ctrl = this.stdinCtrl, buf = this.stdinBuf;
    if (!ctrl || !buf) return;
    while (this._inputQueue.length) {
      if (Atomics.load(ctrl, 0) !== 0) return;      // worker 侧还没取走上一批
      const chunk = this._inputQueue.shift();
      const n = Math.min(chunk.length, buf.length);
      buf.set(chunk.subarray(0, n), 0);
      if (n < chunk.length) this._inputQueue.unshift(chunk.subarray(n));
      Atomics.store(ctrl, 1, n);
      Atomics.store(ctrl, 0, 1);
      Atomics.notify(ctrl, 0);
      return;
    }
  }

  _onWorkerMessage(m) {
    if (!m || typeof m !== "object") return;
    if (m.type === "consumed") { this._flushInput(); return; }
    if (m.type === "stdout" || m.type === "stderr") {
      this._event("output", { category: m.type === "stderr" ? "stderr" : "stdout", output: m.text });
      this._term(m.text);                                   // 程序输出进真终端
      return;
    }
    if (m.type === "started") {
      this._statusMsg("$(debug-alt) OI C++ 调试：运行中");
      this._event("process", { name: "wasm program", isLocalProcess: true, systemProcessId: 0, startMethod: "launch" });
      return;
    }
    if (m.type === "error") { this._error2(m.message); return; }
    if (m.type === "exit") {
      const code = m.code || 0;
      const ms = this.stats.t0 ? Date.now() - this.stats.t0 : 0;
      const sec = (ms / 1000).toFixed(1);
      const color = code === 0 ? "32" : "31";
      this._term(`\r\n\x1b[${color}m[程序${code === 0 ? "正常退出" : "异常退出"} code=${code}]\x1b[0m 总用时 ${sec}s，暂停 ${this.stats.pauses} 次，可断点语句 ${this.stats.sites} 个\r\n`);
      this._term("\x1b[90m[调试会话结束] 关掉这个终端不会影响代码；再点 🐞 会重新编译。\x1b[0m\r\n");
      this._status?.dispose(); this._status = null;
      this._event("exited", { exitCode: code });
      this._event("terminated", {});
      this._kill();
      return;
    }
    if (m.type === "paused") {
      this.paused = {
        siteId: m.siteId, site: m.site, frames: m.frames || [], memory: m.memory, stopId: { siteId: m.siteId },
        localsBase: m.localsBase || 0, bodyLocals: m.bodyLocals || [],
      };
      this.memory = m.memory || null;
      this.onSnapshot(this.memory);   // 内存快照给引擎读变量
      this.onFrame?.({ base: this.paused.localsBase, types: this.paused.bodyLocals });
      this.stats.pauses++;
      const site = m.site;
      const where = site ? `${site.file.split("/").pop()}:${site.line}` : "?";
      this.log(`⏸ 暂停 site=${m.siteId} ${where}（栈 ${this.paused.frames.length} 帧，内存快照 ${this.memory ? (this.memory.byteLength / 1024).toFixed(0) + "KB" : "无"}）`);
      this._term(`\r\n\x1b[33m[暂停] ${where}（第 ${this.stats.pauses} 次）\x1b[0m\r\n`);
      this._statusMsg(`$(debug-pause) OI C++ 调试：已暂停 ${where}`);
      this._event("stopped", {
        reason: (this._lastMode && this._lastMode !== 1) ? "step" : "breakpoint",
        threadId: 1,
        allThreadsStopped: true,
        text: where,
        description: `暂停在 ${site ? site.file + ":" + site.line : "?"}`,
      });
    }
  }

  _error2(message) {
    this.log("✗ " + String(message));
    this._term(`\r\n\x1b[31m[调试失败] ${String(message)}\x1b[0m\r\n`);
    this._status?.dispose(); this._status = null;
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
    try { this._status?.dispose(); } catch {}
    this._status = null;
  }

  // ---- 供宿主（extension.js）注入：DWARF 引擎的宿主 getter 需要读暂停快照 ----
  getLinearMemorySnapshot() { return this.memory; }
}
