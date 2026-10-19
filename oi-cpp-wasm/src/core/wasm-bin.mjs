// 极简 wasm 二进制工具：只做调试插桩需要的部分。
//
// 关键事实（已用引擎实测确认）：
//   · Chrome/微软 DWARF 引擎的 `codeOffset` 是相对 **code 段内容起点**（即函数数量那个字节）的偏移
//   · 所以 moduleOffset = code.contentStart + engineOffset
//
// 插桩策略：
//   · 调试构建会先链接 src/core/dbg-stub.c，产物里已有 import "oi"."probe"
//   · 插桩只在 DWARF 行表给出的语句起点插入 `i32.const siteId; call probeIdx`
//     —— 这些位置本来就是指令边界，且不需要解码指令
//   · 因此**不新增 import、不改函数索引**，只改 code 段（函数体长度 + 段长度）以及因此产生的整体位移
//
// 产物：{ wasm, sites: [{ id, origOffset, newOffset }] }
//   origOffset/newOffset 都是模块内绝对字节偏移，便于运行时交叉查表。

// ---------------------------------------------------------------- LEB128
export function readU32(bytes, pos) {
  let value = 0, shift = 0, b;
  do {
    if (pos >= bytes.length) throw new Error("LEB 越界");
    b = bytes[pos++];
    value |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  return [value >>> 0, pos];
}
export function writeU32(value) {
  const out = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}
/** 有符号 LEB（i32.const 用） */
export function writeS32(value) {
  const out = [];
  let v = value | 0, more = true;
  while (more) {
    let b = v & 0x7f;
    v >>= 7;
    more = !((v === 0 && (b & 0x40) === 0) || (v === -1 && (b & 0x40) !== 0));
    if (more) b |= 0x80;
    out.push(b);
  }
  return out;
}

// ---------------------------------------------------------------- 解析
/**
 * @returns {{
 *   entries: Array<{id:number,start:number,contentStart:number,contentEnd:number}>,
 *   code: {contentStart:number, bodies:Array<{index:number,sizeStart:number,bodyStart:number,end:number}>},
 *   funcImports: Array<{module:string,name:string,index:number}>,
 *   probeImportIndex: number,   // import 段里 oi.probe 的函数索引（缺席为 -1）
 * }}
 */
export function parseWasm(bytes) {
  if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new Error("不是 wasm 模块");
  }
  let pos = 8;
  const entries = [];
  let code = null;
  const allImports = [];        // 所有 import（含非函数）
  let funcImportCount = 0;

  while (pos < bytes.length) {
    const id = bytes[pos];
    const start = pos;
    pos++;
    let size;
    [size, pos] = readU32(bytes, pos);
    const contentStart = pos;
    const contentEnd = pos + size;
    if (contentEnd > bytes.length) throw new Error("段长度越界");
    entries.push({ id, start, contentStart, contentEnd });

    if (id === 2) {                             // import 段
      let p = contentStart, count;
      [count, p] = readU32(bytes, p);
      for (let i = 0; i < count; i++) {
        let mlen; [mlen, p] = readU32(bytes, p);
        const module = new TextDecoder().decode(bytes.subarray(p, p + mlen)); p += mlen;
        let nlen; [nlen, p] = readU32(bytes, p);
        const name = new TextDecoder().decode(bytes.subarray(p, p + nlen)); p += nlen;
        const kind = bytes[p++];
        const isFunc = kind === 0;
        allImports.push({ module, name, kind, index: isFunc ? funcImportCount : -1 });
        if (isFunc) funcImportCount++;
        // 跳过 type/table/memory/global 的描述
        if (kind === 0) { let _t; [_t, p] = readU32(bytes, p); }
        else if (kind === 1) { p++; const fl = bytes[p - 1]; if (fl & 1) { let _m; [_m, p] = readU32(bytes, p); } let _l; [_l, p] = readU32(bytes, p); }
        else if (kind === 2) { const fl = bytes[p++]; if (fl & 1) { let _m; [_m, p] = readU32(bytes, p); } let _l; [_l, p] = readU32(bytes, p); }
        else if (kind === 3) { p += 2; }
        else throw new Error("未知 import kind " + kind);
      }
    } else if (id === 10) {                     // code 段
      let p = contentStart, count;
      [count, p] = readU32(bytes, p);
      const bodies = [];
      for (let i = 0; i < count; i++) {
        const sizeStart = p;
        let size;
        [size, p] = readU32(bytes, p);
        const bodyStart = p;
        bodies.push({ index: i, sizeStart, bodyStart, end: bodyStart + size, size });
        p = bodyStart + size;
      }
      code = { contentStart, count, bodies };
    }
    pos = contentEnd;
  }
  if (!code) throw new Error("没有 code 段");

  const probe = allImports.find((x) => x.kind === 0 && x.module === "oi" && x.name === "probe");
  return { entries, code, funcImports: allImports.filter((x) => x.kind === 0), probeImportIndex: probe ? probe.index : -1 };
}

/** 函数体第一个指令的模块内偏移（跳过 locals 声明） */
export function firstInstrOffset(bytes, body) {
  let p = body.bodyStart;
  let count;
  [count, p] = readU32(bytes, p);
  for (let i = 0; i < count; i++) {
    let n;
    [n, p] = readU32(bytes, p);   // 连续同类型局部变量个数
    p++;                          // 类型字节
  }
  return p;
}

