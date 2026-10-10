/// <reference types="vitest" />
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import type { Plugin } from "vite";
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

/** 构建档位。 */
interface BuildProfile {
  /** JS 语法目标：Oxc 会把这个版本之后的新语法降级掉。 */
  target: "es2022" | "es2017";
  /** 产物目录（相对 ``web/``）。 */
  outDir: string;
}

/** 默认档 = 现代浏览器。 */
const DEFAULT_PROFILE: BuildProfile = {
  target: "es2022",
  outDir: "dist",
};

/**
 * 档位表。键就是 ``vite build --mode <键>`` 里的那个名字。
 *
 * 用 ``--mode`` 而不是环境变量是**刻意的**：``VITE_LEGACY=1 vite build`` 这种写法在
 * Windows 的 npm script（走 cmd）里根本不过，而 ``cross-env`` 是本项目不允许加的新依赖；
 * ``mode`` 由 Vite/Vitest 自己解析，两端都成立。
 *
 * | 档位 | 语法目标 | 产物 | worker | 谁在用 |
 * | ---- | -------- | ---- | ------ | ------ |
 * | ``production``（默认，含 dev/preview/test） | ``es2022`` | ``dist/`` | ``iife`` | 现代浏览器 |
 * | ``legacy``（``--mode legacy``） | ``es2017`` | ``dist/legacy/`` | ``iife`` | Chromium 70 级老引擎 |
 *
 * **两档的 worker 都是 classic（``iife``）**，分档只体现在 JS 语法目标上。这不是「顺手统一」，
 * 而是唯一正解 —— 模块化 worker 要 Chrome/Edge 80+、Safari 15+、Firefox 114+，
 * 而在老引擎上**它的失败方式不是降级、是抛错**：
 *
 * ``src/worker/pool.ts`` 的工厂原来写的是 ``new Worker(url, { type: "module" })``，本注释还替它
 * 辩护过一句「Chrome 70 的 ``WorkerOptions`` 里没有 ``type``，WebIDL 字典会静默忽略未知成员」。
 * **那句是错的**：Chromium **70~79** 的 ``WorkerOptions`` 里**已经有** ``type``（模块化 worker
 * 是「已实现、特性被 flag 关着」），于是构造会走 ``ModuleWorkersEnabled()`` 的失败分支，
 * 直接抛 ``TypeError: Module scripts are not supported on DedicatedWorker yet …
 * (see https://crbug.com/680046)`` —— 2026-10-09 用户报的「兼容版离线文件能算、网页版报错」
 * 就是它（单文件档走 classic Blob，只有多文件档会踩这一行）。**事故内核已确认 =
 * Chromium ``70.0.3499.0``**（Chrome 70 稳定分支；模块化 worker 到 Chrome 80 才转正）。
 *
 * ``iife`` 这边代价≈0，且两件事同时成立：
 *
 * * worker 块本来就**自包含**（唯一一处 ``import("node:module")`` 是永不执行的动态 import），
 *   ``es`` 与 ``iife`` 没有任何跨块共享 ⇒ 体积/行为等价；
 * * rolldown 会把 ``import.meta.url`` 换成 ``self.location.href``，而 worker 里的 ``self.location``
 *   正是 worker 脚本自己的 URL ⇒ ``cracker-*.wasm`` 的相对定位逐字节等价
 *   （``src/wasm/variant.ts`` 的 :func:`absolute` 就靠它）。
 *
 * ⚠️ 这与 ``pool.ts`` 里「**产物**不许传 ``type: "module"``」是**同一个决定的两半**，必须一起动，
 * 由 ``tests/legacy_gate.test.ts`` 第 8 组钉住：产物里不许出现 ``{ type: "module" }``，
 * 且 worker 块里不许出现 ``import.meta`` / ESM 语法（classic 脚本里那是**解析期**报错）。
 *
 * ⚠️ **``worker.format`` 只管打包，管不到 dev**：dev 下 vite 不打包 worker（worker 文件就是一份
 * 未打包的原生 ESM），那个 ``?worker_file&type=…`` 里的 ``type`` 是 ``vite:worker-import-meta-url``
 * 从 ``pool.ts`` 的**源码字面量**里读的，这里改多少都不影响它 —— 所以 ``pool.ts`` 里有一支
 * ``import.meta.env.DEV`` 显式要 ``{ type: "module" }``（不然 ``npm run dev`` 一启动就是
 * ``SyntaxError: Cannot use import statement outside a module``，2026-10-10 的事故）。
 *
 * ⚠️ **legacy 必须排在现代档之后**：默认档 ``emptyOutDir`` 清的是整个 ``dist/``，
 * 会把 ``dist/legacy/`` 一起抹掉。顺序写在 ``package.json`` 的 ``build`` 脚本里，
 * 单独跑 ``npm run build:legacy`` 不会动 ``dist/`` 的其它内容（``emptyOutDir`` 只清自己的 outDir）。
 */
