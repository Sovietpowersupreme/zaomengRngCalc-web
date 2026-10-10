/**
 * ``src_forge/core/search.py`` 的 TS 版：``SeedSearcher`` 搜索契约层。
 *
 * 三层分工（与 Python 一致）：
 *
 * 1. :class:`SeedSet` —— 后端 ``search_slice`` / ``search_near`` 的**原始**返回值，
 *    对应 C 的 ``seedArray``（``data/len/seed``）。
 * 2. :class:`SearchResult` —— 统一结果形状（含 ``nearest`` / ``distance`` /
 *    ``unordered`` 这些只有上层才知道的字段）。
 * 3. :class:`SeedSearcher` —— 抽象基类，子类只实现 ``supports`` /
 *    ``searchSlice`` / ``searchNear`` 三个方法；分片、归并、取消、进度都在这一层。
 *
 * ⚠️ 与 Python 的两处**有意的**差异：
 * * 取消不是 ``threading.Event`` 而是 :class:`CancelToken`（单线程布尔标志，见 ``progress.ts``）；
 * * ``mergeResults`` 的 ``maxResults`` 语义照抄 Python（含 ``0`` 那个「立刻 break」的怪脾气），
 *   调用方别指望它会自作聪明。
 */

import { BackendUnavailable, SpecError } from "./errors";
import { CancelToken, DEFAULT_SHARD_SIZE, Progress, Throttle, type ProgressCallback } from "./progress";
import type { SeedSpec } from "./spec";
import { KMAX, SEED_CAP, u32 } from "./values";

/** 局部搜索的默认步数上限（``search_nearest``）。 */
export const DEFAULT_NEAR_LIMIT = 100_000;

/**
 * 局部搜索的**并行门槛**：``limit >=`` 这个值才把一条链切成多片并行跑。
 *
 * * 照抄 ``src_forge/core/search.py`` 的 ``PARALLEL_MIN_STEPS``
 *   （= ``gameInfo.equipment.MAX_SEED_SEARCH``，两处各一份、由测试断言相等）。
 * * **没有用户开关**：过了门槛就自动并行 —— 与 Python 的 ``search_nearest`` 一致
 *   （并行只改耗时、不改结果，所以不需要给用户一个「要不要」的勾选框）。
 * * 低于门槛时行为与改动前**逐字节相同**，这也是 golden 能共用一份期望值的原因。
 */
export const PARALLEL_MIN_STEPS = 99_999_999;

// =========================================================================== 区间工具
/**
 * 把任意 ``[lo, hi)`` 夹到合法范围。
 *
 * * ``hi > KMAX`` 时改成 :data:`KMAX`；
 * * ``lo >= hi`` 时结果是**空区间** ``(0, 0)``。
 *
 * ⚠️ 全空间就是 ``(0, KMAX)`` —— 左闭右开，所以 ``uv = 0x7FFFFFFF`` 本身
 * **永远扫不到**。这是 C 的既有行为（``uv_hi`` 被夹到 ``kRandomPureMax``）。
 */
export function clampBounds(bounds: readonly number[]): [number, number] {
  let lo = u32(bounds[0] ?? 0);
  let hi = u32(bounds[1] ?? 0);
  if (hi > KMAX) hi = KMAX;
  if (lo >= hi) return [0, 0];
  return [lo, hi];
}

/** 把 ``[lo, hi)`` 切成 ``shardSize`` 大小的分片列表（给并行/可取消场景用）。 */
export function shardBounds(
  total: readonly number[] = [0, KMAX],
  shardSize = DEFAULT_SHARD_SIZE,
): Array<[number, number]> {
  const [lo, hi] = clampBounds(total);
  if (hi <= lo) return [];
  const size = shardSize <= 0 ? DEFAULT_SHARD_SIZE : shardSize;
  const out: Array<[number, number]> = [];
  let start = lo;
  while (start < hi) {
    const end = Math.min(start + size, hi);
    out.push([start, end]);
    start = end;
  }
  return out;
}

