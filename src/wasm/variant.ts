/**
 * wasm 产物的**变体选择**（兼容老浏览器的那一半）。
 *
 * 仓库里有**两份** wasm，同一份 C 源码，只差指令集：
 *
 * | 变体 | 文件 | 特点 | 最低引擎 |
 * | ---- | ---- | ---- | -------- |
 * | `modern` | `cracker.wasm` | emcc 原产物，含 bulk memory（`memory.copy`/`memory.fill`） | Chrome 75 / Firefox 79 / Safari 15 |
 * | `mvp` | `cracker.mvp.wasm` | `wasm-opt --llvm-memory-copy-fill-lowering` 之后的纯 MVP | Chrome 57（本项目实测 70 可用） |
 *
 * 两份是**行为等价**的（同一份源码、同一套参数，只把少数指令展开成循环），
 * `web/tests/wasm_variant.test.ts` 用同一批 golden 向量对拍钉住这一点。
 * ⚠️ 那批向量（`src_forge/tests/golden/`）只在**主仓库本地**存在，公开仓库 / CI 里没有
 * （理由见 `tests/helpers/golden.ts` 文件头）⇒ 该套件的「原语层 / spec 层 / 场景层」在 CI 上
 * 整组跳过，CI 里实际守住的是 **字节层 + ABI 层**（MVP 真的展开了 bulk memory、
 * 两份 `probeLayout()` 逐字段一致）。**逐值等价必须在主仓库本地跑全量 `npm test` 才算数。**
 *
 * ## 为什么是「先试后回退」而不是「先探测再选」
 *
 * 探测（手搭一个含 `memory.copy` 的极简模块丢给 `WebAssembly.validate`）看着更"干净"，
 * 但**失败方向必须也是 mvp**：探测说"支持"而实际编译失败，就会直接白屏；而
 * 「先试 modern、`CompileError` 了再试 mvp」的失败方向天然正确 —— 唯一代价是
 * 老引擎上多一次失败的编译（约 1 ms）+ 一次白下的 wasm。
 *
 * ## 谁在用
 *
 * 三个 realm 各有一份本模块实例，各自独立决策（结果必然一致，因为引擎相同）：
 * 主线程（`wasm/runtime.ts`）、搜索 Worker（`worker/search.worker.ts`）、
 * 单文件版的 Blob Worker。决策结果通过 :func:`setChosenVariant` 记忆，主线程还会把它
 * 顺着消息协议告诉 worker，省掉 worker 那一次注定失败的尝试。
 *
 * ⚠️ `?url` 在不同构建里形态不同，所以用它之前要过一遍 :func:`absolute`：
 *
 * * 普通构建（`vite.config.ts`）—— vite 把它变成 `new URL("assets/cracker-*.wasm", import.meta.url)`，
 *   运行时就是个 http 绝对 URL；dev 下是 `/src/wasm/cracker.wasm`；
 * * 单文件版 / 扩展（lib 或 IIFE）—— vite 直接内联成 `data:application/wasm;base64,…`，**原样用即可**。
 *
 * ⚠️ `node`（vitest 里跑真 wasm）拿到的是**根相对路径** `/src/wasm/cracker.wasm`，
 * emscripten 的 node 分支会拿它当文件路径读 ⇒ `ENOENT D:\src\wasm\…`。测试里一律显式给
 * `locateFile`（`tests/helpers/golden.ts` 的 `testRuntime`）。
 */

import { inlineWasmBinary, inlineWasmVariants } from "../singlefile";
import modernWasmUrl from "./cracker.wasm?url";
import mvpWasmUrl from "./cracker.mvp.wasm?url";

/** 变体名。`modern` 在前 = 优先尝试它。 */
export type WasmVariant = "modern" | "mvp";

/** 所有变体，顺序 = 尝试顺序。 */
export const WASM_VARIANTS: readonly WasmVariant[] = ["modern", "mvp"];

/** 变体名 → 打包器给的资源 URL（可能相对；用之前过一遍 :func:`absolute`）。 */
const RAW_URLS: Record<WasmVariant, string> = {
  modern: modernWasmUrl,
  mvp: mvpWasmUrl,
};

/** 变体名 → 给用户看的说明（状态栏 / 日志 / 错误信息里用）。 */
export const WASM_VARIANT_NOTES: Record<WasmVariant, string> = {
  modern: "modern（含 bulk memory）",
  mvp: "mvp（纯 MVP，兼容老引擎）",
};

/**
 * 把相对资源路径解成绝对 URL。
 *
 * ⚠️ **只在基址是 http(s) 时才解**，其它情况一律原样返回，因为两边的事实不一样：
 *
 * * `node`（vitest）—— `?url` 是**根相对路径**（`/src/wasm/cracker.wasm`），
 *   拿 `file:` 基址去 `new URL()` 会把 `D:\src\wasm\cracker.wasm` 这种凭空多一个盘符根的
 *   东西解出来（而且 node 那边本来也要靠显式 `locateFile` 才能读，见文件头）；
 * * 单文件版 / 扩展 —— 值已经是 `data:application/wasm;base64,…`（vite 内联的 `?url`），
 *   而 `import.meta.url` 在单文件版里是构建器换进去的内联哨兵值；再解一次只会把
 *   `data:` URI 弄坏。**这两个环境真的靠这个 `data:` URI 把 wasm 送进去**
 *   （胶水不读 `Module.wasmBinary`，见 `singlefile.ts` 文件头）。
 */
function absolute(raw: string): string {
  try {
    const base = new URL(import.meta.url);
    if (base.protocol !== "http:" && base.protocol !== "https:") return raw;
    return new URL(raw, base).href;
  } catch {
    return raw;
  }
}

/** 变体的 wasm 资源 URL（绝对形式）。 */
export function wasmUrlFor(variant: WasmVariant): string {
  return absolute(RAW_URLS[variant]);
}

/** 变体的内联二进制（非单文件版为 `null`）。 */
export function inlineBinaryFor(variant: WasmVariant): Uint8Array | null {
  return inlineWasmBinary(variant);
}

/**
 * 当前构建/环境里**实际可用**的变体，顺序 = 尝试顺序。
 *
 * * 单文件版（含扩展的内容脚本）：只算「真的内联了 Base64」的那些 —— 构建器按需注入，
 *   所以正常构建里这里恒为 ``["modern", "mvp"]``，而 MVP 单文件版里只剩 ``["mvp"]``；
 * * 普通构建：两份 `?url` 都打进了产物，两个都可用。
 */
export function candidateVariants(): WasmVariant[] {
  const inlined = inlineWasmVariants();
  if (inlined.length > 0) return inlined;
  return [...WASM_VARIANTS];
}

let chosen: WasmVariant | undefined;

/** 已经选定的变体（还没加载过 wasm 时为 `undefined`）。 */
export function chosenVariant(): WasmVariant | undefined {
  return chosen;
}

/**
 * 记忆选定的变体。只在「当前还没有结论」时生效。
 *
 * `fromPeer = true` 表示这个结论来自另一个 realm（主线程告诉 worker），此时**不覆盖**
 * 本地结论：本地已经加载成功的那个才作数，否则会把已实例化的模块再加载一份。
 */
export function setChosenVariant(variant: WasmVariant, fromPeer = false): void {
  if (fromPeer && chosen !== undefined) return;
  chosen = variant;
}

/** 变体是否合法（跨 realm 的消息可能带任意值过来）。 */
export function isWasmVariant(value: unknown): value is WasmVariant {
  return value === "modern" || value === "mvp";
}
