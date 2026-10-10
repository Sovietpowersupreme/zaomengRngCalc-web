/**
 * 老引擎（Chromium 70 类）的最小兜底。
 *
 * ⚠️ **必须是每个入口 bundle 的「第一条 import」**：`src/main.ts`、
 * `src/worker/search.worker.ts`，以及扩展的 `extension/url-seed/src/content.ts`
 * （那一份最要紧 —— 它把胶水内联进了 content script，一求值就读 `globalThis`）。
 * emscripten 的胶水（`cracker.mjs`）一加载就会求值 `globalThis`，而 `globalThis` 是
 * **Chrome 71** 才有的 —— Chromium 70 上它是 `undefined`，胶水顶层一进去就
 * `ReferenceError`，整个应用白屏。ESM 的模块求值顺序 = 依赖声明顺序，所以放在第一个 import
 * 就够（不需要 `import "./polyfills"` 之后再写别的顺序 hack）。
 *
 * 现代引擎上这个文件几乎等于不存在：`globalThis` 本来就有，一个 `typeof` 判断就过去了。
 * 这也是它**不需要分「现代 / legacy 两份」**的原因 —— 只有一条兜底，多一份就会漂移。
 */

// 用 `typeof` 而不是 `in` / 直接读：变量未声明时 `typeof` 不抛错，这是唯一安全的探测法。
if (typeof globalThis === "undefined") {
  // 浏览器主线程与 worker 的全局对象都是 `self`（主线程里 `self === window`）。
  // 写入要走 cast：类型上 `globalThis` 永远存在，直接写会被 TS 判成多余/只读。
  (self as unknown as Record<string, unknown>)["globalThis"] = self;
}
