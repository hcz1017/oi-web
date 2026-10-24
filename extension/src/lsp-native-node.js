// SPDX-License-Identifier: AGPL-3.0-or-later
// 桌面版（Node 扩展宿主）的原生 clangd 支持。
//
// 为什么桌面版不走 wasm clangd：我们手上的 clangd.js 是 **emscripten 浏览器构建**
// （pthread 用 `new Worker(url,{type:'module'})`），Node 里没有对应的 node 构建。
// 而桌面用户机器上本来就有编译器工具链，直接用**原生 clangd** 效果更好、内存更省。
//
// 做法：起 `clangd` 子进程（stdio LSP），用 vscode-languageclient 的 Node 版连接。
// 编译参数通过临时目录里的 `.clangd` + `compile_commands.json` 交给它。
import * as vscode from "vscode";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { LanguageClient, TransportKind } from "vscode-languageclient/node";

let client = null;
let tmpDir = null;

/** 在 PATH 里找一个可用的 clangd，找不到返回 null */
export function findClangd(configured) {
  const cand = String(configured || "").trim();
  if (cand) return fs.existsSync(cand) || !cand.includes("/") ? cand : null;
  const names = process.platform === "win32" ? ["clangd.exe", "clangd"] : ["clangd"];
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const p = path.join(dir, n);
      try { if (fs.existsSync(p)) return p; } catch {}
    }
  }
  return null;
}

function writeProjectConfig(dir, workspaceDir, flags) {
  fs.mkdirSync(dir, { recursive: true });
  // .clangd：只补参数，不改索引/诊断策略（与 web 端保持一致的精神：能省则省）
  fs.writeFileSync(path.join(dir, ".clangd"),
    [
      "CompileFlags:",
      "  Add: [" + String(flags || "").split(/\s+/).filter(Boolean).map((f) => JSON.stringify(f)).join(", ") + "]",
      "Index:",
      "  Background: Skip",
      "",
    ].join("\n"));
}

/**
 * 启动原生 clangd。
 * @param {{clangdPath?:string, flags?:string, workspaceDir?:string, log?:(s:string)=>void}} o
 */
export async function startNativeClangd(o = {}) {
  if (client) return client;
  const log = o.log || (() => {});
  const exe = findClangd(o.clangdPath);
  if (!exe) {
    log("桌面版：未找到 clangd（可在设置 oiCpp.clangdPath 指定路径，或 apt/brew 安装 clangd）");
    return null;
  }
  tmpDir = path.join(os.tmpdir(), "webcpp-clangd-config");
  writeProjectConfig(tmpDir, o.workspaceDir, o.flags);
  log(`桌面版：启动原生 clangd → ${exe}`);

  const serverOptions = {
    command: exe,
    args: ["--compile-commands-dir=" + tmpDir, "--background-index=false", "--clang-tidy=false", "--log=error"],
    transport: TransportKind.stdio,
    options: { cwd: o.workspaceDir || process.cwd() },
  };
  const clientOptions = {
    documentSelector: [{ language: "cpp" }, { language: "c" }],
    synchronize: { fileEvents: vscode.workspace.createFileSystemWatcher("**/*.{cpp,cc,cxx,c,h,hpp}") },
    outputChannel: o.outputChannel,
  };
  client = new LanguageClient("oi-cpp-clangd-native", "clangd (native)", serverOptions, clientOptions);
  await client.start();
  log("桌面版：原生 clangd 已连接");
  return client;
}

export async function stopNativeClangd() {
  if (!client) return;
  try { await client.stop(); } catch {}
  client = null;
  try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  tmpDir = null;
}

export const nativeSupported = true;
