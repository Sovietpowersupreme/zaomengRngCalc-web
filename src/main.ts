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
 *    ``worker.format: "es"`` + ``base: "./"`` 下唯一被 Vite 认出来的写法（另一个用途是让
 *    打包产物里真的出现 ``search.worker-*.js`` 这一块）；建不起来 / 预热失败都只记一行日志
 *    —— 主线程的串行搜索与并行**逐位一致**，没有池子只是慢，不是坏。
 *
 * 失败路径一律走 :meth:`UiSession.setRuntime(null, null, 原因)`：界面照常可用，
 * 点「运行」时给一句明确的「没有后端」，而不是白屏。
 */

import { createApp } from "vue";

import "./scenarios/index";
import App from "./ui/App.vue";
import { UiSession } from "./ui/session";
import { createRuntime } from "./wasm/runtime";
import { defaultPoolSize, SearchPool } from "./worker/pool";

const session = new UiSession({ href: () => location.href });
session.logLine("正在加载 cracker.wasm…");
// 打开链接 = 把表单填好，**不自动开跑**（§5.8）。
session.boot(location.hash);

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
  try {
    if (typeof Worker !== "undefined") {
      pool = new SearchPool({ size: defaultPoolSize(), nearEngine: runtime.engine });
    } else {
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
