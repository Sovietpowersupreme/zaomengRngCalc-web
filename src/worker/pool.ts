/**
 * 搜索 Worker 池 —— Web 侧的「多核」实现。
 *
 * 分工很单纯：主线程把任务切好喂进来，池子把它们派给 N 个 worker（每个 worker 独占一份
 * wasm runtime，见 `search.worker.ts` 的说明），收回来的 `SeedSet` 按**任务下标**放好后
 * 交给归并。
 *
 * 两类任务（都是「按序归并」的）：
 *
 * | 任务 | 切法 | 归并顺序 |
 * | ---- | ---- | -------- |
 * | `searchShards` / `searchAll` | :func:`shardBounds` 切种子区间 | 分片下标 = 种子升序 |
 * | `searchNearShards` | :func:`nearChunks` 切一条链的步数 | 块下标 = 离起点由近到远 |
 *
 * ⚠️ 为什么不是「谁先回来谁排前面」：`mergeResults` 是**按输入顺序**去重合并的，
 * `head` 取的是**第一个非空分片**的 `head`，局部搜索更是靠 `seeds[0]` 定义「最近的命中」。
 * 只要按任务下标归位，池子的输出就与串行实现**逐位相同**（种子集合升序、`head` 相同、
 * `truncated` 相同、`consumed` 相同）—— 所以结果仍然是 `unordered: false`，
 * 与「跑得快」不矛盾：并行只改**耗时**，不改**结果**。
 *
 * ⚠️ 局部搜索的并行**只在步数过门槛时才用**（`shouldParallelNear`），因为：
 *
 * * 小 limit 的搜索几十毫秒就跑完了，切块 + 过消息比省下的时间还贵；
 * * `limit < 门槛` 时池子与串行走的是**同一份**内核调用次数，结果自然一致，
 *   于是浏览器里也不需要为了「能不能并行」给用户一个开关。
 *
 * ⚠️ 枚举的并行条件**不一样**（`shouldParallelEnum`）：除了宽度过门槛，还要
 * `ctx.preferParallel`（表单上「并行枚举」勾选框）—— 这是 Python `search_all` 的
 * 原条件，**照抄不改**。两条判据都只在 `scenarios/scenario.ts` 里调。
 */

import { BackendUnavailable, Canceled, SpecError } from "../core/errors";
import {
  emptySeedSet,
  nearChunks,
  nearResult,
  SearchContext,
  mergeResults,
  SearchResult,
  seedSet,
  type NearEngine,
  type SeedSet,
} from "../core/search";
import type { SeedSpec } from "../core/spec";
import { KMAX, u32 } from "../core/values";
import type { NearRequest, PoolRequest, PoolResponse, SliceRequest } from "./protocol";

/**
 * 派活时用的「模板」：除了 `id` 以外什么都有。
 *
 * 把 `id` 从模板里去掉，是为了让 :meth:`SearchPool.dispatch` 成为**唯一**拼消息的地方
 * —— 否则新增一类任务就要在「建任务」「派活」两处同时改，漏一处就静默发错消息。
 */
export type JobRequest = Omit<SliceRequest, "id"> | Omit<NearRequest, "id">;

/** worker 的最小接口（浏览器 `Worker` 天然满足；测试里注入假实现）。 */
export interface WorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: PoolResponse }) => void): void;
  terminate(): void;
}

/** 池子的构造参数。 */
export interface SearchPoolOptions {
  /** worker 数量；缺省 :func:`defaultPoolSize`。 */
  size?: number;
  /** 自定义 worker 工厂（测试用）。缺省 = 真的起 `search.worker.ts`。 */
  createWorker?: (index: number) => WorkerLike;
  /** 结果里的后端名（进 `SearchResult.backend`）。 */
  backend?: string;
  /**
   * 局部搜索用的引擎（`rt.engine` 即可）。
   *
   * 只做枚举（`searchAll` / `searchShards`）时**不必**给；但 `searchNearShards` /
   * `searchNearest` 要靠它把链跳过 `offset` 步、并算 `distance`，没给就报错而不是猜。
   */
  nearEngine?: NearEngine;
  /** :meth:`SearchPool.warmup` 里单次 ping 的超时（毫秒）。 */
  timeoutMs?: number;
}

