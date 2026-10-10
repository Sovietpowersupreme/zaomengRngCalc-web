/**
 * ``web/src/core/search.ts`` + ``web/src/wasm/searcher.ts`` 的回归测试。
 *
 * 两条腿：
 *
 * 1. **对拍**：直接读 Python 侧同一份 ``src_forge/tests/golden/scenarios.json``
 *    （``slice`` 498 例 + ``near`` 648 例，DLL 采样），逐位比对 ``seeds`` / ``head`` /
 *    ``truncated`` / 命中数。检查函数与 ``src_forge/tests/test_golden.py`` 里的
 *    ``_check_slice_case`` / ``_check_near_case`` 是同一套规则（含 ``more`` 语义）。
 * 2. **契约**：能力表、``clampBounds`` / ``shardBounds`` / ``mergeResults`` 的语义、
 *    截断与 ``maxResults``、局部搜索的 ``distance``，以及 scratch 不泄漏。
 */

import { beforeAll, describe, expect, it } from "vitest";

import { BackendUnavailable, Canceled, SpecError } from "../src/core/errors";
import {
  clampBounds,
  mergeResults,
  nearChunks,
  PARALLEL_MIN_STEPS,
  SearchContext,
  SearchResult,
  shardBounds,
  shouldParallelEnum,
  shouldParallelNear,
  type SeedSet,
} from "../src/core/search";
import { CancelToken } from "../src/core/progress";
import { IntervalSpec, MaskSpec, PoolSpec, RollSpec, specFromDict, type SeedSpec, WuxingSpec } from "../src/core/spec";
import { KMAX, SEED_CAP, u32 } from "../src/core/values";
import type { WasmRuntime } from "../src/wasm/runtime";
import { loadGolden, testRuntime, type ScenariosGolden, type NearCase, type SliceCase } from "./helpers/golden";

let rt: WasmRuntime;

beforeAll(async () => {
  rt = await testRuntime();
});

// --------------------------------------------------------------------------- 对拍
/** 与 Python ``_check_slice_case`` 同规则；返回 ``null`` 表示一致。 */
function checkSlice(c: SliceCase, got: SeedSet): string | null {
  const exp = c.seeds;
  const seeds = [...got.seeds];
  if (seeds.slice(0, exp.length).join(",") !== exp.join(",")) {
    let i = 0;
    while (i < Math.min(seeds.length, exp.length) && seeds[i] === exp[i]) i += 1;
    return `seeds[${i}]: 得到 ${JSON.stringify(seeds.slice(i, i + 1))} 期望 ${JSON.stringify(exp.slice(i, i + 1))}`;
  }
  const want = c.more ?? exp.length;
  if (seeds.length !== want) return `命中数 ${seeds.length} 期望 ${want}`;
  if (got.head !== u32(c.head)) return `head ${got.head} 期望 ${c.head}`;
  if (!!got.truncated !== !!c.truncated) return `truncated ${got.truncated} 期望 ${c.truncated}`;
  return null;
}

/** 与 Python ``_check_near_case`` 同规则。 */
function checkNear(c: NearCase, got: SeedSet): string | null {
  const exp = c.seeds;
  const seeds = [...got.seeds];
  if (seeds.slice(0, exp.length).join(",") !== exp.join(",")) {
    let i = 0;
    while (i < Math.min(seeds.length, exp.length) && seeds[i] === exp[i]) i += 1;
    return `seeds[${i}]: 得到 ${JSON.stringify(seeds.slice(i, i + 1))} 期望 ${JSON.stringify(exp.slice(i, i + 1))}`;
  }
  const want = c.more ?? exp.length;
  if (seeds.length !== want) return `命中数 ${seeds.length} 期望 ${want}`;
  if (got.head !== u32(c.head)) return `head ${got.head} 期望 ${c.head}`;
  return null;
}

