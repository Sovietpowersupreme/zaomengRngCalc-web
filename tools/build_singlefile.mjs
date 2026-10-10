#!/usr/bin/env node
/**
 * 把 `web/` 打成一个**可直接双击打开**（`file://`）的单文件 HTML。
 *
 * 产出的 HTML 里内联了四样东西，所以运行时**零网络请求**：
 *
 * | 内联项 | 正常构建里的形态 | 单文件里的形态 |
 * | --- | --- | --- |
 * | app（Vue） | `assets/index-*.js`（ESM） | 一段 classic `<script>`（IIFE） |
 * | 样式 | `assets/index-*.css` | `<style>` |
 * | wasm | `assets/cracker-*.wasm`（fetch） | `?url` → `data:application/wasm;base64,…`（vite 内联，`locateFile` 那条路不变） |
 * | worker | `assets/search.worker-*.js`（module） | Blob（内联源码） |
 * | favicon | `favicon.png` | `data:` URI |
 * | 旧浏览器入口垫片 | `web/index.html` 里圈出来的那一段 | 原样切过来（见 :func:`legacyShimBlock`） |
 *
 * 运行时的接线在 `src/singlefile.ts`：它读 HTML 前置注入的 `self.__RNG_SINGLEFILE__`，
 * 于是 `worker/pool.ts` 改从 Blob 起 worker（wasm 那边其实靠 vite 内联的 `data:` URI，
 * 注入的 Base64 只负责「声明哪些变体可用」—— 见 `singlefile.ts` 文件头）。
 * **正常构建（`vite build`）没有这个全局，代码路径完全不变。**
 *
 * 为什么要两趟 `vite.build()` 而不是复用 `vite.config.ts`：
 *
 * * 产物要求 **IIFE 单块 + classic**（`file://` 下没有模块解析、没有相对路径可言），
 *   而 `vite.config.ts` 里是 `worker.format:"es"` + `base:"./"` + `external:[/^node:/]`；
 * * 复用 `external` 会在 IIFE 里留下无效的 `import`，所以这里改用
 *   :func:`nodeStubPlugin` 把 `node:*` 换成空壳（那段分支在浏览器里永不执行）。
 *
 * 用法::
 *
 *     node tools/build_singlefile.mjs              # 现代档（默认压缩）
 *     node tools/build_singlefile.mjs --no-minify  # 保留可读性，便于本地排查
 *     node tools/build_singlefile.mjs --legacy     # 只出 legacy 档（兼容 Chromium 70 类引擎）
 *     node tools/build_singlefile.mjs --all        # 两档都出
 *
 * 产物（都已 gitignore —— 属于生成物）：
 *
 * * 现代档：`web/dist-local/rngcalc.html` + `web/public/rngcalc.html`
 * * legacy 档：`web/dist-local/rngcalc.legacy.html` + `web/public/rngcalc.legacy.html`
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import vue from "@vitejs/plugin-vue";
import { build } from "vite";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FAVICON_FILE = resolve(WEB, "public", "favicon.png");
const ICON_FILE = resolve(WEB, "public", "assets", "zm3_icon.png");
const WASM_DIR = resolve(WEB, "src", "wasm");

/**
 * 构建档位。
 *
 * | 档位 | 语法目标 | 产物 | 内联的 wasm 变体 |
 * | --- | --- | --- | --- |
 * | `modern`（默认） | `es2022` | `rngcalc.html` | `wasmBase64` |
 * | `legacy`（`--legacy`） | `es2017` | `rngcalc.legacy.html` | `wasmMvpBase64` |
 *
 * **只带一个变体是刻意的**（见 `src/singlefile.ts` 文件头）：内联的 Base64 不负责喂字节，
 * 它只声明「这份构建允许用哪个变体」。现代档的 JS 是 es2022，旧引擎根本走不到 wasm 那一步，
 * 带上 MVP 是纯死重；legacy 档反过来。
 */
const PROFILES = {
  modern: {
    target: "es2022",
    file: "rngcalc.html",
    variants: ["modern"],
    label: "现代",
    title: "造梦西游3 随机数计算器（本地单文件版）",
    note: "",
  },
  legacy: {
    target: "es2017",
    file: "rngcalc.legacy.html",
    variants: ["mvp"],
    label: "legacy（兼容旧浏览器）",
    title: "造梦西游3 随机数计算器（本地单文件版 · 兼容旧浏览器）",
    note: " · 兼容旧浏览器",
  },
};