// ---------------------------------------------------------------- 插桩
/**
 * 在给定模块偏移处插入探针调用。
 * @param {Uint8Array} bytes 原始（未插桩）wasm
 * @param {Array<{id:number, offset:number}>} sites  offset 为**模块内绝对偏移**，且必须是语句起点
 * @returns {{wasm: Uint8Array, sites: Array<{id:number, origOffset:number, newOffset:number}>}}
 */
export function instrumentWasm(bytes, sites) {
  const info = parseWasm(bytes);
  if (info.probeImportIndex < 0) {
    throw new Error('产物里没有 import "oi"."probe"（调试构建需要先链接 src/core/dbg-stub.c）');
  }
  const probeIdx = info.probeImportIndex;
  const { code } = info;

  // 1) 把 site 归到函数体，算 body 内相对位置；非法位置直接丢弃（宁可少插，不要插坏）
  const perBody = new Map();     // body.index -> [{rel, id}]
  const dropped = [];
  const sortedSites = [...sites].sort((a, b) => a.offset - b.offset);
  for (const s of sortedSites) {
    const body = code.bodies.find((b) => s.offset >= b.bodyStart && s.offset < b.end);
    if (!body) { dropped.push({ ...s, why: "不在任何函数体内" }); continue; }
    const firstInstr = firstInstrOffset(bytes, body);
    if (s.offset < firstInstr) { dropped.push({ ...s, why: "落在 locals 声明区" }); continue; }
    if (!perBody.has(body.index)) perBody.set(body.index, []);
    perBody.get(body.index).push({ rel: s.offset - body.bodyStart, id: s.id });
  }
  for (const list of perBody.values()) list.sort((a, b) => a.rel - b.rel);

  // 2) 重建 code 段
  const probeSeq = (id) => [0x41, ...writeS32(id | 0), 0x10, ...writeU32(probeIdx)];
  const newBodies = [];
  const outSites = [];
  let newBodyStartCursor = 0; // 相对新 code 段内容起点（函数数量字节之后）——先占位，实际偏移下面算

  // 先算每个函数体的新字节，再拼（需要两遍才能给出 newOffset）
  const bodyBlobs = code.bodies.map((body) => {
    const list = perBody.get(body.index) || [];
    const parts = [];
    let cursor = body.bodyStart;
    for (const ins of list) {
      const at = body.bodyStart + ins.rel;
      parts.push(bytes.subarray(cursor, at));
      parts.push(Uint8Array.from(probeSeq(ins.id)));
      cursor = at;
    }
    parts.push(bytes.subarray(cursor, body.end));
    let total = 0;
    for (const p of parts) total += p.length;
    return { body, parts, payloadLen: total, list, inserted: (list.length * 4) };
  });

  // 计算新 code 段内容：count + 每个 body 的 size + payload
  const pieces = [];
  pieces.push(Uint8Array.from(writeU32(code.count)));
  for (const blob of bodyBlobs) {
    pieces.push(Uint8Array.from(writeU32(blob.payloadLen)));
    for (const p of blob.parts) pieces.push(p);
  }
  const newCodeContent = concat(pieces);

  // 3) 拼整个模块：magic + 逐段（code 段替换内容，其余原样拷贝 id+size+content）
  const out = [];
  out.push(bytes.subarray(0, 8));
  for (const e of info.entries) {
    if (e.id === 10) {
      out.push(Uint8Array.from([10]));
      out.push(Uint8Array.from(writeU32(newCodeContent.length)));
      out.push(newCodeContent);
    } else {
      out.push(bytes.subarray(e.start, e.contentEnd));
    }
  }
  const wasm = concat(out);

  // 4) 计算 newOffset：重新解析新模块，把每个 site 的 body 内相对位置映射到新偏移
  const after = parseWasm(wasm);
  const byRel = new Map();  // bodyIndex -> Map(relOfOrigBodyStart? ) —— 用"插入序号"法更稳
  // 插入序号法：对每个 body，按 orig rel 排序，新 rel = orig rel + 前面插入的探针长度之和
  const newOffsets = new Map(); // `${bodyIndex}:${origRel}` -> newOffset
  for (const blob of bodyBlobs) {
    const bodyNew = after.code.bodies[blob.body.index];
    let added = 0;
    for (const ins of blob.list) {
      added += probeSeq(ins.id).length;
      newOffsets.set(`${blob.body.index}:${ins.rel}`, bodyNew.bodyStart + ins.rel + added);
    }
  }
  for (const s of sortedSites) {
    const body = code.bodies.find((b) => s.offset >= b.bodyStart && s.offset < b.end);
    if (!body) continue;
    const rel = s.offset - body.bodyStart;
    const n = newOffsets.get(`${body.index}:${rel}`);
    if (n != null) outSites.push({ id: s.id, origOffset: s.offset, newOffset: n });
  }

  return { wasm, sites: outSites, dropped, probeImportIndex: probeIdx, codeContentStartOrig: code.contentStart };
}

function concat(list) {
  let total = 0;
  for (const x of list) total += x.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const x of list) { out.set(x, at); at += x.length; }
  return out;
}