describe("slice 对拍 scenarios.json（498 例）", () => {
  it("逐位一致：seeds / head / truncated / 命中数", () => {
    const g = loadGolden<ScenariosGolden>("scenarios.json");
    const sch = rt.searcher;
    const problems: string[] = [];
    for (const c of g.slice) {
      const spec = specFromDict(c.spec);
      if (!sch.supports(spec)) {
        problems.push(`${c.id}: 后端声明不支持 ${spec.kind}`);
        continue;
      }
      const problem = checkSlice(c, sch.searchSlice(spec, c.lo, c.hi));
      if (problem) problems.push(`${c.id}: ${problem}`);
      if (problems.length > 20) break;
    }
    expect(problems.slice(0, 20)).toEqual([]);
    expect(g.slice.length).toBe(498);
  });
});

describe("near 对拍 scenarios.json（648 例）", () => {
  it("逐位一致：seeds / head / 命中数", () => {
    const g = loadGolden<ScenariosGolden>("scenarios.json");
    const sch = rt.searcher;
    const problems: string[] = [];
    for (const c of g.near) {
      const spec = specFromDict(c.spec);
      if (!sch.supportsNear(spec)) {
        problems.push(`${c.id}: 后端声明不支持 ${spec.kind} 的局部搜索`);
        continue;
      }
      const problem = checkNear(c, sch.searchNear(c.seed, spec, c.limit));
      if (problem) problems.push(`${c.id}: ${problem}`);
      if (problems.length > 20) break;
    }
    expect(problems.slice(0, 20)).toEqual([]);
    expect(g.near.length).toBe(648);
  });
});

// --------------------------------------------------------------------------- 契约
const allPass = (): SeedSpec =>
  specFromDict({
    kind: "interval",
    step: 1,
    constraints: [{ kind: "interval", lo: 0, hi: KMAX }],
    scanner: "crack",
  });

// 下面这几个 dict 直接照抄 ``scenarios.json`` 里出现过的形状 —— 那是**验证过能被
// ``specFromDict`` 解析**的最小集合，别自己造字段（容易撞 SpecError）。
const MASK_DICT = {
  kind: "mask",
  step: 1,
  constraints: [{ kind: "mask", mask: 65535, value: 3883208861 }],
  imask: 65535,
};
const ROLL_DICT = {
  kind: "roll",
  step: 1,
  constraints: [{ kind: "interval", lo: 0, hi: KMAX }],
  roll_vals: [1],
  gem_vals: [],
  gem_index: [],
};
const WUXING_DICT = {
  kind: "wuxing",
  step: 1,
  constraints: [{ kind: "interval", lo: 0, hi: KMAX }],
  target_wx: 0,
  bagua_growth: [0, 0],
};
const POOL_DICT = {
  kind: "pool",
  step: 1,
  constraints: [
    { kind: "interval", lo: 0, hi: KMAX },
    { kind: "interval", lo: 0, hi: KMAX },
    { kind: "interval", lo: 0, hi: KMAX },
  ],
  total: 60,
  roll_vals: [],
};

