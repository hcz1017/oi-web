// 测试用例（对拍）逻辑回归测试：判定 / diff / 存储 / 批量编排。
// 纯 Node，秒级；不需要编译器和 wasm。
import {
  VERDICT, normalizeOutput, compareOutput, judgeCase, TestCaseStore,
  runCases, summarize, newCaseId, nextCaseName, TEST_CASES_KEY, shouldAcceptCases, pickRunTarget, normalizeTimeout, shouldAcceptPayload,
} from "../src/web/testcases.js";

let pass = true;
const must = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) pass = false; return c; };

// 假 memento：写入即 JSON 序列化（复现 vscode.dev 的真实行为）
function fakeMemento() {
  const store = new Map();
  return {
    _store: store,
    get(k, d) { return store.has(k) ? JSON.parse(store.get(k)) : d; },
    update(k, v) { store.set(k, JSON.stringify(v)); return Promise.resolve(); },
  };
}

// ---------- 归一化 ----------
must(normalizeOutput("1 2 3\n") === "1 2 3", "去掉末尾换行");
must(normalizeOutput("1 2 \t\n3\n\n\n") === "1 2\n3", "去掉行尾空白 + 末尾空行");
must(normalizeOutput("a\r\nb") === "a\nb", "CRLF 归一");
must(normalizeOutput("") === "", "空输出");
must(normalizeOutput("  \n\n") === "", "只有空白 → 空");

// ---------- 比较 ----------
{
  const ok = compareOutput("1 2\n3\n", "1 2\n3");
  must(ok.ok === true && ok.firstDiff === null, "行尾空白/末尾换行不影响判定（AC）");
  const bad = compareOutput("1 2\n4\n", "1 2\n3\n");
  must(bad.ok === false && bad.firstDiff.index === 1, `能定位第一处不同的行（第 ${bad.firstDiff.index + 1} 行）`);
  must(bad.firstDiff.expected === "3" && bad.firstDiff.actual === "4", "diff 里带期望/实际内容");
  const shorter = compareOutput("1", "1\n2");
  must(shorter.ok === false && shorter.firstDiff.index === 1, "少了行也能定位");
  must(compareOutput("", "").ok === true, "两边都空 → AC");
}

// ---------- 判定 ----------
{
  must(judgeCase({ out: "42\n", code: 0 }, "42").verdict === VERDICT.AC, "输出一致 → AC");
  must(judgeCase({ out: "41\n", code: 0 }, "42").verdict === VERDICT.WA, "输出不一致 → WA");
  must(judgeCase({ out: "", timedOut: true }, "42").verdict === VERDICT.TLE, "超时 → TLE");
  must(judgeCase({ out: "", trap: "unreachable" }, "42").verdict === VERDICT.RE, "trap → RE");
  must(judgeCase({ out: "坏", code: 1 }, "42").verdict === VERDICT.RE, "非零退出且输出不对 → 判 RE（比 WA 更可能是真崩了）");
  must(judgeCase({ out: "42", code: 1 }, "42").verdict === VERDICT.AC, "非零退出但输出对 → 仍算 AC（有些题故意 return 非 0）");
}