/**
 * 把 ``limit`` 步切成若干**不重叠**的块（局部搜索并行用）。
 *
 * 每块是 ``[offset, len]``：块 ``i`` 负责链上第 ``offset`` 步起的 ``len`` 步，它的起点种子是
 * ``engine.fastNextK(seed, offset)``（**必须**由调用方算好再交给 worker，见 ``worker/protocol.ts``）。
 *
 * ⚠️ 与 :func:`shardBounds` 的两处差别：
 * * 这里切的是**步数**（一条链的一维偏移），不是种子区间；
 * * 恒返回**至少一块**（``limit >= 1`` 时），永远不会是空数组 —— 局部搜索不并行也得跑一块。
 *
 * 块数与块大小与 C 的 ``_crackerOrdChunk``（``cracker_ord_mp.h``）**同构**：
 * ``chunk = ceil(limit / count)``、块数 ``= ceil(limit / chunk)``、**只有最后一块可能短**
 * —— 两边一致，所以 Web 侧与桌面端的「按块有序归并」是可比的。
 *
 * @param limit 总步数（``>= 1``；``<= 0`` 返回空数组，由调用方先校验）
 * @param count 期望块数（会被夹到 ``[1, limit]``）；并行时建议给 ``worker 数 * 8``
 *   （与 C 的 ``omp_get_max_threads() * 8`` 一个思路：块多于此才能把长尾摊平）
 */
export function nearChunks(limit: number, count: number): Array<[number, number]> {
  const total = Math.trunc(limit);
  if (total <= 0) return [];
  const want = Number.isFinite(count) ? Math.trunc(count) : 1;
  const n = Math.min(Math.max(want >= 1 ? want : 1, 1), total);
  const chunk = Math.max(1, Math.ceil(total / n));
  const out: Array<[number, number]> = [];
  for (let offset = 0; offset < total; offset += chunk) {
    out.push([offset, Math.min(chunk, total - offset)]);
  }
  return out;
}

// =========================================================================== 原始结果
/** 一次搜索的原始结果 —— 对应 C 的 ``seedArray``。 */
export interface SeedSet {
  /** ``data[0:len]``。 */
  readonly seeds: readonly number[];
  /**
   * C 端的 ``re.seed``。语义随函数而变：``crack`` 是 ``getPreSeed(第一个命中的 uv)``；
   * ``findFabao`` / ``findEquip`` / ``findRechild`` 就是命中的 ``uv`` 本身；
   * ``crack2`` 是回退算出的窗口起始种子。
   */
  readonly head: number;
  /** 是否因为写满 :data:`SEED_CAP` 而提前返回。⚠️ ``_mp`` 家族满容量时返回的是**残缺结果**。 */
  readonly truncated: boolean;
  /** 实际枚举/迭代了多少个 ``uv``（拿不到就留 ``null``）。 */
  readonly consumed: number | null;
}

export function seedSet(
  seeds: readonly number[] = [],
  head = 0,
  truncated = false,
  consumed: number | null = null,
): SeedSet {
  return { seeds, head: u32(head), truncated, consumed };
}

/** 空结果（冻结的常量，可以安全共享）。 */
export const EMPTY_SEED_SET: SeedSet = Object.freeze({
  seeds: Object.freeze([]) as readonly number[],
  head: 0,
  truncated: false,
  consumed: null,
});

export function emptySeedSet(): SeedSet {
  return EMPTY_SEED_SET;
}

// =========================================================================== 归并
/**
 * 把多个分片的结果归并成一个。
 *
 * * ``seeds`` 去重后**保持分片顺序**（即搜索顺序：离起点由近到远）——
 *   分片之间互不重叠，去重只为容忍 ``unordered`` 结果；
 * * ``head`` 取第一个**有命中**的分片的 ``head``（全空则取最后一个的 ``head``，通常是 0）；
 * * ``truncated`` 是各分片的逻辑或；
 * * ``consumed`` 累加（拿得到才算）。
 */