/** 变体 → wasm 文件名。 */
const WASM_FILES = {
  modern: resolve(WASM_DIR, "cracker.wasm"),
  mvp: resolve(WASM_DIR, "cracker.mvp.wasm"),
};

/** 变体 → 内联进 `self.__RNG_SINGLEFILE__` 的字段名（必须与 `src/singlefile.ts` 的 `VARIANT_FIELDS` 一致）。 */
const VARIANT_FIELDS = { modern: "wasmBase64", mvp: "wasmMvpBase64" };

// Vite 8 走 rolldown/oxc，**没有**内置 esbuild：`"esbuild"` 会直接报
// 「Failed to load `transformWithEsbuild`」。`true` 用默认压缩器（oxc）。
const MINIFY = process.argv.includes("--no-minify") ? false : true;

/** 内联脚本里 `import.meta.url` 的替身：一个语法合法、永不真的去取的绝对 URL。 */
const INLINE_IMPORT_META_URL = "file:///_rngcalc_inline_/bundle.js";

/**
 * emscripten 胶水开头的 node 分支里有 `await import("node:module")`。浏览器里
 * `ENVIRONMENT_IS_NODE` 恒为 false，这行永不执行；但 IIFE 格式下 `external` 会留下
 * 一个无效的 import。这里把它换成一个空壳模块，等价且干净。
 */
function nodeStubPlugin() {
  const STUB = "\0rngcalc-singlefile-node-stub";
  return {
    name: "rngcalc-singlefile:node-stub",
    enforce: "pre",
    resolveId(source) {
      return source.startsWith("node:") ? STUB : null;
    },
    load(id) {
      if (id !== STUB) return null;
      // 形状对齐 emscripten 的用法：`const { createRequire } = await import("node:module")`。
      return "export const createRequire = () => () => undefined;\nexport default {};\n";
    },
  };
}

/** 只对我们自己的源码做替换，避免误伤 Vite 内部虚拟模块。 */
function isOwnSource(id) {
  const normalized = id.replace(/\\/g, "/");
  return normalized.includes("/src/");
}

/**
 * `import.meta.url` 在 **IIFE** 里要么被 Rollup 换成运行时 shim、要么直接报错；
 * 换成常量最省心。受影响的是 `cracker.mjs` 顶部的 `var _scriptName=import.meta.url`
 * 与 `search.worker.ts` 顶部的 `new URL(wasmUrlRaw, import.meta.url)` —— 后者只影响一个
 * **永不使用**的 `locateFile` 兜底（wasm 走内联二进制）。
 */
function importMetaUrlPlugin() {
  const replacement = JSON.stringify(INLINE_IMPORT_META_URL);
  return {
    name: "rngcalc-singlefile:import-meta-url",
    enforce: "pre",
    transform(code, id) {
      if (!isOwnSource(id) || !code.includes("import.meta.url")) return null;
      return { code: code.replaceAll("import.meta.url", replacement), map: null };
    },
  };
}

/** 从 `vite.build()` 的返回值里取出「拼成一整块」的 JS 与 CSS。 */
function collect(result) {
  const single = Array.isArray(result) ? result[0] : result;
  if (single === null || single === undefined || !Array.isArray(single.output)) {
    throw new Error("构建没有返回产物（build.write 必须为 false）");
  }
  const js = single.output
    .filter((item) => item.type === "chunk")
    .map((item) => item.code)
    .join("\n");
  const css = single.output
    .filter((item) => item.type === "asset" && item.fileName.endsWith(".css"))
    .map((item) => (typeof item.source === "string" ? item.source : Buffer.from(item.source).toString("utf8")))
    .join("\n");
  return { js, css };
}

