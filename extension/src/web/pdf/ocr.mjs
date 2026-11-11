// OCR 接口（**预留**，当前版本不实现）。
//
// 为什么要留这层：OCR 计划在后续版本接入（tesseract.js 或 PaddleOCR/ONNX），
// 一旦接上，只需要实现这里的 ocrPage/ocrPages 并让 available=true，
// 上层（client.mjs 的工具栏按钮、搜索索引、sidecar 的 ocr 字段）都不用改。
//
// 约定：
//   · 输入是**页面渲染好的位图**（canvas 或 ImageBitmap），不是 pdf.js 的页面对象 ——
//     这样引擎与渲染器解耦，将来换渲染器也不影响 OCR。
//   · 输出统一成 `{ page, lang, text, words: [{ text, x, y, w, h }] }`，坐标是 **pt**，
//     与批注同一套坐标（见 helpers.mjs），可直接叠加到文本层/搜索索引。
//   · OCR 结果**不写回 PDF**，只存 sidecar 的 `ocr[页码]`（annot.mjs 已预留并透传）。

export const OCR_NOT_READY = "OCR 尚未启用：接口已预留，后续版本接入（本地 WASM，不上传文件）";

/**
 * 创建一个 OCR 引擎。
 * @param {object} [o]
 * @param {(msg:string)=>void} [o.log]
 * @param {(p:{page:number,done:number,total:number})=>void} [o.onProgress]
 * @returns {{
 *   available: boolean,
 *   engineName: string,
 *   languages: string[],
 *   ocrPage(bitmap:any, pageNo:number, opts?:object): Promise<{page:number,lang:string,text:string,words:Array}>,
 *   ocrPages(items:Array<{bitmap:any,page:number}>, opts?:object): Promise<Array>,
 *   dispose(): void,
 * }}
 */
export function createOcrEngine({ log = () => { }, onProgress = () => { } } = {}) {
  const notReady = () => { throw new Error(OCR_NOT_READY); };
  return {
    available: false,                 // ← 接入后改 true
    engineName: "none",
    languages: [],
    async ocrPage(_bitmap, _pageNo, _opts) { notReady(); },
    async ocrPages(_items, _opts) { notReady(); },
    dispose() { },
  };
}

/**
 * 把 OCR 结果并入"页面文本"（供搜索用）。
 * 现在没有 OCR 结果时就是恒等函数；接入后搜索自动能搜到扫描页。
 * @param {string} text  pdf.js 抽出来的文本层
 * @param {{text?:string}|undefined} ocr  该页的 OCR 结果
 */
export function mergeOcrText(text, ocr) {
  const a = String(text || "");
  const b = String((ocr && ocr.text) || "");
  if (!b) return a;
  return a ? a + "\n" + b : b;
}