export function mergeResults(
  results: Iterable<SearchResult>,
  maxResults = SEED_CAP,
): SearchResult {
  const seeds: number[] = [];
  const seen = new Set<number>();
  let head = 0;
  let headSet = false;
  let truncated = false;
  let consumed: number | null = 0;
  let backend = "";
  let specKind = "";
  let unordered = false;
  for (const r of results) {
    unordered = unordered || r.unordered;
    truncated = truncated || r.truncated;
    backend = backend || r.backend;
    specKind = specKind || r.specKind;
    if (r.seeds.length > 0 && !headSet) {
      head = r.head;
      headSet = true;
    } else if (!headSet) {
      head = r.head;
    }
    for (const s of r.seeds) {
      if (!seen.has(s)) {
        seen.add(s);
        seeds.push(s);
      }
    }
    if (consumed !== null) consumed = r.consumed === null ? null : consumed + r.consumed;
    if (seeds.length >= maxResults) {
      truncated = truncated || seeds.length > maxResults;
      break;
    }
  }
  let ordered = seeds;
  if (maxResults > 0 && ordered.length > maxResults) {
    ordered = ordered.slice(0, maxResults);
    truncated = true;
  }
  return new SearchResult({
    seeds: ordered,
    head,
    truncated,
    consumed,
    unordered: false,
    backend,
    specKind,
  });
}

// =========================================================================== 结果
export interface SearchResultInit {
  seeds?: readonly number[];
  head?: number;
  nearest?: number | null;
  distance?: number | null;
  consumed?: number | null;
  truncated?: boolean;
  unordered?: boolean;
  backend?: string;
  specKind?: string;
}

/** 搜索结果的统一形状（对应 Python 的 frozen dataclass ``SearchResult``）。 */
export class SearchResult implements Iterable<number> {
  readonly seeds: readonly number[];
  readonly head: number;
  readonly nearest: number | null;
  readonly distance: number | null;
  readonly consumed: number | null;
  readonly truncated: boolean;
  /** 结果是否为**集合**语义（并行分片会把顺序打乱）。 */
  readonly unordered: boolean;
  readonly backend: string;
  /** 源规格的 ``kind``（``"interval"`` / ``"mask"`` / ``"roll"`` / ``"wuxing"`` / ``"pool"``）。 */
  readonly specKind: string;

  constructor(init: SearchResultInit = {}) {
    this.seeds = Object.freeze([...(init.seeds ?? [])]);
    this.head = u32(init.head ?? 0);
    this.nearest = init.nearest ?? null;
    this.distance = init.distance ?? null;
    this.consumed = init.consumed ?? null;
    this.truncated = init.truncated ?? false;
    this.unordered = init.unordered ?? false;
    this.backend = init.backend ?? "";
    this.specKind = init.specKind ?? "";
  }

  get count(): number {
    return this.seeds.length;
  }

  get found(): boolean {
    return this.seeds.length > 0;
  }

  get first(): number | null {
    return this.seeds.length > 0 ? (this.seeds[0] as number) : null;
  }

  get length(): number {
    return this.seeds.length;
  }

  at(index: number): number | undefined {
    return this.seeds[index];
  }

  [Symbol.iterator](): IterableIterator<number> {
    return this.seeds[Symbol.iterator]();
  }

  toDict(): Record<string, unknown> {
    return {
      seeds: this.seeds.map((s) => u32(s)),
      head: u32(this.head),
      nearest: this.nearest === null ? null : u32(this.nearest),
      distance: this.distance === null ? null : u32(this.distance),
      consumed: this.consumed === null ? null : u32(this.consumed),
      truncated: !!this.truncated,
      unordered: !!this.unordered,
      backend: this.backend,
      spec_kind: this.specKind,
    };
  }
}

/**
 * 把一次局部搜索的原始结果收成 :class:`SearchResult`（``nearest`` / ``distance`` 只在这里定义）。
 *
 * 同步的 :meth:`SeedSearcher.searchNearest` 与异步的 ``SearchPool.searchNearest`` 都调它
 * —— 分片并行与串行的输出形状必须一样，写两份就会有一份先漂。
 *
 * ``distance`` 用**原始起点**重算：分块并行时每块各有自己的起点，但归并后的
 * ``seeds[0]`` 到原始起点的距离可以直接算，**不需要**任何偏移补偿。
 */
export function nearResult(
  set: SeedSet,
  start: number,
  limit: number,
  engine: DistanceEngine,
  backend = "",
  specKind = "",
): SearchResult {
  const nearest = set.seeds.length > 0 ? (set.seeds[0] as number) : null;
  const distance = nearest === null ? null : engine.seedDistance(start, nearest, limit);
  return new SearchResult({
    seeds: set.seeds,
    head: set.head,
    nearest,
    distance,
    truncated: set.truncated,
    backend,
    specKind,
  });
}

