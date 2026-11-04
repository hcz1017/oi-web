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

// ---------------------------------------------------------------- 存储
export const TEST_CASES_KEY = "oiCpp.testCases.v1";

/**
 * 用例库：按**源文件名**分组持久化（同一个文件反复调试时用例还在）。
 * 只依赖 { get, update } 两个方法的 Memento，方便测试用 JSON 往返的假实现。
 */
export class TestCaseStore {
  constructor(memento, key = TEST_CASES_KEY) {
    this.memento = memento;
    this.key = key;
    this._mem = null;
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
  _persist() {
    try {
      const p = this.memento.update(this.key, this._load());
      if (p && typeof p.catch === "function") p.catch(() => {});
      return true;
    } catch { return false; }
  }
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
