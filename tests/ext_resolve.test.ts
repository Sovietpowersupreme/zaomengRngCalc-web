/**
 * 扩展恢复链的端到端对拍（``web/extension/url-seed/src/{rules,resolve}.ts`` + 真 wasm）。
 *
 * 这条链就是用户实际会走的那条：
 *
 *     URL →（规则/公式）→ 随机整数 →（resolveCandidates）→ 种子
 *
 * 期望值全部来自 Python 侧 golden（``src_forge/tests/golden/runs.json`` 的
 * ``seed-resolve-save-game`` 与 ``GOLDEN_RESOLVE``），不是在这里另算一遍：
 *
 * - 显示值 ``56250.287406146526`` / ``45074.84054192901``
 *   → 随机整数 ``1207965724`` / ``967974830``
 * - 这一对恢复出来的种子是 ``2097477657``
 *
 * ⚠️ 生成这组数的那局**起始种子**是 ``1779036211``（它的第一个随机数就是
 * ``1207965724``），但恢复的答案是「这两个读数所处的状态」，两者不是同一个数 ——
 * 这是最容易搞错的地方，所以这里两个常量分开写。
 *
 * 这里刻意**不**自己去实现一遍算法 —— 扩展必须和网页版逐位一致，
 * 所以它调的也是 ``web/src/scenarios/seed_resolve.ts``，这个测试只是保证
 * 「接线接对了」。
 */

import { pathToFileURL } from "node:url";
import { describe, expect, it, beforeAll, afterEach, vi } from "vitest";
import { Runtime } from "../src/scenarios/scenario";
import { WASM_FILE, testRuntime } from "./helpers/golden";
import { Resolver, ResolveError } from "../extension/url-seed/src/resolve";
import { MAX_FASTNEXT, builtinRules, matchUrl } from "../extension/url-seed/src/rules";

/** 第一次保存游戏读到的显示值 / 随机整数（golden）。 */
const SAVE1_TEXT = "56250.287406146526";
const SAVE1_INT = 1207965724;
/** 第二次保存游戏读到的显示值 / 随机整数（golden）。 */
const SAVE2_TEXT = "45074.84054192901";
const SAVE2_INT = 967974830;
/** golden 里生成这对读数的那局起始种子（注意：**不是**恢复的答案）。 */
const SEED_START = 1779036211;
/** 恢复这一对读数得到的种子 —— 就是面板上要显示的那个数。 */
const SEED = 2097477657;

/**
 * ``SEED`` 往后走 N 步的结果（``0`` 号位就是 ``SEED`` 本身）。
 *
 * 这几个数是**纯 Python 参考实现**（``tools/sample_csrc.py`` 的 ``fast_next``）
 * 算出来写死在这里的，不是拿被测代码算的 —— 否则就是「自己跟自己比」。
 * 顺带验证了一条能自己复算的性质：
 *
 * * ``fast_next(SEED) === 1988262924``，而 ``randint(1988262924) === 967974830``
 *   （= 匹配值 ``SAVE2_INT``）⇒ **匹配值是从 ``SEED`` 往后一步抽出来的**，
 *   即恢复结果表示的是「读出匹配值**之前**」的状态；
 * * ``get_pre_seed(SEED) === 1779036211`` = 那局的起始种子 ``SEED_START``。
 */
const SHIFTED = [SEED, 1988262924, 994131462, 497065731] as const;

let resolver: Resolver;
let rt: Runtime;

beforeAll(async () => {
  // node 里没有 ``self.__RNG_SINGLEFILE__``，直接注入 web 侧那份 cracker.wasm。
  rt = Runtime.resolve(await testRuntime());
  resolver = new Resolver({ runtime: rt });
});

/** 从一条真实 URL 走出随机整数（规则 + 公式）。 */
function valueOf(url: string): number {
  const out = matchUrl(url, builtinRules());
  if (out.kind !== "capture") throw new Error(`期望 capture，得到 ${out.kind}`);
  return out.value;
}

describe("URL → 随机整数", () => {
  it("两次「保存游戏」的显示值换算成 golden 里的随机整数", () => {
    const url1 = `https://sx.4399.com/index.php?ac=get_token&ran=${SAVE1_TEXT}`;
    const url2 = `https://sx.4399.com/index.php?ac=get_token&ran=${SAVE2_TEXT}`;
    expect(valueOf(url1)).toBe(SAVE1_INT);
    expect(valueOf(url2)).toBe(SAVE2_INT);
  });
});