/** 用同一套配置分别打 worker 与 app（都只要一个自包含的 IIFE）；`target` 由档位决定。 */
async function bundle(entry, target) {
  const result = await build({
    configFile: false,
    root: WEB,
    logLevel: "warn",
    plugins: [nodeStubPlugin(), importMetaUrlPlugin(), vue()],
    // ⚠️ **库模式**下 Vite 故意**不**替换 `process.env.NODE_ENV`（留给库的使用者决定），
    // 而这里要的恰恰是「立刻能跑」：不定义的话 Vue 一加载就
    // `ReferenceError: process is not defined`（浏览器里没有 `process`）。
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      __VUE_PROD_DEVTOOLS__: "false",
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
    },
    build: {
      write: false,
      target,
      minify: MINIFY,
      sourcemap: false,
      cssCodeSplit: false,
      lib: {
        entry: resolve(WEB, entry),
        formats: ["iife"],
        name: "RngCalcBundle",
        fileName: () => "bundle.js",
      },
    },
  });
  return collect(result);
}

/**
 * 内联进 `<script>`/`<style>` 前把会提前闭合标签的序列打断（`\/` 在 JS/CSS 里语义不变）。
 *
 * ⚠替换必须用**函数**形式：`String.replace(All)` 的字符串替换值里 `$&` / `` $` `` / `$'` /
 * `$$` 是特殊模式。打包产物里几乎一定存在这类 `$` 序列（Vue 的模板字符串一抓一大把），
 * 直接传字符串会把内联块炸成好几份（历史上就是这么把脚本块重复注入了 6 次）。
 */
function guardClosingTag(code, tag) {
  return code.replaceAll(`</${tag}`, () => `<\\/${tag}`);
}

/** 用函数替换器占位替换，同理避开 `$` 模式。 */
function fill(html, marker, block) {
  return html.replace(marker, () => block);
}

/**
 * 旧浏览器的「入口垫片」在 `web/index.html` 里，用 `<!--#legacy-shim:start#-->` /
 * `<!--#legacy-shim:end#-->` 圈出来。
 *
 * **切出来用，不在这里重写一遍**：那段代码的每一条注释都在解释「为什么只能是 ES5」
 * 「为什么只认 `SyntaxError`」「为什么不能一路 `/legacy/legacy/…` 转下去」，抄一份就会
 * 各自漂移，而漂移的表现是「网页版能救回来、单文件版白屏」——它们只在老引擎上出现。
 *
 * 单文件版尤其需要它：双击打开时 `./legacy/` 取不到（`file://` 下 XHR 直接被拦，
 * 甚至可能抛），垫片会走 `explain()` 那条路，告诉用户改用 `rngcalc.legacy.html` ——
 * 那正是下载下来时摆在它旁边的另一个文件。legacy 档自己靠路径判断直接放行。
 */
const SHIM_START = "<!--#legacy-shim:start#-->";
const SHIM_END = "<!--#legacy-shim:end#-->";

async function legacyShimBlock() {
  const source = await readFile(resolve(WEB, "index.html"), "utf8");
  const from = source.indexOf(SHIM_START);
  const to = source.indexOf(SHIM_END);
  if (from < 0 || to < 0 || to < from) {
    throw new Error(`web/index.html 里找不到旧浏览器垫片的标记（${SHIM_START} / ${SHIM_END}）`);
  }
  // 连标记一起切：单文件产物里留着这两个注释无伤大雅，反而让「这段是从哪来的」有据可查。
  const block = source.slice(from, to + SHIM_END.length);
  // 垫片自己必须还是「一个 <style> + 一段 <script>」，多了会把它下面那些计数断言搞乱。
  const scripts = (block.match(/<script\b/g) ?? []).length;
  const styles = (block.match(/<style\b/g) ?? []).length;
  if (scripts !== 1 || styles !== 1) {
    throw new Error(`旧浏览器垫片应该只有 1 个 <script> + 1 个 <style>，实际 ${scripts} / ${styles}`);
  }
  // 骨架里 `__RNG_SHIM__` 是顶格写的，切出来的块统一补 4 空格缩进，
  // 产物的 <head> 才不会一半贴左一半缩进（纯样式，不影响解析）。
  return block
    .split("\n")
    .map((line) => (line.length === 0 ? line : `    ${line}`))
    .join("\n");
}

