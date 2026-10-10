/**
 * 旧档产物的**静态闸门**：只量已经构建出来的产物，不跑浏览器、不碰网络。
 *
 * 为什么非要它：兼容旧内核的失败方式**全是静默的** ——
 *
 * * Chromium 70 遇到 `?.` / `??` / class field 是**整段脚本解析失败**（白屏，控制台只有一行）；
 * * 遇到 `Object.fromEntries` 是运行到那一步才抛 `TypeError`（按钮点了没反应）；
 * * 遇到没有兜底的 `gap` 是排版挤在一起（截图才看得出来）；
 * * 少一份 polyfill（`globalThis` 是 Chrome 71 才有的，MV2 声明的最低版本是 70）就是内容脚本
 *   一进页面直接 `ReferenceError`，扩展**整窗静默失效**；
 * * 单文件档挑错 wasm 变体是装不上扩展的浏览器打不开页面。
 *
 * 上面每一条都不会在现代浏览器的自动化里露头 ⇒ 只能靠闸门钉住。分八组：
 *
 * | 组 | 判据 |
 * |----|------|
 * | 语法 | 把产物按 `es2017` 再过一遍，**字节必须不变**（Oxc 只降语法，见 `needsLowering`） |
 * | API | 现代运行时 API 的子串计数必须为 0（降级器降不出这些） |
 * | 兜底 | `globalThis` 的第一次出现必须是那句 `typeof globalThis` 守卫 |
 * | CSS | 不许有 `:is()/inset:/min()/max()/clamp()`，且 flex+gap 的兜底类必须还在 |
 * | flex 基准 | 滚动/弹性容器的 `flex-basis` 不许是内容尺寸（`flex:auto`）；固定横行必须显式 `flex-shrink:0` |
 * | 变体 | 单文件档与扩展档只许带**一份** wasm，且 sha256 对得上源码里的那一份 |
 * | 垫片 | 每个 HTML 产物都得带入口垫片；单文件档那份还得与 `web/index.html` 逐字一致；旧档 `index.html` 的 `<html>` 上得带入口记号（垫片靠它认产物） |
 * | 路径/清单 | 多文件档的资源一律 `./` 相对引用；扩展产物清单与源码清单逐字一致、且是 LF |
 * | worker | 不许向引擎索要 ESM worker（`{ type: "module" }`）；worker 块自己必须是 classic 能跑的。⚠️ 这说的是**产物**：dev 不打包 worker，反过来必须显式要 module（见第 8 组末条） |
 *
 * ⚠️ 产物是被 `.gitignore` 忽略的（`dist/`、`dist-local/`、以及 `extension` 下每个档的 `dist/`），
 * 「文件不在」一律整组跳过 —— 这道闸门量的是产物，不是源码；要它有意义就得先构建。
 * （⚠️ 这句注释里不能写 `extension` 加通配符再加 `/dist/` 那种写法 —— 里面的斜杠星号会提前
 * 把块注释关掉，整个文件就此变成语法错。踩过一次。）
 * （唯二**受版本控制**的产物是 `public/rngcalc.html` 与 `public/rngcalc.legacy.html`，
 * 所以下面那组「单文件档」在任何检出处都会真的跑，闸门不会被静默架空。）
 *
 * ⚠️ 判据里没有任何硬编码的字节数/文件名：产物改名、改大小都不该让闸门变红。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transformWithOxc } from "vite";
import { describe, expect, it } from "vitest";

// --------------------------------------------------------------------------- 定位产物

/** `web/` 的绝对路径。 */
const WEB = fileURLToPath(new URL("..", import.meta.url));

const MODERN_ASSETS = "dist/assets";
const LEGACY_ASSETS = "dist/legacy/assets";
const MV3_DIST = "extension/url-seed/dist";
const MV2_DIST = "extension/url-seed-mv2/dist";

const abs = (rel: string) => resolve(WEB, rel);
const has = (rel: string) => existsSync(abs(rel));
const read = (rel: string) => readFileSync(abs(rel), "utf8");

/** 某个产物目录下的文件（按扩展名筛，排好序）—— 判据里不写死文件名。 */
function assets(rel: string, ext: string): string[] {
  if (!has(rel)) return [];
  return readdirSync(abs(rel))
    .filter((name) => name.endsWith(ext))
    .sort()
    .map((name) => `${rel}/${name}`);
}

/** 旧档的 JS 产物（两个：页面主包 + 搜索 worker）。 */
const LEGACY_JS = assets(LEGACY_ASSETS, ".js");
/** 现代档的 JS 产物 —— 只用来当**反例**（它们本来就允许用新语法）。 */
const MODERN_JS = assets(MODERN_ASSETS, ".js");
const MV3_JS = assets(MV3_DIST, ".js");
const MV2_JS = assets(MV2_DIST, ".js");

