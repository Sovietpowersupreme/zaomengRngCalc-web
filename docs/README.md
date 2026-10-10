# 造梦西游3 随机数计算器 —— Web 版开发说明

> **返回**：站点首页 [`../README.md`](../README.md) · **设计决策**：主仓 `notes/web-design.md`
> （设计文档**只在主仓**，不随本站发布，所以这里没有链接 —— 公开仓库里没有这个文件）
>
> 📌 **本文所有路径都相对 `web/` 目录书写**（文中出现的 `src/…`、`tests/`、`tools/`、
> `../src_forge/` 全是这个基准）。本文自己住在 `docs/` 子目录里，**不影响**基准 ——
> 所以上面那个 `../README.md` 指的是仓库根那份玩家向首页，不是本文的邻居。
> 下文出现的 `notes/web-design.md` 在主仓库里 —— 本站仓库（公开仓库）没有这个文件。

> **线上站点**：<https://sovietpowersupreme.github.io/zaomengRngCalc-web/>
>
> 发布方式 = `web/` 目录被 `git subtree push` 推到公开仓库 `Sovietpowersupreme/zaomengRngCalc-web`
> （公开仓库的根就等于这个 `web/`），再由那边的 `.github/workflows/pages.yml` 构建并部署
> （官方 Pages Actions，**不需要 PAT / secret**）。
> ⚠️ 公开仓库上**不要直接提交**（包括网页 UI 建文件）—— 会打断 `git subtree push`
> 的不变式，之后每次发布都会被 non-fast-forward 拒。详见 `notes/web-design.md` §4.2 / §9.2-11。

Vite + TypeScript + vitest，跑的是与 Python 侧**同一份** wasm 产物
（`src/wasm/cracker.{mjs,wasm}`）与**同一份** golden JSON
（`../src_forge/tests/golden/`，不复制、不派生）。

> wasm 产物由 `../csrc/build_wasm.py` 生成，哈希记在 `src/wasm/build_info.json`。
> **判断产物是否落后一律用 `..\.venv\Scripts\python.exe ..\csrc\build_wasm.py --check`**
> （重建后逐字节比对）；**别看源码 mtime** —— 注释/行尾级的改动会让 mtime 变新、
> 而 emcc 输出一字不变。
>
> `--check` 需要 emsdk；只装了 Python 的机器用 `--source-check`（毫秒级，比源码/产物的
> 摘要与 `build_info.json`）。**两者都只能在主仓库本地跑** —— 公开仓库里没有 `csrc/`，
> 所以发布 workflow 里**没有**这一步（`notes/web-design.md` §4.4 第 4 条）。
> ⚠️ 两者前提是**文本产物已按 LF 归一化**：emcc 在 Windows 上写出的 `cracker.mjs` 末尾
> 两行是 CRLF，而本仓库的 `.gitattributes` 是 `* text=auto eol=lf` ⇒ 不归一化的话
> 「重建产物」与「已提交产物」永远差 2 字节，哨兵在健康工作区上恒红（`build()` 现在会
> 自动改写为 LF，见 `build_wasm.py` 的 docstring 第 4 条）。

## 命令

```powershell
npm install         # 首次
npm run typecheck   # vue-tsc --noEmit（.vue 也查）
npm test            # vitest run（见下面的⚠️）
npm run dev         # 开发服务器（http://127.0.0.1:4173/ 之外的端口，见终端输出）
npm run build       # 产出 dist/
npm run build:local # 产出 dist-local/rngcalc.html（单文件，双击直开，见下）
npm run render:mechanics # 将 web/readme.md 转换为 web/public/mechanics.html
npm run preview     # 预览 dist/（http://127.0.0.1:4173/）
npm run check       # typecheck + test + build 三连（本地全量：30 套件 / 1072 用例）
npm run test:ci     # CI 用：跳过 3 个整份依赖上游 golden 快照的套件（见下）
npm run check:ci    # CI 用：typecheck + test:ci + build
```

