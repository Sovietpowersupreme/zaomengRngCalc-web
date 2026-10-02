/**
 * ``src_forge/backends/wasm_backend.py::WasmSearcher`` 的 1:1 翻译。
 *
 * 分派规则完全照抄 Python 那份 ``match``（改不了，因为是 C 导出的函数表决定的）：
 *
 * | spec                        | ``searchSlice``        | ``searchNear``            |
 * | --------------------------- | ---------------------- | ------------------------- |
 * | ``IntervalSpec(crack)``     | ``wc_crack_slice``     | ``seedFindbyRange``       |
 * | ``IntervalSpec(crack2)``    | ``wc_crack2_slice``    | ✗（链式语义对不上）      |
 * | ``MaskSpec``                | ``wc_fastCrack_slice`` | ✗（等值判定没有局部版）  |
 * | ``RollSpec``                | ``wc_findEquip_slice`` | ``wc_findEquip2``         |
 * | ``WuxingSpec``              | ``wc_findFabao_slice`` | ``wc_findFabao2``         |
 * | ``PoolSpec``                | ``wc_findRechild_slice`` | ``wc_findRechild2``     |
 * | ``GrowthWuxingSpec``        | ✗（不可枚举）          | ✗（由场景自己前扫）      |
 *
 * 指针参数一律走 :class:`Scratch`（本构建没有 ``_malloc``）：先 ``mark()``，
 * 在 ``try/finally`` 里 ``release(mark)``，否则 64 KiB 的静态区几次搜索就见底了。
 *
 * ⚠️ ``seedFindbyRange`` 返回 ``uint32`` 而不是 ``seedArray``，且 **0 既表示「没找到」
 * 也是合法种子**（C 的既有约定，别再想把它「修好」）。``WasmSearcher`` 只保留了后者
 * 的语义：``0`` 当没找到，和 Python 侧逐位一致。
 */

import { BackendUnavailable } from "../core/errors";
import {
  clampBounds,
  emptySeedSet,
  mergeResults,
  seedSet,
  SearchResult,
  SeedSearcher,
  type SearchContext,
  type SeedSet,
} from "../core/search";
import { requireUnitStep, type SeedSpec } from "../core/spec";
import { IntervalSpec, MaskSpec, PoolSpec, RollSpec, WuxingSpec } from "../core/spec";
import { u32 } from "../core/values";
import type { WasmRuntime } from "./runtime";

/** ``_seedFindbyRange`` 的返回哨兵（C 里「没找到」与「种子里真有 0」共用这个值）。 */
const NO_SEED = 0;

export class WasmSearcher extends SeedSearcher {
  override readonly name = "wasm";

  constructor(private readonly rt: WasmRuntime) {
    super(rt.engine);
  }

  private get m() {
    return this.rt.module;
  }

  // ------------------------------------------------------------------ 能力
  override supports(spec: SeedSpec): boolean {
    return (
      spec instanceof IntervalSpec ||
      spec instanceof MaskSpec ||
      spec instanceof RollSpec ||
      spec instanceof WuxingSpec ||
      spec instanceof PoolSpec
    );
  }

  override supportsNear(spec: SeedSpec): boolean {
    // ``MaskSpec`` 的 fastCrack 是「掩码等值」判定，C 里没有对应的局部版本；
    // ``IntervalSpec`` 只有 ``crack`` 有 ``seedFindbyRange``（``crack2`` 的链式语义对不上）。
    if (spec instanceof MaskSpec) return false;
    if (spec instanceof IntervalSpec) return spec.scanner === "crack";
    return spec instanceof RollSpec || spec instanceof WuxingSpec || spec instanceof PoolSpec;
  }

  /**
   * ``*2`` 家族的三个 spec 可以按链切块并行；``IntervalSpec`` **不行**。
   *
   * ``seedFindbyRange`` 虽然也是沿链前扫，但它的语义里有 ``step`` 预退和「命中后回退
   * ``step - 1``」，C 侧没有 ``*_ord_mp`` 版本、也没有在 Web 侧验证过，所以这里保守地
   * 返回 ``false`` —— 与桌面端「哪些 spec 会并行」保持同一张名单。
   */
  override supportsNearParallel(spec: SeedSpec): boolean {
    return spec instanceof RollSpec || spec instanceof WuxingSpec || spec instanceof PoolSpec;
  }

