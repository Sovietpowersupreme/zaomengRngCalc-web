/**
 * wasm 后端 vs Python golden（``src_forge/tests/golden/prng.json``）。
 *
 * 这份 golden 由 DLL 采样生成、Python 侧测试也在用；这里读的是**同一个文件**，
 * 所以「Web 与 Python 一致」这件事不需要额外维护一份 Web 专用期望值。
 *
 * 另外钉住一批**实测出来的 ABI 事实**（结构体偏移 / 上限 / ccall 命名），
 * 它们是 ``web/src/wasm/*`` 里所有指针运算的前提。
 */

import { beforeAll, describe, expect, it } from "vitest";

import { MAX_INPUT, SEED_CAP, u32, i32 } from "../src/core/values";
import type { WasmRuntime } from "../src/wasm/runtime";
import { loadGolden, testRuntime, type PrngGolden } from "./helpers/golden";

let rt: WasmRuntime;

beforeAll(async () => {
  rt = await testRuntime();
});

describe("wasm ABI（实测值，作为回归钉子）", () => {
  it("布局自描述接口给出的偏移与实测一致", () => {
    const l = rt.layout;
    // uRange：min/max 都是 uint32_t[32] → 各 128 字节，num 在 256
    expect(l.urange.size).toBe(260);
    expect([l.urange.min, l.urange.max, l.urange.num]).toEqual([0, 128, 256]);
    // fRange：min/max 是 double[32] → 各 256 字节，num 在 512
    expect(l.frange.size).toBe(520);
    expect([l.frange.min, l.frange.max, l.frange.num]).toEqual([0, 256, 512]);
    // seedArray：data(uint32[999]) / len(int32) / seed(uint32)
    expect(l.seedArray.size).toBe(4004);
    expect([l.seedArray.data, l.seedArray.len, l.seedArray.seed]).toEqual([0, 3996, 4000]);
  });

  it("容量常量与 TS 侧常量一致", () => {
    expect(rt.layout.maxInput).toBe(MAX_INPUT);
    expect(rt.layout.seedCap).toBe(SEED_CAP);
    expect(rt.layout.randPureMax).toBe(0x7fffffff);
    expect(rt.layout.scratchSize).toBe(65536);
    expect(rt.scratch.base).toBe(rt.layout.scratchBase);
  });

  it("JS 导出带 '_' 前缀，而 ccall 要不带前缀的名字", () => {
    const m = rt.module;
    expect(typeof m._wc_max_input).toBe("function");
    expect(m._wc_max_input()).toBe(MAX_INPUT);
    expect((m as unknown as Record<string, unknown>).wc_max_input).toBeUndefined();

    expect(m.ccall("wc_max_input", "number", [], [])).toBe(MAX_INPUT);
    expect(() => m.ccall("_wc_max_input", "number", [], [])).toThrow();
  });

  it("已知向量：fastNext(12345) = 1207965724", () => {
    expect(rt.module._fastNext(12345)).toBe(1207965724);
    expect(rt.engine.fastNext(12345)).toBe(1207965724);
    expect(rt.engine.getPreSeed(1207965724)).toBe(12345);
  });

  it("scratch 用完要能 release，越界要炸", () => {
    const mark = rt.scratch.mark();
    rt.scratch.allocU32(10);
    expect(rt.scratch.mark()).toBeGreaterThan(mark);
    rt.scratch.release(mark);
    expect(rt.scratch.mark()).toBe(mark);
    expect(() => rt.scratch.alloc(rt.layout.scratchSize * 2)).toThrow();
  });
});

