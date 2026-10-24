// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 平台适配 —— **浏览器 / 桌面 Node 宿主** 的差异全部收在这一个模块里。
//
// 两个实现（esbuild 用 alias 选一个）：
//   src/platform-web.js   浏览器：worker 用 URL + blob 兜底，资源用 URL + fetch
//   src/platform-node.js  桌面 Node 宿主：worker 用 worker_threads + 垫片，资源用文件路径
//
// 约定（两边必须一致）：
//   isWeb            boolean
//   workerRef(name)  传给 worker 创建的"引用"：web=URL，node=打包好的 js 路径
//   createNamedWorker(name, {log, shim})   → Promise<WorkerLike>
//        WorkerLike: { postMessage(m, transfer?), addEventListener(type, cb), terminate() }
//   assetsBase()     资产根：web=URL，node=文件路径（worker 里用统一的 fetch 读）
//   label            日志用的平台名
export const PLATFORM_SHAPE = "oi-platform/v1";
