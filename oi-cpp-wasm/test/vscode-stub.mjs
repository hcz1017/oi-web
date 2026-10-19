// 测试用的最小 vscode API 桩（只覆盖 debugAdapter.js 用到的部分）
export class EventEmitter {
  constructor() { this._listeners = []; this.event = (cb) => { this._listeners.push(cb); return { dispose: () => {} }; }; }
  fire(v) { for (const cb of this._listeners) cb(v); }
  dispose() { this._listeners = []; }
}
export const window = { createOutputChannel: () => ({ appendLine() {}, show() {} }) };
export const debug = {};
export const Uri = { joinPath: (...a) => ({ toString: () => a.join("/") }) };
export default { EventEmitter, window, debug, Uri };
