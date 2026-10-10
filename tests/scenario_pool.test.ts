/**
 * 场景层接线测试（`scenario.ts` 的 async 化 + worker 池自动接入）。
 *
 * 用户定的规则：「步数大于 MAX_SEED_SEARCH 自动使用并行，小于依然串行」。
 * Python 侧那条判据在后端内部（``*_ord_mp`` + OpenMP），Web 侧的并行来源是
 * worker 池，所以判据在**协调层**（:meth:`Scenario.search`）被调用一次：
 *
 * * 有池子 + 步数越门槛 ⇒ ``pool.searchNearest``（分块派给 worker）；
 * * 否则 ⇒ 原来的同步 ``searcher.searchNearest``。
 *
 * 这里要钉住的是：**两条路的结果逐位一致**，以及「什么时候才会真的派活」。
 * 假 worker 见 `tests/helpers/fakeWorker.ts`（它自己做的是真 wasm 搜索，
 * 不是打桩）。
 */

import { beforeAll, describe, expect, it } from "vitest";

import { PARALLEL_MIN_STEPS, SearchContext } from "../src/core/search";
import { specFromDict, type SeedSpec } from "../src/core/spec";
import { KMAX } from "../src/core/values";
import { Runtime, Scenario, ScenarioError } from "../src/scenarios/scenario";
import { SearchPool, type WorkerLike } from "../src/worker/pool";
import { FakeWorker, makeFakeFactory } from "./helpers/fakeWorker";
import { testRuntime } from "./helpers/golden";
import type { WasmRuntime } from "../src/wasm/runtime";

let rt: WasmRuntime;
beforeAll(async () => {
  rt = await testRuntime();
  FakeWorker.reset();
});

/**
 * 窄区间 ``wuxing`` 的假场景 —— 只用场景层这一条链路。
 *
 * ``hi`` 与 `searcher.test.ts` 的 ``narrow`` 相同：1e8 步内 919 个命中、
 * 首个在起点后 117154 步（既跨块又不写满 999）。
 */
const NARROW_HI = 20_000;
const INPUTS: Record<string, unknown> = {};
const START_SEED = 12_345;

const narrowDict = (): Record<string, unknown> => ({
  kind: "wuxing",
  step: 1,
  constraints: [{ kind: "interval", lo: 0, hi: NARROW_HI }],
  target_wx: 0,
  bagua_growth: [0, 0],
});

class ProbeScenario extends Scenario {
  override readonly key = "probe";
  override readonly label = "探针";
  override readonly specKind = "wuxing";
  override readonly nearLimit = 400_000;

  override buildSpec(): SeedSpec {
    return specFromDict(narrowDict());
  }
}

class NoNearScenario extends ProbeScenario {
  override readonly supportsNear = false;
}

/**
 * 枚举探针：``interval`` 全通过（每个 uv 都命中 ⇒ 第一片就写满 ``SEED_CAP``）。
 *
 * 这样枚举测试才能在 «完整扫窗口» 与 «几毫秒跑完» 之间两全：只要池子真的派活了，
 * 前缀早停就会在第一片回来时把剩下排队的分片全部判空。
 */
class EnumScenario extends Scenario {
  override readonly key = "enum";
  override readonly label = "枚举探针";
  override readonly specKind = "interval";
  override readonly supportsNear = false;

  override buildSpec(): SeedSpec {
    return specFromDict({
      kind: "interval",
      step: 1,
      constraints: [{ kind: "interval", lo: 0, hi: KMAX }],
      scanner: "crack",
    });
  }
}

const scenario = new ProbeScenario();
const enumScenario = new EnumScenario();

/** 每次用完都要收工，否则假 worker 会一直挂着。 */
function poolOf(size = 3): SearchPool {
  return new SearchPool({ size, createWorker: makeFakeFactory(rt), nearEngine: rt.engine });
}

describe("Runtime 的池子是「注入的能力」", () => {
  it("不传池子 → pool 为 null、canParallelNear 为 false", () => {
    const r = Runtime.resolve(rt);
    expect(r.pool).toBeNull();
    expect(r.canParallelNear).toBe(false);
    expect(r.engine).toBe(rt.engine);
    expect(r.searcher).toBe(rt.searcher);
  });

  it("传了池子 → canParallelNear 为 true；后端仍旧必填", () => {
    const pool = poolOf(1);
    try {
      const r = Runtime.resolve(rt, pool);
      expect(r.pool).toBe(pool);
      expect(r.canParallelNear).toBe(true);
      expect(() => Runtime.resolve(null, pool)).toThrow(ScenarioError);
    } finally {
      pool.terminate();
    }
  });
});

