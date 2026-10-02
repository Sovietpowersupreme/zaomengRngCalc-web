/**
 * ``src_forge/core/engine.py`` 的 1:1 翻译：随机数基元。
 *
 * 只把 **3 个原语**直通 wasm（``fastNext`` / ``RandomPureHasher`` / ``getPreSeed``），
 * 其余派生量全部在本文件里「按 Python 的写法」拼出来 —— 这样「派生量的语义」只有
 * 一处定义，wasm / DLL / 纯 Python 三个后端不可能偷偷漂移（golden 会抓）。
 */

import { BackendUnavailable } from "../core/errors";
import { KMAX, i32, u32 } from "../core/values";
import type { WasmRuntime } from "./runtime";

/** ``getBossTypeUltraFast`` 的与掩码。 */
export const F_FN_MASK = 0x60000000;

/** ``FastNext`` 的 GF(2) 矩阵：第 ``i`` 列 = ``fastNext(1 << i)``。 */
const FASTNEXT_MATRIX: readonly number[] = fastNextColumns();
const IDENTITY_MATRIX: readonly number[] = Array.from({ length: 32 }, (_, i) => 1 << i);

function fastNextColumns(): number[] {
  const s = Array.from({ length: 32 }, (_, i) => 1 << i);
  for (let i = 0; i < 32; i += 1) {
    const v = s[i] as number;
    s[i] = (v & 1) !== 0 ? u32((v >>> 1) ^ 0x48000000) : v >>> 1;
  }
  return s;
}

/** 把一个 32×32 的 GF(2) 线性映射作用到 32 位向量上（对应 C 的 ``_crackerGf2Apply``）。 */
export function gf2Apply(matrix: readonly number[], vector: number): number {
  let result = 0;
  const s = u32(vector);
  for (let i = 0; i < 32; i += 1) {
    if (((s >>> i) & 1) !== 0) result ^= matrix[i] as number;
  }
  return result >>> 0;
}

/** 矩阵合成 ``outer ∘ inner``（先 inner 后 outer）。 */
export function gf2Compose(outer: readonly number[], inner: readonly number[]): number[] {
  return Array.from({ length: 32 }, (_, i) => gf2Apply(outer, inner[i] as number));
}

/**
 * 随机数基元：3 个直通 wasm 的原语 + 全部派生量。
 *
 * 数值约定（与 ``core/engine.py`` 完全一致）：
 * ``*_generator`` 返回 ``int32 & 0x7FFFFFFF``；``*_random`` 的除数是
 * ``KMAX + 1``（**不是** ``0x80000000``，虽然数学上相等，但保留写法以免被「优化」）。
 */
export class WasmEngine {
  readonly name = "wasm";

  constructor(private readonly rt: WasmRuntime) {}

  private get m() {
    return this.rt.module;
  }

  // ------------------------------------------------------------------ 原语
  /** 种子单步推进（C 的 ``fastNext``）。 */
  fastNext(seed: number): number {
    return u32(this.m._fastNext(u32(seed)));
  }

  /** ``RandomPureHasher``：返回 int32（**可能为负**，不要擅自 ``& KMAX``）。 */
  pureHash(iseed: number): number {
    return i32(this.m._RandomPureHasher(i32(iseed)));
  }

  /** ``fastNext`` 的一个逆（C 的 ``getPreSeed``）。 */
  getPreSeed(seed: number): number {
    return u32(this.m._getPreSeed(u32(seed)));
  }

  // ------------------------------------------------------------------ 派生
  /**
   * ``fastNext`` 迭代 ``k`` 次（O(log k) 的 GF(2) 矩阵快速幂）。
   *
   * 分片热身用它跳过前 ``uv_lo * step`` 个种子。
   */
  fastNextK(seed: number, k: number): number {
    if (k <= 0) return u32(seed);
    let base = FASTNEXT_MATRIX;
    let acc: readonly number[] = IDENTITY_MATRIX;
    let n = Math.trunc(k);
    while (n > 0) {
      if ((n & 1) !== 0) acc = gf2Compose(base, acc);
      base = gf2Compose(base, base);
      n >>>= 1;
    }
    return gf2Apply(acc, seed);
  }

