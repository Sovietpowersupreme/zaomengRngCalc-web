/**
 * ``src_forge/backends/wasm_backend.py`` 的「加载 + 运行时」部分（TS 版）。
 *
 * 一个 :class:`WasmRuntime` = 一个 wasm 实例 = 一套 ``Memory`` + ``Scratch``。
 * ⚠️ wasm 是**单线程、无重入保护**的：两个 Web Worker 不能共用同一个实例，
 * 每个 worker 要各自 ``createRuntime()``（这也正是分片提速的前提）。
 */

import { BackendUnavailable } from "../core/errors";
import initCracker, { type CrackerModule, type CrackerModuleOptions } from "./cracker.mjs";
import wasmUrl from "./cracker.wasm?url";
import { Memory, Scratch, probeLayout, type Layout } from "./layout";
import { WasmEngine } from "./engine";
import { WasmSearcher } from "./searcher";

/** 默认的 ``locateFile``：把 ``cracker.wasm`` 指到打包器给的资源 URL。 */
function defaultLocateFile(path: string): string {
  return path.endsWith(".wasm") ? wasmUrl : path;
}

export interface RuntimeOptions {
  /**
   * 覆盖 ``cracker.wasm`` 的位置。
   *
   * * 浏览器：不用给（vite 会把 ``?url`` 变成 http URL）；
   * * node / vitest：建议给 ``pathToFileURL(绝对路径).href`` —— emscripten 的
   *   node 分支对 ``file:`` URI 走 ``fs.readFileSync(new URL(...))``，最稳。
   */
  locateFile?: (path: string, scriptDirectory: string) => string;
  /** 直接喂二进制（给了就不走 ``locateFile``）。 */
  wasmBinary?: ArrayBuffer | Uint8Array;
  /** 静音 wasm 侧的 stdout/stderr 输出（默认 ``console.debug``）。 */
  quiet?: boolean;
}

let cached: Promise<CrackerModule> | undefined;

/** 加载（并缓存）wasm 模块实例。多次调用拿到同一个实例。 */
export function loadCracker(options: RuntimeOptions = {}): Promise<CrackerModule> {
  if (cached) return cached;
  const moduleOptions: CrackerModuleOptions = {
    locateFile: options.locateFile ?? ((path) => defaultLocateFile(path)),
  };
  if (options.wasmBinary) moduleOptions.wasmBinary = options.wasmBinary;
  if (options.quiet) {
    moduleOptions.print = () => undefined;
    moduleOptions.printErr = () => undefined;
  }
  cached = initCracker(moduleOptions).catch((err: unknown) => {
    cached = undefined; // 失败不要留下一个「永远 reject」的缓存
    throw new BackendUnavailable(
      `加载 cracker.wasm 失败（${options.locateFile ? "自定义 locateFile" : "默认 locateFile"}）: ${String(err)}`,
    );
  });
  return cached;
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