// =========================================================================== 上下文
export interface SearchContextInit {
  /** 取消标志；``undefined`` 表示不可取消。 */
  cancelToken?: CancelToken | null;
  /** 进度回调；分片内部没有回调点，所以粒度是「分片」。 */
  progressCb?: ProgressCallback | null;
  /** 扫描范围 ``[lo, hi)``；``undefined`` = 全空间 ``(0, KMAX)``。 */
  sliceBounds?: readonly number[] | null;
  /** 结果上限（含）。C 的硬上限是 :data:`SEED_CAP`。 */
  maxResults?: number;
  /**
   * 允许后端使用并行实现。
   *
   * ⚠️ Web 侧没有 C 的 ``*_mp`` / ``*_ord_mp``（wasm 构建不能加 ``-fopenmp``），
   * 所以这个开关**不改变任何结果** —— 它只是允许把分片交给 worker 池。
   * Python 侧打开的是有序并行（``*_ord_mp``），结果与串行逐位相同。
   */
  preferParallel?: boolean;
  /** 并行/可取消时的分片大小；``undefined`` 用 :data:`DEFAULT_SHARD_SIZE`。 */
  shardSize?: number | null;
  /**
   * 允许局部搜索在 ``limit >= PARALLEL_MIN_STEPS`` 时并行（Web 侧 = 派给 worker 池）。
   *
   * 默认 ``true``：与 Python 的 ``SearchContext.near_parallel`` 一样，**没有用户开关**，
   * 超过门槛自动并行、结果与串行逐位相同。把它设成 ``false`` 只为测试/基准里
   * 「强制串行」用（否则你没法在同一个后端上量出加速比）。
   */
  nearParallel?: boolean;
  /** 进度回调的限流间隔（秒）。 */
  throttleInterval?: number;
}

/** 搜索的运行期参数（与 ``spec`` 分开，因为它描述「怎么跑」而非「找什么」）。 */
export class SearchContext {
  cancelToken: CancelToken | null;
  progressCb: ProgressCallback | null;
  sliceBounds: readonly number[] | null;
  maxResults: number;
  preferParallel: boolean;
  shardSize: number | null;
  nearParallel: boolean;
  throttleInterval: number;
  private throttle: Throttle | null = null;

  constructor(init: SearchContextInit = {}) {
    this.cancelToken = init.cancelToken ?? null;
    this.progressCb = init.progressCb ?? null;
    this.sliceBounds = init.sliceBounds ?? null;
    this.maxResults = init.maxResults ?? SEED_CAP;
    this.preferParallel = init.preferParallel ?? false;
    this.shardSize = init.shardSize ?? null;
    this.nearParallel = init.nearParallel ?? true;
    this.throttleInterval = init.throttleInterval ?? 0.1;
  }

  checkCancel(): void {
    this.cancelToken?.throwIfCancelled();
  }

  get cancelled(): boolean {
    return this.cancelToken !== null && this.cancelToken.cancelled;
  }

  report(done: number, total: number, message = "", unit = "uv"): void {
    if (!this.progressCb) return;
    this.throttle ??= new Throttle(this.progressCb, this.throttleInterval);
    this.throttle.call(new Progress(done, total, message, unit));
  }

  forceReport(done: number, total: number, message = "", unit = "uv"): void {
    if (!this.progressCb) return;
    this.throttle ??= new Throttle(this.progressCb, this.throttleInterval);
    this.throttle.force(new Progress(done, total, message, unit));
  }

  get bounds(): [number, number] {
    return clampBounds(this.sliceBounds ?? [0, KMAX]);
  }

  shards(): Array<[number, number]> {
    const size = this.shardSize ?? DEFAULT_SHARD_SIZE;
    return shardBounds(this.sliceBounds ?? [0, KMAX], size);
  }
}

// =========================================================================== 接口
/** 搜索层只用到引擎的一个方法（``seedDistance``），这里按结构化类型收窄。 */
export interface DistanceEngine {
  seedDistance(start: number, target: number, end: number): number;
}

