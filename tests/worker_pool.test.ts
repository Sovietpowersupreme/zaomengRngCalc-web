/**
 * `src/worker/pool.ts` 的回归测试。
 *
 * 假 worker 在 `tests/helpers/fakeWorker.ts`（`scenario_pool.test.ts` 也用它）。
 */

import { beforeAll, describe, expect, it } from "vitest";

import { BackendUnavailable, Canceled, SpecError } from "../src/core/errors";
import { CancelToken, Progress, type ProgressCallback } from "../src/core/progress";
import { nearChunks, PARALLEL_MIN_STEPS, SearchContext } from "../src/core/search";
import { specFromDict, type SeedSpec } from "../src/core/spec";
import { KMAX } from "../src/core/values";
import { defaultPoolSize, MAX_POOL_SIZE, SearchPool, type WorkerLike } from "../src/worker/pool";
import type { WasmRuntime } from "../src/wasm/runtime";
import { FakeWorker, makeFakeFactory, type FakeWorkerOptions } from "./helpers/fakeWorker";
import { testRuntime } from "./helpers/golden";

let rt: WasmRuntime;
beforeAll(async () => {
  rt = await testRuntime();
  FakeWorker.reset();
});

const allPass = (): SeedSpec =>
  specFromDict({
    kind: "interval",
    step: 1,
    constraints: [{ kind: "interval", lo: 0, hi: KMAX }],
    scanner: "crack",
  });

const SHARDS: Array<[number, number]> = [
  [0, 10],
  [10, 50],
  [50, 114],
  [114, 178],
  [178, 242],
  [242, 300],
];

function fakeFactory(options: FakeWorkerOptions = {}) {
  return makeFakeFactory(rt, options);
}

describe("defaultPoolSize", () => {
  it("下限 1、上限 MAX_POOL_SIZE，非法值归 1", () => {
    expect(defaultPoolSize(1)).toBe(1);
    expect(defaultPoolSize(4)).toBe(4);
    expect(defaultPoolSize(MAX_POOL_SIZE)).toBe(MAX_POOL_SIZE);
    expect(defaultPoolSize(64)).toBe(MAX_POOL_SIZE);
    expect(defaultPoolSize(0)).toBe(1);
    expect(defaultPoolSize(-3)).toBe(1);
    expect(defaultPoolSize(Number.NaN)).toBe(1);
  });
});

describe("并行分片 = 串行分片（逐位一致）", () => {
  it("6 片 × 3 worker：种子/head/truncated/consumed/unordered 全对上", async () => {
    const spec = allPass();
    const ref = rt.searcher.searchShards(spec, SHARDS);
    const pool = new SearchPool({ size: 3, createWorker: fakeFactory() });
    try {
      const got = await pool.searchShards(spec, SHARDS);
      expect(got.seeds).toEqual([...ref.seeds]);
      expect(got.head).toBe(ref.head);
      expect(got.truncated).toBe(ref.truncated);
      expect(got.consumed).toBe(ref.consumed);
      expect(got.unordered).toBe(false);
      expect(got.backend).toBe("wasm");
      expect(got.specKind).toBe("interval");
      expect(pool.created).toBe(3);
      expect(pool.inflight).toBe(0);
    } finally {
      pool.terminate();
    }
  });

  it("worker 有延迟也不改结果（顺序由分片下标决定，不由完成先后决定）", async () => {
    const spec = allPass();
    const ref = rt.searcher.searchShards(spec, SHARDS);
    const pool = new SearchPool({ size: 2, createWorker: fakeFactory({ delayMs: 1 }) });
    try {
      const got = await pool.searchShards(spec, SHARDS);
      expect(got.seeds).toEqual([...ref.seeds]);
      expect(got.head).toBe(ref.head);
      expect(got.consumed).toBe(ref.consumed);
    } finally {
      pool.terminate();
    }
  });

  it("searchAll == 串行 searchAll（同一窗口/同一 shardSize）", async () => {
    const spec = allPass();
    const ref = rt.searcher.searchAll(spec, new SearchContext({ sliceBounds: [0, 300], shardSize: 64 }));
    const pool = new SearchPool({ size: 4, createWorker: fakeFactory() });
    try {
      const got = await pool.searchAll(spec, new SearchContext({ sliceBounds: [0, 300], shardSize: 64 }));
      expect(got.seeds).toEqual([...ref.seeds]);
      expect(got.head).toBe(ref.head);
      expect(got.consumed).toBe(300);
    } finally {
      pool.terminate();
    }
  });

  it("maxResults 截断 + truncated 透传", async () => {
    const pool = new SearchPool({ size: 2, createWorker: fakeFactory() });
    try {
      const got = await pool.searchShards(allPass(), SHARDS, new SearchContext({ maxResults: 3 }));
      expect(got.count).toBe(3);
      expect(got.truncated).toBe(true);
    } finally {
      pool.terminate();
    }
  });

  it("空分片列表：consumed=0，且**不**创建 worker（懒建）", async () => {
    FakeWorker.created = 0;
    const pool = new SearchPool({ size: 3, createWorker: fakeFactory() });
    try {
      const got = await pool.searchShards(allPass(), []);
      expect(got.count).toBe(0);
      expect(got.consumed).toBe(0);
      expect(pool.created).toBe(0);
      expect(FakeWorker.created).toBe(0);
    } finally {
      pool.terminate();
    }
  });

  it("反区间/越界分片被丢掉，不计入 consumed", async () => {
    const pool = new SearchPool({ size: 1, createWorker: fakeFactory() });
    try {
      const got = await pool.searchShards(allPass(), [
        [10, 10],
        [20, 5],
        [30, 40],
      ]);
      expect(got.consumed).toBe(10);
      expect(got.count).toBe(10);
    } finally {
      pool.terminate();
    }
  });
});

