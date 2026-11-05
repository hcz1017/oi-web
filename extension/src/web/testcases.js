// 测试用例（对拍）的纯逻辑：判定、diff、存储、批量运行编排。
//
// 参照 CPH（Competitive Programming Helper）的最小内核：
//   · 每个用例 = { id, name, input, expected }；
//   · 跑完拿实际输出与 expected 比较 → AC / WA / TLE / RE / CE；
//   · WA 时给出"第一处不同的行"，方便一眼定位；
//   · 用例按源文件持久化（Memento，JSON 可序列化 → 只存字符串，别塞二进制）。
//
// 这里只做纯逻辑，运行器（wasm）由宿主注入，方便单元测试。

export const VERDICT = {
  AC: "AC",
  WA: "WA",
  TLE: "TLE",
  RE: "RE",
  CE: "CE",
  NONE: "—",
};

/**
 * 输出归一化（和 CPH 默认一致，适合 OI 题）：
 *   · 每行去掉行尾空白（很多题解会多打一个空格）；
 *   · 去掉末尾的空行；
 *   · 不用动中间的空行（有些题输出里本来就有空行）。
 */
export function normalizeOutput(s) {
  const text = String(s == null ? "" : s).replace(/\r\n?/g, "\n");
  const lines = text.split("\n").map((l) => l.replace(/[ \t]+$/, ""));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  while (lines.length && lines[0] === "") lines.shift();
  return lines.join("\n");
}

/**
 * 比较两段输出。
 * @returns {{ok:boolean, firstDiff:{index:number, expected:string, actual:string}|null}}
 */
export function compareOutput(actual, expected) {
  const a = normalizeOutput(actual);
  const e = normalizeOutput(expected);
  if (a === e) return { ok: true, firstDiff: null };
  const al = a === "" ? [] : a.split("\n");
  const el = e === "" ? [] : e.split("\n");
  const n = Math.max(al.length, el.length);
  for (let i = 0; i < n; i++) {
    if ((al[i] ?? "") !== (el[i] ?? "")) {
      return { ok: false, firstDiff: { index: i, expected: el[i] ?? "", actual: al[i] ?? "" } };
    }
  }
  return { ok: false, firstDiff: { index: 0, expected: e, actual: a } };
}

/**
 * 由一次运行结果得出判定。
 * @param {{out?:string, err?:string, code?:number, trap?:string|null, timedOut?:boolean}} run
 * @param {string} expected
 */
export function judgeCase(run, expected) {
  const r = run || {};
  if (r.timedOut) return { verdict: VERDICT.TLE, detail: "超时", firstDiff: null };
  if (r.trap) return { verdict: VERDICT.RE, detail: r.trap, firstDiff: null };
  const cmp = compareOutput(r.out ?? "", expected ?? "");
  if (cmp.ok) return { verdict: VERDICT.AC, detail: "", firstDiff: null };
  // 非零退出但输出对不上：优先报 RE（更可能是真崩了，而不是格式问题）
  if (typeof r.code === "number" && r.code !== 0) {
    return { verdict: VERDICT.RE, detail: `退出码 ${r.code}${r.err ? "：" + firstLine(r.err) : ""}`, firstDiff: cmp.firstDiff };
  }
  return { verdict: VERDICT.WA, detail: "", firstDiff: cmp.firstDiff };
}

function firstLine(s) {
  return String(s || "").replace(/\r\n?/g, "\n").split("\n").find((x) => x.trim()) || "";
}

/** 生成用例 id（不依赖 crypto，web 环境通用） */
let seq = 0;
export function newCaseId() {
  seq = (seq + 1) % 1e6;
  return `c${Date.now().toString(36)}${seq.toString(36)}`;
}

/** 新用例的默认名字：用例 1、用例 2 … */
export function nextCaseName(cases) {
  const used = new Set((cases || []).map((c) => c.name));
  for (let i = 1; ; i++) if (!used.has(`用例 ${i}`)) return `用例 ${i}`;
}

/**
 * 超时时间（毫秒）归一化：面板里可以直接编辑，写回设置前必须夹紧，
 * 免得用户输入 0 / 负数 / 999999 把对拍搞成"秒退"或"卡死"。
 * @param {any} v 用户输入
 * @param {number} [fallback] 无法解析时用这个（默认 2000）
 * @returns {number} 200..60000 之间的整数
 */
export function normalizeTimeout(v, fallback = 2000) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(200, Math.min(60000, Math.round(n)));
}