/** 取垫片里那段脚本正文，交给 `assertScriptsParse` 一起验（它在 HTML 里，`vue-tsc` 看不到）。 */
function shimScriptBody(block) {
  const match = /<script>([\s\S]*?)<\/script>/.exec(block);
  if (match === null) throw new Error("旧浏览器垫片里没有 <script> 正文");
  return match[1] ?? "";
}

/** 结构自检：两个脚本 / 一个样式（外加垫片那一个），且每个内联块真的只有一份。 */
function assertShape(html, extraScripts = 0, extraStyles = 0) {
  const count = (re) => (html.match(re) ?? []).length;
  // ⚠️ 只数带 id 的标签：打包产物里也可能有 `"<script"` 这类字符串，泛数 `<script\b` 会误报。
  const parts = [
    ["config 块", /<script id="rngcalc-config">/g, 1],
    ["app 块", /<script id="rngcalc-app">/g, 1],
    ["style 块", /<style id="rngcalc-style">/g, 1],
    ["</script>", /<\/script>/g, 2 + extraScripts],
    ["</style>", /<\/style>/g, 1 + extraStyles],
  ];
  for (const [name, re, expect] of parts) {
    const actual = count(re);
    if (actual !== expect) throw new Error(`${name} 出现 ${actual} 次（应为 ${expect} 次）——内联块可能被重复注入`);
  }
}

/**
 * HTML 骨架里的外部引用检查（只查我们手写的部分，不扫打包产物）。
 *
 * ⚠️ 唯一放行的是**同目录下我们自己产出的单文件档**（`PROFILES[*].file`）：老引擎的垫片最后会
 * 写一句「打开同一目录下的旧浏览器版单文件页面」并附上 `./rngcalc.legacy.html`。那不是外部依赖，
 * 是同一次构建的兄弟产物（`--all` 一起出、一起下载）。其余外链一律拒绝 —— 单文件的卖点就是
 * 「拷走一个文件就能跑」。
 */
