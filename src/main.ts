/**
 * Web 版入口：装配「会话 + 外壳」，然后把 wasm 后端挂上去。
 *
 * 三件事，顺序不能换：
 *
 * 1. **注册场景** —— 那一行 ``import "./scenarios/index"`` 是**裸副作用导入**，谁都不用它
 *    导出的东西，但少写这一行就等于所有场景都不存在（``missingKeys()`` 会把它们全列出来，
 *    ``UiSession`` 的构造函数也会因为注册表为空而抛）。TS 的模块图是静态的，
 *    「自动发现」这种活在 Web 侧只能由这个 barrel 显式写出来。
 * 2. **建会话 + 挂载** —— :class:`UiSession` 不碰 DOM、也不读 ``location``，
 *    hash 与当前地址都由这里传进去，所以它能在 node 里被测试。挂载**先于**加载 wasm：
 *    表单该立刻可见，wasm 慢慢来（大种子上要跑很久的那部分运行期在用户点「运行」之后）。
 * 3. **加载后端** —— ``createRuntime()`` 建 wasm，``SearchPool`` 建 worker 池。
 *    池子里的 ``new Worker(new URL("./search.worker.ts", import.meta.url))`` 是
 *    ``worker.format: "iife"`` + ``base: "./"`` 下唯一被 Vite 认出来的写法（另一个用途是让
 *    打包产物里真的出现 ``search.worker-*.js`` 这一块）；⚠️ 它**只能带 `name`**，多一个
 *    ``type: "module"`` 会在 Chromium 70~79 上直接抛错（见 `worker/pool.ts` 的说明）；
 *    建不起来 / 预热失败都只记一行日志
 *    —— 主线程的串行搜索与并行**逐位一致**，没有池子只是慢，不是坏。
 *
 * 失败路径一律走 :meth:`UiSession.setRuntime(null, null, 原因)`：界面照常可用，
 * 点「运行」时给一句明确的「没有后端」，而不是白屏。
 */

// ⚠️ 必须是第一条 import（见该文件的说明）：它给老引擎补 `globalThis`，
// 而 `./wasm/runtime` → `cracker.mjs` 的顶层就会求值它。
import "./polyfills";

import { createApp } from "vue";

import "./scenarios/index";
import { applyCompatClasses } from "./compat/css";
import { isSingleFile, probeInlineWorker } from "./singlefile";
import App from "./ui/App.vue";
import { UiSession } from "./ui/session";
import { createRuntime } from "./wasm/runtime";
import { chosenVariant, WASM_VARIANT_NOTES } from "./wasm/variant";
import { defaultPoolSize, SearchPool } from "./worker/pool";

const session = new UiSession({ href: () => location.href });
session.logLine("正在加载 cracker.wasm…");
// 打开链接 = 把表单填好，**不自动开跑**（§5.8）。
session.boot(location.hash);

// 挂载**之前**定好兼容类：否则老引擎上会先按现代样式排一帧、探针跑完再跳一下。
// （细节见 `src/compat/css.ts`；现代引擎上它只往 `html` 上挂 `no-flex-gap` 或者什么都不做。）
applyCompatClasses();

createApp(App, { session }).mount("#app");

async function boot(): Promise<void> {
  let runtime: Awaited<ReturnType<typeof createRuntime>>;
  try {
    runtime = await createRuntime();
  } catch (exc) {
    const message = exc instanceof Error ? exc.message : String(exc);
    session.setRuntime(null, null, `加载 cracker.wasm 失败：${message}`);
    return;
  }

  // 用的是哪份 wasm：老引擎上会退到 mvp，日志里得能一眼看出来（否则「为什么慢了一点」
  // 这种问题只能靠猜）。
  const variant = chosenVariant();
  if (variant !== undefined) {
    session.logLine(`wasm 变体：${WASM_VARIANT_NOTES[variant]}`);
  }

  // 一条基准向量自检：加载成功但不干活的那种坏法（例如 wasm 与 TS 侧的常量漂移）
  // 在这里就会露出来，不必等到用户点「运行」。
  try {
    const probe = runtime.module._fastNext(12345);
    const ok = probe === 1207965724;
    session.logLine(`fastNext(12345) = ${probe}（基准值 1207965724）${ok ? " ✓" : " ✗ 不一致！"}`);
  } catch (exc) {
    session.logLine(`基准向量自检失败（已忽略）：${String(exc)}`);
  }

  let pool: SearchPool | null = null;
  // 单文件版里 worker 只能从 Blob 起（没有文件 URL 兜底），先探活一次：
  // 少数浏览器在 file:// 下禁止 Blob worker，探到就直接串行，不必等第一次搜索才失败。
  let workersUsable = typeof Worker !== "undefined";
  if (workersUsable && isSingleFile()) {
    workersUsable = await probeInlineWorker();
    if (!workersUsable) {
      session.logLine("内联 Worker 不可用：退回主线程串行搜索（结果一致，只是更慢）");
    }
  }
  try {
    if (workersUsable) {
      pool = new SearchPool({ size: defaultPoolSize(), nearEngine: runtime.engine });
    } else if (typeof Worker === "undefined") {
      session.logLine("当前环境没有 Web Worker：只用主线程串行搜索");
    }
  } catch (exc) {
    session.logLine(`worker 池建不起来，退回串行：${String(exc)}`);
    pool = null;
  }

  session.setRuntime(runtime, pool, "");

  const active = pool;
  if (active !== null) {
    void active.warmup().then(
      () => session.logLine(`worker 池 ${active.size} 个已就绪`),
      (err: unknown) => session.logLine(`worker 池预热失败（不影响串行）：${String(err)}`),
    );
  }
}

void boot();