describe("随机数基元对拍 prng.json", () => {
  let g: PrngGolden["values"];

  beforeAll(() => {
    g = loadGolden<PrngGolden>("prng.json").values;
  });

  it("标量原语（含 int32 回绕与 & 0x7FFFFFFF）", () => {
    const eng = rt.engine;
    const problems: string[] = [];
    const check = (label: string, got: number[], want: number[]): void => {
      if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`${label} 不一致`);
    };
    check("fast_next", g.seeds.map((s) => eng.fastNext(s)), g.fast_next);
    check("get_pre_seed", g.seeds.map((s) => eng.getPreSeed(s)), g.get_pre_seed);
    check("pure_hash", g.pure_hash_seeds.map((x) => eng.pureHash(x)), g.pure_hash);
    check(
      "static_random_generator",
      g.seeds.map((s) => eng.staticRandomGenerator(s)),
      g.static_random_generator,
    );
    check("static_random", g.seeds.map((s) => eng.staticRandom(s)), g.static_random);
    check("boss_type", g.seeds.map((s) => eng.bossType(s)), g.boss_type);
    check(
      "random_advance.值",
      g.seeds.map((s) => eng.randomAdvance(s)[0]),
      g.random_advance_value,
    );
    check(
      "random_advance.新种子",
      g.seeds.map((s) => eng.randomAdvance(s)[1]),
      g.random_advance_next,
    );
    check(
      "random_value.值",
      g.seeds.map((s) => eng.randomValue(s)[0]),
      g.random_value,
    );
    check(
      "random_value.新种子",
      g.seeds.map((s) => eng.randomValue(s)[1]),
      g.random_next,
    );
    expect(problems).toEqual([]);
  });

  it("fast_next_k（GF(2) 矩阵快速幂）与逐次推进等价", () => {
    const eng = rt.engine;
    const flat: number[] = [];
    for (const s of g.fast_next_k_seeds) {
      for (const k of g.fast_next_k_ks) flat.push(eng.fastNextK(s, k));
    }
    expect(flat).toEqual(g.fast_next_k);

    // 与朴素循环交叉验证（golden 里的 k 可能很小，这里额外证一遍大 k）
    for (const k of [0, 1, 2, 7, 64, 1023]) {
      let slow = u32(1234567);
      for (let i = 0; i < k; i += 1) slow = eng.fastNext(slow);
      expect(eng.fastNextK(1234567, k)).toBe(slow);
    }
  });

  it("seedUpdateTest(1, +n) 等价于 fastNextK(1, n)", () => {
    const eng = rt.engine;
    expect(g.seed_update_test_n.map((n) => eng.fastNextK(1, n))).toEqual(g.seed_update_test);
  });

  it("seedDistance（含反向的负数步数）", () => {
    const eng = rt.engine;
    const got = g.seed_distance.map(([start, target, end]) => eng.seedDistance(start, target, end));
    expect(got).toEqual(g.seed_distance.map(([, , , want]) => want));
  });

  it("recover_seeds（逐位反演）", () => {
    const eng = rt.engine;
    for (const c of g.recover_seeds) {
      expect({ in: c.in, out: eng.recoverSeeds(c.in) }).toEqual({ in: c.in, out: c.out });
    }
  });

  it("recoverSeeds 的结果满足 staticRandomGenerator(seed) == 目标", () => {
    const eng = rt.engine;
    for (const c of g.recover_seeds) {
      const target = u32(c.in) & 0x7fffffff;
      for (const s of c.out) {
        expect(eng.staticRandomGenerator(s)).toBe(target);
      }
    }
  });

  it("纯 TS 兜底扫描与小窗口恢复一致", () => {
    const eng = rt.engine;
    // 只在前 200000 个种子里找，够小、够确定性
    const wanted = eng.staticRandomGenerator(4242);
    const scanned = eng.recoverSeedsScan(wanted, 0, 200_000);
    expect(scanned).toContain(4242);
    for (const s of scanned) expect(eng.staticRandomGenerator(s)).toBe(wanted);
  });

  it("i32 / u32 助手与 Python 语义一致", () => {
    expect(u32(-1)).toBe(0xffffffff);
    expect(u32(0x1_0000_0000)).toBe(0);
    expect(i32(0xffffffff)).toBe(-1);
    expect(i32(0x80000000)).toBe(-0x80000000);
  });
});