/**
 * 沿链跳 ``k`` 步的能力（``WasmEngine.fastNextK`` 满足）。
 *
 * 局部搜索并行**只需要这一个方法**：把 ``[offset, len]`` 变成「从哪个种子开始扫」。
 * 按结构化类型收窄，是为了让 `worker/pool.ts` 不必 import 整个 wasm 运行时
 * （测试里也就能塞个假的）。
 */
export interface ChainEngine {
  fastNextK(seed: number, k: number): number;
}

/** 局部搜索并行需要的引擎能力：跳步 + 算距离。 */
export interface NearEngine extends DistanceEngine, ChainEngine {}

/** 种子搜索抽象。子类只需实现 3 个方法。 */
export abstract class SeedSearcher {
  /** 后端名（进 :attr:`SearchResult.backend`）。 */
  abstract readonly name: string;

  /**
   * ``searchSlice`` 单次可接受的**最大区间宽度**；``null`` 表示不限。
   *
   * wasm 后端是 ``null``（C 的 ``*_slice`` 能一口气扫完）；pure_py 后端要设成一个小值。
   * 核心层据此在 :meth:`searchAll` 里自动按片串联，语义与「一次扫完」逐位一致
   * （因为 ``*_slice`` 是可以续扫的）。
   */
  maxSliceWidth: number | null = null;

  constructor(protected readonly engine: DistanceEngine) {}

  // ------------------------------------------------------------------ 子类实现
  /** 本后端能否求解该 spec。 */
  abstract supports(spec: SeedSpec): boolean;

  /** 确定性枚举 ``[uvLo, uvHi)``，返回 uv 升序的前若干个匹配。 */
  abstract searchSlice(spec: SeedSpec, uvLo: number, uvHi: number): SeedSet;

  /** 从 ``seed`` 出发的局部搜索（``*2`` 系列 / ``seedFindbyRange``）。 */
  abstract searchNear(seed: number, spec: SeedSpec, limit: number): SeedSet;

  // ------------------------------------------------------------------ 可选实现
  /**
   * 可选的并行实现。
   *
   * ⚠️ Web 侧**没有** C 的 ``*_mp`` / ``*_ord_mp``：wasm 构建不能加 ``-fopenmp``，
   * 所以这里没有「乱序」可言。默认实现 = 用 :meth:`searchSlice` 逐分片跑，
   * 因此「并行」只是把不可取消变成可取消，并不提速；真正的并行是 worker 池。
   */
  searchParallel(spec: SeedSpec, uvLo: number, uvHi: number, ctx: SearchContext): SeedSet {
    const acc: SeedSet[] = [];
    const bounds = shardBounds([uvLo, uvHi], ctx.shardSize ?? DEFAULT_SHARD_SIZE);
    const total = uvHi - uvLo;
    let done = 0;
    for (const [lo, hi] of bounds) {
      ctx.checkCancel();
      acc.push(this.searchSlice(spec, lo, hi));
      done += hi - lo;
      ctx.report(done, total, `${spec.kind} 分片扫描`, "shard");
    }
    if (acc.length === 0) return emptySeedSet();
    // ⚠️ ``SeedSet`` 上没有 ``backend`` / ``specKind``（它们是 ``SearchResult`` 的字段），
    // Python 侧曾写成 ``backend=s.backend``，于是「并行枚举」一勾就 ``AttributeError``。
    const merged = mergeResults(
      acc.map(
        (s) =>
          new SearchResult({
            seeds: s.seeds,
            head: s.head,
            truncated: s.truncated,
            backend: this.name,
            specKind: spec.kind,
          }),
      ),
    );
    return seedSet(merged.seeds, merged.head, merged.truncated, total);
  }

  /** 是否支持 :meth:`searchNear`（``MaskSpec`` 在 C 里没有局部版本）。 */
  supportsNear(spec: SeedSpec): boolean {
    return this.supports(spec);
  }

  /**
   * 本后端是否支持该 spec 的**有序**并行局部搜索。
   *
   * 默认 ``False``；只有实现了 ``*2`` 家族（``findFabao2`` / ``findEquip2`` /
   * ``findRechild2``）的后端可以为真 —— 那一族是「从起点沿链前扫」，而 ``fastNext``
   * 是可逆的 GF(2) 线性变换，所以「跳 ``k`` 步再扫」与「扫 ``k`` 步」**逐位等价**。
   *
   * ⚠️ ``IntervalSpec``（``seedFindbyRange``）**不**算在内：C 侧也没有它的 ``*_ord_mp``，
   * 本方法返回 ``false`` 才能和桌面端保持同一套判据（``tests/`` 会断言两边门槛相等）。
   */
  supportsNearParallel(_spec: SeedSpec): boolean {
    return false;
  }

