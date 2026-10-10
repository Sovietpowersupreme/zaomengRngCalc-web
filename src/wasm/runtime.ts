/**
 * ``src_forge/backends/wasm_backend.py`` 的「加载 + 运行时」部分（TS 版）。
 *
 * 一个 :class:`WasmRuntime` = 一个 wasm 实例 = 一套 ``Memory`` + ``Scratch``。
 * ⚠️ wasm 是**单线程、无重入保护**的：两个 Web Worker 不能共用同一个实例，
 * 每个 worker 要各自 ``createRuntime()``（这也正是分片提速的前提）。
 */

import { BackendUnavailable } from "../core/errors";
import initCracker, { type CrackerModule, type CrackerModuleOptions } from "./cracker.mjs";
import { Memory, Scratch, probeLayout, type Layout } from "./layout";
import { WasmEngine } from "./engine";
import { WasmSearcher } from "./searcher";
import {
  candidateVariants,
  chosenVariant,
  inlineBinaryFor,
  setChosenVariant,
  wasmUrlFor,
  WASM_VARIANT_NOTES,
  type WasmVariant,
} from "./variant";

/** 默认的 ``locateFile``：把 ``cracker.wasm`` 指到当前变体的资源 URL。 */
function defaultLocateFile(variant: WasmVariant, path: string): string {
  return path.endsWith(".wasm") ? wasmUrlFor(variant) : path;
}

export interface RuntimeOptions {
  /**
   * 覆盖 ``cracker.wasm`` 的位置。
   *
   * * 浏览器：不用给（vite 会把 ``?url`` 变成 http URL）；
   * * node / vitest：建议给 ``pathToFileURL(绝对路径).href`` —— emscripten 的
   *   node 分支对 ``file:`` URI 走 ``fs.readFileSync(new URL(...))``，最稳。
   *
   * ⚠️ 给了它就**完全不参与变体选择**（连同 :attr:`wasmBinary`）：调用方既然自己
   * 指明了位置，就不该被回退逻辑改成去拿另一个文件。
   */
  locateFile?: (path: string, scriptDirectory: string) => string;
  /**
   * 直接喂二进制。
   *
   * ⚠️ 实测当前那份 ``cracker.mjs`` **不读** ``Module.wasmBinary``（见 ``singlefile.ts`` 文件头），
   * 所以它既不阻止 ``locateFile``、也不阻止读文件。保留只是为接口完整；要换位置请用
   * :attr:`locateFile`。同样不参与变体选择。
   */
  wasmBinary?: ArrayBuffer | Uint8Array;
  /**
   * 强制使用某个变体（**不做回退**，想回退就别给）。
   *
   * 两个用途：① 测试同时加载两份做对拍（见 `tests/wasm_variant.test.ts`）；
   * ② 诊断「到底是哪份编译不过」。
   *
   * 可以和 :attr:`locateFile` 一起给（node 下不给位置会 ENOENT），此时用给的那个位置。
   */
  variant?: WasmVariant;
  /** 静音 wasm 侧的 stdout/stderr 输出（默认 ``console.debug``）。 */
  quiet?: boolean;
}

/** 自定义位置（或自定义二进制）的单实例缓存。 */
let explicit: Promise<CrackerModule> | undefined;
/** 按变体缓存的实例（同一个变体不会重复实例化）。 */
const byVariant = new Map<WasmVariant, Promise<CrackerModule>>();
/** 自动选择过程的去重（并发调用只跑一轮）。 */
let auto: Promise<CrackerModule> | undefined;

/** 真正去实例化一个模块。失败时把缓存清掉（否则一条 rejected 的 promise 会永久毒住后续）。 */
function instantiate(
  key: WasmVariant | "explicit",
  binary: ArrayBuffer | Uint8Array | null,
  locateFile: (path: string, scriptDirectory: string) => string,
  quiet: boolean,
): Promise<CrackerModule> {
  const moduleOptions: CrackerModuleOptions = { locateFile };
  if (binary) moduleOptions.wasmBinary = binary;
  if (quiet) {
    moduleOptions.print = () => undefined;
    moduleOptions.printErr = () => undefined;
  }
  const promise = initCracker(moduleOptions).catch((err: unknown) => {
    if (key === "explicit") explicit = undefined;
    else byVariant.delete(key);
    throw err;
  });
  if (key === "explicit") explicit = promise;
  else byVariant.set(key, promise);
  return promise;
}

