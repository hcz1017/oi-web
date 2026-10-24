// SPDX-License-Identifier: AGPL-3.0-or-later
// 平台适配：**浏览器（VS Code for the Web / vscode.dev / 自托管）**。
//
// worker 用 URL 创建；跨源（Marketplace CDN）或 vscode-file: 等自定义 scheme 时，
// 由 wdb 的 createWorker 走 fetch + blob 兜底。
import * as vscode from "vscode";
import { createWorker } from "../../wdb/src/runtime/create-worker.js";

export const isWeb = true;
export const label = "web";

let extUri = null;
export function setExtensionRoot(uri) { extUri = uri; }

export function workerRef(name) {
  // ⚠️ 不要 toString(true)：skipEncoding 会让含空格/中文的扩展路径拼出非法 URL
  return vscode.Uri.joinPath(extUri, "dist", "web", name).toString();
}

export function assetsBase() {
  return vscode.Uri.joinPath(extUri, "assets").toString().replace(/\/+$/, "");
}

export function createNamedWorker(name, opts = {}) {
  return createWorker(workerRef(name), { log: opts.log });
}

export const hasFsAccess = true;    // File System Access API 可用
export const _extUri = () => extUri;