  /**
   * 分块串行跑一遍（**参考实现 / 兜底**）。
   *
   * 真正的提速在 ``worker/pool.ts``（每块一个 worker）；这一支存在的意义有三个：
   *
   * 1. 把「按 ``fastNextK`` 跳步切链」这套语义在**同步层**定义清楚，池子照着抄；
   * 2. 作为池子的对拍基准 —— 分块串行的结果必须与一次扫完逐位相同；
   * 3. 没有 worker 就退到它（单线程，等价但慢）。
   *
   * ⚠️ ``chunks`` 是 ``[offset, len]``，起点 **由本方法算**（池子那边是调用方先算好再发出去，
   * 因为 worker 拿不到主线程的 seed）。跳步用 :meth:`WasmEngine.fastNextK`
   * —— 纯 JS 的 GF(2) 快速幂，已被 ``wasm_engine.test.ts`` 拿 golden 锁住，
   * 所以这里**不需要**为了跳步再导出一个 wasm 函数。
   */
  override searchNearShards(
    seed: number,
    spec: SeedSpec,
    chunks: Iterable<readonly number[]>,
    ctx: SearchContext,
  ): SeedSet {
    const start = u32(seed);
    const parts: SearchResult[] = [];
    let total = 0;
    for (const c of chunks) {
      const offset = Math.trunc(c[0] ?? 0);
      const len = Math.trunc(c[1] ?? 0);
      if (len <= 0) continue;
      ctx.checkCancel();
      total += len;
      const found = this.searchNear(this.rt.engine.fastNextK(start, offset), spec, len);
      parts.push(
        new SearchResult({
          seeds: found.seeds,
          head: found.head,
          truncated: found.truncated,
          // ⚠️ 原样透传（``*2`` 家族本来就是 ``null``）。不要在这里写 ``len``：
          // 一次扫完的结果里 ``consumed`` 是 ``null``，分块后写得有值就不一致了。
          consumed: found.consumed,
          backend: this.name,
          specKind: spec.kind,
        }),
      );
      ctx.report(total, total, `${spec.kind} 局部分块`, "chunk");
    }
    if (parts.length === 0) return emptySeedSet();
    // 各块在链上互不重叠，所以这里的「按块序拼接」就是「按离起点的远近拼接」。
    const merged = mergeResults(parts);
    // ``consumed`` 取归并值（全 ``null`` 累加还是 ``null``），**不要**填 ``total``：
    // 一次扫完的 ``searchNear`` 给的是 ``null``，填了数字两边就不一致了。
    return seedSet(merged.seeds, merged.head, merged.truncated, merged.consumed);
  }

  // ------------------------------------------------------------------ 分片枚举
  override searchSlice(spec: SeedSpec, uvLo: number, uvHi: number): SeedSet {
    // ⚠️ 必须夹一次（Python 侧同样先 ``clamp_bounds``）：``uv_hi`` 传 ``0xFFFFFFFF``
    // 时要落到 ``KMAX``，全空间左闭右开，``uv = 0x7FFFFFFF`` 本身扫不到。
    const [lo, hi] = clampBounds([uvLo, uvHi]);
    if (hi <= lo) return emptySeedSet();
    const scratch = this.rt.scratch;
    const mark = scratch.mark();
    try {
      // ``uRange`` 先写（后面 append 的数组指针都在它之后，互不干扰）。
      const range = scratch.allocURange();
      scratch.writeURange(range, spec.u32Bounds, spec.num);
      const out = scratch.allocSeedArray();

      if (spec instanceof MaskSpec) {
        this.m._wc_fastCrack_slice(lo, hi, range, spec.step | 0, u32(spec.imask), out);
      } else if (spec instanceof IntervalSpec) {
        if (spec.scanner === "crack2") this.m._wc_crack2_slice(lo, hi, range, spec.step | 0, out);
        else this.m._wc_crack_slice(lo, hi, range, spec.step | 0, out);
      } else if (spec instanceof RollSpec) {
        requireUnitStep(spec);
        this.m._wc_findEquip_slice(
          lo,
          hi,
          range,
          spec.rollNum,
          this.u32Array(spec.rollVals),
          spec.gemNum,
          this.u32Array(spec.gemVals),
          this.i32Array(spec.gemIndex),
          out,
        );
      } else if (spec instanceof WuxingSpec) {
        requireUnitStep(spec);
        this.m._wc_findFabao_slice(
          lo,
          hi,
          range,
          u32(spec.targetWx),
          this.u32Array(spec.baguaGrowth),
          out,
        );
      } else if (spec instanceof PoolSpec) {
        requireUnitStep(spec);
        this.m._wc_findRechild_slice(
          lo,
          hi,
          range,
          u32(spec.total),
          spec.rollNum,
          this.u32Array(spec.rollVals),
          out,
        );
      } else {
        throw new BackendUnavailable(`wasm 后端不支持 ${spec.kind} 规格`);
      }

      const got = scratch.readSeedArray(out);
      return seedSet(got.seeds, got.head, got.truncated, hi - lo);
    } finally {
      // 异常路径也要归还 —— 否则一次失败就永久漏掉一块 scratch。
      scratch.release(mark);
    }
  }