describe("一步局部搜索（run({near:true}))：门槛决定走哪条路", () => {
  it("门槛之上：派给池子，结果与同步逐位一致（919 个命中）", async () => {
    const limit = PARALLEL_MIN_STEPS;
    const sync = await scenario.run(INPUTS, START_SEED, { near: true, limit, backend: rt });
    expect(sync.seeds.length).toBe(919);
    expect(sync.truncated).toBe(false);
    expect(sync.backend).toBe("wasm");

    const pool = poolOf(3);
    try {
      const viaPool = await scenario.run(INPUTS, START_SEED, { near: true, limit, backend: rt, pool });
      expect(viaPool.seed).toBe(sync.seed);
      expect(viaPool.distance).toBe(sync.distance);
      expect(viaPool.needConsume).toBe(sync.needConsume);
      expect(viaPool.seeds).toEqual([...sync.seeds]);
      expect(viaPool.truncated).toBe(sync.truncated);
      expect(viaPool.unordered).toBe(sync.unordered);
      expect(viaPool.backend).toBe("wasm");
      // 真的派活了：三个槽都起来了（懒建），跑完没有在途任务。
      expect(pool.created).toBe(3);
      expect(pool.inflight).toBe(0);
    } finally {
      pool.terminate();
    }
  });

  it("门槛之上：与「主线程自己一次扫完」的结果一致", async () => {
    const limit = PARALLEL_MIN_STEPS;
    const searchSeed = rt.engine.fastNextK(START_SEED, scenario.advanceCount(INPUTS));
    const pool = poolOf(2);
    try {
      const viaPool = await scenario.run(INPUTS, START_SEED, { near: true, limit, backend: rt, pool });
      const ref = rt.searcher.searchNearest(searchSeed, scenario.buildSpec(), limit, scenario.searchContext());
      expect(viaPool.seeds).toEqual([...ref.seeds]);
      expect(viaPool.seed).toBe(ref.nearest);
      expect(viaPool.distance).toBe(ref.distance);
    } finally {
      pool.terminate();
    }
  });

  it("门槛之下：就算给了池子也不建 worker（和以前一样同步）", async () => {
    const pool = poolOf(3);
    try {
      const out = await scenario.run(INPUTS, START_SEED, { near: true, limit: 400_000, backend: rt, pool });
      expect(pool.created).toBe(0);
      expect(pool.inflight).toBe(0);
      const sync = await scenario.run(INPUTS, START_SEED, { near: true, limit: 400_000, backend: rt });
      expect(out.seeds).toEqual([...sync.seeds]);
      expect(out.seed).toBe(sync.seed);
    } finally {
      pool.terminate();
    }
  });

  it("ctx.nearParallel=false 也能关掉它（`searchContext` 白名单已收录）", async () => {
    const limit = PARALLEL_MIN_STEPS;
    const ctx = scenario.searchContext({ nearParallel: false });
    expect(ctx.nearParallel).toBe(false);
    const pool = poolOf(3);
    try {
      const out = await scenario.run(INPUTS, START_SEED, { near: true, limit, backend: rt, pool, ctx });
      expect(pool.created).toBe(0);
      const sync = await scenario.run(INPUTS, START_SEED, { near: true, limit, backend: rt });
      expect(out.seeds).toEqual([...sync.seeds]);
      expect(out.seed).toBe(sync.seed);
    } finally {
      pool.terminate();
    }
  });

  it("supportsNear=false 的场景照样拒绝（异步 reject，不是同步抛）", async () => {
    await expect(
      new NoNearScenario().run(INPUTS, START_SEED, { near: true, limit: 400_000, backend: rt }),
    ).rejects.toBeInstanceOf(ScenarioError);
  });
});

describe("nearestOf：每个候选各走一次同一条路", () => {
  it("门槛之上：带不带池子结果一致，且池子确实被用了", async () => {
    const limit = PARALLEL_MIN_STEPS;
    const candidates = [12_345, 67_890];
    const sync = await scenario.nearestOf(INPUTS, candidates, { limit, backend: rt });
    expect(sync.distance).toBeGreaterThan(0);

    const pool = poolOf(3);
    try {
      const viaPool = await scenario.nearestOf(INPUTS, candidates, { limit, backend: rt, pool });
      expect(viaPool.seed).toBe(sync.seed);
      expect(viaPool.distance).toBe(sync.distance);
      expect(viaPool.needConsume).toBe(sync.needConsume);
      expect(pool.created).toBeGreaterThan(0);
    } finally {
      pool.terminate();
    }
  });

  it("候选为空 → 和以前一样给出「没找到」（seed=0 / distance=0）", async () => {
    const out = await scenario.nearestOf(INPUTS, [], { limit: 400_000, backend: rt });
    expect(out.seed).toBe(0);
    expect(out.distance).toBe(0);
    expect(out.backend).toBe("wasm");
  });
});

// --------------------------------------------------------------------------- 枚举
/**
 * 枚举窗口：宽 ``1e8``（``> PARALLEL_MIN_STEPS``），分片 ``1e8/3`` ⇒ 正好 3 片。
 *
 * 分片数少是为了能数清「派了几条」：全通过 spec 第一片就写满 999，早停后
 * 排队的那些**永远不发出去**，所以派活数应该 <= 槽位数。
 */