// ---------- 存储（JSON 往返） ----------
{
  const m = fakeMemento();
  const store = new TestCaseStore(m);
  must(store.get("a.cpp").length === 0, "空库");
  const c1 = store.add("a.cpp", { input: "1 2\n", expected: "3" });
  await store.flush();
  must(!!c1.id && c1.name === "用例 1", `新增用例有 id 和默认名（${c1.name}）`);
  store.add("a.cpp", { input: "4 5", expected: "9" });
  await store.flush();
  must(store.get("a.cpp").length === 2, "两个用例都存下了");
  must(store.get("b.cpp").length === 0, "按文件名隔离（b.cpp 不受影响）");
  must(store.get("a.cpp")[0].input === "1 2\n", "多行输入在 JSON 往返后完好（含换行）");

  const fresh = new TestCaseStore(m);      // 模拟"重启 VS Code"：从 memento 重新加载
  must(fresh.get("a.cpp").length === 2, "重新加载后用例还在（持久化生效）");
  must(fresh.get("a.cpp")[1].expected === "9", "内容一致");

  const id = fresh.get("a.cpp")[0].id;
  fresh.remove("a.cpp", id);
  await fresh.flush();
  must(fresh.get("a.cpp").length === 1, "删除单个用例");
  must(new TestCaseStore(m).get("a.cpp").length === 1, "删除也持久化了");

  fresh.clear("a.cpp");
  await fresh.flush();
  must(new TestCaseStore(m).get("a.cpp").length === 0, "清空该文件的用例");
  must(new TestCaseStore(m).files().includes("a.cpp"), "文件条目仍留着（空数组，便于下次继续加）");
}

// ---------- 脏数据清洗 ----------
{
  const m = fakeMemento();
  m.update(TEST_CASES_KEY, {
    "x.cpp": [
      { id: "k1", name: "用例 1", input: "1", expected: "2" },
      { name: "没有 id", input: "3", expected: "4" },      // 缺 id → 补一个
      { id: "k3" },                                        // 缺 input（非法）→ 丢弃
      null, "垃圾",
    ],
    "y.cpp": "不是数组 → 丢掉",
  });
  const store = new TestCaseStore(m);
  const list = store.get("x.cpp");
  must(list.length === 2, `非法用例被过滤（留下 ${list.length} 个）`);
  must(list.every((c) => typeof c.id === "string" && c.id), "缺 id 的自动补上");
  must(list[1].input === "3", "合法但没有 id 的用例保留内容");
  must(store.get("y.cpp").length === 0, "形状不对的文件条目当空处理");
}

// ---------- 命名 ----------
{
  must(nextCaseName([{ name: "用例 1" }]) === "用例 2", "下一个名字顺延");
  must(nextCaseName([{ name: "用例 1" }, { name: "用例 3" }]) === "用例 2", "跳过已占用的名字");
  must(newCaseId() !== newCaseId(), "id 不重复");
}

// ---------- 批量运行编排 ----------
{
  const cases = [
    { id: "1", name: "用例 1", input: "1 2\n", expected: "3" },
    { id: "2", name: "用例 2", input: "2 2\n", expected: "5" },
    { id: "3", name: "用例 3", input: "0 0\n", expected: "0" },
  ];
  const seen = [];
  // 假运行器：把输入的两个数相加；"0 0" 那个故意死循环 → 超时
  const runOnce = async (c) => {
    seen.push(c.id);
    if (c.input.trim() === "0 0") return { out: "", timedOut: true, ms: 2000 };
    const [a, b] = c.input.trim().split(/\s+/).map(Number);
    return { out: `${a + b}\n`, code: 0, ms: 5 };
  };
  const progress = [];
  const res = await runCases({ cases, runOnce, onProgress: (x) => progress.push(x) });
  must(seen.join(",") === "1,2,3", "用例按顺序串行执行");
  must(res.length === 3, "三个用例都有结果");
  must(res[0].verdict === VERDICT.AC, "用例 1 → AC");
  must(res[1].verdict === VERDICT.WA, "用例 2 → WA（3≠5）");
  must(res[1].firstDiff && res[1].firstDiff.index === 0, "WA 带第一处不同的位置");
  must(res[2].verdict === VERDICT.TLE, "用例 3 → TLE");
  must(progress.length === 3, "每个用例出结果都回调（面板能逐个刷新）");

  const sum = summarize(res);
  must(sum.total === 3 && sum.ac === 1 && sum.allPass === false, `汇总：${sum.text}`);
  must(sum.firstFail && sum.firstFail.case.id === "2", "汇总能指出第一个失败的用例");
  must(summarize([]).text === "没有用例", "空用例的汇总文案");
}