/** worker 上限。再多也不提速：每多一个 worker 就多一份 wasm 实例 + 线性内存。 */
export const MAX_POOL_SIZE = 8;

/**
 * 默认 worker 数。
 *
 * `navigator.hardwareConcurrency` 是**逻辑核数**（含超线程），拿它当 worker 数
 * 会轻微超订，无妨；但手机上给 8 个 worker 会 OOM，所以压到
 * :data:`MAX_POOL_SIZE`，并且**至少 1**。
 */
export function defaultPoolSize(hint?: number): number {
  const hw =
    hint ?? (typeof navigator !== "undefined" ? navigator.hardwareConcurrency : undefined) ?? 0;
  const n = Math.trunc(Number(hw) || 0);
  if (n < 1) return 1;
  return Math.min(n, MAX_POOL_SIZE);
}

/** 真的起一个模块化 worker（vite 认这个 `new Worker(new URL(...))` 字面量形态）。 */
function browserWorkerFactory(index: number): WorkerLike {
  if (typeof Worker === "undefined") {
    throw new BackendUnavailable(
      "当前环境没有 Web Worker，请改用主线程的串行搜索（searcher.searchAll）",
    );
  }
  return new Worker(new URL("./search.worker.ts", import.meta.url), {
    type: "module",
    name: `rngcalc-search-${index}`,
  });
}

/** 跨 realm 的错误没法 `instanceof`，只能按 `name` 再造一个同类。 */
function rehydrate(name: string, message: string): Error {
  if (name === "SpecError") return new SpecError(message);
  if (name === "BackendUnavailable") return new BackendUnavailable(message);
  if (name === "Canceled") return new Canceled(message);
  const err = new Error(message);
  err.name = name;
  return err;
}

/** 一个在途任务。 */
interface Job {
  readonly id: number;
  /** 要发给 worker 的消息（`id` 在派活时补上）。 */
  readonly request: JobRequest;
  readonly resolve: (set: SeedSet) => void;
  readonly reject: (err: unknown) => void;
}

/** 一个 worker 槽位。 */
interface Slot {
  readonly index: number;
  readonly worker: WorkerLike;
  job: Job | null;
  /** 收到过本次任务的 `ack`（说明 worker 活着且已进入同步计算）。 */
  acked: boolean;
}

/**
 * 有序前缀早停的账本 —— C 的 ``csrc/cracker_ord_mp.h`` 里 ``_crackerOrdState`` 的等价物。
 *
 * 有序并行按块下标顺序拼接结果、总长截到 `cap`（串行内核扫到数组满就返回，两者逐位相同）。
 * 于是「前缀凑够 `cap`」之后，第 k 块往后**怎么算都不会进最终结果**，可以干脆不派活
 * —— C 侧对应 ``if (st.prefix_full) continue;``。
 *
 * 前缀只能被「块下标 == 当前已归并前缀长度」的块推进，所以块乱序返回不影响判定：
 * 中间块先回来只会被记进 `done`，等前面那些块补齐了再一起推进。
 */
class PrefixGuard {
  private readonly done: boolean[];
  private readonly hits: number[];
  private index = 0;
  private len = 0;
  private full = false;

  constructor(
    count: number,
    private readonly cap: number,
  ) {
    this.done = new Array<boolean>(count).fill(false);
    this.hits = new Array<number>(count).fill(0);
  }