describe("能力表", () => {
  it("supports：五种规格全支持，其余（如 growth-wuxing）不支持", () => {
    const sch = rt.searcher;
    const specs: [string, SeedSpec, boolean][] = [
      ["interval", allPass(), true],
      ["mask", specFromDict(MASK_DICT), true],
      ["roll", specFromDict(ROLL_DICT), true],
      ["wuxing", specFromDict(WUXING_DICT), true],
      ["pool", specFromDict(POOL_DICT), true],
      // growth-wuxing 不可枚举，wasm 后端根本不接（由场景自己前扫）。
      ["growth-wuxing", { kind: "growth-wuxing" } as unknown as SeedSpec, false],
    ];
    for (const [label, spec, want] of specs) {
      expect([label, sch.supports(spec)]).toEqual([label, want]);
    }
  });

  it("supportsNear：mask 永远不行；interval 只认 crack", () => {
    const sch = rt.searcher;
    const interval = (scanner: string) =>
      specFromDict({
        kind: "interval",
        step: 1,
        constraints: [{ kind: "interval", lo: 0, hi: KMAX }],
        scanner,
      });
    expect(sch.supportsNear(interval("crack"))).toBe(true);
    expect(sch.supportsNear(interval("crack2"))).toBe(false);
    expect(sch.supportsNear(specFromDict(MASK_DICT))).toBe(false);
    expect(sch.supportsNear(specFromDict(ROLL_DICT))).toBe(true);
    expect(sch.supportsNear(specFromDict(WUXING_DICT))).toBe(true);
    expect(sch.supportsNear(specFromDict(POOL_DICT))).toBe(true);
  });

  it("searchNear 对不支持的规格抛 BackendUnavailable", () => {
    const sch = rt.searcher;
    expect(() => sch.searchNear(1, specFromDict(MASK_DICT), 100)).toThrow(BackendUnavailable);
    const crack2 = specFromDict({
      kind: "interval",
      step: 1,
      constraints: [{ kind: "interval", lo: 0, hi: KMAX }],
      scanner: "crack2",
    });
    expect(() => sch.searchNear(1, crack2, 100)).toThrow(/crack2/);
  });

  it("growth-wuxing / 未知规格在 searchSlice 里抛 BackendUnavailable", () => {
    // 这个假 spec 能通过 ``u32Bounds``/``num`` 的读取，因此**能走进 try 块**，
    // 正好顺带验证 finally 归还了 scratch（见下一个用例）。
    const fake = {
      kind: "growth-wuxing",
      step: 1,
      num: 1,
      u32Bounds: [[0, KMAX]],
    } as unknown as SeedSpec;
    expect(() => rt.searcher.searchSlice(fake, 0, 100)).toThrow(BackendUnavailable);
  });
});

describe("区间工具", () => {
  it("clampBounds：hi 夹到 KMAX，空/反区间归一成 (0,0)", () => {
    expect(clampBounds([0, KMAX])).toEqual([0, KMAX]);
    expect(clampBounds([0, 0xffffffff])).toEqual([0, KMAX]);
    expect(clampBounds([10, 10])).toEqual([0, 0]);
    expect(clampBounds([20, 10])).toEqual([0, 0]);
    expect(clampBounds([1, 2])).toEqual([1, 2]);
  });

  it("shardBounds：覆盖完整、步长一致、越界先夹", () => {
    expect(shardBounds([0, 10], 4)).toEqual([
      [0, 4],
      [4, 8],
      [8, 10],
    ]);
    expect(shardBounds([0, 0], 4)).toEqual([]);
    const all = shardBounds([0, KMAX], 1 << 20);
    expect(all.length).toBe(2048);
    expect(all[0]).toEqual([0, 1 << 20]);
    expect(all[all.length - 1]?.[1]).toBe(KMAX);
  });
});

describe("mergeResults", () => {
  const mk = (seeds: number[], head = 0, truncated = false, consumed: number | null = 0) =>
    new SearchResult({ seeds, head, truncated, consumed, backend: "x", specKind: "interval" });

  it("去重保序（按分片顺序）、head 取第一个有命中的分片、consumed 累加", () => {
    const m = mergeResults([mk([], 7, false, 10), mk([5, 3], 3, false, 20), mk([3, 9], 9, true, 30)]);
    expect(m.seeds).toEqual([5, 3, 9]);
    expect(m.head).toBe(3);
    expect(m.consumed).toBe(60);
    expect(m.truncated).toBe(true);
    expect(m.backend).toBe("x");
    expect(m.specKind).toBe("interval");
    expect(m.unordered).toBe(false);
  });

  it("全空时 head 取最后一个分片的值", () => {
    const m = mergeResults([mk([], 7, false, 1), mk([], 11, false, 2)]);
    expect(m.seeds).toEqual([]);
    expect(m.head).toBe(11);
    expect(m.consumed).toBe(3);
  });

  it("maxResults 截断并把 truncated 置真", () => {
    const m = mergeResults([mk([1, 2, 3, 4, 5])], 3);
    expect(m.seeds).toEqual([1, 2, 3]);
    expect(m.truncated).toBe(true);
  });

  it("consumed 一旦有一个分片是 null 就整体为 null", () => {
    const m = mergeResults([mk([1], 1, false, 5), mk([2], 2, false, null)]);
    expect(m.consumed).toBeNull();
  });
});