// ---------- 超时时间：面板可编辑，写入前必须夹紧 ----------
{
  must(normalizeTimeout(2000) === 2000, "合法值原样保留");
  must(normalizeTimeout("3000") === 3000, "字符串数字也能解析（输入框给的是字符串）");
  must(normalizeTimeout(0) === 2000, "0 → 回退默认（否则一跑就 TLE）");
  must(normalizeTimeout(-5) === 2000, "负数 → 回退默认");
  must(normalizeTimeout("abc") === 2000, "非数字 → 回退默认");
  must(normalizeTimeout(1) === 200, "太小 → 夹到下限 200ms");
  must(normalizeTimeout(999999) === 60000, "太大 → 夹到上限 60s");
  must(normalizeTimeout(1234.6) === 1235, "四舍五入成整数");
  must(normalizeTimeout("", 3000) === 3000, "空串用调用方给的 fallback");
}

// ---------- 运行前必须用「现读的源码」（否则改完代码还命中旧缓存） ----------
{
  const stale = { fileName: "a.cpp", source: "int main(){return 0;}" };          // 同步时的快照
  const fresh = { fileName: "a.cpp", source: "int main(){return 1;}" };          // 刚读的最新内容

  const same = pickRunTarget(stale, fresh);
  must(same.reason === "same-file", "同文件：reason=same-file");
  must(same.target.source === fresh.source, "同文件时必须用现读的源码（旧缓存的元凶）");
  must(same.switched === false, "同文件不算切换（不该重置面板状态）");

  const other = pickRunTarget(stale, { fileName: "b.cpp", source: "x" });
  must(other.switched === true && other.target.fileName === "b.cpp", "切到别的文件 → 用新文件并标记 switched");

  const noCurrent = pickRunTarget(null, fresh);
  must(noCurrent.switched === true && noCurrent.target === fresh, "面板还没绑定 → 直接用手上的");

  const noActive = pickRunTarget(stale, null);
  must(noActive.target === null && noActive.reason === "no-file", "没有打开的 C/C++ 文件 → 不乱跑");
}

// ---------- 写盘：串行 + 失败上报（审查指出的"概率性丢数据"根源） ----------
{
  // 假 memento：update 故意乱序完成（后发起的先 resolve），模拟 Web 端异步存储
  const store = new Map();
  const order = [];
  let seq = 0;
  const slowMemento = {
    get(k, d) { return store.has(k) ? JSON.parse(store.get(k)) : d; },
    update(k, v) {
      const my = ++seq;
      const delay = my === 1 ? 40 : 5;          // 第一次写最慢
      return new Promise((res) => setTimeout(() => {
        store.set(k, JSON.stringify(v));
        order.push(my);
        res();
      }, delay));
    },
  };
  const errs = [];
  const st = new TestCaseStore(slowMemento, undefined, { onError: (m) => errs.push(m) });
  st.set("a.cpp", [{ id: "1", name: "用例 1", input: "v1", expected: "1" }]);
  st.set("a.cpp", [{ id: "1", name: "用例 1", input: "v2", expected: "1" }]);   // 紧接着再改
  await st.flush();
  const persisted = JSON.parse(store.get("oiCpp.testCases.v1"))["a.cpp"][0].input;
  must(persisted === "v2", `连续两次编辑后落盘的是最后一次（${persisted}）`);
  must(order.join(",") === "1,2", `写入按提交顺序串行完成（实际 ${order.join(",")}）`);
  must(errs.length === 0, "正常写入不误报错误");
  must((await st.flush()) === true, "flush() 之后没有未落盘内容");
}