> **`test:ci` 与 `check:ci` 是给 CI 的，不是本地跑着玩的。** `test:ci` 在 `vitest run` 上加了
> 三个 `--exclude`（`wasm_engine` / `searcher` / `scenario_runs`）—— 这三个套件读的是
> `../src_forge/tests/golden/` 的快照（`tests/helpers/golden.ts` 用相对路径指向仓库外），
> **只存在于主仓库本地**，公开仓库里没有，在 CI 里必然红。所以：
>
> **CI 全绿 ≠ 全绿。** CI 跑 27 套件 / 969 用例；全量是 30 / 1072，只能在主仓库本地跑。
>
> 还有**第 4 个**读 golden 的套件 `wasm_variant`（两份 wasm 的逐值对拍）。它在 CI 里**照跑**，
> 但只跑不依赖 golden 的**字节层 + ABI 层**；另三层（原语 / spec / 场景）由
> `tests/helpers/golden.ts` 导出的 `GOLDEN_AVAILABLE` 守卫、整组跳过。也就是说 CI 上
> 「两份 wasm 的**结构**与 ABI 等价」有守，「**逐值**等价」没有 —— 后者只能在主仓库本地验。
> （以后再加读 golden 的套件，要么加进 `test:ci` 的 `--exclude`，要么按 `GOLDEN_AVAILABLE` 守卫。）
>
> ⚠️ **旧内核档（`dist/legacy/`）只能在 `npm run build` + `npm run preview` 下验收。**
> `npm run dev` **从不产出也不托管 `/legacy/`**：它是转译 + HMR 服务器，对**任何**未知路径
> 都回 `200` + 同一份现代 `index.html`（连 `/nope.txt` 都是，实测响应逐字节相同）。
> 于是在 dev 里老引擎会看到垫片写的提示条（这是**对**的行为），而不是被跳去一个白屏页面。

## ⚠️ 测试必须走 `npm test`，别直接 `npx vitest`

`npm test` 实际执行 `node tools/vitest-run.mjs run`。这个包装脚本存在的唯一理由是
**把 Windows 盘符掰成大写**：vitest 5 对绝对路径做大小写敏感比较，只要传给 node 的
vitest 入口路径带小写盘符（VS Code 工作区里常见，如 `d:\<仓库>\...`），测试文件里的
`import { describe } from "vitest"` 就会被判成外部模块、重新加载第二份 vitest 实例，
于是**所有**测试都炸成：

```
TypeError: Cannot read properties of undefined (reading 'config')
```

已经排除过的无效解法（别再试）：在 `vite.config.ts` 里改 `root`、`process.chdir()`、
`--pool=forks`、降级/升级 vite、清 `.vite` 缓存、删 `index.html`/`tsconfig.json`。
只有「入口路径盘符大写」这一条是真的管用（大写绿灯 / 小写红灯，6/6 可复现）。

## 目录