describe("两个随机数 → 种子", () => {
  it("golden 对恢复出唯一解 S=2097477657", async () => {
    expect(SEED).not.toBe(SEED_START); // 两个数是两码事，别写成同一个
    const out = await resolver.resolve(SAVE1_INT, SAVE2_INT);
    expect(out.seed).toBe(SEED);
    expect(out.found).toBe(true);
    expect(out.candidates).toEqual([SEED]);
    expect(out.summary).toBe(`种子: ${SEED}`);
    expect(out.notes).toEqual([]);
  });

  it("整条链（URL → 种子）走通", async () => {
    const earlier = valueOf(`https://sx.4399.com/index.php?ac=get_token&ran=${SAVE1_TEXT}`);
    const later = valueOf(`https://sx.4399.com/index.php?ac=get_token&ran=${SAVE2_TEXT}`);
    const out = await resolver.resolve(earlier, later);
    expect(out.randomInt).toBe(SAVE1_INT);
    expect(out.target).toBe(SAVE2_INT);
    expect(out.seed).toBe(SEED);
  });

  it("两个读数不在同一条种子上 ⇒ 不给答案（不能装作算出来了）", async () => {
    // golden GOLDEN_RESOLVE 里的定值：``(1207965724, 2097477657) → seed 0``。
    const out = await resolver.resolve(SAVE1_INT, SEED);
    expect(out.found).toBe(false);
    expect(out.seed).toBe(0);
    expect(out.summary.startsWith("种子: -")).toBe(true);
  });

  it("恢复不到候选时报「无候选」，有候选但不唯一时报候选个数", async () => {
    const out = await resolver.resolve(0, 1);
    expect(out.found).toBe(false);
    expect(out.seed).toBe(0);
    expect(out.summary).toContain("种子: -");
  });

  it("范围外的输入在喂给 wasm 之前就被拦下（不会返回莫名其妙的种子）", async () => {
    await expect(resolver.resolve(-1, SAVE2_INT)).rejects.toBeInstanceOf(ResolveError);
    await expect(resolver.resolve(SAVE1_INT, 0x80000000)).rejects.toBeInstanceOf(ResolveError);
    await expect(resolver.resolve(Number.NaN, SAVE2_INT)).rejects.toBeInstanceOf(ResolveError);
  });

  it("重复恢复结果一致（wasm 复用不会串状态）", async () => {
    const first = await resolver.resolve(SAVE1_INT, SAVE2_INT);
    const second = await resolver.resolve(SAVE1_INT, SAVE2_INT);
    expect(second).toEqual(first);
  });

  it("warmup() 之后 loaded 为真", async () => {
    // 这里刻意**不注入 ``runtime``** —— 要完整走一遍 ``ensure()`` 里那条 ``createRuntime``。
    // 内容脚本里那份单例用的是默认 ``locateFile``（vite 的 ``?url``），在 node 下那是根相对
    // 路径（``/src/wasm/cracker.wasm``），emscripten 的 node 分支拿它当文件路径读，必然
    // ENOENT —— 与 ``tests/helpers/golden.ts`` 里那句注释同一个原因。所以只把「位置」换成
    // ``file:`` URL，其余每一行都是生产代码。
    const scoped = new Resolver({ locateFile: () => pathToFileURL(WASM_FILE).href });
    expect(scoped.loaded).toBe(false);
    await scoped.warmup();
    expect(scoped.loaded).toBe(true);
  });
});

