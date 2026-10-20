// 调试桩：把宿主探针以 **import** 的形式预置进产物。
//
// 为什么要预置：插桩时如果要"临时新增一个 import"，函数索引空间整体后移，
// 必须重写所有 call/ref.func/element/export/start 里的函数索引 —— 那是最容易出错的部分。
// 反过来：调试构建时先链接本桩，import "oi"."probe" 已经在 import 段里，
// 插桩只需要在目标位置插入 `i32.const site; call <该 import 的索引>`，**不动任何已有索引**。
//
// 运行期：本文件里的 __oi_dbg_anchor 永远不会被调用（仅用于让链接器保留这个 import）。
__attribute__((import_module("oi"), import_name("probe")))
extern void __oi_probe(int site);

__attribute__((used, visibility("default")))
void __oi_dbg_anchor(void) { __oi_probe(-1); }
