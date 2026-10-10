#!/usr/bin/env node
/**
 * 把 `web/extension/url-seed/` 打包成可以「加载已解压的扩展程序」的 `dist/`。
 *
 * 产出的四个 JS 都是**自包含 IIFE**，没有任何 `import`：
 *
 * | 入口 | 产物 | 为什么是这个形态 |
 * | --- | --- | --- |
 * | `src/background.ts` | `background.js` | MV3 service worker 默认是 classic script |
 * | `src/content.ts` | `content.js` | 内容脚本不接受 ESM（`import`），只能 IIFE |
 * | `src/popup.ts` | `popup.js` | `<script defer src>` classic |
 * | `src/options.ts` | `options.js` | 同上 |
 *
 * 与 `tools/build_singlefile.mjs` 的关系：**同一套思路，不同用途**。两者都用
 * 「库模式 + iife + 覆盖 `node:*` + 换掉 `import.meta.url`」这四招；差别在于：
 *
 * * 单文件版把 wasm **Base64 内联进 HTML**；扩展版把同一份 Base64 拼成一句
 *   `self.__RNG_SINGLEFILE__ = {...}` **贴在 `content.js` 开头**。内容脚本碰不到
 *   扩展的 `web_accessible_resources`（要额外声明、还要处理 `chrome.runtime.getURL`
 *   与 CSP），内联是这里唯一干净的做法。运行时接线完全复用
 *   `web/src/singlefile.ts` 的 `inlineWasmBinary()` —— 也就是说扩展与在线版跑的是
 *   **同一个 wasm、同一份恢复代码**，结果必然一致。
 * * 扩展版**不**用 `@vitejs/plugin-vue`：四个入口都是原生 DOM，没有 `.vue`。
 *
 * 用法::
 *
 *     node tools/build_extension.mjs              # 默认档：MV3，压缩
 *     node tools/build_extension.mjs --no-minify  # 保留可读性，便于在扩展里排查
 *     node tools/build_extension.mjs --mv2        # 旧浏览器档：MV2（Chromium 70 级）
 *     node tools/build_extension.mjs --all        # 两档都打
 *
 * 产物：`web/extension/url-seed/dist/`（MV3）与 `web/extension/url-seed-mv2/dist/`（MV2），
 * 两者都在 `.gitignore` 里 —— 属于生成物。
 */

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { build } from "vite";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** MV3（现代）那套：**源码就在这里**，两档都从它取入口与静态件。 */
const EXT_MODERN = resolve(WEB, "extension", "url-seed");
const SRC = resolve(EXT_MODERN, "src");
const WASM_DIR = resolve(WEB, "src", "wasm");
/** MV2 档的目录：**只有清单**（代码与两个 HTML、图标一律共用上面那份）。 */
const EXT_LEGACY = resolve(WEB, "extension", "url-seed-mv2");

/**
 * 两个档位。
 *
 * 刻意做成「**一套源码，两份清单**」：MV2 与 MV3 的差别只有列出清单的写法、
 * 几个 API 的有无，以及 wasm 变体（纯 MVP）。同一份 UI / 规则 / 解析器源码维护两份
 * 一定会腐，而腐了的表现是「两个插件行为不一样」—— 最难发现的那种 bug。
 *
 * | | MV3（默认） | MV2（`--mv2`） |
 * | --- | --- | --- |
 * | 输出 | `url-seed/dist/` | `url-seed-mv2/dist/` |
 * | 清单 | 上面那份 `src/manifest.json` | `url-seed-mv2/src/manifest.json` |
 * | 语法目标 | `es2022` | `es2017`（Chromium 70 级引擎） |
 * | 内联 wasm | `wasmBase64`（modern） | `wasmMvpBase64`（纯 MVP） |
 *
 * 内联字段名不是随便写的：`web/src/wasm/variant.ts` 的 `candidateVariants()` 正是按
 * 「声明了哪几个变体」决定加载哪份 wasm，所以 **MV2 档必须只声明 mvp**，
 * 否则老引擎会拿到含 bulk memory 的 modern 产物、直接 `CompileError`。
 */
const PROFILES = {
  mv3: {
    label: "MV3（现代 Chrome / Edge）",
    dir: EXT_MODERN,
    manifest: resolve(SRC, "manifest.json"),
    manifestVersion: 3,
    target: "es2022",
    wasmField: "wasmBase64",
    wasmFile: resolve(WASM_DIR, "cracker.wasm"),
  },
  mv2: {
    label: "MV2（Chromium 70 级旧引擎）",
    dir: EXT_LEGACY,
    manifest: resolve(EXT_LEGACY, "src", "manifest.json"),
    manifestVersion: 2,
    target: "es2017",
    wasmField: "wasmMvpBase64",
    wasmFile: resolve(WASM_DIR, "cracker.mvp.wasm"),
  },
};