  /** 不推进种子的随机数（C 的 ``staticRandomGenerator``）。 */
  staticRandomGenerator(seed: number): number {
    return this.pureHash(i32(u32(seed) * 71)) & KMAX;
  }

  /** ``[0, 1)`` 的浮点（C 的 ``staticRandom``）。 */
  staticRandom(seed: number): number {
    return this.staticRandomGenerator(seed) / (KMAX + 1);
  }

  /** 推进一次并返回 ``[值, 新种子]``（C 的 ``RandomGenerator``）。 */
  randomAdvance(seed: number): [number, number] {
    const newSeed = this.fastNext(seed);
    return [this.pureHash(i32(u32(newSeed) * 71)) & KMAX, newSeed];
  }

  /** 推进一次并返回 ``[浮点值, 新种子]``（C 的 ``random``）。 */
  randomValue(seed: number): [number, number] {
    const [value, newSeed] = this.randomAdvance(seed);
    return [value / (KMAX + 1), newSeed];
  }

  /**
   * ``getBossTypeUltraFast``：``RandomPureHasher(iseed * 71) & 0x60000000``。
   *
   * ⚠️ 这里**没有** ``& 0x7FFFFFFF``，所以 bit30/bit29 保留 —— 这正是它跟
   * :meth:`staticRandomGenerator` 的唯一区别。
   */
  bossType(seed: number): number {
    return this.pureHash(i32(u32(seed) * 71)) & F_FN_MASK;
  }

  /** 别名，语义同 :meth:`fastNextK`。 */
  advance(seed: number, k: number): number {
    return this.fastNextK(seed, k);
  }

  /**
   * 从 ``start`` 出发找 ``target``，最多走 ``end`` 步（直通 C 的 ``seedDistance``）。
   *
   * * ``end >= 0``：正向，返回所需步数（``1`` 表示一步到位）；
   * * ``end < 0``：反向，返回**负数**（``-1`` 表示反向一步）；
   * * 找不到返回 ``0``。
   *
   * ⚠️ ``end == 0`` 与 ``end == 1`` 都直接返回 0（C 的循环上界是开区间），
   * 想找 ``n`` 步以内要传 ``n + 1``。
   */
  seedDistance(start: number, target: number, end: number): number {
    return i32(this.m._seedDistance(u32(start), u32(target), Math.trunc(end)));
  }

  /** 反向推进 ``k`` 次（``*2`` 系列热身用）。 */
  getPreSeedN(seed: number, k: number): number {
    let s = u32(seed);
    for (let i = 0; i < k; i += 1) s = this.getPreSeed(s);
    return s;
  }

  // ------------------------------------------------------------------ 反查
  /**
   * 反查所有满足 ``staticRandomGenerator(seed) == randomInt`` 的种子。
   *
   * C 的 ``recover_seeds`` 用逐位反演，不依赖搜索，很快。``randomInt`` 只用到低 31 位。
   * ⚠️ 结果里的 ``re.seed`` **恒为 0**（C 端从不给它赋值），所以只看 ``data``。
   */
  recoverSeeds(randomInt: number): number[] {
    const { module, scratch } = this.rt;
    const mark = scratch.mark();
    try {
      const out = scratch.allocSeedArray();
      module._wc_recover_seeds(u32(randomInt) & KMAX, out);
      return scratch.readSeedArray(out).seeds;
    } finally {
      scratch.release(mark);
    }
  }

  /**
   * 暴力反查（通用兜底，只适合小窗口；``seedHi`` 不含）。
   *
   * 存在的意义是给 golden 一个「独立于 C 实现」的第二意见。
   */
  recoverSeedsScan(randomInt: number, seedLo = 0, seedHi = KMAX): number[] {
    const target = u32(randomInt) & KMAX;
    const out: number[] = [];
    for (let s = seedLo; s < seedHi; s += 1) {
      if (this.staticRandomGenerator(s) === target) out.push(s);
    }
    return out;
  }

  /** 后端自检；wasm 后端永远可用（拿不到实例时根本构造不出来）。 */
  selfCheck(): void {
    if (!this.m) throw new BackendUnavailable("wasm 模块未初始化");
  }
}