| 目录 | 内容 |
|---|---|
| `src/wasm/` | wasm 产物 + 加载器 + 布局/内存层（**产物是生成物，见该目录 README**） |
| `src/core/` | 与 Python `src_forge/core/` 对应的纯 TS 层（错误、数值、RangeCodec、契约）；`fromValue.ts` = Python `const/stars.py` 的 `random_int_from_value` / `save_game_value` + `parse_value` 那套字符串取值语义 |
| `src/worker/` | Web Worker 池：按 `hardwareConcurrency` 分片跑 `*_slice` |
| `src/scenarios/` | 与 Python `Scenario` 一一对应的场景层（由导出的 `input_schema()` JSON 驱动）。**10 / 10 已移植**；装备族四个场景（`making`/`fusion`/`drops`/`task`）共享 `equipment.ts` 内核。清单与进度表见 `src/scenarios/index.ts` |
| `src/data/` | 常量 JSON（构建时从 Python `const/` 导出，**提交进仓库**） |
| `src/ui/` | 界面层：`url.ts`（hash 路由 / 分享链接）/ `form.ts`（schema → 控件）/ `result.ts`（Outcome → 显示）/ `session.ts`（控制器，**所有规则**）/ `App.vue`（外壳，只摆 DOM）—— 见下面「界面层」一节 |
| `src/compat/` | 旧内核兜底：`css.ts` 用真实布局探针判 flex `gap`，结果挂成 `html.no-flex-gap`（见下面「旧内核档」）。同族的 `src/polyfills.ts`（`globalThis`）必须是三处入口的**第一条 import** |
| `extension/` | 浏览器扩展（种子恢复）：`url-seed/` = MV3，`url-seed-mv2/` = **MV2**（同一份 TS 源码 + 两份 manifest，各自的 README 讲清了差别） |
| `tests/` | vitest：`fixtures/` 是本地产的采样夹具，golden 走 `src_forge/tests/golden/`（**只在主仓库本地**，见上面 `test:ci` 一节） |
| `tools/` | `vitest-run.mjs`（见上）、`build_singlefile.mjs`（单文件打包）、`render_mechanics.py`（Markdown → HTML 机制介绍页）、`make_fixtures.py`（→ `tests/fixtures/ranges.json`）、`make_spec_fixtures.py`（→ `specs.json`）、`make_scenario_fixtures.py`（→ `scenarios.json`，场景目录 `describe()`） |

## 构建产物的两个硬约束

1. **`base` 是相对路径**（`"./"`）—— 产物能丢进任意**子路径**（例如 GitHub Pages 的
   `/zaomengRngCalc-web/`），也抗改名迁移。但**不能 `file://` 双击直开**：`origin: null`
   下外部 module script 会被 CORS 拦、`fetch(cracker.wasm)` 与 `new Worker(...)` 也都不行。
   本地验收请起静态服务器（`npm run preview`）。
   > 想要**双击即用**的形态，用下面「单文件本地版」（`npm run build:local`）—— 那是
   > 目前**唯一**能 `file://` 直开的产物；`dist/` 永远不行。
2. **emscripten 胶水的 node 分支被外置**：`src/wasm/cracker.mjs` 开头有
   `if (ENVIRONMENT_IS_NODE) { const { createRequire } = await import("node:module") … }`。
   浏览器里这行永不执行，但 vite 会为它生成一个 `__vite-browser-external-*.js` 替身块，
   名字以 `_` 开头。所以 `vite.config.ts` 把 `[/^node:/]` 标成 external —— 既省掉一个
   **永远不会执行**的死块，也避开「`_` 开头文件被托管方丢弃」这类坑（历史上走分支发布时
   Jekyll 会静默丢掉它 → 运行期 404；现在的官方 Actions 发布不过 Jekyll，但还是不生成更干净）。
   `build.rollupOptions` 与 `worker.rollupOptions` **两处都要**（worker 里也 import 胶水）。
   不能改用 `-sENVIRONMENT=web,worker`：`tests/` 在 node 里跑，靠这个分支加载胶水。

## 单文件本地版（`npm run build:local`）

给「不想起服务器、只想双击打开」的场景：产出一个**完全自包含**的
`dist-local/rngcalc.html`，里面内联了 app（IIFE）、样式、**wasm（Base64）**、
**worker（Blob）** 与 favicon。打开时**零网络请求**，离线可用。

```powershell
npm run build:local              # 产出 web/dist-local/rngcalc.html
npm run build:local -- --no-minify   # 不压缩，便于排查（体积大概是 2 倍）
```

双击 `dist-local/rngcalc.html` 即可（`file://`）。构建脚本 `tools/build_singlefile.mjs`
做完还会自检：骨架里不得有非 `data:` 的 `src`/`href`、三段内联脚本必须能被 `node:vm`
解析；任一条不过就**不写文件**。

### 它是怎么绕开 `file://` 三条限制的

运行时的接线全在 `src/singlefile.ts`（读 HTML 前置注入的 `self.__RNG_SINGLEFILE__`）：

