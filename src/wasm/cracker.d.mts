/**
 * ``cracker.mjs`` / ``cracker.wasm`` 的类型声明。
 *
 * 这两份产物由 ``csrc/build_wasm.py``（emsdk）生成，**不要手改**；
 * 这里只描述 JS 侧真正会用到的那部分 ABI。
 *
 * ⚠️ 三条与「直觉」相反的事实（都是实测出来的，别按 README 的简写写代码）：
 *
 * 1. Emscripten 给**每个** JS 导出加了 ``_`` 前缀 —— ``M.wc_offsetof_urange_num``
 *    是 ``undefined``，正确的是 ``M._wc_offsetof_urange_num``。
 * 2. 反过来 ``ccall`` 要**不带下划线**的名字：``M.ccall("wc_max_input", ...)``
 *    能用，``M.ccall("_wc_max_input", ...)`` 会抛 ``func is not a function``。
 * 3. 本构建**没有导出 ``_malloc``/``_free``**；JS 侧的临时内存只能走
 *    ``_wc_scratch()`` 那块 64 KiB 静态区（bump 分配，用完即弃）。
 */

/** Emscripten 的 ``Module``：只声明本项目会用到的成员。 */
export interface CrackerModule {
  // ---------------------------------------------------------------- 堆视图
  /** ⚠️ 内存增长后必须重新取。注意本构建**没有**导出 ``HEAPU8``，需要字节视图时自己从 ``HEAPU32.buffer`` 派生。 */
  HEAPU32: Uint32Array;
  HEAP32: Int32Array;
  HEAPF64: Float64Array;

  /** ⚠️ ``ident`` 要**不带**下划线，例如 ``"wc_max_input"``。 */
  ccall(
    ident: string,
    returnType: "number" | "boolean" | "string" | null,
    argTypes: string[],
    args: readonly number[],
  ): number;

  cwrap(ident: string, returnType: string | null, argTypes: string[]): (...args: number[]) => number;

  // ---------------------------------------------------------------- 布局自描述
  _wc_max_input(): number;
  _wc_rand_pure_max(): number;
  _wc_seed_array_cap(): number;

  _wc_sizeof_urange(): number;
  _wc_offsetof_urange_min(): number;
  _wc_offsetof_urange_max(): number;
  _wc_offsetof_urange_num(): number;

  _wc_sizeof_frange(): number;
  _wc_offsetof_frange_min(): number;
  _wc_offsetof_frange_max(): number;
  _wc_offsetof_frange_num(): number;

  _wc_sizeof_seedarray(): number;
  _wc_offsetof_seedarray_data(): number;
  _wc_offsetof_seedarray_len(): number;
  _wc_offsetof_seedarray_seed(): number;

  // ---------------------------------------------------------------- 静态 scratch
  _wc_scratch(): number;
  _wc_scratch_size(): number;

  // ---------------------------------------------------------------- 标量原语
  _fastNext(x: number): number;
  _getPreSeed(x: number): number;
  _RandomPureHasher(x: number): number;
  _RandomGenerator(seedPtr: number): number;
  _staticRandom(seedPtr: number): number;
  _staticRandomGenerator(seed: number): number;
  _getBossTypeUltraFast(seed: number): number;
  _seedUpdateTest(seed: number, n: number): number;
  _seedDistance(start: number, target: number, end: number): number;
  /**
   * ⚠️ 参数顺序照抄 ``csrc/cracker.h``：``seedFindbyRange(uint32_t seed, uRange *range, int end, int step)``
   * —— ``range`` 是**指针**，而 ``crack`` / ``findEquip`` 那一族是**按值**传结构体。返回 ``uint32``
   * 且 **``0`` 同时表示「没找到」与「种子里真有 0」**（C 的既有约定）。
   */
  _seedFindbyRange(seed: number, rangePtr: number, end: number, step: number): number;
  /** 同 :meth:`_seedFindbyRange`，只是结构体换成 ``fRange``（浮点窗口）。 */
  _seedFindbyFloatRange(seed: number, rangePtr: number, end: number, step: number): number;
  _cracker_random(seedPtr: number): number;

  _wc_random(seedPtr: number): number;
  _wc_random_generator(seedPtr: number): number;
  _wc_recover_seeds(randomInt: number, outPtr: number): void;

  // ---------------------------------------------------------------- 分片（slice）
  _wc_crack_slice(uvLo: number, uvHi: number, rPtr: number, step: number, outPtr: number): void;
  _wc_crack2_slice(uvLo: number, uvHi: number, rPtr: number, step: number, outPtr: number): void;
  _wc_fastCrack_slice(
    uvLo: number,
    uvHi: number,
    rPtr: number,
    step: number,
    imask: number,
    outPtr: number,
  ): void;
  _wc_findFabao_slice(
    uvLo: number,
    uvHi: number,
    rPtr: number,
    targetWx: number,
    baguaGrowthPtr: number,
    outPtr: number,
  ): void;
  _wc_findEquip_slice(
    uvLo: number,
    uvHi: number,
    rPtr: number,
    rollNum: number,
    rollValsPtr: number,
    gemNum: number,
    gemValsPtr: number,
    gemIndexPtr: number,
    outPtr: number,
  ): void;
  _wc_findRechild_slice(
    uvLo: number,
    uvHi: number,
    rPtr: number,
    total: number,
    rollNum: number,
    rollValsPtr: number,
    outPtr: number,
  ): void;

  // ---------------------------------------------------------------- 全空间
  _wc_crack(rPtr: number, step: number, outPtr: number): void;
  _wc_crack2(rPtr: number, step: number, outPtr: number): void;
  _wc_fastCrack(rPtr: number, step: number, imask: number, outPtr: number): void;
  _wc_floatCrack(rPtr: number, step: number, outPtr: number): void;
  _wc_floatCrack2(rPtr: number, step: number, outPtr: number): void;
  _wc_findFabao(
    rPtr: number,
    targetWx: number,
    baguaGrowthPtr: number,
    outPtr: number,
  ): void;
  _wc_findEquip(
    rPtr: number,
    rollNum: number,
    rollValsPtr: number,
    gemNum: number,
    gemValsPtr: number,
    gemIndexPtr: number,
    outPtr: number,
  ): void;
  _wc_findRechild(
    rPtr: number,
    total: number,
    rollNum: number,
    rollValsPtr: number,
    outPtr: number,
  ): void;

  // ---------------------------------------------------------------- 局部（带起点种子）
  _wc_findFabao2(
    seed: number,
    rPtr: number,
    targetWx: number,
    baguaGrowthPtr: number,
    maxSearch: number,
    outPtr: number,
  ): void;
  _wc_findEquip2(
    seed: number,
    rPtr: number,
    rollNum: number,
    rollValsPtr: number,
    gemNum: number,
    gemValsPtr: number,
    gemIndexPtr: number,
    maxSearch: number,
    outPtr: number,
  ): void;
  _wc_findRechild2(
    seed: number,
    rPtr: number,
    total: number,
    rollNum: number,
    rollValsPtr: number,
    maxSearch: number,
    outPtr: number,
  ): void;
}

/** 实例化参数：只需 ``locateFile``（把 ``cracker.wasm`` 指到 vite 给出的资源 URL）。 */
export interface CrackerModuleOptions {
  locateFile?(path: string, scriptDirectory: string): string;
  print?(text: string): void;
  printErr?(text: string): void;
  wasmBinary?: ArrayBuffer | Uint8Array;
}

/** 单例工厂（``cracker.mjs`` 的 default export 是个 async 函数）。 */
export default function initCracker(options?: CrackerModuleOptions): Promise<CrackerModule>;