/**
 * 运行前决定"用哪份源码"。
 *
 * ⚠️ 真实事故：面板里的 target 是**同步那一刻**的快照（含源码文本），编辑文件后不会更新，
 *    于是对拍拿旧源码去编译 → 命中旧缓存 → 明明改了代码还判 WA，而终端运行（每次现读
 *    doc.getText()）是正常的。
 * 结论：运行前必须用**当前编辑器的最新内容**，绝不能复用快照。
 *
 * @param {{fileName:string, source:string}|null} current 面板当前绑定（快照）
 * @param {{fileName:string, source:string}|null} active  现读的当前编辑器
 * @returns {{target:object|null, switched:boolean, reason:string}}
 */
export function pickRunTarget(current, active) {
  if (!active) return { target: null, switched: false, reason: "no-file" };
  if (!current) return { target: active, switched: true, reason: "no-current" };
  if (active.fileName !== current.fileName) return { target: active, switched: true, reason: "other-file" };
  // 同一个文件：**用 active（刚读的）**，源码/参数才是最新的
  return { target: active, switched: false, reason: "same-file" };
}

/**
 * 面板发来的载荷该不该被接受（防"跨文件串写"）。
 *
 * ⚠️ 真实风险：webview 的消息和"编辑器切换事件"是两条不同的 IPC 路径，顺序不保证。
 *    切文件时如果那条 `save`（还带着 A 的用例）晚到，宿主会用 `current = B` 去落盘，
 *    结果 **A 的用例被写进 B**、A 的内容同时丢失。
 * 所以每条载荷都必须自带文件名 + 版本号，只接受"就是当前这个文件 + 同一版本"的。
 *
 * @param {{msgFile?:string, msgRev?:number, currentFile?:string, currentRev?:number}} o
 */
export function shouldAcceptPayload({ msgFile, msgRev, currentFile, currentRev } = {}) {
  if (!currentFile || !msgFile) return { ok: false, reason: "no-file" };
  if (String(msgFile) !== String(currentFile)) return { ok: false, reason: "other-file" };
  // rev 只在两边都是数字时比较（老版本消息没有 rev 时宽容放行，避免直接丢用户数据）
  if (typeof msgRev === "number" && typeof currentRev === "number" && msgRev !== currentRev) {
    return { ok: false, reason: "stale-version" };
  }
  return { ok: true, reason: "" };
}

// ---------------------------------------------------------------- 存储
export const TEST_CASES_KEY = "oiCpp.testCases.v1";

/**
 * 用例库：按**源文件名**分组持久化（同一个文件反复调试时用例还在）。
 * 只依赖 { get, update } 两个方法的 Memento，方便测试用 JSON 往返的假实现。
 */
export class TestCaseStore {
  /**
   * @param {{get:Function, update:Function}} memento
   * @param {string} [key]
   * @param {{onError?:(msg:string)=>void}} [opts] 写盘失败的出口（宿主接上后能提示用户）
   */
  constructor(memento, key = TEST_CASES_KEY, opts = {}) {
    this.memento = memento;
    this.key = key;
    this._mem = null;
    this.onError = opts.onError || null;
    // ⚠️ 写盘必须**串行**：以前每个 set() 各自调用一次异步 update()，两次快速编辑可能
    //    后发起的先落地 → 旧内容反而胜出（重启后看到的是上一版）。
    this._writeChain = Promise.resolve();
    this._dirty = false;
  }
  _load() {
    if (this._mem) return this._mem;
    let raw = null;
    try { raw = this.memento.get(this.key, null); } catch { raw = null; }
    const out = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    // 清洗：只保留形状正确的用例（以前的版本可能留下脏数据）
    this._mem = {};
    for (const [file, list] of Object.entries(out)) {
      if (!Array.isArray(list)) continue;
      this._mem[file] = list
        .filter((c) => c && typeof c === "object" && typeof c.input === "string")
        .map((c) => ({
          id: typeof c.id === "string" && c.id ? c.id : newCaseId(),
          name: typeof c.name === "string" && c.name ? c.name : "用例",
          input: c.input,
          expected: typeof c.expected === "string" ? c.expected : "",
        }));
    }
    return this._mem;
  }
  /** 把当前内容排队写入（串行 + 失败上报）。返回本次写入的 promise。 */
  _persist() {
    this._dirty = true;
    const snapshot = JSON.parse(JSON.stringify(this._load()));   // 写盘用快照，避免后续修改影响在途写入
    this._writeChain = this._writeChain.then(async () => {
      try {
        await this.memento.update(this.key, snapshot);
      } catch (e) {
        const msg = String((e && e.message) || e);
        try { this.onError?.(msg); } catch { }
        throw e;
      }
    }).catch(() => { /* 链式保活：单次失败不阻断后续写入 */ });
    return this._writeChain.then(() => { this._dirty = false; });
  }