| 限制 | 正常构建 | 单文件版 |
|---|---|---|
| `origin: null` 下外部 module script 被 CORS 拦 | `assets/index-*.js`（ESM） | 内联 **classic** `<script>`（IIFE） |
| `fetch(cracker.wasm)` 被 `file:` 禁 | `locateFile` → fetch | Base64 解码 → 喂 emscripten 的 `wasmBinary`（**完全不 fetch**） |
| `new Worker("./search.worker-*.js")` 跨源被拦 | **classic** worker（`worker.format: "iife"`，`new Worker(url, { name })`；这正是**产物**那一侧的规则） | `Blob` + `createObjectURL`（同样是 classic） |

> **正常构建完全不走这些分支**：`self.__RNG_SINGLEFILE__` 不存在时 `singlefile.ts`
> 一律返回 `null` / `false`，`vite build` 的产物与行为一字未改（`npm run check` 仍然全绿）。

### Worker 探活与自动降级

`file://` 下「能不能起 Blob worker」是**浏览器策略**问题（没有可靠的特性检测），所以
`main.ts` 启动时会真起一个 worker 发 `ping`（worker 侧的 `ping` 分支**不会**加载 wasm，
毫秒级返回）。**探测失败就自动退回主线程串行搜索** —— 结果完全一致，只是慢。
此时日志里会有一行「内联 Worker 不可用：退回主线程串行搜索」。

> 单文件版里 **wasm 是必须的**（没有它算不了），但 worker 是**可选的**：`createInlineWorker`
> 任何一步失败都吞掉异常返回 `null`，池工厂于是走原来的 `new Worker(new URL(...))`，
> 再由 `main.ts` 统一提示。所以「Blob worker 被禁」不会白屏，只会变慢。
>
> ⚠️ 那个 `new Worker(new URL(...))` 在**产物**里**只能带 `name`**：多写一个 `type: "module"` 会在
> Chromium 70~79 上直接抛 `TypeError`（理由见下一节）。两档产物的 worker 都是 **classic**。
> —— **`npm run dev` 恰好相反**，规则一共两条，见下一节的「dev 与产物，两条规则」。

### 改了源码要重新生成

`dist-local/rngcalc.html` 是**生成物**（已 gitignore），不随源码自动更新。
改了 `src/` 可单独跑 `npm run build:local`；常规构建 `npm run build` 也会自动执行它并把产物同步进 `public/rngcalc.html`（随站点一同发布，供用户在网页右上角直接下载离线版）。

## 旧内核档（Chromium 70）与它的三个额外产物

现代档的语法目标是 `es2022`，Chromium 70 级的引擎**连解析都过不了** —— 而浏览器不会
告诉你为什么，表现就是白屏。这种内核今天还真实存在（老版 360 / QQ 浏览器、旧安卓 WebView、
旧副屏设备），所以除了「现代档」，仓库再出一整**旧内核档**：

| 产物 | 是什么 | 谁在加载 |
|---|---|---|
| `dist/legacy/`（`index.html` + `assets/`） | 多文件网页档：`build.target = es2017`；worker 与**现代档一样**是 classic（`worker.format: "iife"` 两档写死，不跟档位走） | 被**入口垫片**自动跳过来的老引擎 |
| `public/rngcalc.legacy.html`（= `dist-local/rngcalc.legacy.html`） | **单文件**离线版，`file://` 双击即用；内联的是 MVP 档 wasm | 不想起服务器的老引擎用户 |
| `extension/url-seed-mv2/` | **MV2** 版扩展（同一份 TS 源码 + 另一份 manifest） | 装不了 MV3 的老内核用户 |

