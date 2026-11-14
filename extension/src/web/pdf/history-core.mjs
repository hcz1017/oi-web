// PDF 快照（"写回前先留一份"）的**纯逻辑**：不 import vscode，方便在 Node 里直接测。
//
// 为什么不再生成 xxx.pdf.bak：
//   · .bak 会跟 PDF 并排放，用户看着脏、还会被 git/网盘同步上去；
//   · VS Code 自带"时间线"（Timeline），把快照挂在那里，用户在一个地方就能看/回滚；
//   · 快照存在扩展的 globalStorage 里（每用户一份），不污染工作区。
//
// 时间线本身由 history.js 注册（vscode.window.registerTimelineProvider）；
// 这里只管"怎么算 key / 怎么命名 / 怎么裁剪"。

/** 简单 FNV-1a 32 位哈希：把文件 URI 变成稳定的目录名（不需要密码学强度） */
export function keyOf(text) {
  let h = 0x811c9dc5;
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** 时间戳 → 文件名（冒号在 Windows 上非法，统一换成 -） */
export function stampName(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}.pdf`;
}

/** 从文件名里还原时间戳（失败返回 0） */
export function stampOf(name) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})\.pdf$/.exec(String(name || ""));
  if (!m) return 0;
  const [, y, mo, d, h, mi, s, ms] = m;
  return new Date(+y, +mo - 1, +d, +h, +mi, +s, +ms).getTime();
}

/** 新→旧排序 */
export function sortNewestFirst(names) {
  return [...names].sort((a, b) => stampOf(b) - stampOf(a));
}

/** 超出 keep 的旧快照（要删掉的） */
export function pickPrune(names, keep = 20) {
  const sorted = sortNewestFirst(names);
  // keep 必须 ≥ 1：传 0/负数时也至少留最新那份，否则"刚存的备份会被自己删掉"
  const k = Math.max(1, Math.round(Number.isFinite(Number(keep)) ? Number(keep) : 20));
  return sorted.slice(k);
}

/**
 * 快照仓库。fs 适配器形状（由 history.js 用 vscode API 实现，测试里用 node:fs 实现）：
 *   mkdir(dirPath): Promise<void>
 *   writeFile(path, Uint8Array): Promise<void>
 *   readFile(path): Promise<Uint8Array>
 *   readDir(dirPath): Promise<string[]>      // 只返回文件名
 *   deleteFile(path): Promise<void>
 * 路径用字符串拼（"<root>/<key>/<name>"），适配器自己决定怎么映射到 Uri / 真实路径。
 */
export function createHistoryStore(fs, root, { keep = 20 } = {}) {
  return {
    /** 存一份快照，返回快照文件名；失败抛错（调用方决定是否放弃写入） */
    async snapshot(uriString, bytes) {
      const key = keyOf(uriString);
      const dir = `${root}/${key}`;
      await fs.mkdir(dir);
      const name = stampName(Date.now());
      await fs.writeFile(`${dir}/${name}`, bytes);
      // 裁剪：只留最近 keep 份，避免无限长
      try {
        const names = sortNewestFirst((await fs.readDir(dir)).filter((n) => /\.pdf$/.test(n)));
        for (const old of pickPrune(names, keep)) await fs.deleteFile(`${dir}/${old}`);
      } catch { /* 裁剪失败不影响本次保存 */ }
      return name;
    },
    /** 列出某文件的所有快照（新→旧） */
    async list(uriString) {
      const dir = `${root}/${keyOf(uriString)}`;
      let names = [];
      try { names = (await fs.readDir(dir)).filter((n) => /\.pdf$/.test(n)); } catch { return []; }
      return sortNewestFirst(names).map((name) => ({ name, ts: stampOf(name) }));
    },
    /** 读某个快照的字节 */
    async read(uriString, name) {
      if (!/^[0-9-]+\.pdf$/.test(String(name || ""))) throw new Error("非法快照名");
      return fs.readFile(`${root}/${keyOf(uriString)}/${name}`);
    },
  };
}