  /** 等所有在途写入落地（测试/退出前用） */
  async flush() { try { await this._writeChain; } catch { } return !this._dirty; }
  /** @returns {Array<{id,name,input,expected}>} */
  get(fileName) { return (this._load()[fileName] || []).map((c) => ({ ...c })); }
  has(fileName) { return (this._load()[fileName] || []).length > 0; }
  set(fileName, cases) {
    this._load()[fileName] = (cases || []).map((c) => ({
      id: c.id || newCaseId(),
      name: c.name || "用例",
      input: String(c.input ?? ""),
      expected: String(c.expected ?? ""),
    }));
    this._persist();
    return this.get(fileName);
  }
  add(fileName, { input = "", expected = "" } = {}) {
    const list = this.get(fileName);
    const c = { id: newCaseId(), name: nextCaseName(list), input: String(input), expected: String(expected) };
    list.push(c);
    this.set(fileName, list);
    return c;
  }
  remove(fileName, id) {
    this.set(fileName, this.get(fileName).filter((c) => c.id !== id));
  }
  clear(fileName) { this.set(fileName, []); }
  /** 所有有自定义用例的文件名（用于诊断/清理） */
  files() { return Object.keys(this._load()); }
}

/**
 * 面板提交的用例能不能写回存储（防误清空）。
 *
 * 真实事故：面板刚打开、还没收到 init 就点了「运行全部」/「+ 用例」，
 * webview 的 collect() 拿到空数组 → 写回存储 → **已有用例全被清空**。
 * 所以这里统一判定：不合法/可疑的提交一律拒绝，由宿主把权威状态推回去。
 *
 * @param {{incoming:any, existing:Array, ready:boolean}} o
 * @returns {{ok:boolean, reason:string}}
 */
export function shouldAcceptCases({ incoming, existing = [], ready = false } = {}) {
  if (!Array.isArray(incoming)) return { ok: false, reason: "not-array" };
  const hasExisting = Array.isArray(existing) && existing.length > 0;
  if (!ready && incoming.length === 0 && hasExisting) return { ok: false, reason: "not-ready-empty" };
  if (incoming.length === 0 && hasExisting) return { ok: false, reason: "empty-overwrite" };
  // 形状校验：必须是 {id,input,expected} 的对象
  for (const c of incoming) {
    if (!c || typeof c !== "object" || typeof c.input !== "string" || typeof c.expected !== "string") {
      return { ok: false, reason: "bad-shape" };
    }
  }
  return { ok: true, reason: "" };
}

// ---------------------------------------------------------------- 批量运行
/**
 * 依次跑所有用例（不并发：编译产物/工具链都只有一份，串行最稳）。
 *
 * @param {object} o
 * @param {Array} o.cases
 * @param {(c:object)=>Promise<object>} o.runOnce  执行单个用例，返回 {out,err,code,trap,timedOut,ms}
 * @param {(p:object)=>void} [o.onProgress]        每个用例出结果时回调
 * @returns {Promise<Array<{case:object, run:object, verdict:string, detail:string, firstDiff:object|null}>>}
 */
export async function runCases({ cases, runOnce, onProgress = () => { } }) {
  const results = [];
  for (const c of cases || []) {
    let run;
    try {
      run = await runOnce(c);
    } catch (e) {
      run = { out: "", err: "", code: -1, trap: String((e && e.message) || e) };
    }
    const j = judgeCase(run, c.expected);
    const item = { case: c, run: run || {}, verdict: j.verdict, detail: j.detail, firstDiff: j.firstDiff };
    results.push(item);
    try { onProgress(item); } catch { }
  }
  return results;
}

/** 汇总：n 个用例里几个 AC */
export function summarize(results) {
  const total = (results || []).length;
  const ac = (results || []).filter((r) => r.verdict === VERDICT.AC).length;
  const worst = (results || []).find((r) => r.verdict !== VERDICT.AC);
  return {
    total, ac,
    allPass: total > 0 && ac === total,
    firstFail: worst || null,
    text: total ? `${ac}/${total} 通过` : "没有用例",
  };
}
