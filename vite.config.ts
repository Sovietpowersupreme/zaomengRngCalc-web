/// <reference types="vitest" />
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

/**
 * 项目根（绝对路径），盘符统一大写。
 *
 * 起因是 vitest 5 在 Windows 上对绝对路径做**大小写敏感**比较：只要关键路径字符串
 * 带小写盘符，``import { describe } from "vitest"`` 就会被判成外部模块而加载第二份
 * vitest 实例，测试全炸 ``TypeError: Cannot read properties of undefined (reading 'config')``。
 * 真正管用的办法在 ``tools/vitest-run.mjs``（把传给 node 的 vitest 入口路径盘符掰大写）；
 * 这里顺手固定 root 只是让从任何 shell 启动都得到同一个规范路径。
 */
const ROOT = fileURLToPath(new URL(".", import.meta.url)).replace(/^[a-z]:/, (head) =>
  head.toUpperCase(),
);

/**
 * ``web/`` 的构建与测试配置。
 *
 * 三个容易踩的点：
 *
 * 1. ``base: "./"`` —— 产物要能直接丢进任意静态目录或子路径
 *    （GitHub Pages 的 ``/zaomengRngCalc-web/``）打开，所以资源路径一律相对。
 * 2. ``worker.format: "es"`` —— ``src/worker/search.worker.ts`` 是 ESM
 *    （里面要 ``import`` wasm 胶水），默认的 ``iife`` 打包不了它。
 * 3. ``rollupOptions.external`` 里的 ``node:`` —— emscripten 生成的
 *    ``src/wasm/cracker.mjs`` 开头有一个 node 专用分支
 *    ``if (ENVIRONMENT_IS_NODE) { const { createRequire } = await import("node:module") … }``。
 *    浏览器构建解析不了 ``node:module``，vite 会塞一份替身，而且因为这里是**动态**
 *    import，还会单独产出一个 ``__vite-browser-external-<hash>.js`` 块；该块名以
 *    ``_`` 开头（历史上走 Pages **分支发布**时会被 Jekyll 静默排除，留下一个 404 引用；
 *    现在的官方 Actions 发布不过 Jekyll，但这个块本质上仍是永远不执行的死代码）。
 *    这个分支在浏览器里永远不执行（``ENVIRONMENT_IS_NODE`` 恒为 false），所以正确的
 *    做法是把它标成 external：既不再生成替身块，也不必依赖任何 ``.nojekyll``。
 *    不能改用 ``-sENVIRONMENT=web,worker`` —— ``web/tests`` 在 node 里跑，需要这个分支。
 * 4. ``plugins: [vue()]`` —— 编译 ``.vue`` 单文件组件。它只管 SFC，不影响
 *    ``src/worker/search.worker.ts``（那是纯 TS）。
 * 5. ``host`` 显式写 ``"127.0.0.1"`` —— **不写就会踩 IPv6-only 的坑**：vite 默认 host
 *    是 ``"localhost"``，而 Node 的 ``dns.lookup`` 在 Windows 11 上把 ``localhost``
 *    解析成``::1`` 在前、``127.0.0.1`` 在后（``verbatim`` 顺序），``listen`` 只取
 *    第一个地址 ⇒ 服务**只绑 ``[::1]``**。于是 ``http://127.0.0.1:4173/`` 直接
 *    ``ECONNREFUSED``，而只认 IPv4 的浏览器/端口转发/工具全连不上。
 *    绑 ``127.0.0.1`` 后两个写成法都能用（``localhost`` 先试 ``::1`` 被拒，
 *    Happy Eyeballs 会立刻回落到 IPv4）。要局域网/手机访问就改成 ``true``。
 */
export default defineConfig({
  root: ROOT,
  base: "./",
  plugins: [vue()],
  server: {
    // 见上文说明 5。dev 与 preview 要一致，否则「dev 能开、preview 连不上」更难查。
    host: "127.0.0.1",
  },
  preview: {
    host: "127.0.0.1",
  },
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      // 见上文说明 3。
      external: [/^node:/],
    },
  },
  worker: {
    format: "es",
    rollupOptions: {
      // worker 里同样会 import wasm 胶水，同样要挡住替身块。
      external: [/^node:/],
    },
  },
  test: {
    // 测试全在 node 里跑：wasm 胶水自带 node 分支，不需要浏览器/JSDOM。
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // wasm 模块加载 + 全空间扫描比较慢，串行跑更稳
    fileParallelism: true,
    reporters: ["default"],
  },
});