describe("searchAll / 分片 / 并行（与 searchSlice 等价）", () => {
  it("searchAll 默认串行 = searchSlice，并带上 consumed", () => {
    const spec = allPass();
    const sch = rt.searcher;
    const got = sch.searchAll(spec, new SearchContext({ sliceBounds: [0, 300] }));
    const raw = sch.searchSlice(spec, 0, 300);
    expect(got.seeds).toEqual([...raw.seeds]);
    expect(got.head).toBe(raw.head);
    expect(got.consumed).toBe(300);
    expect(got.unordered).toBe(false);
    expect(got.backend).toBe("wasm");
    expect(got.specKind).toBe("interval");
    expect(got.count).toBe(got.seeds.length);
    expect(got.found).toBe(true);
    expect(got.first).toBe(got.seeds[0]);
    expect([...got]).toEqual([...got.seeds]);
    expect(got.toDict()["spec_kind"]).toBe("interval");
  });

  it("空窗口：consumed=0 且结果为空", () => {
    const got = rt.searcher.searchAll(allPass(), new SearchContext({ sliceBounds: [300, 300] }));
    expect(got.count).toBe(0);
    expect(got.consumed).toBe(0);
  });

  it("searchShards 与 searchAll 一致（不均匀分片）", () => {
    const spec = allPass();
    const sch = rt.searcher;
    const shards = [
      [0, 10],
      [10, 50],
      [50, 114],
      [114, 178],
      [178, 242],
      [242, 300],
    ];
    const got = sch.searchShards(spec, shards);
    const ref = sch.searchAll(spec, new SearchContext({ sliceBounds: [0, 300] }));
    expect(got.seeds).toEqual(ref.seeds);
    expect(got.head).toBe(ref.head);
    expect(got.consumed).toBe(300);
  });

  it("preferParallel 走默认实现：逐位一致且仍然标 unordered=false", () => {
    const spec = allPass();
    const sch = rt.searcher;
    const got = sch.searchAll(
      spec,
      new SearchContext({ sliceBounds: [0, 300], preferParallel: true, shardSize: 64 }),
    );
    const ref = sch.searchAll(spec, new SearchContext({ sliceBounds: [0, 300] }));
    expect(got.seeds).toEqual(ref.seeds);
    expect(got.head).toBe(ref.head);
    // Web 侧没有 *_mp（wasm 不能加 -fopenmp），并行实现按片有序归并 -> 不是集合语义
    expect(got.unordered).toBe(false);
    expect(got.backend).toBe("wasm");
    expect(got.consumed).toBe(300);
  });

  it("maxSliceWidth 的分片串联与一次扫完逐位一致", () => {
    const spec = allPass();
    const sch = rt.searcher;
    const saved = sch.maxSliceWidth;
    sch.maxSliceWidth = 64;
    try {
      const got = sch.searchAll(spec, new SearchContext({ sliceBounds: [0, 300] }));
      const ref = rt.searcher.searchSlice(spec, 0, 300);
      expect(got.seeds).toEqual([...ref.seeds]);
      expect(got.head).toBe(ref.head);
      expect(got.consumed).toBe(300);
    } finally {
      sch.maxSliceWidth = saved;
    }
  });

  it("maxResults 生效并把 truncated 置真", () => {
    const got = rt.searcher.searchAll(
      allPass(),
      new SearchContext({ sliceBounds: [0, 300], maxResults: 3 }),
    );
    expect(got.count).toBe(3);
    expect(got.truncated).toBe(true);
  });

  it("命中写满 SEED_CAP 时截断（999）", () => {
    const spec = allPass();
    const raw = rt.searcher.searchSlice(spec, 0, 5000);
    expect(raw.seeds.length).toBe(SEED_CAP);
    expect(raw.truncated).toBe(true);
  });

  it("取消：已取消的 token 让 searchAll 立刻抛 Canceled", () => {
    const token = new CancelToken();
    token.cancel();
    const ctx = new SearchContext({ sliceBounds: [0, 300], cancelToken: token });
    expect(ctx.cancelled).toBe(true);
    expect(() => rt.searcher.searchAll(allPass(), ctx)).toThrow(Canceled);
    // 未取消的 token 不干扰正常路径。
    const ok = new SearchContext({ sliceBounds: [0, 16], cancelToken: new CancelToken() });
    expect(rt.searcher.searchAll(allPass(), ok).count).toBeGreaterThan(0);
  });
});

