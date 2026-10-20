// 终端行编辑（正常运行的 OiPty 与调试终端共用同一套语义）
//
// 为什么必须行缓冲：终端按键是逐字节到来的。如果直接透传给程序的 stdin，
// 用户按一个空格/字母，scanf/cin 就会立刻"读到值"，行为和真实终端完全不同。
// 这里维护一行输入：可打印字符只回显并缓存，**回车才把整行发给程序**。
//
// 支持：
//   · 回车/换行：回显换行 + 发送 "…\n"
//   · 退格：删一个字符（回显 "\b \b"）
//   · Ctrl+D：发送当前行（若有）并触发 EOF
//   · Ctrl+C：回显 ^C，丢弃当前行（调试终端的停止请用工具条 ⏹）
//   · 方向键/Home/Delete 等 ANSI 序列：剥离，避免 "[A" 被当成输入
export function createLineEditor({ write, send }) {
  let line = "";
  return {
    input(data) {
      const cleaned = String(data)
        .replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, "")
        .replace(/\x1bO[A-Za-z]/g, "")
        .replace(/\r\n/g, "\n");
      for (const ch of cleaned) {
        if (ch === "\x04") {                       // Ctrl+D
          if (line) { send(line + "\n"); line = ""; }
          send(null, { eof: true });
          write("^D\r\n");
          return;
        }
        if (ch === "\x03") {                       // Ctrl+C
          write("^C\r\n");
          line = "";
          return;
        }
        if (ch === "\r" || ch === "\n") {
          write("\r\n");
          send(line + "\n");
          line = "";
        } else if (ch === "\x7f" || ch === "\b") {
          if (line.length) { line = line.slice(0, -1); write("\b \b"); }
        } else if (ch >= " " && ch !== "\x1b" && ch !== "\x00") {
          line += ch;
          write(ch);
        }
      }
    },
    get current() { return line; },
  };
}
