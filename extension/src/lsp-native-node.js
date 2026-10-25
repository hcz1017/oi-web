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

/** 扫官方 clangd 扩展的 globalStorage：它自动下载的二进制就存在这里 */
export function findInGlobalStorage(globalStorageRoot) {
  if (!globalStorageRoot) return null;
  const roots = [
    path.join(globalStorageRoot, "llvm-vs-code-extensions.vscode-clangd", "install"),
    path.join(globalStorageRoot, "KylinIdeTeam.kylin-clangd", "install"),
  ];
  const exeName = process.platform === "win32" ? "clangd.exe" : "clangd";
  for (const root of roots) {
    let versions = [];
    try { versions = fs.readdirSync(root); } catch { continue; }
    // 版本目录名排序，取最新的
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) {
      const dir = path.join(root, v);
      // 常见两种布局：<ver>/clangd_<ver>/bin/clangd 或者 <ver>/bin/clangd
      const cands = [
        path.join(dir, `clangd_${v}`, "bin", exeName),
        path.join(dir, "bin", exeName),
      ];
      try {
        for (const sub of fs.readdirSync(dir)) {
          cands.push(path.join(dir, sub, "bin", exeName));
        }
      } catch {}
      for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch {} }
    }
  }
  return null;
}

/**
 * 找 clangd：显式配置 → PATH → 官方扩展自动下载的位置。
 * @param {string} configured oiCpp.clangdPath
 * @param {string} [globalStorageRoot] 扩展 globalStorage 根目录（用于复用官方扩展的安装）
 */
export function findClangd(configured, globalStorageRoot) {
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
  // 复用官方 clangd 扩展已经下载好的二进制（零配置的关键）
  return findInGlobalStorage(globalStorageRoot);
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
  const exe = findClangd(o.clangdPath, o.globalStorageRoot);
  if (!exe) {
    log("桌面版：未找到 clangd（PATH 和官方 clangd 扩展的安装目录都没有）");
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

/** 引导用户拿到 clangd：一条命令，点一下就行（官方扩展会自己下载语言服务器） */
export async function offerClangdInstall(log = () => {}) {
  const OFFICIAL = "llvm-vs-code-extensions.vscode-clangd";
  const has = !!vscode.extensions.getExtension(OFFICIAL);
  const pick = await vscode.window.showInformationMessage(
    has
      ? "桌面版需要 clangd 语言服务器：已安装官方 clangd 扩展，运行它的「Download language server」即可（或设置 oiCpp.clangdPath 指向本地 clangd）。"
      : "桌面版需要 clangd 语言服务器（补全/诊断用）。装官方 clangd 扩展后它会自动下载，之后本扩展会直接复用，无需任何配置。",
    has ? "我知道了" : "安装官方 clangd 扩展",
  );
  if (pick && !has) {
    log("引导安装官方 clangd 扩展");
    await vscode.commands.executeCommand("workbench.extensions.installExtension", OFFICIAL);
  }
}

export const nativeSupported = true;