const ENUM_WINDOW: readonly number[] = [0, 100_000_000];
const ENUM_SHARD = 33_333_334;

/** 收工列表：每个槽一个假 worker，顺便用来数派了几条任务。 */
function enumPool(size = 2): { pool: SearchPool; dispatches: () => number } {
  const workers: FakeWorker[] = [];
  const factory = (_index: number): WorkerLike => {
    const w = new FakeWorker(rt);
    workers.push(w);
    return w;
  };
  const pool = new SearchPool({ size, createWorker: factory, nearEngine: rt.engine });
  return { pool, dispatches: () => workers.reduce((n, w) => n + w.messagesOfType("slice").length, 0) };
}

describe("枚举（run({near:false}))：开关 + 门槛才派给池子", () => {
  it("默认 preferParallel=false ⇒ 全空间也不建 worker（枚举依旧串行）", async () => {
    const ctx = enumScenario.searchContext();
    expect(ctx.preferParallel).toBe(false);
    const { pool, dispatches } = enumPool(3);
    try {
      const viaPool = await enumScenario.run(INPUTS, START_SEED, { backend: rt, pool, ctx });
      expect(pool.created).toBe(0);
      expect(dispatches()).toBe(0);
      const sync = await enumScenario.run(INPUTS, START_SEED, { backend: rt, ctx });
      expect(viaPool.seeds).toEqual([...sync.seeds]);
      expect(viaPool.seed).toBe(sync.seed);
      expect(viaPool.truncated).toBe(sync.truncated);
    } finally {
      pool.terminate();
    }
  });

  it("开关 + 宽度过门槛 ⇒ 派给池子；结果与串行逐位一致，且早停后不再派活", async () => {
    const ctx = enumScenario.searchContext({
      sliceBounds: ENUM_WINDOW,
      preferParallel: true,
      shardSize: ENUM_SHARD,
    });
    const syncCtx = new SearchContext({ sliceBounds: ENUM_WINDOW });
    const ref = rt.searcher.searchAll(enumScenario.buildSpec(), syncCtx);
    expect(ref.seeds.length).toBe(999);
    expect(ref.truncated).toBe(true);

    const { pool, dispatches } = enumPool(2);
    try {
      const out = await enumScenario.run(INPUTS, START_SEED, { backend: rt, pool, ctx });
      expect(pool.created).toBe(2);
      expect(pool.inflight).toBe(0);
      // 派活的真的走了 worker：2 个槽各一条（第一片写满后就没人再发了）。
      expect(dispatches()).toBe(2);
      // 与「主線程一次扫完」逐位一致。
      expect(out.seeds).toEqual([...ref.seeds]);
      expect(out.seed).toBe(ref.nearest ?? ref.head);
      expect(out.truncated).toBe(ref.truncated);
      expect(out.unordered).toBe(ref.unordered);
      expect(out.backend).toBe("wasm");
    } finally {
      pool.terminate();
    }
  });

  it("开了开关但宽度不够 ⇒ 仍旧不建 worker", async () => {
    const ctx = enumScenario.searchContext({
      sliceBounds: [0, PARALLEL_MIN_STEPS - 1],
      preferParallel: true,
      shardSize: ENUM_SHARD,
    });
    const { pool, dispatches } = enumPool(3);
    try {
      const out = await enumScenario.run(INPUTS, START_SEED, { backend: rt, pool, ctx });
      expect(pool.created).toBe(0);
      expect(dispatches()).toBe(0);
      const ref = rt.searcher.searchAll(
        enumScenario.buildSpec(),
        new SearchContext({ sliceBounds: [0, PARALLEL_MIN_STEPS - 1] }),
      );
      expect(out.seeds).toEqual([...ref.seeds]);
      expect(out.truncated).toBe(ref.truncated);
    } finally {
      pool.terminate();
    }
  });

  it("不给池子 → search 不碰池子这条岔路（与串行完全同源）", async () => {
    const ctx = enumScenario.searchContext({
      sliceBounds: ENUM_WINDOW,
      preferParallel: true,
      shardSize: ENUM_SHARD,
    });
    const out = await enumScenario.run(INPUTS, START_SEED, { backend: rt, ctx });
    const ref = rt.searcher.searchAll(
      enumScenario.buildSpec(),
      new SearchContext({ sliceBounds: ENUM_WINDOW, preferParallel: true, shardSize: ENUM_SHARD }),
    );
    expect(out.seeds).toEqual([...ref.seeds]);
    expect(out.seed).toBe(ref.nearest ?? ref.head);
  });

  it("`supportsNear=false` 不影响枚举（near 路径才看它）", async () => {
    expect(enumScenario.supportsNear).toBe(false);
    const out = await enumScenario.run(INPUTS, START_SEED, {
      backend: rt,
      ctx: enumScenario.searchContext({ sliceBounds: ENUM_WINDOW }),
    });
    expect(out.count).toBeGreaterThan(0);
  });
});
