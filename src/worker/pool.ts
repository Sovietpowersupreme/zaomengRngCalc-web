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
import { createInlineWorker } from "../singlefile";
import { chosenVariant, type WasmVariant } from "../wasm/variant";
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

/**
 * 真 `Worker` 的「我自己崩了」两个钩子（`onerror` / `onmessageerror`）。
 *
 * 单独写成一个**可选能力**而不是塞进 :interface:`WorkerLike`：真 `Worker` 两个属性都有，
 * 测试里的假 worker 没有，而给假实现加上必需属性会逼着所有内联工厂跟着改。
 *
 * ⚠️ 不接这两个事件的后果很具体：worker 在装好 `message` 监听**之前**就崩掉
 * （老引擎上 wasm 实例化抛错正是这条路），主线程既收不到 `error` 响应、也收不到任何事件，
 * 那条任务就永远挂着 —— 界面卡在「搜索中」不返回。
 */
type CrashHooks = Partial<Pick<Worker, "onerror" | "onmessageerror">>;

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

/**
 * 真的起一个 worker（vite 只认 `new Worker(new URL("./x.ts", import.meta.url), …)` 这个字面量形态）。
 *
 * ⚠️ **产物里不许有 `{ type: "module" }`，而 dev 里必须有** —— 这是两条规则，别想着「统一」掉任一边。
 *
 * 先看产物这一边：两档产物里的 worker 块都是 **classic**（`worker.format: "iife"`，
 * 档位表在 `vite.config.ts` 的文件头），而 `type` 这个字典成员**不是「加了也无害」**：
 *
 * * Chromium **70~79** 的 `WorkerOptions` 里**已经有** `type`（模块化 worker 是「已实现、
 *   特性被 flag 关着」），于是构造走的是 `ModuleWorkersEnabled()` 的失败分支 ⇒ **直接抛**
 *   ``TypeError: Module scripts are not supported on DedicatedWorker yet … (see https://crbug.com/680046)``。
 *   「老引擎的 WebIDL 字典会静默忽略未知成员」这个假设**恰好在这一段版本上是错的**。
 *   事故内核已由用户实测确认：**Chromium `70.0.3499.0`**（= Chrome 70 稳定分支，模块化 worker
 *   要到 Chrome 80 才转正）。⚠️ 本机内置浏览器是 Chromium 150，**复现不出来** ——
 *   这类「只有老内核才炸」的问题别试图在开发机上原地复现，直接去查该成员是否「已存在但被 flag 关着」；
 * * Firefox < 114 / Safari < 15 反过来是真忽略它 ⇒ 落成 classic，「碰巧」能用。
 *
 * 2026-10-09 用户报的就是这件事：**兼容版离线文件能算**（它走的是 `createInlineWorker` 的
 * classic Blob），而**网页版**（`/legacy/` 多文件档）在这一行抛错。后果不致命 ——
 * :meth:`SearchPool.ensureSlots` 会把异常兜成「小池子或抛错」，`main.ts` 再兜成「退回主线程
 * 串行」（结果逐位一致，只是慢）—— 但多核是实打实地白丢，日志里还多一条红字。
 * （改成只传 `name` 之后，那台 `70.0.3499.0` 上已验证正常。）
 *
 * 要真的在**产物**里用模块化 worker，就得连 `worker.format` 一起改成 `"es"`，而那是 Chrome 80+ 才有
 * 的东西：本项目的下限是 Chromium 70，所以两档一律 classic。
 *
 * 再看 dev 这一边（2026-10-10 用户报的 ``npm run dev`` 报 ``搜索 worker 崩了：Uncaught SyntaxError:
 * Cannot use import statement outside a module``）：**dev 下 vite 根本不打包 worker**。它只把
 * ``new URL("./search.worker.ts", import.meta.url)`` 改写成
 * ``/src/worker/search.worker.ts?worker_file&type=<type>``，而那个 ``<type>`` 是
 * ``vite:worker-import-meta-url`` 从**下面这行的源码字面量**里读出来的 —— ``getWorkerType`` 只认
 * 字面量，``worker.format`` 在 dev 里**完全不参与**。与此同时 worker 文件在 dev 里是**未打包的
 * 原生 ESM**（静态 ``import`` 原样保留）⇒ 按 classic 起就是「classic 容器装 ESM 正文」，
 * 一启动就解析失败；报错经 worker 的 ``error`` 事件变成 :func:`workerCrash` 的文案，正是用户看到的
 * 那一条。``npm run preview`` 没这个问题，因为它服务的是**打包产物**（``iife`` 在那里真的生效了）。
 *
 * 所以 dev 这一支必须显式要 ``{ type: "module" }``：``import.meta.env.DEV`` 在**所有**
 * ``build()`` / ``preview`` 路径上都被静态替换成 ``false``（vite 8.3.1 源码里
 * ``resolveConfig(…, "build", "production", "production")``，preview 同参；只有 ``createServer``
 * 拿 development），死分支会被 rolldown 消除 ⇒ 产物里不会留下 ``type: "module"``，
 * ``tests/legacy_gate.test.ts`` 第 8 组照旧全绿。dev 只服务开发机（现代浏览器即可）；
 * 老内核一律靠 ``build`` / ``preview`` + chrome70 台架验。
 */
