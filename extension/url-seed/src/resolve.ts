/**
 * 恢复的执行层 —— 扩展里**唯一**碰 wasm 的地方。
 *
 * 这一层刻意做得很薄，因为它要守的规矩只有一条：**结果必须和网页版逐位一致**。
 * 也就是说这里的算法一个字节都不许自己写，只能把参数摆好、去调网页版那一份：
 *
 * | 这一步 | 谁做的 | 为什么 |
 * | --- | --- | --- |
 * | URL → 随机整数 | :mod:`./formula` 的公式（用户可改） | 每种 URL 的倍率不同，这是「规则」的事 |
 * | 随机整数 → 种子 | :func:`~scenarios/seed_resolve.resolveCandidates` | 只有唯一解才算解，多解时**不能**随便挑一个 |
 * | 种子 → 后移 N 次 | :func:`advanceSeed`（**扩展独有**） | 恢复出的是「读出匹配值**之前**」的种子，之后又推进了 N 步要补回来 |
 * | wasm 从哪来 | :func:`~wasm/runtime.createRuntime` | 单文件版的内联 Base64，零网络请求 |
 *
 * ⚠️ 表格里第三行是**唯一**一处「网页版没有」的加工：它纯粹是**展示口径**
 * （游戏通常按 ``rand_next`` 取值 —— 读一个数就顺手推进种子，所以「现在的种子」
 * 比恢复结果靠后若干步），不影响恢复本身。
 * 后移用朴素循环而非快速幂 —— N 是玩家手填的个位数，快速幂的 GF(2) 矩阵乘法
 * 只会把这行代码变成「另一个需要和别处对齐的算法」。
 *
 * ``Runtime`` 的第二参数 ``pool`` 恒为 ``null``：``IntervalSpec`` 从来不并行，
 * 而扩展里没有 worker（也不想为此再内联一份 worker 源码）—— 于是每次恢复都是
 * 同步跑在内容脚本的线程上。实测单次 1~2 秒，面板上有「计算中…」挡着，
 * 不值得为它引入 worker。**如果哪天真的卡**，要换的也只是这一层。
 *
 * 还有一处**必须**兜住的现实：``ensure()`` 返回的那个 promise 是这份单例上**所有**恢复
 * 共用的入口，它一旦**既不肯 resolve 也不肯 reject**，``busy`` 就永远是 ``true``
 * —— 面板永久停在「恢复中…」、按钮永久禁用，点几次「恢复」也只会被塞进队列。
 * 这在浏览器上真发生过（刷新页面后内容脚本刚注入，``fetch(data:application/wasm;…)``
 * 在文档被换掉的那一刻没了下文）：emscripten 那边只有「成」和「败」两条路，
 * **没有**「等多久算失败」这条路。所以闸门就放在加载这一层 ——
 * 每次尝试最多等 :data:`LOAD_TIMEOUT_MS`、超时/失败自动重试，总计
 * :data:`LOAD_ATTEMPTS` 次；再不行就抛 :class:`ResolveError` 出去，
 * ``runResolve`` 的 ``catch`` 会把它显示成「恢复失败…」并把按钮放回去，
 * 而不是无声无息地卡住。
 *
 * 另一个容易踩的点：``resolveCandidates`` 的返回里 ``seed === 0`` 是**正常结果**
 * 而不是错误 —— ``src`` 的原话是 ``results[0] if len(results) == 1 else 0``，
 * 「零个候选」与「多个候选」都返回 0。所以这里必须把 ``candidates`` 一起带出去，
 * 否则面板没法把「找不到」和「不唯一」讲清楚。
 */

import { Runtime } from "../../../src/scenarios/scenario";
import { resolveCandidates } from "../../../src/scenarios/seed_resolve";
import { createRuntime, type RuntimeOptions, type WasmRuntime } from "../../../src/wasm/runtime";
import { MAX_RANDOM_INT } from "./formula";
import { MAX_FASTNEXT } from "./rules";

/** 恢复失败（参数不对、wasm 起不来）：文案已经是给用户看的中文。 */
export class ResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolveError";
  }
}