// --------------------------------------------------------------------------- 1. 语法

/**
 * 把一个文件按 `es2017` 再过一遍，返回「还有东西需要降级吗」。
 *
 * 判据的来历：Oxc（Vite 8 / rolldown 用的降级器，构建时就是它）**只降语法**，而且只降真的
 * 出现的那种。所以同一份代码按 `esnext` 与按 `es2017` 各过一遍，输出**字节相同**就说明里面
 * 没有比 es2017 更新的语法。
 *
 * ⚠️ 反面判据（「按 es2017 过一遍后变了吗」）**不能用**：Oxc 对任何现代代码都会注入
 * `@oxc-project/runtime/helpers` 的 import，本来就干净的文件也会变（实测
 * 213076 → 314379 字符），恒真 ⇒ 等于没有判据。
 * ⚠️ 也不能拿 `indexOf("?.")` 当判据：压缩器会把 `x == null ? .1 : x` 压成 `x==null?.1:x`，
 * 两个旧档产物里恰好各有一处（实测）⇒ 一测一个假红，专门冤枉它要保护的文件。
 */
async function needsLowering(file: string): Promise<boolean> {
  const code = readFileSync(abs(file), "utf8");
  // target 必须与 `web/vite.config.ts` 里旧档的 `build.target` 同一个值，否则量的是别的标准。
  const [asIs, lowered] = await Promise.all([
    transformWithOxc(code, abs(file), { target: ["esnext"], lang: "js" }),
    transformWithOxc(code, abs(file), { target: ["es2017"], lang: "js" }),
  ]);
  return asIs.code !== lowered.code;
}

describe.skipIf(LEGACY_JS.length === 0)("旧档语法：es2017 往返后字节不变", () => {
  it.each(LEGACY_JS)("%s", async (file) => {
    expect(await needsLowering(file), `${basename(file)} 里有比 es2017 更新的语法`).toBe(false);
  });

  it("反例：现代档不是干净的（证明这道闸门真的在量东西）", async () => {
    const results = await Promise.all(MODERN_JS.map((f) => needsLowering(f)));
    expect(results.filter(Boolean).length, "现代档居然全都 es2017 干净？判据可能已经失效").toBeGreaterThan(0);
  });
});