  /**
   * 把 ``chunks`` 里每一块各自跑一遍 :meth:`searchNear`，再**按块顺序**归并。
   *
   * ``chunks`` 由 :func:`nearChunks` 切出来，每项是 ``[offset, len]``；块 ``i`` 的实际起点是
   * ``fastNextK(seed, offset)``，**由本方法负责算**（同步实现）或由调用方提前算好再发出去
   * （worker 池，见 ``worker/pool.ts``）。
   *
   * 默认实现**转发** :meth:`searchNear`（即整条链一次扫完）—— 没有 ``fastNextK`` 的后端
   * 只能这么做，但结果与分块跑**逐位相同**，所以拿它当串行参照是安全的。
   *
   * 归并规则与 :func:`mergeResults` 一致：种子按块序拼接、``head`` 取第一个有命中的块、
   * ``truncated`` 取或、``consumed`` 照原样累加（``*2`` 家族本来就返回 ``null``，所以分块
   * 与一次扫完在这里也是同一个 ``null``）。因为各块在链上**互不重叠**，
   * ``seeds[0]`` 就是「最近的命中」。
   */
  searchNearShards(
    seed: number,
    spec: SeedSpec,
    chunks: Iterable<readonly number[]>,
    _ctx: SearchContext,
  ): SeedSet {
    let total = 0;
    for (const c of chunks) total += Math.trunc(c[1] ?? 0);
    if (total <= 0) return emptySeedSet();
    return this.searchNear(u32(seed), spec, total);
  }

  /**
   * ``maxSliceWidth`` 小于全宽时的分片串联兜底。
   *
   * ``*_slice`` 是**可续扫**的 —— ``crack2`` 的 ``fastNextK(1, uvLo * step)``
   * 热身会精确复原「连续扫描到该处」的环形缓冲状态。因此「按片扫完再拼」
   * 与「一次扫完」在 ``uv`` 升序上逐位一致：命中序列相同、``999`` 截断点相同。
   *
   * 唯一有意的差别是 :attr:`SearchResult.consumed`：这里只累加**真正扫过的**
   * ``uv`` 数，提前截断时不会虚报全空间。
   */
  protected searchAllSharded(
    spec: SeedSpec,
    lo: number,
    hi: number,
    width: number,
    ctx: SearchContext,
  ): SearchResult {
    const seeds: number[] = [];
    let head = 0;
    let headSet = false;
    let truncated = false;
    let consumed = 0;
    const span = hi - lo;
    for (const [shardLo, shardHi] of shardBounds([lo, hi], width)) {
      ctx.checkCancel();
      const found = this.searchSlice(spec, shardLo, shardHi);
      consumed += found.consumed ?? shardHi - shardLo;
      if (found.seeds.length > 0 && !headSet) {
        head = u32(found.head);
        headSet = true;
      }
      seeds.push(...found.seeds);
      ctx.report(consumed, span, `${spec.kind} 扫描中`);
      if (found.truncated) {
        truncated = true;
        break;
      }
      if (ctx.maxResults > 0 && seeds.length >= ctx.maxResults) break;
    }
    let out = seeds;
    if (ctx.maxResults > 0 && out.length > ctx.maxResults) {
      out = out.slice(0, ctx.maxResults);
      truncated = true;
    }
    ctx.forceReport(consumed, span, `${spec.kind} 扫描完成`);
    return new SearchResult({
      seeds: out,
      head: u32(head),
      truncated,
      consumed,
      unordered: false,
      backend: this.name,
      specKind: spec.kind,
    });
  }