/** 要打进扩展的四个入口（也是 dist 下的文件名）。 */
const ENTRIES = ["background", "content", "popup", "options"];

/**
 * 要原样拷进 dist 的静态件。
 *
 * 刻意放在 ``src/`` 下而不是扩展根目录：这几个文件是**源**，而 ``dist/`` 才是能加载的
 * 成品。以前 ``manifest.json`` 就在 ``url-seed/`` 根部，于是在 ``chrome://extensions``
 * 里顺手选 ``url-seed/`` 也能读到清单，接着却找不到清单点名的 ``background.js`` ——
 * 报出来的是「无法加载背景脚本」这种指向错误处的错。现在根部没有清单，选错了只会
 * 得到「清单文件缺失或无法读取」，一眼就知道是选错了目录。
 */
const COPIES = [
  ["src/popup.html", "popup.html"],
  ["src/options.html", "options.html"],
  ["icons", "icons"],
];

// Vite 8 走 rolldown/oxc，**没有**内置 esbuild：`"esbuild"` 会直接报
// 「Failed to load `transformWithEsbuild`」。`true` 用默认压缩器（oxc）。
const MINIFY = process.argv.includes("--no-minify") ? false : true;

/** 内联脚本里 `import.meta.url` 的替身：语法合法、永不真的去取的绝对 URL。 */
const INLINE_IMPORT_META_URL = "file:///_rngcalc_extension_/bundle.js";

/**
 * emscripten 胶水开头的 node 分支里有 `await import("node:module")`。扩展里
 * `ENVIRONMENT_IS_NODE` 恒为 false，这行永不执行；但 IIFE 格式下 `external` 会留下
 * 一个无效的 import。换成空壳，等价且干净。
 */
function nodeStubPlugin() {
  const STUB = "\0rngcalc-extension-node-stub";
  return {
    name: "rngcalc-extension:node-stub",
    enforce: "pre",
    resolveId(source) {
      return source.startsWith("node:") ? STUB : null;
    },
    load(id) {
      if (id !== STUB) return null;
      return "export const createRequire = () => () => undefined;\nexport default {};\n";
    },
  };
}

/** 只对我们自己的源码做替换，避免误伤 Vite 内部虚拟模块。 */
function isOwnSource(id) {
  return id.replace(/\\/g, "/").includes("/src/");
}

/** `import.meta.url` 在 IIFE 里不成立（见 build_singlefile.mjs 的同类插件）。 */
function importMetaUrlPlugin() {
  const replacement = JSON.stringify(INLINE_IMPORT_META_URL);
  return {
    name: "rngcalc-extension:import-meta-url",
    enforce: "pre",
    transform(code, id) {
      if (!isOwnSource(id) || !code.includes("import.meta.url")) return null;
      return { code: code.replaceAll("import.meta.url", replacement), map: null };
    },
  };
}

/** 打一个自包含 IIFE；返回代码字符串。 */
async function bundle(entry, target) {
  const name = entry.replace(/\.ts$/, "");
  const result = await build({
    configFile: false,
    root: WEB,
    logLevel: "warn",
    plugins: [nodeStubPlugin(), importMetaUrlPlugin()],
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    build: {
      write: false,
      target,
      minify: MINIFY,
      sourcemap: false,
      cssCodeSplit: false,
      lib: {
        entry: resolve(SRC, entry),
        formats: ["iife"],
        name: "RngCalcExtBundle",
        fileName: () => `${name}.js`,
      },
    },
  });
  const single = Array.isArray(result) ? result[0] : result;
  if (single === null || single === undefined || !Array.isArray(single.output)) {
    throw new Error(`${entry}: 构建没有返回产物（build.write 必须为 false）`);
  }
  return single.output
    .filter((item) => item.type === "chunk")
    .map((item) => item.code)
    .join("\n");
}

