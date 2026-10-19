// 调试桩 C 源码（编译期预置 import，供插桩使用）。
//
// 为什么不事后新增 import：wasm 的函数索引空间是"先 import 后 define"，
// 中途插入一个 import 会让后面所有函数索引 +1，必须重写 call/ref.func/element/export/start，
// 那是最容易出错的一步。改成"调试构建先链接本桩"，插桩时就只需要
// 插入 `i32.const siteId; call <已存在的 import 索引>`，不动任何已有索引。
export const DBG_STUB_SOURCE = `// oi-cpp-wasm debug stub (auto-generated, do not edit)
// probe：返回本次暂停的 locals 快照地址（0 = 这次不需要暂停）
__attribute__((import_module("oi"), import_name("probe")))
extern int __oi_probe(int site);

// pause：locals 写完之后调用，真正阻塞等待宿主恢复
__attribute__((import_module("oi"), import_name("pause")))
extern void __oi_pause(void);

// 仅用于让链接器保留上面两个 import（运行期不会被调用）
__attribute__((used, visibility("default")))
void __oi_dbg_anchor(void) { __oi_probe(-1); __oi_pause(); }
`;