  // ------------------------------------------------------------------ 公共入口
  /** 枚举式搜索。默认确定性串行；``ctx.preferParallel`` 时交给后端的并行实现（仍然有序）。 */
  searchAll(spec: SeedSpec, ctx: SearchContext | null = null): SearchResult {
    const context = ctx ?? new SearchContext();
    if (!this.supports(spec)) {
      throw new BackendUnavailable(`${this.name} 后端不支持 ${spec.kind} 规格`);
    }
    const [lo, hi] = context.bounds;
    if (hi <= lo) {
      return new SearchResult({ head: 0, consumed: 0, backend: this.name, specKind: spec.kind });
    }
    context.checkCancel();
    context.forceReport(0, hi - lo, `${spec.kind} 开始扫描`);
    if (this.maxSliceWidth !== null && hi - lo > this.maxSliceWidth) {
      return this.searchAllSharded(spec, lo, hi, Math.trunc(this.maxSliceWidth), context);
    }
    let found: SeedSet;
    // ⚠️ 这里**恒**为 false。Web 侧唯一的 ``searchParallel`` 实现是按片串行再
    // 有序归并（``mergeResults`` 只做保序去重，不再排序），所以结果与串行逐位相同 ——
    // 与 Python 侧的 ``*_ord_mp`` 语义对齐（并行只改耗时，不改结果）。
    const unordered = false;
    if (context.preferParallel) {
      found = this.searchParallel(spec, lo, hi, context);
    } else {
      found = this.searchSlice(spec, lo, hi);
    }
    let seeds = found.seeds;
    let truncated = found.truncated;
    if (context.maxResults > 0 && seeds.length > context.maxResults) {
      seeds = seeds.slice(0, context.maxResults);
      truncated = true;
    }
    context.forceReport(hi - lo, hi - lo, `${spec.kind} 扫描完成`);
    return new SearchResult({
      seeds,
      head: found.head,
      truncated,
      consumed: found.consumed ?? hi - lo,
      unordered,
      backend: this.name,
      specKind: spec.kind,
    });
  }

  /**
   * 局部搜索：从 ``seed`` 出发，最多 ``limit`` 步内找最近的匹配。
   *
   * ``limit`` 必须 **>= 1**；注意 C 的循环上界是开区间（``i < end``），
   * 所以「``limit`` 步以内」实际上不含第 ``limit`` 步。传 ``n + 1`` 才是「``n`` 步以内」。
   */
  searchNearest(
    seed: number,
    spec: SeedSpec,
    limit = DEFAULT_NEAR_LIMIT,
    ctx: SearchContext | null = null,
  ): SearchResult {
    const context = ctx ?? new SearchContext();
    if (!this.supportsNear(spec)) {
      throw new BackendUnavailable(`${this.name} 后端不支持 ${spec.kind} 的局部搜索`);
    }
    if (limit < 1) {
      throw new SpecError(`局部搜索步数上限必须 >= 1，得到 ${limit}`);
    }
    context.checkCancel();
    const start = u32(seed);
    const found = this.searchNear(start, spec, Math.trunc(limit));
    return nearResult(found, start, Math.trunc(limit), this.engine, this.name, spec.kind);
  }

  /**
   * 对一组**显式**分片做确定性枚举并归并（Python 侧串行，Web 侧可派给 Worker）。
   *
   * ``_mp`` 不可用时这就是「手动并行」的骨架：把 :func:`shardBounds` 的结果
   * 分给多个 Worker，各自调 :meth:`searchSlice`，最后 :func:`mergeResults`。
   */
  searchShards(
    spec: SeedSpec,
    shards: Iterable<readonly number[]>,
    ctx: SearchContext | null = null,
  ): SearchResult {
    const context = ctx ?? new SearchContext();
    if (!this.supports(spec)) {
      throw new BackendUnavailable(`${this.name} 后端不支持 ${spec.kind} 规格`);
    }
    const list: Array<[number, number]> = [];
    let total = 0;
    for (const s of shards) {
      const lo = u32(s[0] ?? 0);
      const hi = u32(s[1] ?? 0);
      if (hi > lo) {
        list.push([lo, hi]);
        total += hi - lo;
      }
    }
    let done = 0;
    const results: SearchResult[] = [];
    for (const [lo, hi] of list) {
      context.checkCancel();
      const found = this.searchSlice(spec, lo, hi);
      results.push(
        new SearchResult({
          seeds: found.seeds,
          head: found.head,
          truncated: found.truncated,
          consumed: hi - lo,
          backend: this.name,
          specKind: spec.kind,
        }),
      );
      done += hi - lo;
      context.forceReport(done, total, `${spec.kind} 分片 ${done}/${total}`, "shard");
    }
    const merged = mergeResults(results, context.maxResults);
    return new SearchResult({
      seeds: merged.seeds,
      head: merged.head,
      truncated: merged.truncated,
      consumed: merged.consumed,
      unordered: false,
      backend: this.name,
      specKind: spec.kind,
    });
  }
}