describe.skipIf(MV2_JS.length === 0)("MV2 档语法：es2017 往返后字节不变", () => {
  it.each(MV2_JS)("%s", async (file) => {
    expect(await needsLowering(file), `${basename(file)} 里有比 es2017 更新的语法`).toBe(false);
  });

  it("反例：MV3 档不是干净的（两档共用一份源码，差别就在降级目标上）", async () => {
    const results = await Promise.all(MV3_JS.map((f) => needsLowering(f)));
    expect(results.filter(Boolean).length).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------------- 2. 运行时 API

/**
 * 降级器只降**语法**，这些是**运行时 API**：引擎里没有就是没有，降级降不出来。
 * 括号里是「多老的 Chrome 才有」——最低版本线是 Chromium 70。
 *
 * 用子串而不是 AST 解析：今天四棵产物树里实测**全是 0**，一旦有人写回来会立刻红，
 * 人工再看是不是误报（已知误报源：`.at(` 也会命中自己写的 `x.at(`）。
 */
const FORBIDDEN_API: [string, number][] = [
  ["Object.fromEntries", 73],
  ["Object.hasOwn", 93],
  ["structuredClone", 98],
  ["queueMicrotask", 71],
  ["crypto.randomUUID", 92],
  [".replaceAll(", 85],
  [".flatMap(", 69],
  [".at(", 92],
  [".allSettled(", 76],
  // ⚠️ 下面这几条是**踩过**才加的（2026-10-09）：`replaceChildren` 曾经把整份扩展 UI 干掉。
  // 它是 ``ParentNode.replaceChildren``（Chrome 86+），而扩展的 popup / 设置页 / 面板
  // 全是「先 clear 再渲染」⇒ 老内核上抛在第一步 = 界面全白，且 popup 与设置页是**唯一**
  // 能授权站点的地方，于是「UI 挂了」还会连坐成「一个随机数都抓不到」。
  // 注意：**不能**把 ``findLast`` / ``toSorted`` / ``toReversed`` 加进来 ——
  // ``@vue/reactivity`` 的 arrayInstrumentations 里就有这几个**方法定义**（不是调用），
  // 加进来会让网页旧档恒红。
  ["replaceChildren", 86],
  ["adoptedStyleSheets", 73],
  ["replaceSync", 73],
  ["requestSubmit", 77],
  ["Object.groupBy", 117],
  ["Array.fromAsync", 121],
];

describe.skipIf(LEGACY_JS.length === 0)("旧档禁用 API：一个都不许出现", () => {
  it.each(LEGACY_JS)("%s", (file) => {
    const code = readFileSync(abs(file), "utf8");
    for (const [token, version] of FORBIDDEN_API) {
      expect(code.split(token).length - 1, `${basename(file)} 里出现了 ${token}（Chrome ${version}+）`).toBe(0);
    }
  });
});

describe.skipIf(MV2_JS.length === 0)("MV2 档禁用 API：一个都不许出现", () => {
  it.each(MV2_JS)("%s", (file) => {
    const code = readFileSync(abs(file), "utf8");
    for (const [token, version] of FORBIDDEN_API) {
      expect(code.split(token).length - 1, `${basename(file)} 里出现了 ${token}（Chrome ${version}+）`).toBe(0);
    }
  });
});

// --------------------------------------------------------------------------- 3. globalThis 兜底

/**
 * `globalThis` 是 **Chrome 71** 才有的，而 MV2 档声明的 `minimum_chrome_version` 是 **70**；
 * 旧网页档的底线同样是 70。这个 bundle 里内联了 emscripten 的胶水，它**一求值就读**
 * `globalThis`（`!!globalThis.window` …）⇒ 必须由 `web/src/polyfills.ts` 把它先兜住。
 *
 * 判据取「第一个 `globalThis` 出现在哪」：它必须正好是那句 `typeof globalThis` 守卫里的
 * （守卫是 `typeof globalThis > "u" && (self.globalThis = self)`）⇒ 任何一次更早的裸读都会红。
 *
 * ⚠️ 只查旧档与 MV2 档：MV3/现代档声明的最低版本是 116，裸读 `globalThis` 完全没问题。
 */
const GUARDED_TREES = [...LEGACY_JS, ...MV2_JS];

describe.skipIf(GUARDED_TREES.length === 0)("globalThis：第一次出现必须是那句 typeof 守卫", () => {
  it.each(GUARDED_TREES)("%s", (file) => {
    const code = readFileSync(abs(file), "utf8");
    const first = code.indexOf("globalThis");
    if (first < 0) return; // 这个 bundle 根本没用到，跳过（不是失败）。
    const guard = code.indexOf("typeof globalThis");
    expect(guard, `${basename(file)} 裸读了 globalThis 却没有 polyfills.ts 兜底`).toBeGreaterThanOrEqual(0);
    expect(guard + "typeof ".length, `${basename(file)} 在守卫之前就读了 globalThis`).toBe(first);
  });

  it("至少有一个旧档产物真的在读 globalThis（否则上面这组等于空的）", () => {
    const readers = GUARDED_TREES.filter((file) => readFileSync(abs(file), "utf8").includes("globalThis"));
    expect(readers.length, "整个旧档一个 globalThis 都没有？那这组判据是空转的").toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------------- 4. CSS 兜底

/** 旧引擎里没有、必须绕开（或由 `web/src/compat/css.ts` 加类兜住）的东西。 */
const FORBIDDEN_CSS: [string, RegExp, number][] = [
  // `inset:`（87）必须拆成长写。⚠️ 只匹配**属性**（前面是 `;`、`{` 或开头），
  // `box-shadow: … inset` 里的同一个词不算 —— 换个宽松写法就会冤枉它。
  ["inset: 简写", /(?:^|[;{])\s*inset\s*:/, 87],
  // `min()` / `max()` / `clamp()`（79）。`\b` 天然排除 `minmax(`。
  ["min()/max()/clamp()", /\b(?:min|max|clamp)\(/, 79],
  [":is()/:where()/:has()", /:(?:is|where|has)\(/, 88],
];

/**
 * flex 基准泄漏闸门（2026-10-09 事故后的产物侧守卫）。
 *
 * 为什么单列一组：Chromium 70（LayoutNG 之前）的老 flex 算法把 `flex-basis:auto`
 * 解析成**内容尺寸**并向上传播 —— 详情页签一份 18000px 的 `<pre>` 就能把标题条/
 * 工具栏/标签行/底栏全部压成 2~15px 的细线，且 `min-height:0` 在那个内核不生效；
 * 现代引擎按可用空间分配 ⇒ 同一份 CSS 两边行为分裂，本机永远复现不了（同 worker 那组）。
 *
 * | 判据 | 出错时的现场 |
 * | ---- | ------------ |
 * | 产物里没有 `flex:auto` | minifier 把 `flex: 1 1 auto` 压成 `flex:auto` ⇒ 老内核拿内容尺寸当基准，横竖两个方向都可能挤压兄弟行（`src/ui/App.vue` 现在全部写 `flex: 1 1 0%`） |
 * | 每个 CSS 产物都有 ≥3 处 `flex-shrink:0` | 那是标题条/工具栏/标签行/底栏这几条固定横行的防压缩保险；少了说明有人重构掉了 —— 老内核上直接压碎 |
 *
 * ⚠️ 判据吃四份产物：dist 两档 CSS + 两个**受版本控制**的单文件档（同文件头那条注），
 * dist 不存在时闸门仍然真的会跑。
 * ⚠️ `flex:none`（= `0 0 auto`）**允许**：基准为 0 增长为 0，内容尺寸只是固定宽高，不参与分配、无泄漏。
 */
const FLEX_ARTIFACTS = [
  ...assets(MODERN_ASSETS, ".css"),
  ...assets(LEGACY_ASSETS, ".css"),
  "public/rngcalc.html",
  "public/rngcalc.legacy.html",
];

describe.skipIf(FLEX_ARTIFACTS.filter(has).length < 4)("flex 基准：滚动容器不许拿内容尺寸当基准", () => {
  it.each(FLEX_ARTIFACTS.filter(has))("%s 不含 flex:auto", (file) => {
    const css = read(file);
    expect(
      css.split("flex:auto").length - 1,
      `${basename(file)} 里还有 flex:auto ⇒ Chromium 70 会把内容尺寸当 flex-basis 向上泄漏，压碎固定横行`,
    ).toBe(0);
  });

  it.each(FLEX_ARTIFACTS.filter(has))("%s 的固定横行保险还在", (file) => {
    const css = read(file);
    expect(
      css.split("flex-shrink:0").length - 1,
      `${basename(file)} 里 flex-shrink:0 少于 3 处 ⇒ 固定横行的防压缩保险被重构掉了`,
    ).toBeGreaterThanOrEqual(3);
  });
});

describe.skipIf(!has(LEGACY_ASSETS) || assets(LEGACY_ASSETS, ".css").length === 0)("旧档 CSS：只留旧引擎认得的东西", () => {
  const legacyCss = assets(LEGACY_ASSETS, ".css");

  it.each(legacyCss)("%s 不含现代 CSS", (file) => {
    const css = readFileSync(abs(file), "utf8");
    for (const [label, pattern, version] of FORBIDDEN_CSS) {
      expect(pattern.test(css), `${basename(file)} 里还有 ${label}（Chrome ${version}+）`).toBe(false);
    }
  });

  it("flex + gap 的兜底类还在（排版全靠它）", () => {
    for (const file of legacyCss) {
      const css = readFileSync(abs(file), "utf8");
      expect(css, `${basename(file)} 里没有 no-flex-gap 兜底`).toContain("no-flex-gap");
      expect(css, `${basename(file)} 里没有 flex 布局？判据写错了`).toContain("display:flex");
    }
  });

  it("两档的 flex/gap 覆盖范围一致（不许只改一边）", () => {
    const modernCss = assets(MODERN_ASSETS, ".css");
    expect(modernCss.length, "现代档 CSS 不在，无法对照").toBeGreaterThan(0);
    const count = (file: string, token: string) => readFileSync(abs(file), "utf8").split(token).length - 1;
    for (const token of ["no-flex-gap", "gap:", "display:flex"]) {
      const legacyTotal = legacyCss.reduce((n, f) => n + count(f, token), 0);
      const modernTotal = modernCss.reduce((n, f) => n + count(f, token), 0);
      expect(legacyTotal, `\`${token}\` 在旧档出现 ${legacyTotal} 次、现代档 ${modernTotal} 次`).toBe(modernTotal);
    }
  });
});

describe.skipIf(MV2_JS.length === 0)("扩展档 CSS 兜底：类名与探针都在", () => {
  it.each(["content.js", "popup.js", "options.js"].map((f) => `${MV2_DIST}/${f}`).filter((f) => has(f)))(
    "%s",
    (file) => {
      const code = readFileSync(abs(file), "utf8");
      expect(code, `${basename(file)} 里没有 no-flex-gap`).toContain("no-flex-gap");
      // 兜底类是 `supportsFlexGap()` 判出来的 —— 探针字符串也必须在。
      expect(code, `${basename(file)} 里没有 gap 探针`).toMatch(/rowGap|columnGap/);
    },
  );
});

// --------------------------------------------------------------------------- 5. wasm 变体

/** 源码里的两份 wasm（由 `csrc/build_wasm.py` 生成并校验）。 */
const WASM_SRC = {
  modern: "src/wasm/cracker.wasm",
  mvp: "src/wasm/cracker.mvp.wasm",
} as const;

type WasmVariant = keyof typeof WASM_SRC;

/** Base64 内联的 wasm 在产物里叫什么字段（`src/wasm/runtime.ts` 按这个名字取）。 */
const WASM_FIELD: Record<WasmVariant, string> = { modern: "wasmBase64", mvp: "wasmMvpBase64" };

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

/** 源码 wasm 的 sha256：产物里内联的那份必须与它一致。 */
const WASM_SHA = (() => {
  const out = {} as Record<WasmVariant, string>;
  for (const variant of Object.keys(WASM_SRC) as WasmVariant[]) out[variant] = sha256(readFileSync(abs(WASM_SRC[variant])));
  return out;
})();

/** 从「`字段名: "base64"`」里把内联的 wasm 抠出来。 */
function inlineWasm(code: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const m of code.matchAll(/["']?(wasm[A-Za-z]*Base64)["']?\s*:\s*"([A-Za-z0-9+/=]+)"/g)) {
    found[m[1] as string] = m[2] as string;
  }
  return found;
}

/** 单文件档：路径 → 它该带哪份 wasm。 */
const SINGLEFILES: [string, WasmVariant][] = [
  ["public/rngcalc.html", "modern"],
  ["public/rngcalc.legacy.html", "mvp"],
  ["dist/rngcalc.html", "modern"],
  ["dist-local/rngcalc.legacy.html", "mvp"],
];

describe("单文件档：只带一份 wasm，且是对的那份", () => {
  it("现代档与 MVP 档不是同一份 wasm（否则这道闸门没有意义）", () => {
    expect(WASM_SHA.modern).not.toBe(WASM_SHA.mvp);
  });

  it.each(SINGLEFILES.filter(([file]) => has(file)))("%s", (file, variant) => {
    const fields = inlineWasm(read(abs(file)));
    expect(Object.keys(fields), `${file} 里内联的 wasm 字段不唯一`).toEqual([WASM_FIELD[variant]]);
    const buf = Buffer.from(fields[WASM_FIELD[variant]] as string, "base64");
    expect(sha256(buf), `${file} 里内联的是**另一份** wasm（旧引擎会装不上/解不开）`).toBe(WASM_SHA[variant]);
  });
});

describe.skipIf(!has(`${MV3_DIST}/content.js`) || !has(`${MV2_DIST}/content.js`))(
  "扩展档：内联的 wasm 也挑了对应变体",
  () => {
    it.each<[string, WasmVariant]>([
      [`${MV3_DIST}/content.js`, "modern"],
      [`${MV2_DIST}/content.js`, "mvp"],
    ])("%s", (file, variant) => {
      const fields = inlineWasm(read(file));
      expect(Object.keys(fields)).toEqual([WASM_FIELD[variant]]);
      const buf = Buffer.from(fields[WASM_FIELD[variant]] as string, "base64");
      expect(sha256(buf)).toBe(WASM_SHA[variant]);
    });
  },
);

// --------------------------------------------------------------------------- 6. 入口垫片

/** 垫片在 `web/index.html` 里的两个标记（`tools/build_singlefile.mjs` 也是按它切的）。 */
const SHIM_START = "<!--#legacy-shim:start#-->";
const SHIM_END = "<!--#legacy-shim:end#-->";

function shimBlock(html: string): string {
  const from = html.indexOf(SHIM_START);
  const to = html.indexOf(SHIM_END);
  if (from < 0 || to < from) return "";
  return html.slice(from, to + SHIM_END.length);
}

/**
 * 去掉行首缩进与空行后再比 —— 单文件档是**整块照抄**（含缩进），
 * 但 Vite 会把内联 `<style>` 压成一行，所以只能这样归一。
 */
const normalize = (block: string) =>
  block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n");

const SHIM_IN_SOURCE = normalize(shimBlock(read("index.html")));

/** 五个 HTML 产物：两个多文件档 + 三个单文件档。 */
const HTML_ARTIFACTS = [
  "dist/index.html",
  "dist/legacy/index.html",
  "dist/rngcalc.html",
  "dist-local/rngcalc.legacy.html",
  "public/rngcalc.legacy.html",
];

describe("入口垫片：老引擎打开现代档时要说人话", () => {
  it("垫片源块非空（构建器切的就是它）", () => {
    expect(SHIM_IN_SOURCE).toContain("engine-too-old-tip");
    expect(SHIM_IN_SOURCE).toContain('indexOf("legacy")');
  });

  it.each(HTML_ARTIFACTS.filter(has))("%s 带了垫片", (file) => {
    const html = read(file);
    expect(html.split(SHIM_START).length - 1, `${file} 里 ${SHIM_START} 不唯一`).toBe(1);
    expect(html.split(SHIM_END).length - 1, `${file} 里 ${SHIM_END} 不唯一`).toBe(1);
    const block = shimBlock(html);
    expect(block, `${file} 的垫片块是空的`).not.toBe("");
    // 类名得在**样式**与**脚本**里都对得上。⚠️ 别数次数：样式里多一条
    // `.engine-too-old-tip a { color: … }` 次数就变了（2026-10 踩过），要钉的是契约本身。
    expect(block, `${file} 的垫片里没有提示元素的样式`).toContain(".engine-too-old-tip");
    expect(block, `${file} 的垫片里没有提示元素的类名常量`).toContain('"engine-too-old-tip"');
    expect(block, `${file} 的垫片少了「已经站在 legacy 产物上」的守门`).toContain('indexOf("legacy")');
  });

  it.each(HTML_ARTIFACTS.filter(has).filter((f) => f.includes("rngcalc")))(
    "单文件档 %s 的垫片与 web/index.html 逐字一致",
    (file) => {
      // ⚠️ 多文件档不能这样比：Vite 会把垫片的**内联 `<style>` 压缩**（同一批声明、格式不同），
      // 那是它该干的活；单文件档走的是自己的构建器，整块照抄，这里钉的是「别哪天改了源块忘了拷」。
      expect(normalize(shimBlock(read(file))), `${file} 的垫片与 web/index.html 不一致`).toBe(SHIM_IN_SOURCE);
    },
  );

  it.skipIf(!has("dist/legacy/index.html"))("旧档 index.html 的 <html> 上带着入口记号", () => {
    // ⚠️ 跨文件契约的**产物侧**证据：`index.html` 的那个占位由 `vite.config.ts` 的插件按档换成
    // 记号，两处任一处漂了，老引擎在真机上就再也跳不过去（而且一声不响，就是白屏）。
    // 判据只看 `<html>` 标签上的属性，不看全文：垫片脚本里那串“拼”出来的字面量不在这里算数。
    expect(
      read("dist/legacy/index.html"),
      "旧档产物的 <html> 上没有记号 ⇒ 垫片会以为那边根本没有旧版产物",
    ).toMatch(/<html[^>]*data-legacy-build/);
  });

  it.skipIf(!has("dist/index.html"))("现代档 index.html 的 <html> 上没有记号，也不留占位", () => {
    const html = read("dist/index.html");
    expect(html).not.toMatch(/<html[^>]*data-legacy-build/);
    expect(html, "占位没被替换掉 ⇒ 会原样出现在线上页面里").not.toContain("%%legacy-index-marker%%");
  });
});

// --------------------------------------------------------------------------- 7. 相对路径与清单

describe.skipIf(!has("dist/index.html"))("相对路径：产物要能放在任意子目录/本地打开", () => {
  it.each(["dist/index.html", "dist/legacy/index.html"].filter(has))("%s 用 ./ 引用资源", (file) => {
    const html = read(file);
    expect(html, `${file} 的资源不是相对路径（部署到子目录就会 404）`).toMatch(/(?:src|href)="\.\//);
    expect(html, `${file} 里还有绝对路径的资源`).not.toMatch(/(?:src|href)="\/[^/]/);
  });
});

describe.skipIf(!has(`${MV2_DIST}/manifest.json`))("MV2 清单结构", () => {
  /** 清单在源码与产物里各一份（产物那份由 `tools/build_extension.mjs` 拷过去）。 */
  const manifest = () => JSON.parse(read(`${MV2_DIST}/manifest.json`)) as Record<string, unknown>;

  it("关键字段与 MV3 档正好错位", () => {
    const m = manifest();
    expect(m.manifest_version).toBe(2);
    expect(m.minimum_chrome_version).toBe("70");
    // MV2 用 background.scripts（常驻页），没有 action / content_scripts / host_permissions。
    expect(m.background).toEqual({ scripts: ["background.js"], persistent: true });
    expect(m).not.toHaveProperty("action");
    expect(m).not.toHaveProperty("content_scripts");
    expect(m).not.toHaveProperty("host_permissions");
    // 权限从 optional_host_permissions 挪回 optional_permissions。
    expect(m.optional_permissions).toContain("*://*/*");
    expect(m).not.toHaveProperty("optional_host_permissions");
  });

  it("产物清单与源码清单结构一致（防「改了源码忘了重构建」）", () => {
    const src = JSON.parse(read(`${MV2_DIST}/../src/manifest.json`)) as unknown;
    expect(manifest()).toEqual(src);
  });

  it("产物清单是 LF（CRLF 混进去会让 Chrome 认为清单损坏）", () => {
    expect(read(`${MV2_DIST}/manifest.json`)).not.toContain("\r");
  });
});

describe.skipIf(!has(`${MV3_DIST}/manifest.json`))("MV3 清单结构", () => {
  it("service worker + optional_host_permissions", () => {
    const m = JSON.parse(read(`${MV3_DIST}/manifest.json`)) as Record<string, unknown>;
    expect(m.manifest_version).toBe(3);
    expect(m.background).toEqual({ service_worker: "background.js" });
    expect(m.optional_host_permissions).toContain("*://*/*");
    expect(m).not.toHaveProperty("optional_permissions");
  });
});

// --------------------------------------------------------------------------- 8. worker 起法

/**
 * worker 必须按 **classic** 起（`worker.format: "iife"` + `new Worker(url, { name })`）。
 *
 * 为什么单列一组：这一条错了的**表象是「照常出结果」** —— `main.ts` 会把「池子建不起来」
 * 吞成一行日志、退回主线程串行（结果与并行**逐位一致**，只是慢），而现代浏览器上又完全正常。
 * 于是回归能一路潜伏，直到用户在旧内核上打开网页版才炸：2026-10-09 就是这样被报上来的
 * （兼容版**离线文件**能算，**网页版**报 `Failed to construct 'Worker': Module scripts are not
 * supported on DedicatedWorker yet … (see https://crbug.com/680046)`；事故内核实测 =
 * Chromium **`70.0.3499.0`**）。
 *
 * 两个判据对应「必须一起成立的两个前提」：
 *
 * | 判据 | 出错时的现场 |
 * | ---- | ------------ |
 * | 产物里没有 `type: "module"` | Chromium **70~79**（事故内核实测 `70.0.3499.0`）的 `WorkerOptions` 里**已经有** `type`（特性被 flag 关着）⇒ 构造走 `ModuleWorkersEnabled()` 的失败分支、**直接抛 TypeError**。早先注释里「老引擎的 WebIDL 字典会静默忽略未知成员」的假设在这一段版本上是**错的** |
 * | worker 块自己能当 classic 跑（无 `import.meta`/ESM 语法） | 模块语法在 classic 脚本里是**解析期**报错 ⇒ worker 一启动就崩，池子永远等不到 `ack` |
 *
 * ⚠️ 第三条判据在**源码**上（`src/worker/pool.ts` 的 `import.meta.env.DEV` 分支）：dev 与产物走的是
 * **两条路** —— 产物听 `worker.format`，dev 听源码里的 `type` 字面量（vite 在 dev 下不打包 worker）。
 * 所以「产物里没有」与「dev 里有」必须同时成立，缺前者炸老内核、缺后者炸 dev。详见下面那条用例。
 *
 * ⚠️ 判据要连**单文件档 HTML** 一起查：那两个是唯一**受版本控制**的产物（同文件头最后那条注），
 * 所以这组在任何检出处都真的会跑，不会被「dist 不存在」静默架空。
 * ⚠️ `type: "module"` 的值可能是引号也可能是反引号（压缩器会换），三种都得吃。
 * ⚠️ 不能把 HTML 里的 `<script type="module">` 算进去 —— 那个是 `=`、且是现代档页面必需的；
 * 正则要求**冒号**，天然不会误伤。
 */
const WORKER_REQUEST = /type\s*:\s*["'`]module["'`]/;
/** classic 脚本里跑不了的模块专有语法（动态 `import(` 是合法的，故不在列）。 */
const MODULE_ONLY_SYNTAX: [string, RegExp][] = [
  ["import.meta", /\bimport\s*\.\s*meta\b/],
  ["ESM export", /\bexport\s*\{/],
  ["静态 import", /\bimport\s*[{*"']/],
];

/** 会发起 `new Worker(...)` 的产物：四棵 JS 树 + 所有 HTML（单文件档把 worker 工厂内联在页里）。 */
const WORKER_CALLERS = [
  ...new Set([
    ...MODERN_JS,
    ...LEGACY_JS,
    ...MV3_JS,
    ...MV2_JS,
    ...HTML_ARTIFACTS,
    "public/rngcalc.html",
  ]),
];
/** worker 块自己（现代档的 `search.worker-*.js` 也在这条线上）。 */
const WORKER_CHUNKS = [...MODERN_JS, ...LEGACY_JS].filter((f) =>
  basename(f).startsWith("search.worker"),
);

describe("worker：只能按 classic 起（老内核上没有模块化 worker）", () => {
  it("反例：产物里真的找得到 worker 工厂（否则下面几条是空转的）", () => {
    const hit = WORKER_CALLERS.filter(has).filter((f) => read(f).includes("rngcalc-search-"));
    expect(hit.length, "连 worker 工厂的痕迹都没有：判据可能已经失效").toBeGreaterThan(0);
  });

  it.each(WORKER_CALLERS.filter(has))("%s 没有向引擎索要 ESM worker", (file) => {
    expect(
      read(file),
      `${file} 里出现了 { type: "module" } ⇒ Chromium 70~79 上 new Worker 会直接抛 TypeError`,
    ).not.toMatch(WORKER_REQUEST);
  });

  /**
   * 源码这一半：**dev 必须显式要 module worker**。
   *
   * 上面那组只量产物，而 dev 与产物的 worker 起法是**两条路**：
   *
   * * 产物：`worker.format: "iife"` 真的生效 ⇒ worker 块是 classic ⇒ `new Worker(url, { name })`；
   * * dev：vite **不打包** worker，那个文件是**未打包的原生 ESM**，而 `?worker_file&type=<type>`
   *   里的 `<type>` 是 `vite:worker-import-meta-url` 从**源码字面量**里读出来的
   *   （`getWorkerType` 只认字面量，`worker.format` 完全不参与）⇒ 不带 `type: "module"` 就是
   *   「classic 容器装 ESM 正文」，一启动 `SyntaxError: Cannot use import statement outside a module`。
   *
   * 这条回归**在产物侧永远量不到**，而它的表象又是「照常出结果」（`main.ts` 会把池子建不起来吞成
   * 一行日志、退回主线程串行，结果逐位一致，只是慢）⇒ 只能靠这条源码级断言钉住。
   */
  it("源码：dev 那一支显式要 module worker（否则 npm run dev 一启动就 SyntaxError）", () => {
    const src = read("src/worker/pool.ts");
    const at = src.indexOf("function browserWorkerFactory");
    expect(at, "pool.ts 里找不到 browserWorkerFactory：判据已失效").toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("\n}\n", at));
    // ⚠️ 只留**代码行**：`WORKER_REQUEST` 那串字面量在注释里出现过好几次（它就是本题讨论的东西），
    // 不滤掉注释的话「只应有一处」永远为假。块注释续行（`*`）与行注释（`//`）都要滤。
    const code = body
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    const devCheck = /if\s*\(\s*import\.meta\.env\.DEV\s*\)/;
    expect(
      code,
      'browserWorkerFactory 里找不到 `if (import.meta.env.DEV)` ⇒ dev 会用 classic 起一个未打包的 ESM worker（就是用户报的 SyntaxError）',
    ).toMatch(devCheck);
    // `type` 必须是**字面量**：`getWorkerType` 先 evalValue（我们对象里有 name 变量 ⇒ 必然抛）
    // 再走 AST 回退，非 Literal 直接报
    // `Expected worker options type property to be a literal value.`
    const hits = code.match(new RegExp(WORKER_REQUEST.source, "g")) ?? [];
    expect(
      hits.length,
      '代码里 `type: "module"` 必须**恰好一处**（dev 那一支）：少了 dev 崩，多了产物侧的闸门就要红',
    ).toBe(1);
    // 顺序：那一处必须在 DEV 分支之后（否则它落在 classic 那一支上，dev 照样崩）。
    expect(
      code.indexOf('type: "module"') > code.search(devCheck),
      "`type: \"module\"` 出现在 `import.meta.env.DEV` 之前 ⇒ 它挂在 classic 那一支上了",
    ).toBe(true);
    // 两个 `new Worker(` 都必须**紧跟** `new URL(`：`vite:worker-import-meta-url` 的正则要求两者紧邻，
    // 中间塞进注释/换行以外的东西 URL 就不会被改写（dev 与产物会一起坏，且坏得安静）。
    expect(
      code.match(
        /return\s+new\s+Worker\s*\(\s*new\s+URL\s*\(\s*"\.\/search\.worker\.ts"\s*,\s*import\.meta\.url\s*\)/g,
      )?.length,
      '这里的 `new Worker(new URL("./search.worker.ts", import.meta.url), …)` 不是两处字面量形态（vite 的正则要求构造函数与 `new URL(` 紧邻）',
    ).toBe(2);
  });

  it("反例：源码里的那一处确实会被产物判据逮住（证明「产物里没有」不是判据失效）", () => {
    // 源码**必须**命中 `WORKER_REQUEST`，产物**必须**不命中 —— 两个方向都活着，上面几条才有信息量。
    expect(read("src/worker/pool.ts")).toMatch(WORKER_REQUEST);
  });
});

describe.skipIf(WORKER_CHUNKS.length === 0)("worker 块自身：classic 脚本能直接跑", () => {
  it("反例：判据真的认得出模块语法（现代档主包里有 import.meta）", () => {
    // 现代档主包本来就允许 `import.meta`（它跑在 ESM 页面里），这里只拿它证明
    // `MODULE_ONLY_SYNTAX` 不是恒不命中的空判据。
    const flagged = MODERN_JS.filter((f) => MODULE_ONLY_SYNTAX.some(([, re]) => re.test(read(f))));
    expect(flagged.length, "模块语法判据没命中任何现代主包？判据可能已经失效").toBeGreaterThan(0);
  });

  it.each(WORKER_CHUNKS)("%s", (file) => {
    const bad = MODULE_ONLY_SYNTAX.filter(([, re]) => re.test(read(file))).map(([name]) => name);
    expect(bad, `${basename(file)} 里有 ${bad.join("/")} ⇒ 当 classic 脚本加载会解析失败`).toEqual(
      [],
    );
  });
});