describe("进度与取消", () => {
  it("progressCb 收到 0 → total，且最终 done == total", async () => {
    const seen: Progress[] = [];
    const onProgress: ProgressCallback = (p) => seen.push(p);
    const pool = new SearchPool({ size: 2, createWorker: fakeFactory({ delayMs: 1 }) });
    try {
      await pool.searchShards(allPass(), SHARDS, new SearchContext({ progressCb: onProgress }));
    } finally {
      pool.terminate();
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]?.done).toBe(0);
    expect(seen[0]?.total).toBe(300);
    expect(seen[seen.length - 1]?.done).toBe(300);
    expect(seen[seen.length - 1]?.percent).toBe(100);
  });

  it("预先取消：抛 Canceled，且一个 worker 都不创建", async () => {
    FakeWorker.created = 0;
    const token = new CancelToken();
    token.cancel();
    const pool = new SearchPool({ size: 3, createWorker: fakeFactory() });
    try {
      await expect(
        pool.searchShards(allPass(), SHARDS, new SearchContext({ cancelToken: token })),
      ).rejects.toBeInstanceOf(Canceled);
      expect(FakeWorker.created).toBe(0);
    } finally {
      pool.terminate();
    }
  });

  it("跑到一半取消：剩余分片不再派发，整体以 Canceled 结束", async () => {
    const token = new CancelToken();
    let dispatched = 0;
    const tracking = (_index: number): WorkerLike => {
      dispatched += 1;
      return new FakeWorker(rt, 1);
    };
    const pool = new SearchPool({ size: 1, createWorker: tracking });
    try {
      const ctx = new SearchContext({
        cancelToken: token,
        progressCb: () => token.cancel(),
      });
      await expect(pool.searchShards(allPass(), SHARDS, ctx)).rejects.toBeInstanceOf(Canceled);
      expect(dispatched).toBe(1);
    } finally {
      pool.terminate();
    }
  });

  it("取消后可以再跑一轮（activeCtx 已复位）", async () => {
    const pool = new SearchPool({ size: 2, createWorker: fakeFactory() });
    try {
      const token = new CancelToken();
      token.cancel();
      await expect(
        pool.searchShards(allPass(), SHARDS, new SearchContext({ cancelToken: token })),
      ).rejects.toBeInstanceOf(Canceled);
      const got = await pool.searchShards(allPass(), [[0, 20]]);
      expect(got.count).toBe(20);
    } finally {
      pool.terminate();
    }
  });
});