/**
 * 「这次局部搜索该不该并行」的**唯一**判据。
 *
 * 与 Python ``search_nearest`` 里的条件一字不差：
 *
 * .. code-block:: python
 *
 *     ctx.near_parallel and limit >= PARALLEL_MIN_STEPS and self.supports_near_parallel(spec)
 *
 * ⚠️ 两边的**位置**不同，这是刻意的：Python 的并行实现在后端内部（``*_ord_mp`` + OpenMP），
 * 所以判据直接写在 ``search_nearest`` 里；Web 侧的并行实现是**外面的 worker 池**，
 * 所以判据只能由协调层（``scenarios/scenario.ts``）调，然后决定
 * 「派给 :meth:`SearchPool.searchNearest`」还是「同步 :meth:`SeedSearcher.searchNearest` 一次扫完」。
 *
 * 判据一旦写两份就会漂：一处并行、一处串行，同一次搜索的耗时和结果归属都对不上，
 * 而且很难测出来。所以**只在 scenario 层调本函数**，其他地方一律别自己写条件。
 *
 * 同步路径**不**按本判据切块：JS 是单线程，切块只是白付一遍 ``fastNextK`` 和 ``limit``
 * 次函数调用开销，没有任何收益。
 *
 * @param searcher 承担串行兜底的那个搜索器（*不是* 池子）—— 能力问题要问后端
 * @param limit 局部搜索步数上限
 */
export function shouldParallelNear(
  searcher: SeedSearcher,
  spec: SeedSpec,
  limit: number,
  ctx: SearchContext,
): boolean {
  return (
    ctx.nearParallel && Math.trunc(limit) >= PARALLEL_MIN_STEPS && searcher.supportsNearParallel(spec)
  );
}

/**
 * 「这次枚举该不该派给 worker 池」的**唯一**判据。
 *
 * 与 Python ``search_all`` 里的条件一字不差：
 *
 * .. code-block:: python
 *
 *     if ctx.prefer_parallel and (hi - lo) >= PARALLEL_MIN_STEPS:
 *
 * 与 :func:`shouldParallelNear` 的两处不同**都是刻意的，别顺手「统一」掉**：
 *
 * 1. 枚举**有**开关（``ctx.preferParallel``，对应表单上「并行枚举」勾选框），
 *    局部搜索**没有** —— Python 就是这样的，照抄；
 * 2. 枚举不问后端「有没有该 spec 的有序并行实现」。Python 侧那个 ``supports_near_parallel``
 *    问的是「``*_ord_mp`` 有没有这个 spec 的导出」；而 Web 侧的并行只是
 *    「把分片派给 worker」，凡是 :meth:`SeedSearcher.searchSlice` 支持的 spec 都能派，
 *    没有「某 spec 少了并行实现」这回事。
 *
 * 另外要求 ``searcher.maxSliceWidth === null``：设了上限的后端走的是
 * :meth:`SeedSearcher.searchAllSharded`（那条路只累加**真正扫过的** ``consumed``，
 * 与池子的「按片宽累加」不是同一套语义）。wasm 后端的 ``maxSliceWidth`` 是 ``null``，
 * 所以这道闸门平时不拦人 —— 但判据不能装作看不见它。
 *
 * 与 :func:`shouldParallelNear` 一样：**只在 scenario 层调本函数**，
 * 别在别处再写一遍条件。
 *
 * @param searcher 承担串行兜底的那个搜索器（*不是* 池子）—— 能力问题要问后端
 */
export function shouldParallelEnum(searcher: SeedSearcher, ctx: SearchContext): boolean {
  if (!ctx.preferParallel) return false;
  if (searcher.maxSliceWidth !== null) return false;
  const [lo, hi] = ctx.bounds;
  return hi - lo >= PARALLEL_MIN_STEPS;
}
