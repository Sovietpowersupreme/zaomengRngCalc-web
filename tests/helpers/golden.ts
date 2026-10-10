/**
 * 测试用的路径与 golden 加载器。
 *
 * 设计取舍：**不复制** Python 侧的 golden JSON，而是直接读
 * ``src_forge/tests/golden/`` 里的那一份。理由：
 *
 * * 复制会漂移（改了 Python golden 忘了同步 web 副本，测试照样"绿"）；
 * * 「同一份文件」才是真正的对拍 —— 与 ``src_forge`` 的 golden 测试共享同一批字节。
 *
 * ## ⚠️ golden 只存在于**主仓库本地**，公开仓库里没有
 *
 * 公开仓库（GitHub Pages 那个）的仓库根就是 ``web/``，而 ``src_forge/`` 是它的**上一级**
 * （主仓库的私有目录，subtree 不会带过去）。于是 CI 里这里的相对路径会指到
 * ``<runner>/work/<repo>/src_forge/tests/golden/`` —— 目录不存在，读它必 ``ENOENT``。
 *
 * ⇒ **凡是读 golden 的套件，都得先问 :data:`GOLDEN_AVAILABLE`**，用
 * ``describe.skipIf(!GOLDEN_AVAILABLE)`` 把整组跳掉（与 ``legacy_gate.test.ts`` 里
 * 「产物不在就整组跳过」是同一个惯例）。目前读 golden 的共 4 个套件：
 *
 * | 套件 | 怎么处理 |
 * | --- | --- |
 * | ``wasm_engine`` / ``searcher`` / ``scenario_runs`` | 在 ``package.json`` 的 ``test:ci`` 里 ``--exclude`` 掉（整份依赖 golden） |
 * | ``wasm_variant`` | 只有 3 层依赖 golden ⇒ 那 3 层用 ``GOLDEN_AVAILABLE`` 守卫，字节层/ABI 层在 CI 里照跑 |
 *
 * ⚠️ ``testRuntime`` 被十来个套件引用，但那些只是借它加载 wasm、**不读** golden，无需守卫。
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRuntime, type RuntimeOptions, type WasmRuntime } from "../../src/wasm/runtime";
import type { WasmVariant } from "../../src/wasm/variant";

/** 仓库根目录（``web/tests/helpers/`` 往上三级）。 */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Python 侧 golden 目录。 */
export const GOLDEN_DIR = fileURLToPath(new URL("../../../src_forge/tests/golden/", import.meta.url));

/**
 * 当前环境下能不能读到 golden（= 我们是不是跑在主仓库本地）。
 *
 * 公开仓库 / CI 里 :data:`GOLDEN_DIR` 指向一个不存在的目录 ⇒ ``false``。
 * 读 golden 的套件一律 ``describe.skipIf(!GOLDEN_AVAILABLE)``（见文件头那张表）。
 */
export const GOLDEN_AVAILABLE = existsSync(GOLDEN_DIR);

/** 自带的 ``cracker.wasm`` 绝对路径（= modern 变体）。 */
export const WASM_FILE = fileURLToPath(new URL("../../src/wasm/cracker.wasm", import.meta.url));

/**
 * 两份 wasm 的绝对路径（键 = 变体名）。
 *
 * ``mvp`` 那份是 ``csrc/build_wasm.py`` 用 ``wasm-opt --llvm-memory-copy-fill-lowering``
 * 从 modern 那份展开出来的（除了 ``memory.copy``/``memory.fill`` 展开成循环，其余逐字节相同）。
 */
export const WASM_FILES: Record<WasmVariant, string> = {
  modern: WASM_FILE,
  mvp: fileURLToPath(new URL("../../src/wasm/cracker.mvp.wasm", import.meta.url)),
};

/** 读一个 golden JSON（UTF-8）。 */
export function loadGolden<T>(name: string): T {
  return JSON.parse(readFileSync(GOLDEN_DIR + name, "utf8")) as T;
}

/**
 * 造一个测试用的 wasm 运行时（**默认 modern**，走「调用方指定位置」那一支）。
 *
 * ⚠️ node 里**必须**自己给 ``locateFile``：打包器在 node 下把 ``?url`` 给成**根相对**路径
 * （``/src/wasm/cracker.wasm``），emscripten 的 node 分支会拿它当文件路径读
 * ⇒ ``ENOENT D:\src\wasm\cracker.wasm``。⚠️ 光给 ``wasmBinary`` **没用** ——
 * 当前这份 ``cracker.mjs`` 根本不读 ``Module.wasmBinary``（见 ``singlefile.ts`` 文件头）。
 */
export function testRuntime(options: RuntimeOptions = {}): Promise<WasmRuntime> {
  return createRuntime({
    quiet: true,
    locateFile: () => pathToFileURL(WASM_FILE).href,
    ...options,
  });
}

