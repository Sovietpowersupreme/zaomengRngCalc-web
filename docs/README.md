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
npm run preview     # 预览 dist/（http://127.0.0.1:4173/）
npm run check       # typecheck + test + build 三连（本地全量：21 套件 / 831 用例）
npm run test:ci     # CI 用：跳过 3 个依赖上游 golden 快照的套件（见下）
npm run check:ci    # CI 用：typecheck + test:ci + build
```

> **`test:ci` 与 `check:ci` 是给 CI 的，不是本地跑着玩的。** `test:ci` 在 `vitest run` 上加了
> 三个 `--exclude`（`wasm_engine` / `searcher` / `scenario_runs`）—— 这三个套件读的是
> `../src_forge/tests/golden/` 的快照（`tests/helpers/golden.ts` 用相对路径指向仓库外），
> **只存在于主仓库本地**，公开仓库里没有，在 CI 里必然红。所以：
>
> **CI 全绿 ≠ 全绿。** CI 跑 18 套件 / 728 用例；全量是 21 / 831，只能在主仓库本地跑。

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
| `tests/` | vitest：`fixtures/` 是本地产的采样夹具，golden 走 `src_forge/tests/golden/` |
| `tools/` | `vitest-run.mjs`（见上）、`make_fixtures.py`（→ `tests/fixtures/ranges.json`）、`make_spec_fixtures.py`（→ `specs.json`）、`make_scenario_fixtures.py`（→ `scenarios.json`，场景目录 `describe()`） |

## 构建产物的两个硬约束

1. **`base` 是相对路径**（`"./"`）—— 产物能丢进任意**子路径**（例如 GitHub Pages 的
   `/zaomengRngCalc-web/`），也抗改名迁移。但**不能 `file://` 双击直开**：`origin: null`
   下外部 module script 会被 CORS 拦、`fetch(cracker.wasm)` 与 `new Worker(...)` 也都不行。
   本地验收请起静态服务器（`npm run preview`）。
2. **emscripten 胶水的 node 分支被外置**：`src/wasm/cracker.mjs` 开头有
   `if (ENVIRONMENT_IS_NODE) { const { createRequire } = await import("node:module") … }`。
   浏览器里这行永不执行，但 vite 会为它生成一个 `__vite-browser-external-*.js` 替身块，
   名字以 `_` 开头。所以 `vite.config.ts` 把 `[/^node:/]` 标成 external —— 既省掉一个
   **永远不会执行**的死块，也避开「`_` 开头文件被托管方丢弃」这类坑（历史上走分支发布时
   Jekyll 会静默丢掉它 → 运行期 404；现在的官方 Actions 发布不过 Jekyll，但还是不生成更干净）。
   `build.rollupOptions` 与 `worker.rollupOptions` **两处都要**（worker 里也 import 胶水）。
   不能改用 `-sENVIRONMENT=web,worker`：`tests/` 在 node 里跑，靠这个分支加载胶水。

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
| `App.vue` | 工具栏 / 进度条 / 左右分栏 / 四个标签页 / 种子弹层 / F5·Esc 快捷键。**不含**任何判断逻辑 |

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
  测试锁在 `tests/ui_session.test.ts` 的「取消」组；UI 侧的 F5 / Esc 接线由
  `tests/ui_app.test.ts` 钉（真键盘 F5 在浏览器里会被浏览器自己截走，自动化只能发合成事件）。

组件测试的开关是**文件级**的：在文件首行写 `// @vitest-environment happy-dom`，
不要改 `vite.config.ts` 里的全局 `environment: "node"` —— 大多数套件要加载真的 wasm 产物，
浏览器环境会走进 emscripten 的 fetch 分支。

## 两个容易踩的 TS 坑

1. **`& 0xFFFFFFFF` 不是「转 uint32」**：JS 位运算是 int32，`(x & 0xFFFFFFFF)` 对
   `x >= 2**31` 会给出负数。一律用 `>>> 0` 或 `| 0`，见 `src/core/values.ts`。
2. **wasm 的 `HEAP*` 视图在内存增长后会换对象**，每次访问都要重取；
   本构建**没有导出 `HEAPU8`**（只有 `HEAPU32`/`HEAP32`/`HEAPF64`），
   需要字节视图时从 `HEAPU32.buffer` 派生。