档位表、`worker.format` 为什么**两档都**是 `"iife"`（以及 `new Worker(...)` 里为什么一个字符
都不许加 `{ type: "module" }` —— 它在 Chromium 70~79 上不是「被忽略」而是**直接抛错**）、
`cssTarget` 为什么故意不设 —— 都写在 `vite.config.ts` 的文件头，改之前先读那一段。
`npm run build` 已一次出齐网页那两份
（`build_singlefile.mjs --all && vite build && vite build --mode legacy`），顺序不能调：
默认档的 `emptyOutDir` 会把 `dist/legacy/` 一起抹掉。扩展另跑 `npm run build:ext:all`。

### dev 与产物，两条规则（worker 的 `type`）

`worker.format: "iife"` **只管打包**：`npm run dev` 下 vite **不打包** worker，那个 `.ts`
是**原生 ESM**，而容器仍是 classic ⇒ 一启动就
`SyntaxError: Cannot use import statement outside a module`（界面上表现为「搜索 worker 崩了：…」）。
所以同一个 `new Worker(...)` 在两侧的规则**正好相反**：

| 场景 | 写法 | 为什么 |
|---|---|---|
| **打包产物**（`dist/`、`dist/legacy/`、两份单文件、扩展） | `new Worker(url, { name })` | Chromium 70~79 上 `type: "module"` 不是「被忽略」而是**直接抛 `TypeError`**（见上） |
| **`npm run dev`** | `new Worker(url, { type: "module", name })` | 那份 worker 没被打包，只有 module 容器装得下它 |

两条规则都在 `src/worker/pool.ts` 的 `browserWorkerFactory` 里，用 `if (import.meta.env.DEV)`
分开：`build` / `preview` 路径上它是静态 `false`（死分支被消除 ⇒ 产物里一个 `type` 都不剩），
只有 dev 下才为真。**`type` 必须是字面量**（vite 从源码 AST 里读它，读不出变量），并且
`new Worker(` 与 `new URL(` 必须**紧邻**（中间塞进别的东西，URL 就不会被改写）。

改了这里请一起跑 `npm run test`：`tests/legacy_gate.test.ts` 会同时查「**产物**里没有」与
「**源码** dev 分支里有」（含反例，防止判据本身失效）。

> ⚠️ 由此 **`npm run dev` 需要现代浏览器**（模块化 worker）；老内核只能靠
> `build` / `preview` 的产体验，`tests/` 里那个 chrome70 台架也走产物。

### 老引擎是被这五件事救回来的

1. **入口垫片** —— `index.html` 里 `<!--#legacy-shim:start#-->` 圈住的那段 **ES5**：
   先 `new Function("… ??= … ?. … 1n")` 问一句「这个引擎解析得动现代档吗」，解析不动
   （且**只有** `SyntaxError` 才算：站点以后配了 CSP，抛的 `EvalError` 不算）再去 `GET
   ./legacy/index.html`，**只有响应里带着构建期盖的记号**（`<html data-legacy-build>`，
   由 `vite.config.ts` 的 `legacyIndexMark()` 往 `%%legacy-index-marker%%` 占位里替）
   才 `location.replace("./legacy/")`；拿不到就原地写一句人话（带一个指向单文件档的链接）。
   ⚠️ **不能只看状态码**：`npm run dev` 的 SPA 兜底对任何路径都回 `200`，探测会恒真，
   老引擎于是被送到一个它解析不了的页面上 —— 这个坑真踩过（2026-10）。**状态码不是
   存在性证明，能当证据的只有产物内容。** 也正因为垫片问的是「这一页的内容」，
   记号必须是**拼**出来的字面量，本文件里不许出现完整记号（回声会变成恒真）。
   单文件档由构建器把**同一块**整段拷进去（`tools/build_singlefile.mjs`）。
2. **wasm 换 MVP 档** —— 老引擎没有 bulk memory（`memory.copy`/`memory.fill`，Chrome 75+）
   ⇒ 用 `cracker.mvp.wasm`。选择逻辑在 `src/wasm/variant.ts`（先试 modern、`CompileError`
   再回退 mvp —— 失败方向必须落在 mvp 上），细节见 `src/wasm/README.md`。