  /** 记下第 `index` 块回来了（`hits` = 它自己的命中数），并把前缀尽量往前推。 */
  mark(index: number, hits: number): void {
    this.done[index] = true;
    this.hits[index] = hits;
    while (!this.full && this.index < this.done.length && this.done[this.index]) {
      this.len += this.hits[this.index] ?? 0;
      this.index += 1;
      if (this.len >= this.cap) this.full = true;
    }
  }

  /** 前缀已经凑够 `cap` ⇒ 后面的块不必再派。 */
  get stopped(): boolean {
    return this.full;
  }
}

export class SearchPool {
  readonly size: number;
  readonly backend: string;

  private readonly createWorker: (index: number) => WorkerLike;
  private readonly timeoutMs: number;
  private readonly nearEngine: NearEngine | null;
  private readonly slots: Slot[] = [];
  private readonly queue: Job[] = [];
  private readonly jobs = new Map<number, Job>();
  /** 探活的回调表；键是**负数** id 空间，与真实任务号不会撞。 */
  private readonly pings = new Map<number, () => void>();
  private nextId = 1;
  private nextPing = 0;
  private closed = false;
  /** 本轮搜索的上下文（用来在派活前检查取消）。 */
  private activeCtx: SearchContext | null = null;
  /**
   * 本轮搜索的「前缀已满」谓词（C 的 ``prefix_full``）。
   *
   * 只有有序分片/分块的两条路会传它；`null` = 不早停（例如任务数本来就少）。
   */
  private stopMore: (() => boolean) | null = null;