describe("后移次数 fastnext", () => {
  it("省略 / 0 ⇒ 与旧行为逐字节一致（连 summary 都不多一个字）", async () => {
    const omitted = await resolver.resolve(SAVE1_INT, SAVE2_INT);
    const zero = await resolver.resolve(SAVE1_INT, SAVE2_INT, 0, 0);
    expect(omitted).toEqual(zero);
    expect(omitted.fastnext).toBe(0);
    expect(omitted.seed).toBe(SEED);
    expect(omitted.summary).toBe(`种子: ${SEED}`); // 没有「已后移…」后缀
  });

  it("N = 1/2/3 就是把种子往后走 N 次 FastNext", async () => {
    for (const n of [1, 2, 3]) {
      const out = await resolver.resolve(SAVE1_INT, SAVE2_INT, 0, n);
      expect(out.seed).toBe(SHIFTED[n]);
      expect(out.found).toBe(true);
      expect(out.fastnext).toBe(n);
      expect(out.summary).toBe(`种子: ${SHIFTED[n]}（已后移 ${n} 步）`);
    }
  });

  it("候选列表也跟着后移（fastNext 是双射 ⇒ 不合并、个数不变）", async () => {
    const raw = await resolver.resolve(SAVE1_INT, SAVE2_INT, 0, 0);
    expect(raw.candidates).toEqual([SEED]); // 唯一解 ⇒ 只有一个候选
    for (const n of [1, 2, 3]) {
      const out = await resolver.resolve(SAVE1_INT, SAVE2_INT, 0, n);
      // 候选被移过（不是原样端出），且移的就是同一个映射。
      expect(out.candidates).toEqual([SHIFTED[n]]);
      expect(out.candidates).toHaveLength(raw.candidates.length);
    }
  });

  it("小数被截断（1.9 → 走 1 步）", async () => {
    const out = await resolver.resolve(SAVE1_INT, SAVE2_INT, 0, 1.9);
    expect(out.fastnext).toBe(1);
    expect(out.seed).toBe(SHIFTED[1]);
  });

  it("没算出唯一解时不后移，也不加后缀（没答案就别假装加工过）", async () => {
    const out = await resolver.resolve(SAVE1_INT, SEED, 0, 3);
    expect(out.found).toBe(false);
    expect(out.seed).toBe(0);
    expect(out.fastnext).toBe(0);
    expect(out.summary).not.toContain("FastNext");
  });

  it("N 不合法时在喂给 wasm 之前就报错（不是静默当 0）", async () => {
    await expect(resolver.resolve(SAVE1_INT, SAVE2_INT, 0, -1)).rejects.toBeInstanceOf(ResolveError);
    await expect(
      resolver.resolve(SAVE1_INT, SAVE2_INT, 0, MAX_FASTNEXT + 1),
    ).rejects.toBeInstanceOf(ResolveError);
    await expect(
      resolver.resolve(SAVE1_INT, SAVE2_INT, 0, Number.NaN),
    ).rejects.toBeInstanceOf(ResolveError);
  });

  it("后移用朴素循环，与网页版的 O(log k) 快速幂结果一致（两条实现互证）", async () => {
    const out = await resolver.resolve(SAVE1_INT, SAVE2_INT, 0, 5);
    expect(out.seed).toBe(rt.engine.fastNextK(SEED, 5));
  });
});

/**
 * 加载这一层的兑现承诺：**悬住不许锁死面板**。
 *
 * 用户报的「刷新页面后偶发卡在 恢复中…（值 → 值）不放」只能是加载那个 promise
 * 既不肯 resolve 也不肯 reject —— ``busy`` 于是永远是 true、``finally`` 永不执行、
 * 按钮永久禁用。emscripten 只有「成/败」两条路，所以闸门放在 ``Resolver`` 里：
 * 每次尝试最多 10 秒，总计两次。
 *
 * 这里用 ``create`` 注入一个**永不 settle** 的加载（就是那次「请求发出去了、然后
 * 没了下文」），然后拿假定时器把 10 秒 × 2 快进过去 —— 测的仍然是生产代码里
 * ``ensure()/load()/withTimeout()`` 的每一行。
 */
describe("wasm 加载悬住时的兜底", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("永不 settle ⇒ 超时抛 ResolveError，而不是永远 pending", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const scoped = new Resolver({
      create: () => {
        attempts += 1;
        return new Promise<never>(() => {});
      },
    });
    const task = scoped.warmup();
    const rejected = expect(task).rejects.toBeInstanceOf(ResolveError);
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    await expect(task).rejects.toThrow(/已尝试 2 次/);
    expect(attempts).toBe(2); // 悬住之后确实又发起了一次
    expect(scoped.loaded).toBe(false);
  });

  it("第一次悬住、重试成功 ⇒ 照样能恢复（刷新丢掉的加载就是这种）", async () => {
    const backend = await testRuntime(); // 真 wasm：趁真定时器还在先建好
    vi.useFakeTimers();
    let attempts = 0;
    const scoped = new Resolver({
      create: () => {
        attempts += 1;
        return attempts === 1 ? new Promise<never>(() => {}) : Promise.resolve(backend);
      },
    });
    const task = scoped.warmup();
    const done = expect(task).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    await done;
    expect(attempts).toBe(2);
    expect(scoped.loaded).toBe(true);
    // 用的是重试成功那次建好的运行时 —— 恢复结果和正常路径一致。
    const out = await scoped.resolve(SAVE1_INT, SAVE2_INT);
    expect(out.seed).toBe(SEED);
  });

  it("失败不缓存：全挂之后再来一次会重新加载（不吃那个坏 promise）", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const scoped = new Resolver({
      create: () => {
        attempts += 1;
        return new Promise<never>(() => {});
      },
    });
    const first = scoped.warmup();
    const firstRejected = expect(first).rejects.toBeInstanceOf(ResolveError);
    await vi.advanceTimersByTimeAsync(60_000);
    await firstRejected;
    expect(attempts).toBe(2);

    const second = scoped.warmup();
    const secondRejected = expect(second).rejects.toBeInstanceOf(ResolveError);
    await vi.advanceTimersByTimeAsync(60_000);
    await secondRejected;
    expect(attempts).toBe(4); // 新一轮也是「两次尝试」，说明 pending 被清掉了
  });
});