{
  // 写盘抛错：要能拿到错误（不能静默吞掉）
  const errs = [];
  const broken = {
    get(_k, d) { return d; },
    update() { throw new Error("quota exceeded"); },
  };
  const st = new TestCaseStore(broken, undefined, { onError: (m) => errs.push(m) });
  st.set("a.cpp", [{ id: "1", name: "用例 1", input: "x", expected: "x" }]);
  await st.flush();
  must(errs.length > 0 && /quota exceeded/.test(errs[0]), `写盘失败会上报（${errs[0]}）`);
  must(st.get("a.cpp").length === 1, "写盘失败不影响内存里的数据（本次会话仍可继续用）");
}

// ---------- 防误清空（真实事故：面板没就绪就点运行 → 旧用例全没了） ----------
{
  const existing = [{ id: "a", name: "用例 1", input: "1", expected: "1" }];
  must(shouldAcceptCases({ incoming: [], existing, ready: false }).reason === "not-ready-empty",
    "未就绪 + 提交空 → 拒绝（这是「清空全部用例」的元凶）");
  must(shouldAcceptCases({ incoming: [], existing, ready: true }).reason === "empty-overwrite",
    "已就绪但提交空、本地有数据 → 也拒绝（宁可让用户重试，也别清数据）");
  must(shouldAcceptCases({ incoming: [], existing: [], ready: true }).ok === true,
    "本地本来就空 → 允许提交空（比如刚清空）");
  must(shouldAcceptCases({ incoming: [{ id: "x", input: "1", expected: "2" }], existing, ready: true }).ok === true,
    "正常提交 → 允许");
  must(shouldAcceptCases({ incoming: "不是数组", existing, ready: true }).reason === "not-array", "非数组 → 拒绝");
  must(shouldAcceptCases({ incoming: [{ id: "x" }], existing, ready: true }).reason === "bad-shape", "缺 input/expected → 拒绝");
  // 未就绪但本地为空：允许（首次打开、面板自己创建的空用例）
  must(shouldAcceptCases({ incoming: [], existing: [], ready: false }).ok === true, "未就绪且本地为空 → 允许");
}

// ---------- 运行器抛异常也要有结果 ----------
{
  const res = await runCases({
    cases: [{ id: "x", name: "用例 1", input: "", expected: "" }],
    runOnce: async () => { throw new Error("worker 崩了"); },
  });
  must(res[0].verdict === VERDICT.RE && /worker 崩了/.test(res[0].detail), "运行器抛异常 → RE 且带原因（不能让面板卡住）");
}


// ---------- payload identity: 防止 A 的用例写进 B ----------
{
  const okSame = shouldAcceptPayload({ msgFile: "file:///a.cpp", msgRev: 3, currentFile: "file:///a.cpp", currentRev: 3 });
  must(okSame.ok === true, "payload: 同文件同版本 -> 接受");
  const otherFile = shouldAcceptPayload({ msgFile: "file:///a.cpp", msgRev: 3, currentFile: "file:///b.cpp", currentRev: 3 });
  must(otherFile.ok === false && otherFile.reason === "other-file", "payload: 别的文件 -> 拒绝（串写根源）");
  const stale = shouldAcceptPayload({ msgFile: "file:///a.cpp", msgRev: 2, currentFile: "file:///a.cpp", currentRev: 3 });
  must(stale.ok === false && stale.reason === "stale-version", "payload: 版本过期 -> 拒绝");
  must(shouldAcceptPayload({ msgFile: "", currentFile: "file:///a.cpp" }).reason === "no-file", "payload: 缺文件名 -> 拒绝");
  must(shouldAcceptPayload({ msgFile: "file:///a.cpp", currentFile: "file:///a.cpp", currentRev: 5 }).ok === true,
    "payload: 没有 rev -> 宽容接受");
  must(shouldAcceptPayload({ msgFile: "file:///d1/main.cpp", currentFile: "file:///d2/main.cpp" }).ok === false,
    "payload: 不同目录同名文件 -> 拒绝");
}

console.log(pass ? "\n全部通过" : "\n存在失败项");
process.exit(pass ? 0 : 1);