/** 加载指定变体（已加载过就直接给缓存的实例）。 */
function loadVariant(variant: WasmVariant, options: RuntimeOptions): Promise<CrackerModule> {
  const hit = byVariant.get(variant);
  if (hit) return hit;
  const locateFile =
    options.locateFile ?? ((path: string) => defaultLocateFile(variant, path));
  return instantiate(
    variant,
    inlineBinaryFor(variant),
    locateFile,
    options.quiet ?? false,
  );
}

/**
 * 自动选一个变体：按 :func:`candidateVariants` 的顺序逐个尝试，第一个能实例化的胜出。
 *
 * 失败方向天然安全：老引擎上 modern 会 `CompileError`，退到 mvp 即可；而新引擎第一次
 * 就成功，不会白白降级。
 */
async function decide(options: RuntimeOptions): Promise<CrackerModule> {
  const candidates = candidateVariants();
  const tried: string[] = [];
  for (const variant of candidates) {
    try {
      const module = await loadVariant(variant, options);
      setChosenVariant(variant);
      return module;
    } catch (err) {
      tried.push(`  ${WASM_VARIANT_NOTES[variant]}: ${String(err)}`);
    }
  }
  auto = undefined;
  byVariant.clear();
  throw new BackendUnavailable(
    `加载 cracker.wasm 失败（已试 ${tried.length} 个变体）：\n${tried.join("\n")}`,
  );
}

/** 加载（并缓存）wasm 模块实例。多次调用拿到同一个实例。 */
export function loadCracker(options: RuntimeOptions = {}): Promise<CrackerModule> {
  // ① 点名了变体：只加载它，**不回退**（对拍 / 诊断用；见 `tests/wasm_variant.test.ts`）。
  //    排在最前面是有原因的：它必须能和 `locateFile` 同时用（node 下不给位置就 ENOENT）。
  if (options.variant !== undefined) return loadVariant(options.variant, options);
  // ② 调用方自己指明了位置/二进制：不参与变体选择（node、vitest、扩展注入走这一支）。
  if (options.wasmBinary !== undefined || options.locateFile !== undefined) {
    if (explicit) return explicit;
    const locateFile = options.locateFile ?? ((path: string) => path);
    // 错误统一裹成 BackendUnavailable：调用方（`main.ts` / 扩展）按类型分流提示，
    // 不该因为「消息来自 emscripten 还是 fetch」而漏判。包在这里而不是 instantiate 里，
    // 是为了让变体回退路径能拿到原始错误（它只要知道"这条路不通"）。
    return instantiate("explicit", options.wasmBinary ?? null, locateFile, options.quiet ?? false)
      .catch((err: unknown) => {
        explicit = undefined;
        throw new BackendUnavailable(`加载 cracker.wasm 失败（调用方指定了位置）: ${String(err)}`);
      });
  }
  // ③ 已知胜者。
  const known = chosenVariant();
  if (known) return loadVariant(known, options);
  // ④ 首次：探测 + 记住结果。
  auto ??= decide(options);
  return auto;
}

/** 一次 wasm 运行时的全部句柄。 */
export class WasmRuntime {
  /** 后端名（日志 / golden 报告用）。 */
  readonly name = "wasm";
  readonly module: CrackerModule;
  readonly layout: Layout;
  readonly memory: Memory;
  readonly scratch: Scratch;
  readonly engine: WasmEngine;
  readonly searcher: WasmSearcher;

  constructor(module: CrackerModule) {
    this.module = module;
    this.layout = probeLayout(module);
    this.memory = new Memory(module);
    this.scratch = new Scratch(this.memory, this.layout);
    this.engine = new WasmEngine(this);
    this.searcher = new WasmSearcher(this);
  }

  /** 布局的「人话」摘要（``--list`` 之类的自检输出用）。 */
  describe(): string {
    const l = this.layout;
    return (
      `wasm: uRange(${l.urange.size}B, num@${l.urange.num}) ` +
      `fRange(${l.frange.size}B) seedArray(${l.seedArray.size}B, data@${l.seedArray.data}, ` +
      `len@${l.seedArray.len}, seed@${l.seedArray.seed}) ` +
      `max_input=${l.maxInput} cap=${l.seedCap} scratch=${l.scratchSize}B@${l.scratchBase}`
    );
  }
}

/** 加载 + 组装运行时（一个实例一套内存，worker 之间不要共用）。 */
export async function createRuntime(options: RuntimeOptions = {}): Promise<WasmRuntime> {
  const module = await loadCracker(options);
  return new WasmRuntime(module);
}