describe("searchNearest", () => {
  it("limit < 1 抛 SpecError", () => {
    expect(() => rt.searcher.searchNearest(1, allPass(), 0)).toThrow(SpecError);
  });

  it("支持局部搜索的规格返回 nearest/distance，且与 searchNear 一致", () => {
    const spec = allPass();
    const sch = rt.searcher;
    const got = sch.searchNearest(12345, spec, 1000);
    const raw = sch.searchNear(12345, spec, 1000);
    expect(got.seeds).toEqual([...raw.seeds]);
    expect(got.nearest).toBe(got.first);
    if (got.nearest !== null) {
      expect(got.distance).toBe(rt.engine.seedDistance(12345, got.nearest, 1000));
    }
  });

  it("不支持的规格抛 BackendUnavailable", () => {
    expect(() => rt.searcher.searchNearest(1, specFromDict(MASK_DICT), 100)).toThrow(BackendUnavailable);
  });
});

describe("局部搜索并行（nearChunks / searchNearShards / shouldParallelNear）", () => {
  /**
   * 窄区间 ``wuxing``：``hi`` 越小命中越稀。
   *
   * 实测（当前 wasm）：``hi=20000`` 在 1e8 步内 919 个命中、首个在起点后 117154 步，
   * 所以既能覆盖「命中跨块」，又不会写满 999 而提前截断。
   */
  const narrow = (hi: number): SeedSpec =>
    specFromDict({
      kind: "wuxing",
      step: 1,
      constraints: [{ kind: "interval", lo: 0, hi }],
      target_wx: 0,
      bagua_growth: [0, 0],
    });

  it("nearChunks：limit<=0 返回空，其余覆盖完整、无重叠、只有末块可能短", () => {
    expect(nearChunks(0, 8)).toEqual([]);
    expect(nearChunks(-5, 8)).toEqual([]);
    expect(nearChunks(10, 4)).toEqual([
      [0, 3],
      [3, 3],
      [6, 3],
      [9, 1],
    ]);
    // count 被夹到 [1, limit]：要 100 块也只有 4 块可切。
    expect(nearChunks(4, 1)).toEqual([[0, 4]]);
    expect(nearChunks(4, 100)).toEqual([
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
    ]);
    expect(nearChunks(3, 0)).toEqual([[0, 3]]);
  });

  it("nearChunks：与 C 的 _crackerOrdChunk 同构（块大小 / 块数 / 偏移递增）", () => {
    for (const total of [1, 7, 8, 9, 100, 4096, 100_000, PARALLEL_MIN_STEPS]) {
      for (const count of [1, 2, 7, 8, 64, 4096]) {
        const chunks = nearChunks(total, count);
        const want = Math.min(Math.max(count, 1), total);
        const chunk = Math.max(1, Math.ceil(total / want));
        expect(chunks.length).toBe(Math.ceil(total / chunk));
        let seen = 0;
        for (let i = 0; i < chunks.length; i += 1) {
          const [offset, len] = chunks[i]!;
          expect(offset).toBe(seen);
          expect(len).toBe(Math.min(chunk, total - offset));
          seen += len;
        }
        expect(seen).toBe(total);
      }
    }
  });

  it("searchNearShards：分块 = 一次扫完（逐位一致，且命中跨块）", () => {
    const spec = narrow(20_000);
    const limit = 400_000;
    const ref = rt.searcher.searchNear(12_345, spec, limit);
    // 命中数 + 首个命中是锁死的：规格或 wasm 一改，这里先炸，提醒重新挑参数。
    expect(ref.seeds.length).toBe(5);
    expect(ref.seeds[0]).toBe(317_203_667);
    for (const count of [1, 2, 4, 8, 32]) {
      const got = rt.searcher.searchNearShards(12_345, spec, nearChunks(limit, count), new SearchContext());
      expect([...got.seeds]).toEqual([...ref.seeds]);
      expect(got.head).toBe(ref.head);
      expect(got.truncated).toBe(ref.truncated);
      // ``*2`` 家族拿不到 consumed ⇒ 两边都是 null（分块不能把它写成总步数）。
      expect(got.consumed).toBe(ref.consumed);
      expect(got.consumed).toBeNull();
    }
  });

  it("searchNearShards：空块表 = 空结果", () => {
    const got = rt.searcher.searchNearShards(12_345, narrow(20_000), [], new SearchContext());
    expect(got.seeds.length).toBe(0);
    expect(got.consumed).toBeNull();
  });

  it("supportsNearParallel：只有 *_2 家族（roll / wuxing / pool）", () => {
    const s = rt.searcher;
    expect(s.supportsNearParallel(specFromDict(WUXING_DICT))).toBe(true);
    expect(s.supportsNearParallel(specFromDict(ROLL_DICT))).toBe(true);
    expect(s.supportsNearParallel(specFromDict(POOL_DICT))).toBe(true);
    // interval（seedFindbyRange）/ mask（fastCrack）在 C 侧也没有局部并行版本。
    expect(s.supportsNearParallel(allPass())).toBe(false);
    expect(s.supportsNearParallel(specFromDict(MASK_DICT))).toBe(false);
  });

  it("shouldParallelNear：门槛 = PARALLEL_MIN_STEPS（= MAX_SEED_SEARCH）", () => {
    const s = rt.searcher;
    const spec = specFromDict(WUXING_DICT);
    expect(PARALLEL_MIN_STEPS).toBe(99_999_999);
    expect(new SearchContext().nearParallel).toBe(true);
    expect(shouldParallelNear(s, spec, PARALLEL_MIN_STEPS, new SearchContext())).toBe(true);
    expect(shouldParallelNear(s, spec, PARALLEL_MIN_STEPS + 1, new SearchContext())).toBe(true);
    expect(shouldParallelNear(s, spec, PARALLEL_MIN_STEPS - 1, new SearchContext())).toBe(false);
    // 显式关掉 nearParallel 就不并行（对应 Python 的 ctx.near_parallel）。
    expect(
      shouldParallelNear(s, spec, PARALLEL_MIN_STEPS, new SearchContext({ nearParallel: false })),
    ).toBe(false);
    expect(shouldParallelNear(s, allPass(), PARALLEL_MIN_STEPS, new SearchContext())).toBe(false);
    expect(shouldParallelNear(s, specFromDict(MASK_DICT), PARALLEL_MIN_STEPS, new SearchContext())).toBe(false);
  });

  it("shouldParallelEnum：要开关 + 宽度过门槛（= Python search_all 的条件）", () => {
    const s = rt.searcher;
    // 前提：wasm 后端不分段（maxSliceWidth === null），否则走 *_sharded。
    expect(s.maxSliceWidth).toBeNull();
    expect(new SearchContext().preferParallel).toBe(false);
    // 默认没开关 ⇒ 全空间也不并行（与 Python 的默认 False 一致）。
    expect(shouldParallelEnum(s, new SearchContext())).toBe(false);
    expect(shouldParallelEnum(s, new SearchContext({ sliceBounds: [0, KMAX] }))).toBe(false);
    // 开了开关但宽度不够 ⇒ 还是串行（低于门槛一律串行）。
    const wide = (sliceBounds: readonly number[]): SearchContext =>
      new SearchContext({ preferParallel: true, sliceBounds });
    expect(shouldParallelEnum(s, wide([0, PARALLEL_MIN_STEPS - 1]))).toBe(false);
    // 两个条件都满足 ⇒ 并行；边界（宽度正好 = 门槛）也算。
    expect(shouldParallelEnum(s, wide([0, PARALLEL_MIN_STEPS]))).toBe(true);
    expect(shouldParallelEnum(s, wide([0, 100_000_000]))).toBe(true);
    // 看的是**宽度**不是上界：起点不为 0 时同样成立。
    expect(shouldParallelEnum(s, wide([5, PARALLEL_MIN_STEPS + 5]))).toBe(true);
    expect(shouldParallelEnum(s, wide([5, PARALLEL_MIN_STEPS + 4]))).toBe(false);
    // maxSliceWidth 的后端另有 *_sharded 路径（consumed 语义不同）⇒ 不派池子。
    const saved = s.maxSliceWidth;
    s.maxSliceWidth = 64;
    try {
      expect(shouldParallelEnum(s, wide([0, 100_000_000]))).toBe(false);
    } finally {
      s.maxSliceWidth = saved;
    }
  });

  it("门槛之上：分块与一次扫完逐位一致（919 个命中、不截断）", () => {
    const spec = narrow(20_000);
    const ref = rt.searcher.searchNearest(12_345, spec, PARALLEL_MIN_STEPS, new SearchContext());
    expect(ref.seeds.length).toBe(919);
    expect(ref.truncated).toBe(false);
    expect(ref.nearest).toBe(317_203_667);
    expect(ref.distance).toBe(117_154);
    const sharded = rt.searcher.searchNearShards(
      12_345,
      spec,
      nearChunks(PARALLEL_MIN_STEPS, 24),
      new SearchContext(),
    );
    expect([...sharded.seeds]).toEqual([...ref.seeds]);
    expect(sharded.head).toBe(ref.head);
    expect(sharded.truncated).toBe(ref.truncated);
  });
});