/** 一次恢复的全部产出 —— 面板只认这个结构，不认 ``ResolveResult`` 的内部形状。 */
export interface ResolveOutcome {
  /** 恢复值（更早那个随机整数，= ``resolveCandidates`` 的 ``randomInt``）。 */
  readonly randomInt: number;
  /** 匹配值（更晚那个随机整数，= ``resolveCandidates`` 的 ``target``）。 */
  readonly target: number;
  /** 唯一解；``0`` = 没找到 / 多个候选（两者与 ``src`` 一样不区分）。 */
  readonly seed: number;
  /** ``seed !== 0``。 */
  readonly found: boolean;
  /** 实际后移的 ``FastNext()`` 次数（0 = 没动）。 */
  readonly fastnext: number;
  /** 通过筛选的全部候选（含被 ``seed`` 取走的那个），**已按 ``fastnext`` 后移**。 */
  readonly candidates: readonly number[];
  /** 逐条说明（多解 / 全被排除 / 恢复不到），可能为空。 */
  readonly notes: readonly string[];
  /** 面板直接显示的一行结论。 */
  readonly summary: string;
}

export interface ResolverOptions {
  /**
   * 显式喂 wasm 二进制。
   *
   * ⚠️ 实测**当前那份 ``cracker.mjs`` 并不读它**：胶水里 ``var wasmBinary`` 只有声明、
   * 没有从 ``Module`` 赋值，``getWasmBinary()`` 拿到二进制之后照样去读 ``locateFile``
   * 给的那个路径。也就是说单文件版/扩展能跑起来，靠的是 vite 把 ``?url`` 内联成的
   * ``data:application/wasm;base64,…``（走 ``locateFile`` 这条路），而不是这里的 Base64。
   *
   * 于是这个字段目前**只是为了不破坏既有接口**；想换 wasm 的位置请用 :attr:`locateFile`。
   */
  readonly wasmBinary?: Uint8Array;
  /**
   * 覆盖 ``cracker.wasm`` 的位置（就是 ``createRuntime`` 的那个 ``locateFile``）。
   *
   * **node / vitest 里必须给**：那里 vite 的 ``?url`` 是根相对路径
   * （``/src/wasm/cracker.wasm``），emscripten 的 node 分支拿它当文件路径读，必然 ENOENT。
   * 浏览器里不用给。
   */
  readonly locateFile?: (path: string, scriptDirectory: string) => string;
  /** 直接注入一个现成的 ``Runtime``（测试用；给了就完全不碰 wasm 加载）。 */
  readonly runtime?: Runtime;
  /**
   * 换掉「造 Runtime」这件事本身（**测试用**：给一个永不 settle 的实现就能验超时）。
   * 生产路径不要传 —— 默认就是 :func:`~wasm/runtime.createRuntime`。
   */
  readonly create?: (options: RuntimeOptions) => Promise<WasmRuntime>;
}

/** 输入范围自检 —— 越界在这里拦，别喂给 wasm 再让它给出莫名其妙的结果。 */
function checkRandomInt(value: number, what: string): number {
  if (!Number.isFinite(value)) {
    throw new ResolveError(`${what}不是有效数字：${String(value)}`);
  }
  const truncated = Math.trunc(value);
  if (truncated < 0 || truncated > MAX_RANDOM_INT) {
    throw new ResolveError(`${what} ${truncated} 超出 31 位随机数范围（0~${MAX_RANDOM_INT}）`);
  }
  return truncated;
}

/** 「后移次数」自检 —— 与 :func:`checkRandomInt` 同样只做**报错**，不静默纠正。 */
function checkFastnext(value: number): number {
  if (!Number.isFinite(value)) {
    throw new ResolveError(`后移次数不是有效数字：${String(value)}`);
  }
  const truncated = Math.trunc(value);
  if (truncated < 0) {
    throw new ResolveError(`后移次数不能为负数：${truncated}（只会往后推，不会往前）`);
  }
  if (truncated > MAX_FASTNEXT) {
    throw new ResolveError(`后移次数 ${truncated} 超出上限 ${MAX_FASTNEXT}`);
  }
  return truncated;
}

/**
 * 把种子往后推 ``times`` 次 ``FastNext()``。**朴素循环**，不用快速幂 ——
 * 见文件头那段的理由（N 只是个位数，且这里不想再造一个「要对齐的算法」）。
 *
 * ``fastNext`` 是双射（GF(2) 上的可逆线性变换）⇒ 后移**不会**把两个不同候选并成
 * 一个，候选个数与相对顺序都保持；``seed === 0`` 也照样映射成 0（0 是固定点）。
 */