describe("错误处理与生命周期", () => {
  it("worker 报错 → 池子以同类错误 reject（跨 realm 按 name 复原）", async () => {
    FakeWorker.lastError = null;
    const pool = new SearchPool({
      size: 2,
      createWorker: fakeFactory({
        failOn: (m) => (m.type === "slice" && m.lo === 114 ? new BackendUnavailable("wasm 后端不支持假规格") : null),
      }),
    });
    try {
      const err = await pool.searchShards(allPass(), SHARDS).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(BackendUnavailable);
      expect((err as Error).message).toContain("假规格");
      expect(pool.inflight).toBe(0);
    } finally {
      pool.terminate();
    }
  });

  it("postMessage 抛错 → 任务 reject，不会永远挂着", async () => {
    const pool = new SearchPool({ size: 1, createWorker: fakeFactory({ throwOnPost: true }) });
    try {
      const err = await pool.searchShards(allPass(), SHARDS).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("postMessage");
    } finally {
      pool.terminate();
    }
  });

  it("worker 崩了（onerror）→ 在途任务立刻失败，不会永远挂着", async () => {
    const workers: FakeWorker[] = [];
    const pool = new SearchPool({
      size: 1,
      createWorker: () => {
        // 回得够慢，好让「崩」发生在它回话之前（worker 在装好监听前就崩就是这个形状）。
        const w = new FakeWorker(rt, 50);
        workers.push(w);
        return w;
      },
    });
    try {
      const inflight = pool.searchShards(allPass(), SHARDS);
      // 等它真把任务派出去再崩，否则测不到「在途任务」这条路。
      await new Promise((resolve) => setTimeout(resolve, 10));
      const first = workers[0];
      expect(first).toBeDefined();
      first?.crash("模拟 wasm 实例化抛错");
      const err = await inflight.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(BackendUnavailable);
      expect((err as Error).message).toContain("崩");
      expect(pool.inflight).toBe(0);
    } finally {
      pool.terminate();
    }
  });

  it("worker 建起来就崩：补建有限次，不会无限重建", async () => {
    /** 构造完的下一轮微任务才崩 —— 那时池子已经把 `onerror` 挂上了。 */
    class BootCrash extends FakeWorker {
      constructor() {
        super(rt);
        queueMicrotask(() => this.crash("一进去就崩"));
      }
    }
    let created = 0;
    const pool = new SearchPool({
      size: 1,
      createWorker: () => {
        created += 1;
        return new BootCrash();
      },
    });
    try {
      const err = await pool.searchShards(allPass(), SHARDS).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(BackendUnavailable);
      expect((err as Error).message).toContain("崩");
      expect(pool.inflight).toBe(0);
      // 关键护栏：没有它，「建起来就崩」会变成建-崩-建的死循环（页面直接卡死）。
      expect(created).toBeLessThanOrEqual(2 * pool.size + 1);
    } finally {
      pool.terminate();
    }
  });

  it("terminate：在途任务以 Canceled 结束，之后调用一律拒绝", async () => {
    const pool = new SearchPool({ size: 2, createWorker: fakeFactory({ delayMs: 10 }) });
    const inflight = pool.searchShards(allPass(), SHARDS);
    pool.terminate();
    await expect(inflight).rejects.toBeInstanceOf(Canceled);
    expect(pool.isClosed).toBe(true);
    expect(pool.created).toBe(0);
    await expect(pool.searchShards(allPass(), SHARDS)).rejects.toBeInstanceOf(Canceled);
    await expect(pool.warmup()).rejects.toBeInstanceOf(Canceled);
  });

  it("同一时刻只允许一轮（并发调用抛 SpecError）", async () => {
    const pool = new SearchPool({ size: 2, createWorker: fakeFactory({ delayMs: 5 }) });
    try {
      const first = pool.searchShards(allPass(), SHARDS);
      await expect(pool.searchShards(allPass(), SHARDS)).rejects.toBeInstanceOf(SpecError);
      const got = await first;
      expect(got.count).toBe(300);
      // 上一轮结束后又能用了。
      expect((await pool.searchShards(allPass(), [[0, 5]])).count).toBe(5);
    } finally {
      pool.terminate();
    }
  });

  it("warmup：每个 worker 收到一条 ping 并回 pong", async () => {
    const workers: FakeWorker[] = [];
    const pool = new SearchPool({
      size: 3,
      createWorker: (_i) => {
        const w = new FakeWorker(rt);
        workers.push(w);
        return w;
      },
    });
    try {
      await pool.warmup(2_000);
      expect(workers.length).toBe(3);
      for (const w of workers) {
        expect(w.messages.filter((m) => m.type === "ping").length).toBe(1);
      }
      expect(pool.created).toBe(3);
      // 预热过的池子照常能搜。
      expect((await pool.searchShards(allPass(), [[0, 8]])).count).toBe(8);
    } finally {
      pool.terminate();
    }
  });

  it("worker 工厂抛错（环境不支持）→ 原样抛出 BackendUnavailable", async () => {
    const pool = new SearchPool({
      size: 2,
      createWorker: () => {
        throw new BackendUnavailable("当前环境没有 Web Worker");
      },
    });
    try {
      await expect(pool.searchShards(allPass(), SHARDS)).rejects.toBeInstanceOf(BackendUnavailable);
    } finally {
      pool.terminate();
    }
  });

  it("size 至少为 1（传 0 也当 1）", () => {
    const pool = new SearchPool({ size: 0, createWorker: fakeFactory() });
    expect(pool.size).toBe(1);
    pool.terminate();
  });
});