describe("scratch 不泄漏", () => {
  it("连续 300 次 searchSlice 后游标回到起点", () => {
    const before = rt.scratch.used();
    for (let i = 0; i < 300; i += 1) rt.searcher.searchSlice(allPass(), i * 8, i * 8 + 100);
    expect(rt.scratch.used()).toBe(before);
  });

  it("抛异常的路径同样归还 scratch", () => {
    const fake = { kind: "growth-wuxing", step: 1, num: 1, u32Bounds: [[0, KMAX]] } as unknown as SeedSpec;
    const before = rt.scratch.used();
    for (let i = 0; i < 50; i += 1) {
      expect(() => rt.searcher.searchSlice(fake, 0, 100)).toThrow(BackendUnavailable);
    }
    expect(rt.scratch.used()).toBe(before);
  });
});

describe("spec 子类判定（TS 特有的陷阱）", () => {
  it("五种 spec 实例都能被 instanceof 正确辨识", () => {
    expect(specFromDict({ kind: "interval", step: 1, constraints: [{ kind: "interval", lo: 0, hi: KMAX }], scanner: "crack" })).toBeInstanceOf(
      IntervalSpec,
    );
    expect(specFromDict(MASK_DICT)).toBeInstanceOf(MaskSpec);
    expect(specFromDict(ROLL_DICT)).toBeInstanceOf(RollSpec);
    expect(specFromDict(WUXING_DICT)).toBeInstanceOf(WuxingSpec);
    expect(specFromDict(POOL_DICT)).toBeInstanceOf(PoolSpec);
  });
});