function advanceSeed(rt: Runtime, seed: number, times: number): number {
  let current = seed;
  for (let i = 0; i < times; i += 1) current = rt.engine.fastNext(current);
  return current;
}

/**
 * 没有唯一解时的那行结论。面板上**正面**的写法就是 ``种子: N``
 * （见 :func:`makeSummary`），所以这里必须跟着是 ``种子: -``。
 *
 * ⚠️ **不要再**去 import ``scenarios/seed_resolve`` 的 ``NO_HIT_PREVIEW`` —— 那是
 * 计算器「属性预览」的标签，会跟着那边改措辞（2026-10 就从「种子: -」改成了
 * 「命中种子: -」，扩展跟着变反而与自己的正面写法对不上）。两边长得一样只是巧合，
 * 不是契约。
 */
const NO_HIT_PREVIEW = "种子: -";

/** 一行结论。没命中时的写法见 :data:`NO_HIT_PREVIEW`。 */
function makeSummary(seed: number, candidates: readonly number[], fastnext: number): string {
  if (seed !== 0) {
    return fastnext > 0 ? `种子: ${seed}（已后移 ${fastnext} 步）` : `种子: ${seed}`;
  }
  if (candidates.length === 0) return `${NO_HIT_PREVIEW}（无候选）`;
  return `${NO_HIT_PREVIEW}（${candidates.length} 个候选，无法唯一确定）`;
}

/**
 * 单次 wasm 加载的等待上限（毫秒）与总尝试次数（含第一次）。
 *
 * 冷启动实测 45~200 毫秒，10 秒 × 2 次不会误伤正常路径；它换来的东西见文件头：
 * 加载**永不返回**时不会把面板永久锁死，重试一次还能把「刷新那一下丢掉的加载」捡回来。
 */
const LOAD_TIMEOUT_MS = 10_000;
const LOAD_ATTEMPTS = 2;

/** 超时文案（一次写成常量，免得拼接出半截句子）。 */
const LOAD_TIMEOUT_MESSAGE = `加载 cracker.wasm 超时（${LOAD_TIMEOUT_MS / 1000} 秒内没有结果）`;

/** 给一个 promise 装一道「到点就 reject」的闸门；原 promise 先 settle 时把定时器撤掉。 */
function withTimeout<T>(task: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ResolveError(timeoutMessage));
    }, ms);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * 恢复器。一次建好 wasm 就复用 —— ``createRuntime`` 本身也缓存模块，
 * 这里再缓存一层只是为了少走一次 ``await`` 与错误分支。
 */
export class Resolver {
  private runtime: Runtime | null = null;
  private pending: Promise<Runtime> | null = null;

  constructor(private readonly options: ResolverOptions = {}) {}

  /** wasm 已经就绪（面板据此决定要不要先显示「加载中…」）。 */
  get loaded(): boolean {
    return this.runtime !== null;
  }

  /**
   * 建（或复用）运行时；失败**不缓存**，下一次调用会重试。
   *
   * ``pending`` 是**故意**共用的：并发的几次恢复只加载一次。代价是它一旦悬住就连锁整个
   * 面板，所以 :meth:`load` 里给每次尝试都装了超时（见文件头）。
   */
  private ensure(): Promise<Runtime> {
    const injected = this.options.runtime;
    if (injected !== undefined) {
      this.runtime = injected;
      return Promise.resolve(injected);
    }
    if (this.runtime !== null) return Promise.resolve(this.runtime);
    if (this.pending === null) {
      this.pending = this.load().catch((err: unknown) => {
        this.pending = null; // 失败别留下「永远 reject」的缓存（也别留下永不 settle 的那份）
        throw err instanceof ResolveError
          ? err
          : new ResolveError(`加载 cracker.wasm 失败：${err instanceof Error ? err.message : String(err)}`);
      });
    }
    return this.pending;
  }