const PROFILES: Record<string, BuildProfile> = {
  production: DEFAULT_PROFILE,
  legacy: { target: "es2017", outDir: "dist/legacy" },
};

// ------------------------------------------------------- 旧版 index.html 的入口记号

/**
 * 旧版 `index.html` 上的记号：**入口垫片靠它认「那边真的有旧版产物」**。
 *
 * 为什么非得有个记号：垫片原来只 `HEAD ./legacy/` 看着状态码，被 `npm run dev` 一击即破 ——
 * vite 的 SPA 兜底对**任何**路径都回 `200` + 同一份现代 `index.html`（连 `/nope.txt` 都是，
 * 实测两条 URL 的响应逐字节相同）⇒ 探测必然「成功」，老引擎被 `location.replace` 送到一个
 * 连解析都过不了的页面上，还是白屏。**状态码不是存在性证明，能当证据的只有产物内容。**
 *
 * ⚠️ 这串字面量必须与 `index.html` 里垫片**拼**出来的那个完全一致
 * （`tests/legacy_entry_shim.test.ts` 会读这个文件逐字比对）。
 * ⚠️ 也正因为垫片是拼的，`index.html` 里任何地方都**不许**出现完整记号：那份文件自己就会
 * 被当返回值取回来（dev 兜底回的就是它），回声里带着记号 = 探测恒真。
 */
const LEGACY_INDEX_MARK = "data-legacy-build";

/** 模板（`index.html` 的 `<html>` 标签）里的占位，打包时被下面这个插件按档换掉。 */
const LEGACY_INDEX_SLOT = "%%legacy-index-marker%%";

/**
 * 按档位往 `index.html` 的 `<html>` 上盖记号：legacy 档盖，dev 与现代档**删掉**。
 *
 * 用 `transformIndexHtml` 而不是拆成两份模板：两个档本来就共用同一份 `index.html`
 * （legacy 只是 `build.target` 不同），多一份模板迟早会漂。
 * 好在 `transformIndexHtml` 在 `vite dev` 里**也会跑**，于是 dev 的页面天然没有记号 ——
 * 垫片问「这一页是旧版产物吗」得到的答案就是对的。
 *
 * 盖在 `<html>` 的**属性**上而不是 HTML 注释里：注释会被各种压缩/优化工具顺手删掉，
 * 属性不会，而记号丢了就是老引擎在真机上白屏。
 *
 * ⚠️ 占位在模板里必须与前一个属性**用空格隔开**：它本身是个裸属性名（`%` 在属性名里合法），
 * 贴着写的话 `lang="zh-CN"%%…%%` 就变成一个畸形的未加引号属性值，parse5 每次解析都会
 * 报 `missing-whitespace-between-attributes`（不致命，但 dev 每次刷新都刷一遍，看着像出事了）。
 */
function legacyIndexMark(isLegacy: boolean): Plugin {
  // 现代档/dev 的替换是空串，于是留下 `lang="zh-CN" >` 多一个空格：合法、无害，不必美化。
  const replacement = isLegacy ? `${LEGACY_INDEX_MARK}="1"` : "";
  return {
    name: "rngcalc:legacy-index-mark",
    transformIndexHtml(html) {
      return html.replace(LEGACY_INDEX_SLOT, () => replacement);
    },
  };
}