  constructor(options: SearchPoolOptions = {}) {
    this.size = Math.max(1, Math.trunc(options.size ?? defaultPoolSize()));
    this.backend = options.backend ?? "wasm";
    this.createWorker = options.createWorker ?? browserWorkerFactory;
    this.timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? 30_000));
    this.nearEngine = options.nearEngine ?? null;
  }

  /** 已建好的 worker 数（懒建，所以可能是 0）。 */
  get created(): number {
    return this.slots.length;
  }

  /** 正在跑的任务数（含排队）。 */
  get inflight(): number {
    return this.jobs.size;
  }

  /** 已进入同步计算的槽位数（收过 `ack`）；`inflight` 减它就是「还在排队」。 */
  get started(): number {
    return this.slots.filter((slot) => slot.acked).length;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // ------------------------------------------------------------------ 对外入口
  /**
   * 并行枚举一组**显式**分片，语义 = `SeedSearcher.searchShards`（结果逐位相同）。
   *
   * `ctx.preferParallel` **被忽略** —— 池子本身就是并行分片，不需要再握手一次。
   * 该不该走池子是**外面**的事（`core/search.ts` 的 `shouldParallelEnum`），
   * 池子只管“来了就派”。
   */
  async searchShards(
    spec: SeedSpec,
    shards: Iterable<readonly number[]>,
    ctx: SearchContext | null = null,
  ): Promise<SearchResult> {
    const context = ctx ?? new SearchContext();
    if (this.closed) throw new Canceled("搜索池已关闭");
    // ⚠️ 同一个池子只跑一轮：worker 是**独占**资源（一槽一任务），两轮交错会把
    // 两边都拖慢，而且 `activeCtx` 只有一份 —— 取消也说不清是谁在取消。
    // 要同时跑两轮就开两个池子（UI 就是这么做的）。
    if (this.activeCtx !== null) throw new SpecError("搜索池同一时刻只支持一轮搜索");
    const list: Array<[number, number]> = [];
    let total = 0;
    for (const s of shards) {
      const lo = u32(s[0] ?? 0);
      const hi = u32(s[1] ?? 0);
      if (hi > lo && hi <= KMAX) {
        list.push([lo, hi]);
        total += hi - lo;
      }
    }
    if (list.length === 0) {
      return new SearchResult({ consumed: 0, backend: this.backend, specKind: spec.kind });
    }
    context.checkCancel();
    const dict = spec.toDict() as unknown as Record<string, unknown>;
    const results = new Array<SearchResult | undefined>(list.length);
    const cap = Math.max(1, Math.trunc(Number(context.maxResults) || 0));
    const guard = new PrefixGuard(list.length, cap);
    let done = 0;
    context.forceReport(0, total, `${spec.kind} 分片开始`, "shard");
    const tasks = list.map(([lo, hi], index) => ({
      request: { type: "slice", spec: dict, lo, hi } satisfies JobRequest,
      done: (set: SeedSet): void => {
        results[index] = new SearchResult({
          seeds: set.seeds,
          head: set.head,
          truncated: set.truncated,
          // 与 ``searchShards`` 一致：``consumed`` 记「这一片有多宽」。
          consumed: set.consumed ?? hi - lo,
          backend: this.backend,
          specKind: spec.kind,
        });
        guard.mark(index, set.seeds.length);
        done += hi - lo;
        context.report(done, total, `${spec.kind} 分片 ${index + 1}/${list.length}`, "shard");
      },
    }));
    await this.submit(tasks, context, () => guard.stopped);
    context.forceReport(total, total, `${spec.kind} 分片完成`, "shard");
    const merged = mergeResults(
      results.map(
        (r) =>
          r ??
          new SearchResult({ head: 0, consumed: 0, backend: this.backend, specKind: spec.kind }),
      ),
      context.maxResults,
    );
    return new SearchResult({
      seeds: merged.seeds,
      head: merged.head,
      truncated: merged.truncated,
      consumed: merged.consumed,
      unordered: false,
      backend: this.backend,
      specKind: spec.kind,
    });
  }

  /**
   * 按 `ctx.shardSize`（缺省 `DEFAULT_SHARD_SIZE`）切分 `ctx.sliceBounds` 后并行枚举。
   *
   * 与 `SeedSearcher.searchAll` 的区别只有一个：**这里一定会分片**（哪怕窗口很小），
   * 因为首要目的就是把活摊到多个核上。
   *
   * 调用方：`scenarios/scenario.ts` 的 `Scenario.search` 在 `shouldParallelEnum`
   * 为真时走这里（``preferParallel`` + 宽度过门槛）；否则跑同步 `searchAll`。
   */
  async searchAll(spec: SeedSpec, ctx: SearchContext | null = null): Promise<SearchResult> {
    const context = ctx ?? new SearchContext();
    return this.searchShards(spec, context.shards(), context);
  }

  /**
   * 并行局部搜索：把一条链切成 `chunks` 块派给 worker，结果逐位等于串行。
   *
   * `chunks` 由 :func:`nearChunks` 切出（`[offset, len]`），块起点用
   * `nearEngine.fastNextK(seed, offset)` 在**主线程**算好再发出去。
   *
   * 归并严格按块序：`mergeResults` 保序去重、`head` 取第一个非空块，所以
   * `seeds[0]` 就是「最近的命中」—— 与一次扫完等价（各块互不重叠，连去重都不会触发）。
   */
  async searchNearShards(
    seed: number,
    spec: SeedSpec,
    chunks: Iterable<readonly number[]>,
    ctx: SearchContext | null = null,
  ): Promise<SeedSet> {
    const context = ctx ?? new SearchContext();
    if (this.closed) throw new Canceled("搜索池已关闭");
    if (this.activeCtx !== null) throw new SpecError("搜索池同一时刻只支持一轮搜索");
    const engine = this.nearEngine;
    if (engine === null) {
      throw new BackendUnavailable(
        "搜索池没有 nearEngine，无法按块跳步：构造 SearchPool 时传 nearEngine: rt.engine",
      );
    }
    const start = u32(seed);
    const list: Array<[number, number]> = [];
    let total = 0;
    for (const c of chunks) {
      const offset = Math.trunc(c[0] ?? 0);
      const len = Math.trunc(c[1] ?? 0);
      if (len > 0) {
        list.push([offset, len]);
        total += len;
      }
    }
    if (list.length === 0) return emptySeedSet();
    context.checkCancel();
    const dict = spec.toDict() as unknown as Record<string, unknown>;
    const results = new Array<SearchResult | undefined>(list.length);
    const cap = Math.max(1, Math.trunc(Number(context.maxResults) || 0));
    const guard = new PrefixGuard(list.length, cap);
    let done = 0;
    context.forceReport(0, total, `${spec.kind} 局部并行开始`, "chunk");
    const tasks = list.map(([offset, len], index) => ({
      request: {
        type: "near",
        spec: dict,
        // 跳步在这里（主线程）做：worker 只收到「从哪个种子开始、扫多少步」。
        seed: engine.fastNextK(start, offset),
        limit: len,
      } satisfies JobRequest,
      done: (set: SeedSet): void => {
        results[index] = new SearchResult({
          seeds: set.seeds,
          head: set.head,
          truncated: set.truncated,
          // ⚠️ 原样透传（``*2`` 家族本来就是 ``null``）。写 ``set.consumed ?? len`` 会让
          // 「分块跑」的 ``consumed`` 变成总步数，而一次扫完是 ``null`` —— 就不一致了。
          consumed: set.consumed,
          backend: this.backend,
          specKind: spec.kind,
        });
        guard.mark(index, set.seeds.length);
        done += len;
        context.report(done, total, `${spec.kind} 局部并行 ${index + 1}/${list.length} 块`, "chunk");
      },
    }));
    await this.submit(tasks, context, () => guard.stopped);
    context.forceReport(total, total, `${spec.kind} 局部并行完成`, "chunk");
    const merged = mergeResults(
      results.map(
        (r) =>
          r ??
          new SearchResult({ head: 0, consumed: 0, backend: this.backend, specKind: spec.kind }),
      ),
      context.maxResults,
    );
    return seedSet(merged.seeds, merged.head, merged.truncated, merged.consumed);
  }

  /**
   * 并行局部搜索的完整结果（`SearchResult`，带 `nearest` / `distance`）。
   *
   * 调用方**必须先**用 `shouldParallelNear` 判断该不该走这里（步数过门槛 + 后端支持）；
   * 池子不自己判断，因为「不支持时怎么办」是上层的事（退到串行，而不是在这里抛错）。
   *
   * 切块数取 `size * 8`（与 C 的 `omp_get_max_threads() * 8` 同思路）：块比 worker 多几倍，
   * 动态派活才能把长尾摊平 —— near 搜索里各块耗时并不总是均匀（某块先填满
   * `SEED_CAP` 就会提前收工）。
   */
  async searchNearest(
    seed: number,
    spec: SeedSpec,
    limit: number,
    ctx: SearchContext | null = null,
  ): Promise<SearchResult> {
    const context = ctx ?? new SearchContext();
    const engine = this.nearEngine;
    if (engine === null) {
      throw new BackendUnavailable(
        "搜索池没有 nearEngine，无法算 distance：构造 SearchPool 时传 nearEngine: rt.engine",
      );
    }
    const steps = Math.trunc(limit);
    const set = await this.searchNearShards(
      seed,
      spec,
      nearChunks(steps, this.size * 8),
      context,
    );
    return nearResult(set, u32(seed), steps, engine, this.backend, spec.kind);
  }

  /**
   * 预热：给每个 worker 发一条 ping，把 wasm 加载起来。
   *
   * 用户按下搜索前先调一次，能省掉第一片那 ~百毫秒的加载与实例化。
   *
   * ⚠️ 「尽力而为」：单个 worker 超时就跳过它（不抛错），因为预热失败不该阻断搜索 ——
   * 真正的问题会以第一片失败的形式暴露出来，那时的报错信息才带着上下文。
   */
  async warmup(timeoutMs = this.timeoutMs): Promise<void> {
    if (this.closed) throw new Canceled("搜索池已关闭");
    this.ensureSlots();
    await Promise.all(this.slots.map((slot) => this.ping(slot, timeoutMs)));
  }

  /** 关掉所有 worker；在途任务一律以 `Canceled` 结束。 */
  terminate(reason = "搜索池已关闭"): void {
    this.closed = true;
    this.activeCtx = null;
    this.queue.length = 0;
    for (const slot of this.slots) {
      try {
        slot.worker.terminate();
      } catch {
        /* 已经死了就算了 */
      }
    }
    this.slots.length = 0;
    const pending = [...this.jobs.values()];
    this.jobs.clear();
    for (const job of pending) job.reject(new Canceled(reason));
    const pings = [...this.pings.values()];
    this.pings.clear();
    for (const done of pings) done();
  }

  // ------------------------------------------------------------------ 内部
  private ensureSlots(): void {
    if (this.slots.length >= this.size) return;
    while (this.slots.length < this.size) {
      const index = this.slots.length;
      let worker: WorkerLike;
      try {
        worker = this.createWorker(index);
      } catch (err) {
        // 一个都建不起来才算致命；已经建好的就先用着（降级成小池子）。
        if (this.slots.length === 0) throw err;
        break;
      }
      const slot: Slot = { index, worker, job: null, acked: false };
      worker.addEventListener("message", (event: { data: PoolResponse }) =>
        this.onMessage(slot, event.data),
      );
      this.slots.push(slot);
    }
  }

  private ping(slot: Slot, timeoutMs: number): Promise<void> {
    this.nextPing += 1;
    const id = -this.nextPing;
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.pings.delete(id);
        resolve();
      }, timeoutMs);
      this.pings.set(id, () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        slot.worker.postMessage({ type: "ping", id } satisfies PoolRequest);
      } catch {
        clearTimeout(timer);
        this.pings.delete(id);
        resolve();
      }
    });
  }

  /**
   * 把任务派出去，全部回来（或第一次失败）就 settle。
   *
   * `tasks[i].done` 一定在**第 i 个**任务的响应到达时被调用 —— 归并的顺序保证在这一层，
   * 调用方只管往 `results[i]` 里放。
   *
   * `stop` 非空时，每次派活前先问一句「还要不要接着算」；一旦它给 `true`，
   * 排队里的任务全部以**空结果** resolve（见 :meth:`flushQueue`）。
   */
  private submit(
    tasks: ReadonlyArray<{
      readonly request: JobRequest;
      readonly done: (set: SeedSet) => void;
    }>,
    ctx: SearchContext,
    stop: (() => boolean) | null = null,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let remaining = tasks.length;
      let settled = false;
      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        // 失败即清空排队与登记，避免留下永不被 resolve 的 promise。
        this.queue.length = 0;
        const pending = [...this.jobs.values()];
        this.jobs.clear();
        for (const job of pending) job.reject(err);
        reject(err);
      };
      if (remaining === 0) {
        // 空任务列表：立刻完成（不能指望循环里那个 ``resolve``）。
        settled = true;
        resolve();
        return;
      }
      this.activeCtx = ctx;
      this.stopMore = stop;
      this.ensureSlots();
      for (const task of tasks) {
        const job: Job = {
          id: this.nextId++,
          request: task.request,
          resolve: (set) => {
            task.done(set);
            remaining -= 1;
            if (remaining === 0 && !settled) {
              settled = true;
              resolve();
            }
          },
          reject: fail,
        };
        this.jobs.set(job.id, job);
        this.queue.push(job);
      }
      try {
        this.dispatch();
      } catch (err) {
        fail(err);
      }
    }).finally(() => {
      this.activeCtx = null;
      this.stopMore = null;
    });
  }

  /** 给每个空闲槽位派一个排队中的任务。 */
  private dispatch(): void {
    if (this.closed || this.jobs.size === 0) return;
    if (this.activeCtx?.cancelled) {
      this.abort(new Canceled("搜索已取消"));
      return;
    }
    for (const slot of this.slots) {
      if (slot.job !== null) continue;
      if (this.queue.length === 0) return;
      // 前缀已满 ⇒ 剩下的块不再派活，直接判空（C 的 ``if (st.prefix_full) continue;``）。
      if (this.stopMore !== null && this.stopMore()) {
        this.flushQueue();
        return;
      }
      const job = this.queue.shift();
      if (job === undefined) return;
      if (!this.jobs.has(job.id)) continue; // 已被取消/失败清理掉
      slot.job = job;
      slot.acked = false;
      // 唯一拼消息的地方：`id` 补在模板上，任务类型由模板自带。
      const msg = { ...job.request, id: job.id } as PoolRequest;
      try {
        slot.worker.postMessage(msg);
      } catch (err) {
        slot.job = null;
        this.jobs.delete(job.id);
        this.dropSlot(slot, err);
        job.reject(err);
        return;
      }
    }
  }

  /**
   * 前缀已满：把还在排队、**还没派出去**的任务直接判空。
   *
   * 用 `resolve(emptySeedSet())` 而不是 `reject` —— 有序归并里它们本来就会被截掉，
   * 当空块看待的结果与串行（扫到数组满就返回）逐位相同；在途的块则会自然跑完，
   * 这也是 C 侧那个 benign race 的同一件事（读到旧值最多多算一个块）。
   */
  private flushQueue(): void {
    while (this.queue.length > 0) {
      const job = this.queue.shift();
      if (job === undefined) break;
      if (!this.jobs.has(job.id)) continue;
      this.jobs.delete(job.id);
      try {
        job.resolve(emptySeedSet());
      } catch (err) {
        job.reject(err);
      }
    }
  }

  /** 取消整个池子当前这一轮（worker 留着，只是不再派新活）。 */
  private abort(err: Error): void {
    this.queue.length = 0;
    const pending = [...this.jobs.values()];
    this.jobs.clear();
    for (const job of pending) job.reject(err);
  }

  /** 槽位级故障（worker 崩了 / postMessage 抛了）：踢掉它，让别人接着干。 */
  private dropSlot(slot: Slot, err: unknown): void {
    const idx = this.slots.indexOf(slot);
    if (idx >= 0) this.slots.splice(idx, 1);
    try {
      slot.worker.terminate();
    } catch {
      /* ignore */
    }
    const job = slot.job;
    slot.job = null;
    if (job !== null) {
      this.jobs.delete(job.id);
      job.reject(err);
    }
    if (!this.closed) {
      try {
        this.ensureSlots();
        this.dispatch();
      } catch {
        /* 补不回来就算了：在途任务会因收不到响应而失败 */
      }
    }
  }

  private onMessage(slot: Slot, resp: PoolResponse): void {
    if (resp.type === "ack") {
      if (slot.job !== null && slot.job.id === resp.id) slot.acked = true;
      return;
    }
    if (resp.type === "pong") {
      const done = this.pings.get(resp.id);
      if (done !== undefined) {
        this.pings.delete(resp.id);
        done();
      }
      return;
    }
    const job = slot.job;
    if (job === null || job.id !== resp.id) return; // 迟到的响应：任务已被取消/丢弃
    slot.job = null;
    this.jobs.delete(job.id);
    if (resp.type === "error") {
      job.reject(rehydrate(resp.name, resp.message));
    } else {
      // ⚠️ 别写成 ``resp.type === "slice" || resp.type === "near"``：`ResultResponse.type`
      // 是两个字面量的联合，那种判断**收不掉** `ErrorResponse`，于是 ``resp.name`` 报错。
      // 先问 `error` 才能让剩下的一支自己收敛成 `ResultResponse`。
      try {
        job.resolve(seedSet(resp.seeds, resp.head, resp.truncated, resp.consumed));
      } catch (err) {
        job.reject(err);
      }
    }
    if (!this.closed) this.dispatch();
  }
}