  /**
   * 真正去建运行时：每次尝试都必须在 :data:`LOAD_TIMEOUT_MS` 内给出结果。
   *
   * 单次失败（不管是被拒还是超时）都不立刻放弃 —— 刷新页面之后那一下最典型的失败是
   * 「请求发出去了但没了下文」，隔开一次重新发起往往就成了。所以总计试
   * :data:`LOAD_ATTEMPTS` 次，只有全都不成才抛错。
   */
  private async load(): Promise<Runtime> {
    const { wasmBinary, locateFile } = this.options;
    const create = this.options.create ?? createRuntime;
    const call: RuntimeOptions = {};
    if (wasmBinary !== undefined) call.wasmBinary = wasmBinary;
    if (locateFile !== undefined) call.locateFile = locateFile;
    let last: unknown = null;
    for (let attempt = 1; attempt <= LOAD_ATTEMPTS; attempt += 1) {
      try {
        const backend = await withTimeout(create(call), LOAD_TIMEOUT_MS, LOAD_TIMEOUT_MESSAGE);
        // ``Runtime`` 的 pool 恒为 null —— 见文件头。
        const rt = Runtime.resolve(backend);
        this.runtime = rt;
        return rt;
      } catch (err) {
        last = err;
      }
    }
    const reason = last instanceof Error ? last.message : String(last);
    throw new ResolveError(`加载 cracker.wasm 失败（已尝试 ${LOAD_ATTEMPTS} 次）：${reason}`);
  }

  /**
   * 预热（面板一展开就调，别让用户第一次点「恢复」时等 wasm）。
   *
   * 失败会 reject（文案里已经写明原因），调用方**必须**接住 —— 内容脚本把它记进日志
   * 并显示到状态栏，否则用户看到的就是「一个什么都不会发生、也不知道为什么的面板」。
   */
  async warmup(): Promise<void> {
    await this.ensure();
  }

  /**
   * 用**读到的两个随机整数**恢复种子。
   *
   * :param earlier: 更早读到的那一个（``random()`` 系列里先出现的），
   *     也就是 ``resolveCandidates`` 的 ``randomInt`` —— 反演的入口。
   * :param later: 更晚读到的那一个，用来在多解里筛掉不合法的候选（``target``）。
   * :param userSeed: 起始值。``0``（默认）表示「手上只有两个随机数」这一常见情形；
   *     非 0 时语义与网页版「恢复值填整数」一致（``earlier`` 退化成无所谓，
   *     ``later`` 才参与筛选）。**面板暂时不暴露这个参数**，接口先留着 ——
   *     将来若要支持「上次算出的种子 + 这一次的随机数」直接翻倍即可。
   * :param fastnext: 拿到种子后再**往后** ``FastNext()`` 几次（默认 ``0`` 不动，
   *     **扩展独有**，见文件头）。由「匹配值」那条规则的「后移次数」决定 ——
   *     恢复出的是「读出匹配值**之前**」的种子，游戏若是读过数就推进（``rand_next``），
   *     那之后再走几步就是「现在的」种子。
   */
  async resolve(
    earlier: number,
    later: number,
    userSeed = 0,
    fastnext = 0,
  ): Promise<ResolveOutcome> {
    const randomInt = checkRandomInt(earlier, "恢复值");
    const target = checkRandomInt(later, "匹配值");
    const seed0 = checkRandomInt(userSeed, "起始值");
    const shift = checkFastnext(fastnext);
    const rt = await this.ensure();
    const result = resolveCandidates(seed0, randomInt, target, { rt });
    // 只在真的拿到唯一解时后移：多解（``seed === 0``）本来就没有「那个种子」可言，
    // 这时原样端出候选列表反而诚实（它们都是「读到匹配值那一刻」的状态）。
    const shifted = shift > 0 && result.seed !== 0;
    const seed = shifted ? advanceSeed(rt, result.seed, shift) : result.seed;
    const candidates = shifted
      ? result.candidates.map((candidate) => advanceSeed(rt, candidate, shift))
      : [...result.candidates];
    return {
      randomInt,
      target,
      seed,
      found: result.found,
      fastnext: shifted ? shift : 0,
      candidates,
      notes: result.notes.map((note) => note.message),
      summary: makeSummary(seed, candidates, shifted ? shift : 0),
    };
  }
}

/**
 * 内容脚本（面板）共用的一份实例。
 *
 * 不按 tab 分开：一个页面就一份内容脚本，没必要多份；而且 wasm 实例很占内存，
 * 多开几个 tab 时反而应该共用同一段已编译代码（``createRuntime`` 的模块缓存
 * 是模块级的，天然共享）。
 */
export const resolver = new Resolver();