// --------------------------------------------------------------------------- 局部搜索并行
/**
 * 近搜索的分块并行：``SearchPool.searchNearShards`` / ``searchNearest``。
 *
 * 关键是「**块 = ``fastNextK`` 跳步后的链段**」这条约定必须成立：块 ``i`` 的起点在主线程算好
 * （``fastNextK(seed, offset)``）再发出去，池子只按块下标归并。归并后的结果必须与
 * `rt.searcher.searchNear` 一次扫完**逐位相同**。
 */
describe("局部搜索分块并行（near）", () => {
  /** 与 ``searcher.test.ts`` 同一把尺子：``hi=20000`` 时 400000 步内 5 个命中、首个跨到第 2 块。 */
  const narrow = (hi: number): SeedSpec =>
    specFromDict({
      kind: "wuxing",
      step: 1,
      constraints: [{ kind: "interval", lo: 0, hi }],
      target_wx: 0,
      bagua_growth: [0, 0],
    });

  it("searchNearShards：池子分块 = 同步分块（逐位一致，命中跨块）", async () => {
    const spec = narrow(20_000);
    const chunks = nearChunks(400_000, 8);
    const ref = rt.searcher.searchNearShards(12_345, spec, chunks, new SearchContext());
    expect(ref.seeds.length).toBe(5);
    expect(ref.seeds[0]).toBe(317_203_667);
    const pool = new SearchPool({ size: 3, createWorker: fakeFactory(), nearEngine: rt.engine });
    try {
      const got = await pool.searchNearShards(12_345, spec, chunks, new SearchContext());
      expect([...got.seeds]).toEqual([...ref.seeds]);
      expect(got.head).toBe(ref.head);
      expect(got.truncated).toBe(ref.truncated);
      expect(got.consumed).toBe(ref.consumed);
      // 池子真的起了 worker（不是走了兜底）。
      expect(pool.created).toBeGreaterThan(0);
      expect(pool.inflight).toBe(0);
    } finally {
      pool.terminate();
    }
  });

  it("searchNearest：门槛之上（1e8 步）结果与同步一致", async () => {
    const spec = narrow(20_000);
    const limit = PARALLEL_MIN_STEPS;
    const ref = rt.searcher.searchNearest(12_345, spec, limit, new SearchContext());
    expect(ref.seeds.length).toBe(919);
    expect(ref.nearest).toBe(317_203_667);
    expect(ref.distance).toBe(117_154);
    const pool = new SearchPool({ size: 3, createWorker: fakeFactory(), nearEngine: rt.engine });
    try {
      const got = await pool.searchNearest(12_345, spec, limit, new SearchContext());
      expect([...got.seeds]).toEqual([...ref.seeds]);
      expect(got.head).toBe(ref.head);
      expect(got.nearest).toBe(ref.nearest);
      expect(got.distance).toBe(ref.distance);
      expect(got.truncated).toBe(ref.truncated);
      expect(got.backend).toBe(ref.backend);
      expect(got.specKind).toBe("wuxing");
    } finally {
      pool.terminate();
    }
  });

  it("截断（凑满 999）时后面的块不再派活，结果仍与串行一次扫完逐位一致", async () => {
    const spec = narrow(20_000);
    const limit = 0x7fffffff;
    const ref = rt.searcher.searchNearest(12_345, spec, limit, new SearchContext());
    expect(ref.seeds.length).toBe(999); // = SEED_CAP，串行那边也是扫到数组满就走
    const size = 4;
    const workers: FakeWorker[] = [];
    const pool = new SearchPool({
      size,
      createWorker: () => {
        const w = new FakeWorker(rt, 2);
        workers.push(w);
        return w;
      },
      nearEngine: rt.engine,
    });
    try {
      const got = await pool.searchNearest(12_345, spec, limit, new SearchContext());
      expect([...got.seeds]).toEqual([...ref.seeds]);
      expect(got.head).toBe(ref.head);
      expect(got.nearest).toBe(ref.nearest);
      expect(got.distance).toBe(ref.distance);
      expect(got.truncated).toBe(ref.truncated);
      expect(got.consumed).toBe(ref.consumed);
      // 一共 32 块（size * 8），但前 2 块就凑满 999 ⇒ 前缀已满后只剩在途的几块。
      const chunks = nearChunks(limit, size * 8).length;
      const dispatched = workers.reduce((n, w) => n + w.messages.filter((m) => m.type === "near").length, 0);
      expect(chunks).toBe(32);
      expect(dispatched).toBeLessThan(chunks);
      expect(dispatched).toBeLessThanOrEqual(size + 2);
    } finally {
      pool.terminate();
    }
  });

  it("searchNearest：size=1 也走池子（单 worker 兜底）", async () => {
    const spec = narrow(20_000);
    const limit = PARALLEL_MIN_STEPS;
    const ref = rt.searcher.searchNearest(12_345, spec, limit, new SearchContext());
    const workers: FakeWorker[] = [];
    const pool = new SearchPool({
      size: 1,
      createWorker: () => {
        const w = new FakeWorker(rt);
        workers.push(w);
        return w;
      },
      nearEngine: rt.engine,
    });
    try {
      const got = await pool.searchNearest(12_345, spec, limit, new SearchContext());
      expect([...got.seeds]).toEqual([...ref.seeds]);
      expect(got.nearest).toBe(ref.nearest);
      expect(got.distance).toBe(ref.distance);
      expect(workers.length).toBe(1);
      const near = workers[0]!.messages.filter((m) => m.type === "near");
      expect(near.length).toBe(8); // size 1 → 1 * 8 块
      for (const m of near) {
        if (m.type === "near") expect(m.limit).toBeGreaterThan(0);
      }
    } finally {
      pool.terminate();
    }
  });

  it("缺 nearEngine → BackendUnavailable（构造池子时就得传）", async () => {
    const spec = narrow(20_000);
    const pool = new SearchPool({ size: 2, createWorker: fakeFactory() });
    try {
      await expect(pool.searchNearShards(12_345, spec, [[0, 10]])).rejects.toBeInstanceOf(BackendUnavailable);
      await expect(pool.searchNearest(12_345, spec, 10)).rejects.toBeInstanceOf(BackendUnavailable);
    } finally {
      pool.terminate();
    }
  });

  it("near 任务报错 → 原样回传（rehydrate 认得出 BackendUnavailable）", async () => {
    const spec = narrow(20_000);
    const pool = new SearchPool({
      size: 2,
      createWorker: fakeFactory({
        failOn: (m) => (m.type === "near" && m.limit === 64 ? new BackendUnavailable("假规格") : null),
      }),
      nearEngine: rt.engine,
    });
    try {
      await expect(pool.searchNearShards(12_345, spec, [[0, 64]])).rejects.toBeInstanceOf(BackendUnavailable);
      // 一轮失败之后池子照常能用。
      const again = await pool.searchNearShards(12_345, spec, nearChunks(400_000, 4));
      expect(again.seeds.length).toBe(5);
    } finally {
      pool.terminate();
    }
  });

  it("空块表 → 立刻得到空结果，且不建任何 worker", async () => {
    const before = FakeWorker.created;
    const pool = new SearchPool({ size: 2, createWorker: fakeFactory(), nearEngine: rt.engine });
    try {
      const got = await pool.searchNearShards(12_345, narrow(20_000), [], new SearchContext());
      expect(got.seeds.length).toBe(0);
      expect(got.consumed).toBeNull();
      expect(FakeWorker.created).toBe(before);
    } finally {
      pool.terminate();
    }
  });

  it("near 也能取消（第一块回来后取消 → Canceled）", async () => {
    const spec = narrow(20_000);
    const token = new CancelToken();
    const pool = new SearchPool({ size: 3, createWorker: fakeFactory(), nearEngine: rt.engine });
    try {
      const ctx = new SearchContext({
        cancelToken: token,
        // 起手那条 forceReport（done=0）不触发取消，等真有块回来再取消。
        progressCb: (p: Progress) => {
          if (p.done > 0) token.cancel();
        },
      });
      await expect(pool.searchNearShards(12_345, spec, nearChunks(400_000, 8), ctx)).rejects.toBeInstanceOf(
        Canceled,
      );
    } finally {
      pool.terminate();
    }
  });

  it("同一时刻只允许一轮（near 与 slice 互斥）", async () => {
    const pool = new SearchPool({
      size: 2,
      createWorker: fakeFactory({ delayMs: 5 }),
      nearEngine: rt.engine,
    });
    try {
      const first = pool.searchNearShards(12_345, narrow(20_000), nearChunks(400_000, 4));
      await expect(pool.searchShards(allPass(), SHARDS)).rejects.toBeInstanceOf(SpecError);
      expect((await first).seeds.length).toBe(5);
      // 上一轮结束后又能用了。
      expect((await pool.searchNearShards(12_345, narrow(20_000), nearChunks(400_000, 4))).seeds.length).toBe(5);
    } finally {
      pool.terminate();
    }
  });
});
