/**
 * 测试用的路径与 golden 加载器。
 *
 * 设计取舍：**不复制** Python 侧的 golden JSON，而是直接读
 * ``src_forge/tests/golden/`` 里的那一份。理由：
 *
 * * 复制会漂移（改了 Python golden 忘了同步 web 副本，测试照样"绿"）；
 * * 「同一份文件」才是真正的对拍 —— 与 ``src_forge`` 的 golden 测试共享同一批字节。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRuntime, type RuntimeOptions, type WasmRuntime } from "../../src/wasm/runtime";

/** 仓库根目录（``web/tests/helpers/`` 往上三级）。 */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Python 侧 golden 目录。 */
export const GOLDEN_DIR = fileURLToPath(new URL("../../../src_forge/tests/golden/", import.meta.url));

/** 自带的 ``cracker.wasm`` 绝对路径。 */
export const WASM_FILE = fileURLToPath(new URL("../../src/wasm/cracker.wasm", import.meta.url));

/** 读一个 golden JSON（UTF-8）。 */
export function loadGolden<T>(name: string): T {
  return JSON.parse(readFileSync(GOLDEN_DIR + name, "utf8")) as T;
}

/**
 * 造一个测试用的 wasm 运行时。
 *
 * ⚠️ node 里**必须**自己给 ``locateFile``：vite 的 ``?url`` 在 SSR/node 模式下
 * 给的是文件系统路径，emscripten 的 node 分支只对 ``file:`` URI 才去 ``fs`` 读；
 * 转成 ``pathToFileURL`` 最稳。
 */
export function testRuntime(options: RuntimeOptions = {}): Promise<WasmRuntime> {
  return createRuntime({
    quiet: true,
    locateFile: () => pathToFileURL(WASM_FILE).href,
    ...options,
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
