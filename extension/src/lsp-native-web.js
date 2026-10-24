// SPDX-License-Identifier: AGPL-3.0-or-later
// 浏览器端不使用原生 clangd（web 端走 wasm clangd，见 lsp.js），这里是同接口的空实现，
// 让 esbuild 在 web 构建里不必解析 vscode-languageclient/node。
export const nativeSupported = false;
export function findClangd() { return null; }
export async function startNativeClangd() { return null; }
export async function stopNativeClangd() {}