/**
 * ``web/`` 的构建与测试配置。
 *
 * 几个容易踩的点：
 *
 * 1. ``base: "./"`` —— 产物要能直接丢进任意静态目录或子路径
 *    （GitHub Pages 的 ``/zaomengRngCalc-web/``）打开，所以资源路径一律相对。
 *    legacy 档也靠它：``dist/legacy/`` 被部署到现代档的**子目录**，写死 ``/assets/`` 就会 404。
 * 2. ``worker.format: "iife"`` —— 两档都用 classic worker，理由见上面档位表那一整段
 *    （一句话：``type: "module"`` 在 Chromium 70~79 上是**抛错**，不是降级）。
 *    配套写法在 ``src/worker/pool.ts``：``new Worker(new URL("./search.worker.ts",
 *    import.meta.url), { name })`` —— **两处要改一起改**。
 *    ⚠️ 它**只管打包**：dev 下 vite 不打包 worker，``type`` 由 ``pool.ts`` 的
 *    ``import.meta.env.DEV`` 分支里的**字面量**决定（详见档位表尾注）。
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
 * 4. ``plugins: [vue(), legacyIndexMark(...)]`` —— 前者编译 ``.vue`` 单文件组件（它只管 SFC，
 *    不影响 ``src/worker/search.worker.ts``，那是纯 TS）；后者给**旧版** ``index.html``
 *    盖入口记号，理由见上面 ``LEGACY_INDEX_MARK`` 的说明。
 * 5. ``host`` 显式写 ``"127.0.0.1"`` —— **不写就会踩 IPv6-only 的坑**：vite 默认 host
 *    是 ``"localhost"``，而 Node 的 ``dns.lookup`` 在 Windows 11 上把 ``localhost``
 *    解析成``::1`` 在前、``127.0.0.1`` 在后（``verbatim`` 顺序），``listen`` 只取
 *    第一个地址 ⇒ 服务**只绑 ``[::1]``**。于是 ``http://127.0.0.1:4173/`` 直接
 *    ``ECONNREFUSED``，而只认 IPv4 的浏览器/端口转发/工具全连不上。
 *    绑 ``127.0.0.1`` 后两个写成法都能用（``localhost`` 先试 ``::1`` 被拒，
 *    Happy Eyeballs 会立刻回落到 IPv4）。要局域网/手机访问就改成 ``true``。
 * 6. **``cssTarget`` 不设** —— 它默认跟随 ``build.target``，于是两份产物的 CSS 走完全相同的
 *    处理。legacy 需要的那些兼容写法（``gap`` 兜底、``inset`` 拆长写、``min()`` 拆开、
 *    ``-webkit-backdrop-filter``）都是**手写在源码里**的（见 ``src/compat/``），
 *    交给 CSS 转换器反而有风险：把 ``gap`` 当成老引擎不支持的属性**删掉**之后，
 *    现代浏览器打开 ``/legacy/`` 会排版塌掉，而 ``html.no-flex-gap`` 兜底又不会被触发
 *    （探针在现代引擎上会说"支持"）。
 */
export default defineConfig(({ mode }) => {
  // vitest 传进来的是 ``mode: "test"``、``vite dev`` 是 ``"development"``，都落到默认档。
  const profile = PROFILES[mode] ?? DEFAULT_PROFILE;
  return {
    root: ROOT,
    base: "./",
    plugins: [vue(), legacyIndexMark(mode === "legacy")],
    server: {
      // 见上文说明 5。dev 与 preview 要一致，否则「dev 能开、preview 连不上」更难查。
      host: "127.0.0.1",
    },
    preview: {
      host: "127.0.0.1",
    },
    build: {
      target: profile.target,
      outDir: profile.outDir,
      emptyOutDir: true,
      sourcemap: true,
      rollupOptions: {
        // 见上文说明 3。
        external: [/^node:/],
      },
    },
    worker: {
      // ⚠️ 写死的 ``"iife"``（不跟档位走）：两档都要 classic，见档位表那一节。
      // 只管打包；dev 的 ``type`` 由 ``src/worker/pool.ts`` 的 ``import.meta.env.DEV`` 分支决定。
      format: "iife",
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
  };
});
