// 下载 vscode-web 静态构建到 .vscode-test-web（CI 与首次运行用）
// 直接复用 @vscode/test-web 的下载器，保证与本地开发用同一份构建。
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { downloadAndUnzipVSCode } = require("@vscode/test-web/out/server/download.js");

const quality = process.env.QUALITY || "stable";
const commit = process.env.COMMIT || undefined;
const dir = await downloadAndUnzipVSCode(path.join(ROOT, ".vscode-test-web"), quality, commit);
console.log("✓ vscode-web:", dir);