function browserWorkerFactory(index: number): WorkerLike {
  // 单文件版优先：此时没有可用的文件 URL，worker 只能从 Blob（classic）起。
  const inline = createInlineWorker(index);
  if (inline !== null) return inline;
  if (typeof Worker === "undefined") {
    throw new BackendUnavailable(
      "当前环境没有 Web Worker，请改用主线程的串行搜索（searcher.searchAll）",
    );
  }
  const name = `rngcalc-search-${index}`;
  // dev：vite 不打包 worker，那个文件是原生 ESM，只能按模块化 worker 起（见上面那段）。
  // ⚠️ 这段注释只能待在这里：构造函数与 `new URL(` 之间塞不得任何东西 —— `vite:worker-import-meta-url`
  // 的正则要求两者紧邻，中间多一个注释就不会改写 URL（dev 与产物会一起坏，而且坏得很安静）。
  if (import.meta.env.DEV) {
    return new Worker(new URL("./search.worker.ts", import.meta.url), { type: "module", name });
  }
  // ⚠️ 打包产物里**只能有 `name`**：多一个 `type: "module"` 就会在老 Chromium 上抛错（见上面那段）。
  return new Worker(new URL("./search.worker.ts", import.meta.url), { name });
}

/**
 * 主线程已定下的 wasm 变体提示（还没定就什么都不带）。
 *
 * 带上它能在老引擎上省掉 worker 的一次注定失败的 modern 尝试；不带也对 ——
 * worker 会自己在本地选，两边逻辑相同，结论必然一致。
 */
function variantHint(): { variant?: WasmVariant } {
  const variant = chosenVariant();
  return variant === undefined ? {} : { variant };
}

/** 把 worker 的 `ErrorEvent` 折成一条能给人看的错误（消息可能空着，只能看 `error`）。 */
function workerCrash(event: unknown): BackendUnavailable {
  const detail = event as { message?: unknown; error?: unknown } | null | undefined;
  const text = [detail?.message, detail?.error]
    .map((v) => (typeof v === "string" ? v : v instanceof Error ? v.message : ""))
    .find((s) => s !== "");
  return new BackendUnavailable(`搜索 worker 崩了：${text ?? "未知原因"}`);
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
  /**
   * 本轮的补建次数（每轮开搜时清零）。
   *
   * 用来堵住「建起来就崩」的无限重建：老引擎上 worker 脚本一进去就抛错时，
   * `dropSlot` → `ensureSlots` 会变成死循环，直接把页面刷爆。超过 `size` 次就不再补，
   * 剩下的活以错误结束（见 :meth:`SearchPool.dropSlot`）。
   */
  private replenished = 0;
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
      // 「worker 自己崩了」的两条路都踢槽位（并让它手上那条任务失败），不再静等。
      // `as` 是必须的：`CrashHooks` 全是可选属性、又和 `WorkerLike` 没有一个公共属性，
      // 直接赋值会撞上 TS 的「弱类型」检查（TS2559）。
      const hooks = worker as WorkerLike & CrashHooks;
      hooks.onerror = (event) => this.dropSlot(slot, workerCrash(event));
      hooks.onmessageerror = () =>
        this.dropSlot(slot, new BackendUnavailable("搜索 worker 的消息无法反序列化"));
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
        slot.worker.postMessage({ type: "ping", id, ...variantHint() } satisfies PoolRequest);
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
      this.replenished = 0;
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
      // 唯一拼消息的地方：`id` 补在模板上，任务类型由模板自带；顺便把已定的
      // wasm 变体顺过去（见 :func:`variantHint`）。
      const msg = { ...job.request, id: job.id, ...variantHint() } as PoolRequest;
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

  /**
   * 槽位级故障（worker 崩了 / `postMessage` 抛了 / 消息反序列化失败）：踢掉它，让别人接着干。
   *
   * 三个入口：`dispatch` 里 `postMessage` 抛错、:meth:`ensureSlots` 挂的 `onerror`、
   * `onmessageerror`。手上那条任务**一定**以 `err` 失败 —— 宁可报错也不让调用方等一个
   * 永远不会来的响应。
   */
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
    if (!this.closed && this.replenished < this.size) {
      this.replenished += 1;
      try {
        this.ensureSlots();
        this.dispatch();
      } catch {
        /* 补不回来就算了：下面那段会把还排着的活一次性失败掉 */
      }
    }
    // 一个能用的槽位都没有、队列里却还有活 ⇒ 再等也不会有人来干，立刻失败。
    // 这比挂着强：调用方（`scenarios`）能把它当成「并行不可用」，报出来或退回串行。
    if (!this.closed && this.slots.length === 0 && this.queue.length > 0) {
      this.abort(new BackendUnavailable(`所有搜索 worker 都不可用：${String(err)}`));
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