3. **`globalThis` 兜底** —— 它是 **Chrome 71** 才有的，而底线是 **70**。`src/polyfills.ts`
   必须是 `src/main.ts`、`src/worker/search.worker.ts`、扩展 `src/content.ts` **三处的第一条 import**
   （扩展那份更是硬性的：内联进去的 emscripten 胶水一求值就读 `globalThis.window`）。
4. **flex `gap` 兜底** —— flex 方向的 `gap` 是 **Chrome 84** 才有的，老引擎上元素会全挤在一起
   （不报错，只是难看）。`src/compat/css.ts` 探针量**真实布局**，不支持就往 `<html>` 加
   `no-flex-gap`，兜底样式全写在那套前缀下 ⇒ 现代引擎上一条都不生效。
   不能用 `@supports (gap: 1px)`：Chrome 70 上 grid 的 `gap` 会让它直接成立，flex 场景被误判。
5. **不用老引擎没有的 CSS** —— `:is()/:where()/:has()`、`inset:`、`min()/max()/clamp()` 一个都不写
   （在**源码**里就拆成长写 / 展开成静态值），于是两份产物走同一套 `cssTarget` 也不必分叉。

### 两条铁律（破了就是静默失效）

- **旧档不许有 es2017 之后的语法，也不许用老引擎没有的运行时 API**
  （`Object.fromEntries`、`.at()`、`structuredClone`、`crypto.randomUUID` …）。
  降级器只降**语法**，运行时 API 降不出来，而且是跑到那一步才炸 `TypeError`。
- **旧档任何 bundle 里，`globalThis` 的第一次出现必须是 `polyfills.ts` 那句 `typeof` 守卫。**

上面这五件事与两条铁律全部由**产物闸门**钉住，它们量的是**已构建的产物**：

| 套件 | 钉什么 |
|---|---|
| `tests/legacy_gate.test.ts` | 旧档 JS 的语法/禁用 API/`globalThis` 守卫、旧档 CSS、单文件档与扩展档内联的 wasm 变体、五个 HTML 产物的入口垫片、MV2/MV3 清单结构 |
| `tests/legacy_entry_shim.test.ts` | 垫片本身：源码里不许有现代语法（先剥注释与字符串）、记号必须是**拼**出来的（本文件里不许出现完整记号）、再在 `node:vm` 里真跑一遍（现代引擎放行 / 老引擎看到记号才跳转 / 只有 200 但没记号就写提示 / **回声自己那份文档不许算数** / 站在 legacy 产物上什么都不做 / CSP 不许误判）。`vite.config.ts` 的占位与替换值也在这里逐字比对 |

判据本身有三个坑，写在 `tests/legacy_gate.test.ts` 的文件头里，动手改之前先看：

- 语法判据是「把产物按 `es2017` 用 Oxc 再过一遍、**字节必须不变**」（Oxc 就是构建时的
  降级器，且只降语法）。⚠️ 反面判据「过一遍之后变了没有」**恒真** —— Oxc 会给任何现代代码
  注入 `@oxc-project/runtime/helpers` 的 import，本来就干净的文件也会变。
- 更不能拿 `indexOf("?.")` 当判据：压缩器把 `x == null ? .1 : x` 压成了 `x==null?.1:x`，
  每个旧档产物里都恰好有这么一处 ⇒ 一测一个**假红**，专门冤枉它要保护的文件。
- 产物缺席（没构建过）一律整组跳过 —— `dist/` 本身不进版本库。唯二进版本库的单文件产物是
  `public/rngcalc.html` 与 `public/rngcalc.legacy.html`，所以 CI 里这道闸门也不是空转的。

## 夹具（fixtures）怎么来的

`tests/fixtures/*.json` 是**采样**出来的对拍答案，权威实现在 Python 侧，生成后提交进仓库：

