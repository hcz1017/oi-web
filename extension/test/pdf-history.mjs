// PDF 快照（写回前的备份）纯逻辑测试 + 一个用真实临时目录的仓库往返测试。
//
// 这套东西替代了 xxx.pdf.bak：快照存到扩展 globalStorage，供 VS Code「时间线」展示。
// 算错会导致"时间线里一堆条目但点开读不出来"，或者"裁剪把最新的一份删了"。
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync as rmF, existsSync } from "fs";
import os from "os";
import path from "path";
import { keyOf, stampName, stampOf, sortNewestFirst, pickPrune, createHistoryStore } from "../src/web/pdf/history-core.mjs";

let pass = true;
const must = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) pass = false; return c; };

// ---------- keyOf ----------
must(/^[0-9a-f]{8}$/.test(keyOf("file:///a/b.pdf")), "keyOf: 输出 8 位十六进制");
must(keyOf("file:///a/b.pdf") === keyOf("file:///a/b.pdf"), "keyOf: 稳定（同样的 URI 同样的 key）");
must(keyOf("file:///a/b.pdf") !== keyOf("file:///a/c.pdf"), "keyOf: 不同文件不同 key");
must(keyOf("") === keyOf(""), "keyOf: 空串也能算（不抛）");

// ---------- 时间戳命名 ----------
{
  const ts = new Date(2026, 10, 14, 23, 29, 22, 586).getTime();
  const name = stampName(ts);
  must(name === "20261114-232922-586.pdf", `stampName: 可读且无非法字符（${name}）`);
  must(stampOf(name) === ts, "stampOf: 能从文件名还原时间戳");
  must(stampOf("乱七八糟.pdf") === 0, "stampOf: 非法名返回 0");
  must(/^[0-9]{8}-[0-9]{6}-[0-9]{3}\.pdf$/.test(name), "stampName: 文件名格式固定（排序/校验都靠它）");
}

// ---------- 排序 / 裁剪 ----------
{
  const names = ["20260101-000000-000.pdf", "20260301-000000-000.pdf", "20260201-000000-000.pdf"];
  must(sortNewestFirst(names)[0] === "20260301-000000-000.pdf", "sortNewestFirst: 新的在前");
  must(pickPrune(names, 2).length === 1 && pickPrune(names, 2)[0] === "20260101-000000-000.pdf",
    "pickPrune: 只淘汰最旧的一份");
  must(pickPrune(names, 0).length === 2, "pickPrune: keep=0 也至少保留 1 份（不能把当前备份也删了）");
}

// ---------- 仓库往返（真实临时目录） ----------
{
  const root = mkdtempSync(path.join(os.tmpdir(), "pdfhist-"));
  const fs = {
    async mkdir(p) { mkdirSync(p, { recursive: true }); },
    async writeFile(p, bytes) { writeFileSync(p, Buffer.from(bytes)); },
    async readFile(p) { return new Uint8Array(readFileSync(p)); },
    async readDir(p) { try { return readdirSync(p); } catch { return []; } },
    async deleteFile(p) { try { rmF(p); } catch { } },
  };
  const store = createHistoryStore(fs, root, { keep: 3 });
  const uri = "file:///ws/题面.pdf";

  must((await store.list(uri)).length === 0, "list: 还没有快照时返回空数组");
  const n1 = await store.snapshot(uri, new Uint8Array([1, 2, 3]));
  must(!!n1, "snapshot: 返回快照名");
  const list1 = await store.list(uri);
  must(list1.length === 1 && list1[0].name === n1, "list: 能列出刚存的快照");
  must(list1[0].ts > 0, "list: 带时间戳");
  const bytes = await store.read(uri, n1);
  must(bytes.length === 3 && bytes[0] === 1, "read: 读回来的字节一致");

  // 再存 5 份 → keep=3，只应剩 3 份，且包含最新的
  await new Promise((r) => setTimeout(r, 3));
  const later = [];
  for (let i = 0; i < 5; i++) { await new Promise((r) => setTimeout(r, 2)); later.push(await store.snapshot(uri, new Uint8Array([9, i]))); }
  const list2 = await store.list(uri);
  must(list2.length === 3, `keep=3: 裁剪后只剩 3 份（实际 ${list2.length}）`);
  must(list2.some((x) => x.name === later[later.length - 1]), "裁剪: 最新的一份必须还在");

  // 另一个文件互不影响
  const other = "file:///ws/别的.pdf";
  must((await store.list(other)).length === 0, "不同文件互不干扰");

  // 非法快照名（防止 ../ 之类穿越）
  let rejected = false;
  try { await store.read(uri, "../../etc/passwd"); } catch { rejected = true; }
  must(rejected, "read: 非法快照名被拒绝");

  rmSync(root, { recursive: true, force: true });
}

console.log(pass ? "\n全部通过" : "\n存在失败项");
process.exit(pass ? 0 : 1);