function assertNoExternalRefs(skeleton) {
  const siblings = new Set(Object.values(PROFILES).map((profile) => `./${profile.file}`));
  const found = [];
  const refRe = /\b(?:src|href)\s*=\s*["']([^"']*)["']/gi;
  let match = refRe.exec(skeleton);
  while (match !== null) {
    const value = match[1] ?? "";
    if (!/^(?:data:|#|javascript:)/i.test(value) && !siblings.has(value)) found.push(match[0]);
    match = refRe.exec(skeleton);
  }
  if (found.length > 0) {
    throw new Error(`骨架里还有指向外部文件的引用：\n  ${found.join("\n  ")}`);
  }
}

/** 三段脚本都必须能被解析（只编译不执行）。 */
function assertScriptsParse(scripts) {
  for (const [name, code] of scripts) {
    try {
      new vm.Script(code, { filename: `${name}.js` });
    } catch (err) {
      throw new Error(`${name} 脚本语法错误：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

async function main(profile) {
  const outFile = resolve(WEB, "dist-local", profile.file);
  const publicOutFile = resolve(WEB, "public", profile.file);
  console.log(`[${profile.label}]`);
  console.log("[1/4] 打包 worker（IIFE）…");
  const worker = await bundle("src/worker/search.worker.ts", profile.target);
  if (worker.js.length === 0) throw new Error("worker 打包为空");

  console.log("[2/4] 打包 app（IIFE）…");
  const app = await bundle("src/main.ts", profile.target);
  if (app.js.length === 0) throw new Error("app 打包为空");

  console.log("[3/4] 读 wasm / favicon / icon / 旧版垫片 并组装…");
  const shimBlock = await legacyShimBlock();
  // 只带本档声明的变体（见 `PROFILES` 的说明）。字段名用 `VARIANT_FIELDS` 查，
  // 写成 `modern → wasmBase64` 这种硬编码很容易和 `src/singlefile.ts` 疏远。
  const inline = /** @type {Record<string, string>} */ ({});
  const wasmLogs = [];
  for (const variant of profile.variants) {
    const base64 = (await readFile(WASM_FILES[variant])).toString("base64");
    inline[VARIANT_FIELDS[variant]] = base64;
    wasmLogs.push([WASM_FILES[variant].split(/[\\/]/).pop(), base64.length]);
  }
  const faviconUri = `data:image/png;base64,${(await readFile(FAVICON_FILE)).toString("base64")}`;
  let zm3IconBase64 = "";
  try {
    zm3IconBase64 = (await readFile(ICON_FILE)).toString("base64");
  } catch {
    // 图标可选，读不到则降级为空
  }

  // 前置注入：JSON 里 `</` 会被 HTML 解析器当成 `</script>` 的开头，转成 `<\/`（JSON 合法转义）。
  const configScript = `self.__RNG_SINGLEFILE__=${JSON.stringify({
    ...inline,
    workerSource: worker.js,
    zm3IconBase64,
  }).replaceAll("</", "<\\/")};`;

  const skeleton = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      name="description"
      content="造梦西游3 随机数计算器（本地单文件版${profile.note}）：全部 JS / WASM / Worker 内联，双击即可离线使用。"
    />
    <link rel="icon" type="image/png" href="${faviconUri}" />
    <title>${profile.title}</title>
__RNG_SHIM__
    <style id="rngcalc-style">__RNG_STYLE__</style>
  </head>
  <body>
    <div id="app"></div>
    <noscript>这个计算器需要 JavaScript。</noscript>
    <script id="rngcalc-config">__RNG_CONFIG__</script>
    <script id="rngcalc-app">__RNG_APP__</script>
  </body>
</html>
`;

  // 垫片先填进去再查外部引用：它里面那句 `xhr.open("HEAD", "./legacy/")` 是运行时的，
  // 而且单文件版**就是靠它**才提示得了「改用另一个文件」，所以它是骨架的一部分。
  assertNoExternalRefs(fill(skeleton, "__RNG_SHIM__", shimBlock));
  const configBlock = guardClosingTag(configScript, "script");
  const appBlock = guardClosingTag(app.js, "script");
  const styleBlock = guardClosingTag(app.css, "style");
  assertScriptsParse([
    ["config", configScript],
    ["app", app.js],
    ["worker", worker.js],
    ["legacy-shim", shimScriptBody(shimBlock)],
  ]);

  const html = fill(
    fill(fill(fill(skeleton, "__RNG_SHIM__", shimBlock), "__RNG_STYLE__", styleBlock), "__RNG_CONFIG__", configBlock),
    "__RNG_APP__",
    appBlock,
  );
  // 占位符全部被替换（防止模板里漏了一个没改到）。
  for (const marker of ["__RNG_SHIM__", "__RNG_STYLE__", "__RNG_CONFIG__", "__RNG_APP__"]) {
    if (html.includes(marker)) throw new Error(`占位符未被替换：${marker}`);
  }
  assertShape(html, 1, 1);

  console.log("[4/4] 写文件…");
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, html, "utf8");
  await mkdir(dirname(publicOutFile), { recursive: true });
  await writeFile(publicOutFile, html, "utf8");

  console.log("");
  console.log(`  语法目标      ${profile.target}`);
  console.log(`  worker 源码   ${kb(worker.js.length)}`);
  console.log(`  app 源码      ${kb(app.js.length)}（CSS ${kb(app.css.length)}）`);
  for (const [name, size] of wasmLogs) {
    console.log(`  内联 wasm     ${name} Base64 ${kb(size)}`);
  }
  console.log(`  favicon       ${kb(faviconUri.length)}`);
  console.log(`  旧版垫片      ${kb(shimBlock.length)}（切自 web/index.html）`);
  console.log(`  ── 单文件总大小 ${kb(html.length)}`);
  console.log("");
  console.log(`已写入：${outFile}`);
  console.log(`已同步至：${publicOutFile}（供静态站点在线下载）`);
}

/** 命令行档位：`--legacy` 只出 legacy，`--all` 两档都出，默认只出现代档。 */
function selectedProfiles() {
  const flags = process.argv.slice(2);
  if (flags.includes("--all")) return [PROFILES.modern, PROFILES.legacy];
  if (flags.includes("--legacy")) return [PROFILES.legacy];
  return [PROFILES.modern];
}

async function run() {
  for (const profile of selectedProfiles()) await main(profile);
  console.log("直接双击打开即可（file://）。若要回归对比，请用 `npm run preview`（HTTP）。");
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