```powershell
..\.venv\Scripts\python.exe tools/make_fixtures.py            # 显示值 → 原始区间（RangeCodec）
..\.venv\Scripts\python.exe tools/make_spec_fixtures.py       # SeedSpec 契约（规范化/边界/应抛错的输入）
..\.venv\Scripts\python.exe tools/make_scenario_fixtures.py   # 场景目录 describe() + input_schema()
```

三个脚本都支持 `--check`（只校验文件是否最新，适合 CI）。它们自己也会先验证
「errors 用例确实抛错且消息含特征子串」、`describe()["key"]` 与所在位置一致等交叉自检，
所以夹具不会悄悄漂移。

⚠️ 夹具里比对 `SeedSpec.toDict()` 时是 **`JSON.stringify` 逐字比较**，因此键的顺序
也是契约的一部分 —— 改动 `spec.ts` 的 `extraToDict()` 字段顺序会直接弄坏对拍。

## 测试网的四个层次（加场景时照着抄）

一个场景落地要同时满足四张网，缺哪张都会"悄悄漂"：

| 网 | 文件 | 钉的是什么 |
|---|---|---|
| 结构 / 表单 | `tests/scenarios.test.ts` | 场景 `describe()` 与 `tests/fixtures/scenarios.json` **逐字段**相等（含 `schema.fields` 的每个键）；`near_limit` / `slice_bounds` 单独比 |
| 规格 | `tests/spec.test.ts` | `SeedSpec` 的规范化/边界/应抛错输入，对 `tests/fixtures/specs.json` |
| 结果（跨语言、跨后端） | `tests/scenario_runs.test.ts` | 对 `src_forge/tests/golden/runs.json` 里**每个**用例重放 `run()`，与 Python 记下来的 `expect` 逐字段相等 |
| 单场景合约 | `tests/<scenario>.test.ts` | 上面三张网盖不到的地方：常量表交叉钉、纯函数、报错文案、`golden` 没覆盖的分支（如 no-hit 出口） |

第四张网不是重复劳动 —— `runs.json` 只记 `Outcome`，**表单默认值、`validate` 文案、
场景内部的纯函数、以及"扫满上限之后"这类出口全都盖不到**。

⚠️ `strict` + `noUncheckedIndexedAccess` 下写这类测试的常见坑：
`expect(x?.[0]).toBe(...)` 会把"x 是 null"和"值不对"混成同一个红灯，
取字段前先 `if (!found) throw new Error(...)`（见各测试文件里的 `field()` / `strength()` 辅助函数）。

## 界面层（`src/ui/`）

**`App.vue` 参与类型检查。** `npm run typecheck` 是 `vue-tsc --noEmit`：
`<script setup>`、模板里的表达式、跨组件传的 props 都会报错（详见 `notes/web-design.md` §5.7；
`typescript` 因此钉在 TS6 别名上，`shims-vue.d.ts` 已删除 —— 别加回来，它会盖掉真实 props 类型）。
即便这样，仍然保留一条硬规矩：

> **界面里所有规则都写在纯 TS 模块里，`.vue` 只负责摆 DOM 和转发事件。**

理由不是「`.vue` 是盲区」了，而是**只有纯 TS 才能在 `node` 下钉**：
下游那四个模块的断言毫秒级跑完，搬进 DOM 要起 `happy-dom`，慢且会因为改样式而红。

| 文件 | 承担什么 |
|---|---|
| `url.ts` | `parseHash` / `buildHash` / `encodeParams` / `decodeParams` / `shareUrl` —— 表单与 URL 的双向映射，`_v`（表单版本）对不上只降级恢复 + 一条 warning，**永远不拒绝** |
| `form.ts` | `InputSchema` → 分组 / 宽度 / 控件值（`initialForm` / `writeForm` / `textOf`）与反方向（`collect` / `coerce` / `issues` / `mergeNotes`） |
| `result.ts` | `Outcome` → 结论一句话、KV 表、预览、种子条、详情 JSON |
| `session.ts` | `UiSession`：唯一有状态的东西。校验驳回、忙时互斥、取消、进度、日志、跑完回填（`advance`）、hash 同步全在这里 |
| `App.vue` | 工具栏 / 进度条 / 左右分栏 / 四个标签页 / 种子弹层 / F7·Esc 快捷键。**不含**任何判断逻辑 |

