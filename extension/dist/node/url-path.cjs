"use strict";
// Windows 路径 vs URL 的判定（Node worker 垫片用）
//
// ⚠️ 为什么单独成文件：Windows 盘符路径 `d:\vscode\...\assets` 会被 `/^[a-z]+:/i` 当成
//    URL 协议（"d:"），于是垫片把本地文件交给真正的 fetch → undici 抛
//    `TypeError: fetch failed`（桌面 Windows 上 clangd 永远起不来）。
//    macOS/Linux 路径以 "/" 开头，不会命中这个正则，所以本机测试一直测不出来。
//    单独放成模块是为了能写单元测试（worker-shim.cjs 本身需要 worker_threads 环境才能加载）。

/** 形如 `d:\...` / `d:/...` 的 Windows 盘符路径 */
function isWindowsDrive(s) {
  return /^[a-zA-Z]:[\\/]/.test(String(s || ""));
}

/**
 * 形如 `http:` / `file:` / `vscode-file:` 的真实 URL 协议。
 * ⚠️ 协议名至少要有 2 个字符：RFC 语法上 `d:` 也算协议，但那会和 Windows 盘符
 *    （`d:\...` / `d:/...`）撞车 —— 我们这边不存在单字母协议，直接排除掉最省事。
 */
function isScheme(s) {
  return /^[a-zA-Z][a-zA-Z0-9+.\-]+:/.test(String(s || ""));
}

/**
 * 这个字符串是不是"本地文件"
 * @param {string} s 传入 fetch / importScripts 的值
 * @param {(p: string) => boolean} isAbsolute 平台的 path.isAbsolute
 */
function isFileLike(s, isAbsolute) {
  const str = String(s || "");
  if (/^file:/i.test(str)) return true;        // file:///d:/...
  if (isWindowsDrive(str)) return true;        // d:\...
  if (isScheme(str)) return false;             // http: / data: / blob: / vscode-file:
  return typeof isAbsolute === "function" ? isAbsolute(str) : false;
}

module.exports = { isWindowsDrive, isScheme, isFileLike };