  // ------------------------------------------------------------------ 局部搜索
  override searchNear(seed: number, spec: SeedSpec, limit: number): SeedSet {
    const start = u32(seed);
    if (spec instanceof IntervalSpec) {
      if (spec.scanner !== "crack") {
        throw new BackendUnavailable(
          "seedFindbyRange 走的是 crack 的链式语义，不支持 crack2 规格",
        );
      }
      const scratch = this.rt.scratch;
      const mark = scratch.mark();
      try {
        const range = scratch.allocURange();
        scratch.writeURange(range, spec.u32Bounds, spec.num);
        const found = u32(this.m._seedFindbyRange(start, range, limit | 0, spec.step | 0));
        if (found === NO_SEED) return emptySeedSet();
        return seedSet([found], found, false, null);
      } finally {
        scratch.release(mark);
      }
    }

    if (spec instanceof MaskSpec) {
      throw new BackendUnavailable("fastCrack 判定是等值比较，C 里没有对应的局部搜索");
    }

    const scratch = this.rt.scratch;
    const mark = scratch.mark();
    try {
      const range = scratch.allocURange();
      scratch.writeURange(range, spec.u32Bounds, spec.num);
      const out = scratch.allocSeedArray();
      if (spec instanceof RollSpec) {
        requireUnitStep(spec);
        this.m._wc_findEquip2(
          start,
          range,
          spec.rollNum,
          this.u32Array(spec.rollVals),
          spec.gemNum,
          this.u32Array(spec.gemVals),
          this.i32Array(spec.gemIndex),
          u32(limit),
          out,
        );
      } else if (spec instanceof WuxingSpec) {
        requireUnitStep(spec);
        this.m._wc_findFabao2(
          start,
          range,
          u32(spec.targetWx),
          this.u32Array(spec.baguaGrowth),
          u32(limit),
          out,
        );
      } else if (spec instanceof PoolSpec) {
        requireUnitStep(spec);
        this.m._wc_findRechild2(
          start,
          range,
          u32(spec.total),
          spec.rollNum,
          this.u32Array(spec.rollVals),
          u32(limit),
          out,
        );
      } else {
        throw new BackendUnavailable(`wasm 后端不支持 ${spec.kind} 的局部搜索`);
      }
      const got = scratch.readSeedArray(out);
      return seedSet(got.seeds, got.head, got.truncated, null);
    } finally {
      scratch.release(mark);
    }
  }

  // ------------------------------------------------------------------ 内部
  /** 写一个 ``uint32[]`` 进 scratch 并返回指针；空数组返回 ``0``（C 侧当 NULL，与 Python 驱动一致）。 */
  private u32Array(values: readonly number[]): number {
    if (values.length === 0) return 0;
    const ptr = this.rt.scratch.allocU32(values.length);
    this.rt.scratch.writeU32Array(ptr, values);
    return ptr;
  }

  /** 写一个 ``int32[]`` 进 scratch 并返回指针；空数组返回 ``0``。 */
  private i32Array(values: readonly number[]): number {
    if (values.length === 0) return 0;
    const ptr = this.rt.scratch.allocI32(values.length);
    this.rt.scratch.writeI32Array(ptr, values);
    return ptr;
  }
}

export function createSearcher(rt: WasmRuntime): WasmSearcher {
  return new WasmSearcher(rt);
}