想给**决策逻辑**加测试 → 加到 `tests/ui_*.test.ts`（纯 TS，`node` 环境，不起 DOM）；
想钉**接线**（哪个 `@click` 接了哪个方法、`:data-field` 是不是写错了）→ 加到
`tests/ui_app.test.ts`（`happy-dom` + `@vue/test-utils`，**不加载 wasm**，结果面板直接喂纯数据 `Outcome`）；
想改布局 → 只动 `App.vue`，那边出错只会影响观感，不会算错。（**别在文档里写测试条数**。）

几个已实测的坑：

* `noUncheckedIndexedAccess` ⇒ 取首字符用 `text.charAt(0)`，别用 `text[0]`（后者多一个 `undefined`）。
* `verbatimModuleSyntax` ⇒ 只当类型用的导入必须写 `import type { ... }`。
* `textOf` 对 `bool` 回的是**真布尔**，Python 侧 `fields.text_of` 回的是 `"1"`/`"0"`（那边要塞进
  tkinter `StringVar`）。这是**有意的分歧**，界面状态等价，别去「对齐」。
* 详情页的 JSON（`detailJson()`）是**方法**不是 `computed`：它序列化整个 `Outcome`，
  只在切到「详情」标签时才调用（`App.vue` 里 `tab === "detail"` 才求值）。
* `WasmRuntime` / `SearchPool` / 999 长的种子数组**不进响应式**（`UiSession` 里是普通私有字段，
  只有 `Outcome` 这种纯数据快照才挂 `computed`）；种子列表按 400 个一块渲染。
* `history.replaceState` 写 hash（**不能** `pushState`）：`UiSession.syncHash()` 里有
  `typeof history === "undefined"` 守卫，所以它在 node 里跑测试时是空操作。
* **能不能取消，取决于走哪条路（实测）**：
  * **并行枚举 = 开（默认）** ⇒ 进 worker 池分片，每个分片开头查 `cancelToken`，
    主线程不阻塞 ⇒ Esc / 「取消」**真的生效**，能在一秒内断下来并记一行「已取消」。
  * **并行枚举 = 关** ⇒ 同步枚举，`Searcher.searchNearest` 只在发起 C 调用**之前**查一次
    `cancelToken`，而 C 调用是同步的 ⇒ 整段搜索期间主线程被占死，
    **取消按钮 / Esc 根本点不到**（实测 `stars` 全空间约 4 秒，采样 132 次全部 `disabled`）。
    想让取消永远可达，得把这条同步路径也分片（会碰到 `tests/ui_session.test.ts`
    的「取消」组里那两条锁）。
  测试锁在 `tests/ui_session.test.ts` 的「取消」组；UI 侧的 F7 / Esc 接线由
  `tests/ui_app.test.ts` 钉。

组件测试的开关是**文件级**的：在文件首行写 `// @vitest-environment happy-dom`，
不要改 `vite.config.ts` 里的全局 `environment: "node"` —— 大多数套件要加载真的 wasm 产物，
浏览器环境会走进 emscripten 的 fetch 分支。

## 两个容易踩的 TS 坑

1. **`& 0xFFFFFFFF` 不是「转 uint32」**：JS 位运算是 int32，`(x & 0xFFFFFFFF)` 对
   `x >= 2**31` 会给出负数。一律用 `>>> 0` 或 `| 0`，见 `src/core/values.ts`。
2. **wasm 的 `HEAP*` 视图在内存增长后会换对象**，每次访问都要重取；
   本构建**没有导出 `HEAPU8`**（只有 `HEAPU32`/`HEAP32`/`HEAPF64`），
   需要字节视图时从 `HEAPU32.buffer` 派生。
