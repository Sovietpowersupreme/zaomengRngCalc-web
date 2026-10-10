/**
 * ``npm test`` 的启动器 —— 存在的唯一理由是把 Windows 盘符掰成大写。
 *
 * 背景：vitest 5 在 Windows 上对「项目根路径」做**大小写敏感**比较。只要有任何一个
 * 关键绝对路径字符串带小写盘符（形如 ``d:\<仓库>\...``），测试文件里的
 * ``import { describe } from "vitest"`` 就会被判成外部模块而重新加载第二份 vitest
 * 实例，``getWorkerState()`` 于是为空，所有测试炸成
 * ``TypeError: Cannot read properties of undefined (reading 'config')``。
 *
 * 实测结论：
 *   - 起决定作用的是 **vitest CLI 入口脚本路径的盘符大小写**（以及 cwd，一并掰正更保险）；
 *   - 在 ``vite.config.ts`` 里改 ``root`` 或 ``process.chdir`` 都无效（配置在另一个进程里加载）；
 *   - 直接 ``vitest run`` 且路径带小写盘符必炸，带大写盘符全绿（6/6 可复现）。
 *
 * 用法：``node tools/vitest-run.mjs run [-- <vitest 参数>]``
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 把 Windows 盘符统一成大写，避免 vitest 的大小写敏感路径比较踩雷。 */
const driveUpper = (p) => p.replace(/^[a-z]:/, (head) => head.toUpperCase());

/** ``web/`` 的绝对路径。 */
const ROOT = driveUpper(fileURLToPath(new URL("..", import.meta.url)));
const CLI = driveUpper(fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url)));

if (!existsSync(CLI)) {
  console.error("找不到 vitest，请先在 web/ 下执行 npm install");
  process.exit(1);
}

const child = spawn(process.execPath, [CLI, ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});
child.on("error", (err) => {
  console.error(String(err));
  process.exit(1);
});
