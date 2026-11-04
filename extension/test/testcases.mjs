// 测试用例（对拍）逻辑回归测试：判定 / diff / 存储 / 批量编排。
// 纯 Node，秒级；不需要编译器和 wasm。
import {
  VERDICT, normalizeOutput, compareOutput, judgeCase, TestCaseStore,
  runCases, summarize, newCaseId, nextCaseName, TEST_CASES_KEY,
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
  must(!!c1.id && c1.name === "用例 1", `新增用例有 id 和默认名（${c1.name}）`);
  store.add("a.cpp", { input: "4 5", expected: "9" });
  must(store.get("a.cpp").length === 2, "两个用例都存下了");
  must(store.get("b.cpp").length === 0, "按文件名隔离（b.cpp 不受影响）");
  must(store.get("a.cpp")[0].input === "1 2\n", "多行输入在 JSON 往返后完好（含换行）");

  const fresh = new TestCaseStore(m);      // 模拟"重启 VS Code"：从 memento 重新加载
  must(fresh.get("a.cpp").length === 2, "重新加载后用例还在（持久化生效）");
  must(fresh.get("a.cpp")[1].expected === "9", "内容一致");

  const id = fresh.get("a.cpp")[0].id;
  fresh.remove("a.cpp", id);
  must(fresh.get("a.cpp").length === 1, "删除单个用例");
  must(new TestCaseStore(m).get("a.cpp").length === 1, "删除也持久化了");

  fresh.clear("a.cpp");
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

// ---------- 运行器抛异常也要有结果 ----------
{
  const res = await runCases({
    cases: [{ id: "x", name: "用例 1", input: "", expected: "" }],
    runOnce: async () => { throw new Error("worker 崩了"); },
  });
  must(res[0].verdict === VERDICT.RE && /worker 崩了/.test(res[0].detail), "运行器抛异常 → RE 且带原因（不能让面板卡住）");
}

console.log(pass ? "\n全部通过" : "\n存在失败项");
process.exit(pass ? 0 : 1);