/**
 * 造一个**点名变体**的运行时（不回退，只加载那一份）。
 *
 * ``locateFile`` 是必需的：node 下打包器给的 ``?url`` 是根相对路径（``/src/wasm/…``），
 * emscripten 会拿它当文件路径读 ⇒ ``ENOENT D:\src\wasm\…``。
 * ``variant`` 与 ``locateFile`` 同时给是被支持的（见 ``runtime.ts::loadCracker`` ①）。
 */
export function variantRuntime(variant: WasmVariant): Promise<WasmRuntime> {
  return createRuntime({
    quiet: true,
    variant,
    locateFile: () => pathToFileURL(WASM_FILES[variant]).href,
  });
}

/** ``prng.json`` 的结构（只声明用到的部分）。 */
export interface PrngGolden {
  schema: number;
  meta: Record<string, unknown>;
  values: {
    seeds: number[];
    fast_next: number[];
    get_pre_seed: number[];
    pure_hash_seeds: number[];
    pure_hash: number[];
    static_random_generator: number[];
    static_random: number[];
    boss_type: number[];
    random_advance_value: number[];
    random_advance_next: number[];
    random_value: number[];
    random_next: number[];
    fast_next_k_seeds: number[];
    fast_next_k_ks: number[];
    fast_next_k: number[];
    seed_update_test_n: number[];
    seed_update_test: number[];
    seed_distance: [number, number, number, number][];
    recover_seeds: { in: number; out: number[] }[];
  };
}

/**
 * ``scenarios.json`` 的结构（``slice`` 498 例 + ``near`` 648 例，由 DLL 采样）。
 *
 * ``seeds`` 只存了**前若干个**命中，完整命中数在 ``more`` 里（缺省时等于 ``seeds.length``）——
 * 这是 Python 侧 ``_check_slice_case`` 的约定，别只看 ``seeds``。
 */
export interface SliceCase {
  id: string;
  /** 直接喂 :func:`specFromDict`。 */
  spec: Record<string, unknown>;
  lo: number;
  hi: number;
  seeds: number[];
  head: number;
  truncated: boolean;
  more?: number;
}

export interface NearCase {
  id: string;
  spec: Record<string, unknown>;
  seed: number;
  limit: number;
  seeds: number[];
  head: number;
  more?: number;
}

export interface ScenariosGolden {
  slice: SliceCase[];
  near: NearCase[];
  meta: Record<string, unknown>;
}

/** ``runs.json`` 里 ``notes`` 的一项（= Python ``Note.to_dict()``）。 */
export interface RunNoteDict {
  level: string;
  message: string;
  field: string;
}

/**
 * ``runs.json`` 里的一条端到端 run（= Python ``tools/make_scenario_runs.py`` 的一条用例）。
 *
 * 这是**场景层**（``Scenario.run()``）的跨语言契约。``fixtures/scenarios.json`` 只冻到
 * 「表单契约」、``scenarios.json`` 只冻到 spec 层，而「输入翻译 → ``consume`` /
 * ``need_consume`` / ``seed_after`` / ``preview`` / ``notes``」这一整条链路只在这里。
 *
 * ⚠️ golden 是用 **ctypes** 后端采的，TS 侧只有 **wasm** —— 所以它同时是
 * 「两个后端在场景层逐字段一致」的证明。
 */
export interface RunCase {
  id: string;
  scenario: string;
  /**
   * ``run()`` 的起点。与 ``inputs["start_seed"]`` 是**同一个东西**（该场景有
   * ``start_seed`` 字段时两者必然相等，生成器就是这么写的），所以别只改一个。
   */
  start_seed: number;
  /** ``input_schema().defaults()`` 之上的覆盖；**已经包含** ``start_seed``。 */
  inputs: Record<string, unknown>;
  /**
   * ``Outcome.to_dict()`` 的一个**子集**（= 生成器的 ``KEEP`` 常量）。
   *
   * ``backend`` / ``notes`` / ``extra`` 不在里面：``backend`` 两个后端必然不同
   * （采样是 ``ctypes``、重放是 ``wasm``），``notes`` 单列在 :attr:`RunCase.notes`，
   * ``extra`` 各场景自定义、跨语言未必对得上。
   */
  expect: Record<string, unknown>;
  /** ``Outcome.notes`` 的全量（重放时必须逐字段相等）。 */
  notes: RunNoteDict[];
}

export interface RunsGolden {
  meta: {
    schema_version: number;
    generator: string;
    forge_version: string;
    /** 采样用的后端名（``ctypes``）—— 与 TS 侧的 ``wasm`` **不同**，这是刻意的。 */
    backend: string;
    backend_detail: string;
    backend_sha256: string;
    /** 采样时 Python ``registry.registered_keys()``：10 项，**顺序 = UI 标签页顺序**。 */
    scenarios: string[];
    count: number;
  };
  runs: RunCase[];
}

/**
 * 读 ``src_forge/tests/golden/runs.json``。
 *
 * 文件缺失就直接抛（不像 Python 侧那样 ``skip``）：这份 golden 是**在仓库里**的，
 * 读不到只可能是路径写错了，让它响出来比安静地少跑一个套件好。
 */
export function loadRuns(): RunsGolden {
  return loadGolden<RunsGolden>("runs.json");
}