/** 每个产物都必须能被解析（只编译不执行）。 */
function assertParses(name, code) {
  try {
    new vm.Script(code, { filename: `${name}.js` });
  } catch (err) {
    throw new Error(`${name}.js 语法错误：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * MV3 的内容脚本与扩展页都在 **不允许 `eval` / `new Function`** 的 CSP 下（`'self'`），
 * 一旦产物里出现它们，运行时才会炸 —— 而且是在用户机器上炸。构建期直接拦掉。
 *
 * emscripten 的胶水与我们的公式解析器都已确认不碰这两个东西（:mod:`formula` 是手写的
 * 词法/语法分析，正是为了这个），所以这条断言是「守住现状」而不是「也许过不了」。
 */
function assertNoEval(name, code) {
  for (const pattern of [/\beval\s*\(/, /\bnew\s+Function\s*\(/]) {
    const found = pattern.exec(code);
    if (found !== null) {
      const at = Math.max(0, found.index - 60);
      throw new Error(
        `${name}.js 里出现了 ${pattern} —— MV3 的 CSP 不允许，运行时会直接报错。\n` +
          `  附近代码：…${code.slice(at, found.index + 40).replace(/\s+/g, " ")}…`,
      );
    }
  }
}

/**
 * manifest 里点名的文件（两个版本的清单都能读）。
 *
 * MV3 是 `background.service_worker` + `action`；MV2 是 `background.scripts`（数组）+
 * `browser_action`。清单写错一个文件名，本地加载扩展时只会看到一句含糊的
 * 「无法加载背景脚本」，所以两边都得覆盖。
 */
function manifestFiles(manifest) {
  const wanted = [];
  if (typeof manifest.background?.service_worker === "string") {
    wanted.push(manifest.background.service_worker);
  }
  for (const file of manifest.background?.scripts ?? []) {
    if (typeof file === "string") wanted.push(file);
  }
  for (const ui of [manifest.action, manifest.browser_action]) {
    if (typeof ui?.default_popup === "string") wanted.push(ui.default_popup);
    for (const size of Object.values(ui?.default_icon ?? {})) {
      if (typeof size === "string") wanted.push(size);
    }
  }
  if (typeof manifest.options_page === "string") wanted.push(manifest.options_page);
  if (typeof manifest.options_ui?.page === "string") wanted.push(manifest.options_ui.page);
  for (const size of Object.values(manifest.icons ?? {})) {
    if (typeof size === "string") wanted.push(size);
  }
  return wanted;
}

/** manifest 里点名的文件必须真的在 dist 里（少了才会在加载扩展时才发现）。 */
function assertManifestComplete(manifest, present) {
  const missing = manifestFiles(manifest).filter((item) => !present.has(item));
  if (missing.length > 0) throw new Error(`manifest.json 引用了不存在的文件：${missing.join("、")}`);
}

/**
 * 清单必须与档位对得上。
 *
 * ⚠️ MV2 清单里如果漏写了 `manifest_version: 2`，Chrome 会当成 MV1（或直接拒绝），
 * 报错信息与真正的原因相隔十万八千里；至于把 `scripting` 写进 MV2 的 `permissions`
 * —— 那个 API 在 MV2 里根本不存在，Chrome 会在加载时直接报「无效的权限」。
 */
function assertManifestProfile(manifest, profile) {
  if (manifest.manifest_version !== profile.manifestVersion) {
    throw new Error(
      `${profile.label} 清单的 manifest_version 是 ${manifest.manifest_version}，应该是 ${profile.manifestVersion}`,
    );
  }
  const permissions = [...(manifest.permissions ?? []), ...(manifest.optional_permissions ?? [])];
  if (profile.manifestVersion === 2) {
    const mv3Only = permissions.filter((item) => item === "scripting");
    if (mv3Only.length > 0) throw new Error("MV2 清单里不该出现 MV3 专属权限：scripting");
    if (manifest.background?.service_worker !== undefined) {
      throw new Error("MV2 清单里不该有 background.service_worker（那是 MV3 的）");
    }
    if (manifest.action !== undefined || manifest.host_permissions !== undefined) {
      throw new Error("MV2 清单里不该有 MV3 的 action / host_permissions");
    }
    if (typeof manifest.background?.persistent !== "boolean") {
      // 我们的「每标签页最近 URL」缓冲是内存里的，背景页被回收就等于丢了它。
      throw new Error("MV2 清单必须显式写 background.persistent（本扩展需要常驻背景页）");
    }
  }
}

/** 按 **UTF-8 字节**算，不用 `code.length`（那是 UTF-16 码元数，中文一个字符算 1，
 * 于是日志里的数字比 `dir` 小一大截，容易让人以为产物写缺了）。
 * 参数可以是字符串（自动量字节）或已经是字节数。 */
const kb = (size) => `${((typeof size === "number" ? size : Buffer.byteLength(size, "utf8")) / 1024).toFixed(1)} KB`;

/** 打一个档位（`profile` 见文件头的 PROFILES）。 */
async function main(profile) {
  const OUT = resolve(profile.dir, "dist");
  const manifest = JSON.parse(await readFile(profile.manifest, "utf8"));
  assertManifestProfile(manifest, profile);

  console.log(`── ${profile.label}（target ${profile.target}）`);
  console.log(`[1/4] 清空并重建 ${OUT} …`);
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  console.log(`[2/4] 打包 ${ENTRIES.length} 个入口（IIFE${MINIFY ? "" : "，不压缩"}）…`);
  const outputs = new Map();
  for (const entry of ENTRIES) {
    const name = entry.replace(/\.ts$/, "");
    const code = await bundle(entry, profile.target);
    if (code.length === 0) throw new Error(`${entry}: 打包结果为空`);
    assertParses(name, code);
    assertNoEval(name, code);
    outputs.set(name, code);
    console.log(`      ${name}.js  ${kb(code)}`);
  }

  console.log("[3/4] 内联 wasm 到 content.js，并拷清单 / HTML / 图标…");
  const wasmBase64 = (await readFile(profile.wasmFile)).toString("base64");
  const content = outputs.get("content");
  if (content === undefined) throw new Error("缺 content.js");
  // 这一句必须在 IIFE **之前**执行：`Resolver` 首次恢复时才读这个全局，
  // 但顺序上贴着放最保险（也让「扩展里到底有没有内联 wasm」一眼可见）。
  //
  // ⚠️ 字段名决定加载哪份 wasm：`variant.ts` 的 `candidateVariants()` 只认
  // 「声明了哪几个变体」。MV2 档必须**只**声明 mvp，否则老引擎会去编译含
  // bulk memory 的 modern 产物，直接 `CompileError`（恢复全废，且只在老机器上复现）。
  const other = profile.wasmField === "wasmBase64" ? "wasmMvpBase64" : "wasmBase64";
  const banner = `self.__RNG_SINGLEFILE__=${JSON.stringify({ [profile.wasmField]: wasmBase64 })};\n`;
  assertParses("content(banner)", banner);
  if (banner.includes(`"${other}"`)) {
    throw new Error(`content.js 的 wasm 声明里混进了 ${other}（本档只该有 ${profile.wasmField}）`);
  }
  outputs.set("content", banner + content);

  for (const [name, code] of outputs) {
    await writeFile(resolve(OUT, `${name}.js`), code, "utf8");
  }
  await cp(profile.manifest, resolve(OUT, "manifest.json"));
  for (const [from, to] of COPIES) {
    await cp(resolve(EXT_MODERN, from), resolve(OUT, to), { recursive: true });
  }

  console.log("[4/4] 校验…");
  const present = new Set([...outputs.keys()].map((name) => `${name}.js`));
  for (const [, to] of COPIES) {
    if (to === "icons") {
      for (const size of [16, 32, 48, 128]) present.add(`icons/icon${size}.png`);
    } else {
      present.add(to);
    }
  }
  present.add("manifest.json");
  assertManifestComplete(manifest, present);
  for (const [name, code] of outputs) {
    if (!code.includes("__RNG_SINGLEFILE__")) continue;
    console.log(`      ${name}.js 已内联 wasm（${profile.wasmField}，Base64 ${kb(wasmBase64)}）`);
  }

  // 四个 JS 合计：wasm 的 Base64 已经在 content.js 里了，所以**不要**再加一遍。
  const total = [...outputs.values()].reduce((sum, code) => sum + Buffer.byteLength(code, "utf8"), 0);
  console.log("");
  console.log(`  扩展名        ${manifest.name} v${manifest.version}（manifest_version ${manifest.manifest_version}）`);
  console.log(`  入口          ${ENTRIES.join(" / ")}`);
  console.log(`  ── 四个 JS 合计（含内联 wasm）  ${kb(total)}`);
  console.log("");
  console.log(`已写入：${OUT}`);
  console.log("下一步：Chrome/Edge 打开 chrome://extensions → 打开「开发者模式」→「加载已解压的扩展程序」→ 选上面这个 dist 目录。");
  if (profile.manifestVersion === 2) {
    console.log("⚠️ MV2 档只能在**支持 MV2 的旧浏览器**里装（Chrome 127+ 已彻底停用 MV2）。");
  }
}

/** 命令行选了哪几档（默认只打 MV3，与以前的行为一致）。 */
function selectedProfiles() {
  if (process.argv.includes("--all")) return [PROFILES.mv3, PROFILES.mv2];
  if (process.argv.includes("--mv2")) return [PROFILES.mv2];
  return [PROFILES.mv3];
}

async function run() {
  for (const profile of selectedProfiles()) await main(profile);
}

run().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
