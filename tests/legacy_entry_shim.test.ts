/**
 * 入口垫片（`web/index.html` 里 `<!--#legacy-shim:start#-->` 圈出来的那一段）的测试。
 *
 * 垫片干的活：老引擎（连现代档的语法都解析不了）打开现代档页面时，**立刻把话说明白**，
 * 能自己跳到 `./legacy/` 就跳。它跑在 `file://` 下、跑在没有任何构建工具帮忙的最老引擎里，
 * 所以必须**只写 ES5**、不依赖任何 polyfill、且任何情况下都不许把异常抛到页面上。
 *
 * 为什么要单独测它：它的失败方式是**静默**的 ——
 *
 * * 写了现代语法 ⇒ 老引擎解析失败，那段 `try/catch` 根本轮不到执行，白屏照旧（等于白写）；
 * * 拿**状态码**当「那边有旧版产物」的证据 ⇒ `npm run dev` 下 vite 的 SPA 兜底对任何路径都
 *   回 `200` + 同一份现代 `index.html`（连 `/nope.txt` 都是）⇒ 探测必然假阳性，老引擎被送到
 *   一个连解析都过不了的页面上（2026-10 真机踩到的就是这一条）；
 * * 判存在的**记号**写成一整串字面量 ⇒ 服务器把本页原样回给你时，回声里就带着记号 ⇒
 *   探测恒真。所以记号必须**拼**出来，且模板里任何地方都不许出现完整记号；
 * * 跳转前不确认那边存不存在 ⇒ 在 legacy 档自己的页面（`dist/legacy/index.html` 是同一份
 *   模板）上无限转圈；
 * * 站在 `rngcalc.legacy.html`（老引擎双击 `file://` 打开的那份）上还去跳 ⇒ 明明页面是好的，
 *   却被盖一句「这个浏览器版本太旧、也没能跳到旧版页面」。
 *
 * 两组判据：
 *
 * 1. **形状**：源码里不许出现现代语法关键词（先剥注释与字符串字面量，否则那句
 *    `new Function("… ??= … 1n")` 会把自己的探针判成违规）；恰好一个 `<script>` + 一个 `<style>`；
 *    记号必须是拼的、且与 `vite.config.ts` 里注入的那份逐字一致。
 * 2. **行为**：扔进 `node:vm` 里跑，桩出 `location` / `XMLHttpRequest` / `document`，
 *    验各种处境下的结论（现代引擎放行 / 老引擎 + 探测到真产物就跳 / 回声不跳 / 404 不跳 /
 *    网络报错不跳 / 站在 legacy 产物上什么都不做），外加一条「CSP 挡了 `new Function` 时
 *    不许误判成老引擎」。
 *    ⚠️ 「回声」那条的回声体就是**本页源码**：谁把记号写成了一整串，这条立刻红。
 *
 * ⚠️ 只有 `SyntaxError` 才算「引擎太老」：站点以后配了 CSP 会抛 `EvalError: unsafe-eval`，
 * 那时把现代浏览器赶去旧版页面的代价远大于「不跳」。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as vm from "node:vm";
import { describe, expect, it } from "vitest";

// --------------------------------------------------------------------------- 取源码

const INDEX_HTML = fileURLToPath(new URL("../index.html", import.meta.url));
const VITE_CONFIG = fileURLToPath(new URL("../vite.config.ts", import.meta.url));

/** 垫片在 `web/index.html` 里的两个标记，构建单文件产物时也是按它切的（见 `tools/build_singlefile.mjs`）。 */
const SHIM_START = "<!--#legacy-shim:start#-->";
const SHIM_END = "<!--#legacy-shim:end#-->";

/** 只取标记之间那一段（`web/tools/build_singlefile.mjs::legacyShimBlock` 取的也是这一段）。 */
function shimBlock(html: string): string {
  const from = html.indexOf(SHIM_START);
  const to = html.indexOf(SHIM_END);
  expect(from, `${INDEX_HTML} 里找不到 ${SHIM_START}`).toBeGreaterThanOrEqual(0);
  expect(to, `${INDEX_HTML} 里找不到 ${SHIM_END}`).toBeGreaterThan(from);
  return html.slice(from, to + SHIM_END.length);
}

const HTML_SOURCE = readFileSync(INDEX_HTML, "utf8");
const BLOCK = shimBlock(HTML_SOURCE);
const SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(BLOCK)?.[1] ?? "";

