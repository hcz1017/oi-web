/** 把任意文件名变成 clangd 虚拟 FS 里安全的名字（避免空格/中文/特殊字符造成 URI 与路径不一致） */
export function sanitizeName(name) {
  return String(name || "main.cpp").replace(/[^A-Za-z0-9._-]/g, "_") || "main.cpp";
}
