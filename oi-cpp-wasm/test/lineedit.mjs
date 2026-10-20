// 行编辑单元测试：终端按键必须"回车才提交一行"，否则单按空格程序就读到值（真实 bug）。
import { createLineEditor } from "../src/web/lineedit.mjs";

let pass = true;
const must = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) pass = false; return c; };

function mk() {
  const out = { written: "", sent: [], eof: 0 };
  const ed = createLineEditor({
    write: (s) => { out.written += s; },
    send: (text, opts) => {
      if (opts && opts.eof) { out.eof++; return; }
      if (text != null) out.sent.push(text);
    },
  });
  return { ed, out };
}

// 1) 关键回归：只输入字符/空格（没回车）不能把任何东西发给程序
{
  const { ed, out } = mk();
  ed.input("1");
  ed.input(" ");
  ed.input("2");
  must(out.sent.length === 0, `未按回车时没有数据发给程序（sent=${JSON.stringify(out.sent)}）`);
  must(out.written === "1 2", `按键回显正常（${JSON.stringify(out.written)}）`);
  ed.input("\r");
  must(out.sent.length === 1 && out.sent[0] === "1 2\n", `回车后提交整行（${JSON.stringify(out.sent)}）`);
  must(out.written.endsWith("\r\n"), "回车回显换行");
}

// 2) 退格只影响当前行，回车时提交修正后的内容
{
  const { ed, out } = mk();
  ed.input("12");
  ed.input("\x7f");
  ed.input("3");
  ed.input("\n");
  must(out.sent[0] === "13\n", `退格生效（${JSON.stringify(out.sent)}）`);
  must(out.written.includes("\b \b"), "退格有回显");
}

// 3) 多行/粘贴：CRLF 不能变成两个换行
{
  const { ed, out } = mk();
  ed.input("a\r\nb\r\n");
  must(JSON.stringify(out.sent) === JSON.stringify(["a\n", "b\n"]),
    `粘贴 CRLF 正常（${JSON.stringify(out.sent)}）`);
}

// 4) Ctrl+D：先提交残留行，再 EOF
{
  const { ed, out } = mk();
  ed.input("42");
  ed.input("\x04");
  must(out.sent[0] === "42\n" && out.eof === 1, `Ctrl+D 提交并 EOF（sent=${JSON.stringify(out.sent)}, eof=${out.eof}）`);
  ed.input("\x04");
  must(out.eof === 2 && out.sent.length === 1, "纯 Ctrl+D 只发 EOF");
}

// 5) Ctrl+C：丢弃当前行
{
  const { ed, out } = mk();
  ed.input("99");
  ed.input("\x03");
  ed.input("\r");
  must(out.sent[0] === "\n", `Ctrl+C 丢弃本行（${JSON.stringify(out.sent)}）`);
}

// 6) 方向键 ANSI 序列被剥离，不能把 "[A" 当输入
{
  const { ed, out } = mk();
  ed.input("5");
  ed.input("\x1b[A");        // ↑
  ed.input("\x1b[D");        // ←
  ed.input("6");
  ed.input("\r");
  must(out.sent[0] === "56\n", `ANSI 序列被剥离（${JSON.stringify(out.sent)}）`);
}

console.log(pass ? "\n全部通过" : "\n存在失败项");
process.exit(pass ? 0 : 1);