/**
 * 旧版产物上的记号（源头是 `vite.config.ts` 的 `LEGACY_INDEX_MARK`）与模板里的占位。
 *
 * ⚠️ 记号在垫片里必须是**拼**出来的：模板自己能当返回值取回来，回声里带着记号 = 探测恒真。
 * 所以下面那几条断言是**判据**，不是格式洁癖。
 */
const MARK = "data-legacy-build";
const SLOT = "%%legacy-index-marker%%";

/** 把 `"a" + "b"` 这种拼接合起来 —— 用来验「拼起来正好是记号」。 */
const joinStringLiterals = (source: string) => source.replace(/"\s*\+\s*"/g, "");

/**
 * 把注释与字符串字面量替换成空占位。
 *
 * ⚠️ 这一步是**必须**的：探针本身就是一句 `new Function("… o.a ??= 2 … 1n;")`，
 * 注释里也写满了 `??=` / `const` 这些词。不先剥掉，下面的 ES5 扫描只会一直红。
 * 剥法很粗暴（正则），它只服务于「别误报」这一个目的；漏判由 `node:vm` 那组行为测试兜底
 * —— 真写了现代语法，那个沙箱里跑的就是它自己。
 */
function stripLiterals(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

/** 垫片里一旦出现这些，就说明它已经不再是 ES5（老引擎会**解析失败**，连 `try/catch` 都轮不到）。 */
const MODERN_ONLY: [string, RegExp][] = [
  ["箭头函数", /=>/],
  ["模板串", /`/],
  ["const / let", /\b(?:const|let)\s/],
  ["可选链 / 空值合并", /\?\.|\?\?/],
  ["class", /\bclass\s/],
  ["展开语法", /\.\.\./],
  ["async / await", /\b(?:async|await)\b/],
];

// --------------------------------------------------------------------------- 1. 形状

describe("垫片源码形状", () => {
  it("整块恰好一个 <script> + 一个 <style>（构建器按这个不变量切它）", () => {
    expect(BLOCK.match(/<script\b/g) ?? []).toHaveLength(1);
    expect(BLOCK.match(/<style\b/g) ?? []).toHaveLength(1);
    expect(SCRIPT.length).toBeGreaterThan(200);
  });

  it("脚本正文里没有现代语法（它要在解析器最老的那一端跑）", () => {
    const code = stripLiterals(SCRIPT);
    for (const [label, pattern] of MODERN_ONLY) {
      expect(pattern.test(code), `垫片里出现了${label} ⇒ 老引擎解析不了它`).toBe(false);
    }
  });

  it("探针串挑的是现代档真的会用到的那几样语法", () => {
    // 探针太弱就会「老引擎也被当成现代的」：这几样必须都在串里。
    for (const token of ["??=", "?.", "class ", "static {}", "1n"]) {
      expect(SCRIPT, `探针串里缺少 ${token}`).toContain(token);
    }
  });

  it("只有 SyntaxError 才算「太老」（CSP 抛的 EvalError 不算）", () => {
    expect(SCRIPT).toContain("err instanceof SyntaxError");
    // 反例：写成 `catch (err) { tooOld = true }` 就会把 CSP/别的异常也算进去。
    expect(SCRIPT).not.toMatch(/tooOld\s*=\s*true/);
  });

  it("跳转前先看自己是不是已经站在某个 legacy 产物上", () => {
    expect(SCRIPT, "缺少路径守门 ⇒ 老引擎双击 rngcalc.legacy.html 会被盖一句假的「太旧」提示").toContain(
      'indexOf("legacy")',
    );
  });

  it("提示元素用的类名在 <style> 与脚本里一致", () => {
    expect(BLOCK).toContain(".engine-too-old-tip");
    expect(SCRIPT).toContain('"engine-too-old-tip"');
  });

  it("探测只认产物内容里的记号，不再拿状态码当存在性证据", () => {
    expect(SCRIPT, "探测地址得是 ./legacy/index.html（目录 URL 不是哪家都做 index 兜底）").toContain(
      '"./legacy/index.html"',
    );
    expect(SCRIPT, "不许再只发 HEAD 看状态码 —— dev 的 SPA 兜底对任何路径都回 200").not.toContain('"HEAD"');
    expect(SCRIPT).toContain("responseText");
  });

  it("记号是拼出来的，模板里不许出现完整记号", () => {
    expect(
      HTML_SOURCE,
      `${INDEX_HTML} 里出现了完整的 ${MARK}：dev 的 SPA 兜底回的就是本文件，回声里带着记号 ⇒ 探测恒真`,
    ).not.toContain(MARK);
    expect(SCRIPT).not.toContain(MARK);
    expect(joinStringLiterals(SCRIPT), "拼起来必须正好是那个记号").toContain(MARK);
  });

  it("记号占位与会注入它的那份配置对得上（两边必须逐字一致）", () => {
    // 占位丢了 ⇒ legacy 档没有记号 ⇒ 老引擎在生产上也不再跳转，而且一声不响。
    expect(HTML_SOURCE, `${INDEX_HTML} 里缺少 ${SLOT}（打包时按档换成记号的就是它）`).toContain(SLOT);
    const config = readFileSync(VITE_CONFIG, "utf8");
    expect(config, "vite.config.ts 里的记号与 index.html 这边对不上").toContain(`"${MARK}"`);
    expect(config).toContain(`"${SLOT}"`);
  });

  it("跳不过去时的提示给出单文件旧版的位置（那是最省事的一条路）", () => {
    expect(SCRIPT).toContain("rngcalc.legacy.html");
  });
});

// --------------------------------------------------------------------------- 2. 行为

/** 桩出来的处境。 */
interface ShimScenario {
  /** `location.pathname` —— 判据只看**紧挨着的那一级**。 */
  path: string;
  /** 引擎够不够新：`modern` 放行，`old` 走「太老」分支，`csp` 让 `new Function` 抛 `EvalError`。 */
  engine: "modern" | "old" | "csp";
  /**
   * 探测 `./legacy/index.html` 拿到什么：
   *
   * * `marked` —— 真旧版产物（响应里带着构建期记号）；
   * * `echo` —— 200，但服务器把**本页原样**回给你（`vite dev` 的 SPA 兜底就这么干）；
   * * `missing` —— 404；`error` —— 请求直接失败（`file://` 常见）。
   */
  legacy: "marked" | "echo" | "missing" | "error";
}

interface ShimResult {
  /** `location.replace` 收到的地址（跳转了才非空）。 */
  replaced: string[];
  /** 提示元素上的文字（`appendChild` 收到几条）。 */
  tips: string[];
  /** 探测请求的地址（没发就是空数组）。 */
  requested: string[];
}

/**
 * 在 `node:vm` 里跑一遍垫片。
 *
 * ⚠️ 替换 `Function` 时必须抛**属于这个 realm 的** `SyntaxError` / `EvalError` —— 从外面
 * 传一个 Error 进去，`instanceof` 认不出来（两个 realm 的构造函数不是一个对象），
 * 垫片就会得出相反的结论，而那正是它的核心判据。
 */
function runShim(scenario: ShimScenario): ShimResult {
  const replaced: string[] = [];
  const tips: string[] = [];
  const requested: string[] = [];

  class XhrStub {
    status = 0;
    responseText = "";
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    open(_method: string, url: string): void {
      requested.push(url);
    }
    send(): void {
      if (scenario.legacy === "error") {
        this.onerror?.();
        return;
      }
      if (scenario.legacy === "missing") {
        this.status = 404;
        this.responseText = "<html><body>404</body></html>";
      } else {
        this.status = 200;
        // `echo` 就是 `vite dev` 的兜底：把**本页源码**原样回给你。用真模板当回声体是有意的
        // —— 「记号被写成一整串」这种改法会在这里立刻现形。
        this.responseText = scenario.legacy === "echo" ? HTML_SOURCE : `<html><head>${MARK}</head></html>`;
      }
      this.onload?.();
    }
  }

  /**
   * 元素桩：`textContent` **读时才拼**（自己的文字 + 各子节点的文字），
   * 这样提示里那截链接文字也能被断言到。
   */
  class ElementStub {
    className = "";
    href = "";
    private own = "";
    private readonly kids: ElementStub[] = [];
    get textContent(): string {
      return this.own + this.kids.map((kid) => kid.textContent).join("");
    }
    set textContent(value: string) {
      this.own = value;
    }
    appendChild(child: ElementStub): void {
      this.kids.push(child);
    }
  }

  /** 垫片最后是 `body.appendChild(提示元素)`，这里把它的文字收下来。 */
  const sink = {
    appendChild: (node: ElementStub) => void tips.push(node.textContent),
  };

  const context = vm.createContext({
    location: { pathname: scenario.path, replace: (url: string) => void replaced.push(url) },
    document: {
      createElement: () => new ElementStub(),
      createTextNode: (text: string) => {
        const node = new ElementStub();
        node.textContent = text;
        return node;
      },
      body: sink,
      documentElement: sink,
    },
    XMLHttpRequest: XhrStub,
  } as Record<string, unknown>);

  if (scenario.engine !== "modern") {
    const kind = scenario.engine === "old" ? "SyntaxError" : "EvalError";
    vm.runInContext(`globalThis.Function = function () { throw new ${kind}("stub"); };`, context);
  }
  vm.runInContext(SCRIPT, context);
  return { replaced, tips, requested };
}

describe("垫片行为（node:vm 里跑真货）", () => {
  it("现代引擎：什么都不做（连探测请求都不发）", () => {
    const result = runShim({ path: "/", engine: "modern", legacy: "marked" });
    expect(result).toEqual({ replaced: [], tips: [], requested: [] });
  });

  it("老引擎 + 探测到真旧版产物（带着记号）：跳过去，不留提示", () => {
    const result = runShim({ path: "/", engine: "old", legacy: "marked" });
    expect(result.replaced).toEqual(["./legacy/"]);
    expect(result.tips).toEqual([]);
    expect(result.requested).toEqual(["./legacy/index.html"]);
  });

  it("老引擎 + 服务器把本页原样回给你（vite dev 的兜底）：不跳，写提示", () => {
    // ⚠️ 2026-10 真机踩到的那一条：dev 对 `/legacy/`、`/nope.txt` 一律回 200 + 同一份现代
    // index.html ⇒ 只看状态码必然假阳性，老引擎被送到一个连解析都过不了的页面上。
    const result = runShim({ path: "/", engine: "old", legacy: "echo" });
    expect(result.replaced).toEqual([]);
    expect(result.tips).toHaveLength(1);
    expect(result.tips[0]).toContain("旧");
  });

  it("老引擎 + 那份 index.html 是 404：不跳，原地写一句人话", () => {
    const result = runShim({ path: "/", engine: "old", legacy: "missing" });
    expect(result.replaced).toEqual([]);
    expect(result.tips).toHaveLength(1);
    expect(result.tips[0]).toContain("旧");
    expect(result.tips[0], "提示里要给出单文件旧版的位置").toContain("rngcalc.legacy.html");
  });

  it("老引擎 + 探测请求直接报错（file:// 常见）：同上，不许抛异常", () => {
    const result = runShim({ path: "/", engine: "old", legacy: "error" });
    expect(result.replaced).toEqual([]);
    expect(result.tips).toHaveLength(1);
  });

  it("CSP 挡了 new Function（EvalError）：当现代引擎处理，不跳也不提示", () => {
    const result = runShim({ path: "/", engine: "csp", legacy: "marked" });
    expect(result).toEqual({ replaced: [], tips: [], requested: [] });
  });

  it("已经站在 /legacy/ 上：放行（否则会 /legacy/legacy/legacy/… 转下去）", () => {
    const result = runShim({ path: "/legacy/", engine: "old", legacy: "marked" });
    expect(result).toEqual({ replaced: [], tips: [], requested: [] });
  });

  it("已经站在 /legacy/index.html（旧版目录里的文件）上：放行，不许盖假的提示", () => {
    // 有的托管方会把 `/legacy/` 301 到 `/legacy/index.html`，那时提示会盖在**本来好好的**
    // 旧版页面上。守门的第二条判据（任何一级目录名恰好是 legacy）就是为它准备的。
    const result = runShim({ path: "/legacy/index.html", engine: "old", legacy: "missing" });
    expect(result).toEqual({ replaced: [], tips: [], requested: [] });
  });

  it("已经站在 rngcalc.legacy.html 上（file:// 双击）：放行，不许盖假的「太旧」提示", () => {
    const result = runShim({ path: "/home/a/rngcalc.legacy.html", engine: "old", legacy: "missing" });
    expect(result).toEqual({ replaced: [], tips: [], requested: [] });
  });

  it("守门不误伤：放在 legacy-notes/ 里的现代档照常去探测", () => {
    // ⚠️ 桩对路径不敏感（拿 `marked` 就一定会「探测成功」），这里钉的是**守门别误伤**：
    // 目录名只有**恰好**等于 legacy 才算。现实中探测地址会落在 /legacy-notes/legacy/ 而 404 ——
    // 那是「那边没有旧版产物」的正确结论，不是这条用例管的事。
    const result = runShim({ path: "/legacy-notes/rngcalc.html", engine: "old", legacy: "marked" });
    expect(result.requested, "守门把 legacy-notes/ 当成旧版目录了").toEqual(["./legacy/index.html"]);
    expect(result.replaced).toEqual(["./legacy/"]);
  });
});
