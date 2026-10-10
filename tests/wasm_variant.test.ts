/**
 * 两份 wasm（`cracker.wasm` / `cracker.mvp.wasm`）的**行为等价性**对拍。
 *
 * 背景见 `src/wasm/variant.ts`：为了兼容 Chromium 70 类引擎，同一份 C 源码出两份 wasm ——
 * modern 是 emcc 原产物（含 bulk memory），mvp 是 `wasm-opt --llvm-memory-copy-fill-lowering`
 * 把 `memory.copy`/`memory.fill` 展开成循环之后的纯 MVP。**加了老引擎支持，就不能把老引擎
 * 上算出来的东西弄错**，所以「两份必须逐值等价」是一条硬约束，由本文件钉住。
 *
 * 五层各对一遍（层越往上，能漏掉的错误越多）：
 *
 * | 层 | 对拍对象 | 用例量 | 要 golden 吗 |
 * | --- | --- | --- | --- |
 * | 字节层 | 结构：MVP 里不该再有任何 bulk memory 指令 | 2 份文件 | 不要 |
 * | ABI 层 | `probeLayout()` 的每个偏移/上限 | 1 组 | 不要 |
 * | 原语层 | `prng.json` 的全部标量向量 | 1 组（大） | **要** |
 * | spec 层 | `scenarios.json` 的 slice 498 + near 648 例 | 1146 例 | **要** |
 * | 场景层 | `runs.json` 的端到端 run（`Scenario.run()`） | 随移植进度 | **要** |
 *
 * ⚠️ 这里**不比对 golden 期望值** —— 那是 `wasm_engine.test.ts` / `searcher.test.ts` /
 * `scenario_runs.test.ts` 的活。本文件只问「modern 与 mvp 是不是一模一样」，
 * 于是 golden 只作为**输入与用例来源**（同一批种子、同一批 spec、同一批 run），
 * golden 本身变了也不会让这里变红或变绿。
 *
 * ⚠️ **后三层要 golden，而 golden 只在主仓库本地存在**（公开仓库的仓库根就是 `web/`，
 * `src_forge/` 在它的上一级、不会被 subtree 带过去；理由详见 `tests/helpers/golden.ts` 文件头）。
 * ⇒ CI / 公开仓库里 `GOLDEN_AVAILABLE === false`，这三层用 `describe.skipIf` 整组跳过，
 * **只剩字节层 + ABI 层在跑**。也就是说 **CI 全绿只证明「两份 wasm 的结构与 ABI 等价」，
 * 不证明「逐值等价」** —— 后者必须在主仓库本地跑全量 `npm test`（同 `test:ci` 与全量
 * `test` 的那条界线）。
 *
 * ⚠️ 两份 must **同时活着**：wasm 实例各有一份线性内存，跨实例传指针没有意义。
 */

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

// 副作用导入：只有 ``scenarios/index`` 里登记过的场景才算「已落地」。
import "../src/scenarios/index";
import { specFromDict } from "../src/core/spec";
import { getScenario, registeredKeys } from "../src/scenarios/registry";
import type { WasmRuntime } from "../src/wasm/runtime";
import { WASM_VARIANTS, type WasmVariant } from "../src/wasm/variant";
import {
  GOLDEN_AVAILABLE,
  loadGolden,
  loadRuns,
  variantRuntime,
  WASM_FILES,
  type PrngGolden,
  type RunCase,
  type ScenariosGolden,
} from "./helpers/golden";

/** 两份运行时（变体名 → 运行时）。 */
const runtimes = new Map<WasmVariant, WasmRuntime>();

beforeAll(async () => {
  const loaded = await Promise.all(WASM_VARIANTS.map(async (v) => [v, await variantRuntime(v)] as const));
  for (const [variant, rt] of loaded) runtimes.set(variant, rt);
});

/** 取指定变体的运行时。 */
function rtOf(variant: WasmVariant): WasmRuntime {
  const rt = runtimes.get(variant);
  if (rt === undefined) throw new Error(`变体 ${variant} 还没加载（beforeAll 没跑？）`);
  return rt;
}

/**
 * 对每个变体跑一次 :param:`probe`，返回「变体名 → 稳定序列化结果」。
 *
 * 失败时把**两边的差异**直接列出来：这类对拍一旦红了，只看 `toEqual` 的 diff
 * 是找不到第几个用例出问题的（498 例的数组）。
 */
function compare<T>(probe: (rt: WasmRuntime) => T): Record<WasmVariant, T> {
  const out = {} as Record<WasmVariant, T>;
  for (const variant of WASM_VARIANTS) out[variant] = probe(rtOf(variant));
  return out;
}

// --------------------------------------------------------------------------- 字节层

/**
 * 只读一遍文件（两份都不大）。
 *
 * 拷成独立的 ``Uint8Array<ArrayBuffer>`` 是为了 ``WebAssembly.validate`` 接受它
 * （``Buffer.buffer`` 是 ``ArrayBufferLike``，那个泛型不匹配）。
 */
function wasmBytes(variant: WasmVariant): Uint8Array<ArrayBuffer> {
  const buf = readFileSync(WASM_FILES[variant]);
  const out = new Uint8Array(buf.length);
  out.set(buf);
  return out;
}

/** 按 LEB128 走一遍 section 头，返回 ``{id, offset, size}``（offset 指向 payload 首字节）。 */
function sections(data: Uint8Array): { id: number; offset: number; size: number }[] {
  // 到处写 `!`：这是在逐字节解析，边界由 while / for 条件保证。
  if (data[0] !== 0x00 || data[1] !== 0x61 || data[2] !== 0x73 || data[3] !== 0x6d) {
    throw new Error("不是 wasm 文件（magic 不对）");
  }
  const out: { id: number; offset: number; size: number }[] = [];
  let i = 8; // magic(4) + version(4)
  while (i < data.length) {
    const id = data[i]!;
    i += 1;
    let size = 0;
    let shift = 0;
    for (;;) {
      const byte = data[i]!;
      i += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    out.push({ id, offset: i, size });
    i += size;
  }
  return out;
}

/** 数一个字节对（如 ``FC 0A``）在区间里的出现次数。 */
function countPair(data: Uint8Array, from: number, to: number, a: number, b: number): number {
  let n = 0;
  for (let i = from; i + 1 < to; i += 1) if (data[i] === a && data[i + 1] === b) n += 1;
  return n;
}

describe("字节层：MVP 产物真的把 bulk memory 展平了", () => {
  // 实测值（2026-10-02，wasm-opt 218 / emcc 6.0.10）：
  //   modern  20139 B：section 12(1) + code 18140 B，含 memory.copy ×52 / memory.fill ×20
  //   mvp     20175 B：**没有 section 12**，code 18177 B，两个字节对都是 0
  // 变大了 36 B 是正常的：展开成循环比一条指令长。
  const BULK = { copy: [0xfc, 0x0a], fill: [0xfc, 0x0b] } as const;

  it("MVP 里没有 DataCount 段（modern 有）", () => {
    const modern = sections(wasmBytes("modern")).map((s) => s.id);
    const mvp = sections(wasmBytes("mvp")).map((s) => s.id);
    // DataCount（id 12）是 bulk memory 的产物，必须排在 code（id 10）之前。
    expect(modern).toContain(12);
    expect(modern.indexOf(12)).toBeLessThan(modern.indexOf(10));
    expect(mvp).not.toContain(12);
    // 两份的段序集合除 12 之外应当一致 —— 少一段就说明 wasm-opt 顺手删了别的东西。
    expect(mvp).toEqual(modern.filter((id) => id !== 12));
  });

  it("MVP 的代码段里没有任何 memory.copy / memory.fill 指令", () => {
    // ⚠️ 这是**字节对扫描**（不完整解码），只是启发式：它可能被立即数里的
    // ``FC 0A`` 误命中。但实测「整文件计数 == code 段计数」且 modern 正好是 52/20、
    // mvp 正好是 0/0 —— 也就是说今天它精确成立；哪天冒出误报，只会让这条变红，
    // 那时把判据换成真正的反汇编即可（宁可吵，不可漏）。
    const counts = {} as Record<WasmVariant, { copy: number; fill: number }>;
    for (const variant of WASM_VARIANTS) {
      const data = wasmBytes(variant);
      const code = sections(data).filter((s) => s.id === 10);
      expect(code.length, `${variant}: 应当恰好一个 code 段`).toBe(1);
      const { offset, size } = code[0]!;
      counts[variant] = {
        copy: countPair(data, offset, offset + size, ...BULK.copy),
        fill: countPair(data, offset, offset + size, ...BULK.fill),
      };
      // 整文件计数必须等于 code 段计数（证明别处没有同名字节对，扫描没被稀释）
      expect(countPair(data, 0, data.length, ...BULK.copy)).toBe(counts[variant].copy);
    }
    expect(counts.modern.copy).toBeGreaterThan(0);
    expect(counts.modern.fill).toBeGreaterThan(0);
    expect(counts.mvp).toEqual({ copy: 0, fill: 0 });
  });

  it("两份都是能被同一颗引擎接受的合法模块", () => {
    for (const variant of WASM_VARIANTS) {
      const bytes = wasmBytes(variant);
      expect(bytes.length, `${variant} 太小了，八成是坏文件`).toBeGreaterThan(4096);
      expect(WebAssembly.validate(bytes), `${variant} 不是合法 wasm`).toBe(true);
    }
    // 顺手钉住「确实是两份不同的文件」（防止有人把 mvp 的目标指回 modern）
    expect(Buffer.compare(Buffer.from(wasmBytes("mvp")), Buffer.from(wasmBytes("modern")))).not.toBe(0);
  });
});

// --------------------------------------------------------------------------- ABI 层

describe("ABI 层：自描述布局逐字段一致", () => {
  it("probeLayout() 的全部字段相等（含 scratchBase）", () => {
    const { modern, mvp } = compare((rt) => rt.layout);
    expect(mvp).toEqual(modern);
  });

  it("describe() 的文本相等", () => {
    const { modern, mvp } = compare((rt) => rt.describe());
    expect(mvp).toBe(modern);
  });

  it("上限常量与 ccall 行为一致", () => {
    const { modern, mvp } = compare((rt) => ({
      maxInput: rt.module._wc_max_input(),
      viaCcall: rt.module.ccall("wc_max_input", "number", [], []),
      seedCap: rt.layout.seedCap,
    }));
    expect(mvp).toEqual(modern);
  });
});

// --------------------------------------------------------------------------- 原语层

describe.skipIf(!GOLDEN_AVAILABLE)("原语层：prng.json 的全部标量向量逐值一致", () => {
  it("每个导出原语在两份里给出同一串值", () => {
    const g = loadGolden<PrngGolden>("prng.json").values;
    const sig = (rt: WasmRuntime): Record<string, unknown> => {
      const eng = rt.engine;
      return {
        fastNext: g.seeds.map((s) => eng.fastNext(s)),
        getPreSeed: g.seeds.map((s) => eng.getPreSeed(s)),
        pureHash: g.pure_hash_seeds.map((x) => eng.pureHash(x)),
        staticRandomGenerator: g.seeds.map((s) => eng.staticRandomGenerator(s)),
        staticRandom: g.seeds.map((s) => eng.staticRandom(s)),
        bossType: g.seeds.map((s) => eng.bossType(s)),
        randomAdvance: g.seeds.map((s) => eng.randomAdvance(s).join(",")),
        randomValue: g.seeds.map((s) => eng.randomValue(s).join(",")),
        fastNextK: g.fast_next_k_seeds.flatMap((s) => g.fast_next_k_ks.map((k) => eng.fastNextK(s, k))),
        seedDistance: g.seed_distance.map(([start, target, end]) => eng.seedDistance(start, target, end)),
      };
    };
    // 逐字段比（比整体 toEqual 更容易定位；`toEqual` 的浮点/长数组 diff 不好读）
    const modern = sig(rtOf("modern"));
    const mvp = sig(rtOf("mvp"));
    for (const key of Object.keys(modern) as (keyof typeof modern)[]) {
      expect(mvp[key], `prng.json 的 ${String(key)} 两份算出来的不一样`).toEqual(modern[key]);
    }
  });

  it("recover_seeds / seed_update 之类的复合原语也一致", () => {
    const g = loadGolden<PrngGolden>("prng.json").values;
    const sig = (rt: WasmRuntime): unknown => {
      const eng = rt.engine;
      return {
        recover: g.recover_seeds.map((c) => eng.recoverSeeds(c.in).join(",")),
        // 没有单独的 ``seedUpdateTest`` 导出 —— golden 里那个序列就是 ``fastNextK(1, n)``
        // （见 ``wasm_engine.test.ts`` 同名用例），照同一个口径复现。
        update: g.seed_update_test_n.map((n) => eng.fastNextK(1, n)),
        preSeedN: g.seeds.map((s) => eng.getPreSeedN(s, 8)),
      };
    };
    const modern = sig(rtOf("modern"));
    const mvp = sig(rtOf("mvp"));
    expect(mvp).toEqual(modern);
  });
});

// --------------------------------------------------------------------------- spec 层

describe.skipIf(!GOLDEN_AVAILABLE)("spec 层：scenarios.json 全量逐例一致", () => {
  /**
   * 把一次搜索的结果压成可直接比的字符串。
   *
   * 连「后端声明支不支持」也算进来：两份的 supports / supportsNear 必须一致，
   * 否则会出现「modern 能搜、mvp 说不能」这种诡异的兼容性差异。
   */
  const sliceSig = (rt: WasmRuntime, c: ScenariosGolden["slice"][number]): string => {
    const spec = specFromDict(c.spec);
    const sch = rt.searcher;
    if (!sch.supports(spec)) return `${spec.kind}:不支持`;
    const got = sch.searchSlice(spec, c.lo, c.hi);
    return JSON.stringify([spec.kind, [...got.seeds], got.head, got.truncated]);
  };

  const nearSig = (rt: WasmRuntime, c: ScenariosGolden["near"][number]): string => {
    const spec = specFromDict(c.spec);
    const sch = rt.searcher;
    if (!sch.supportsNear(spec)) return `${spec.kind}:不支持局部搜索`;
    const got = sch.searchNear(c.seed, spec, c.limit);
    return JSON.stringify([spec.kind, [...got.seeds], got.head]);
  };

  it("slice 498 例：seeds / head / truncated / 支持性全一致", () => {
    const g = loadGolden<ScenariosGolden>("scenarios.json");
    expect(g.slice.length).toBe(498);
    const modern = g.slice.map((c) => sliceSig(rtOf("modern"), c));
    const mvp = g.slice.map((c) => sliceSig(rtOf("mvp"), c));
    // 先报出**第一处**不同（498 行 diff 读不动）
    const i = modern.findIndex((row, k) => row !== mvp[k]);
    expect(i, `slice 第 ${i} 例（${g.slice[i]?.id}）不一致`).toBe(-1);
    expect(mvp).toEqual(modern);
  });

  it("near 648 例：seeds / head / 支持性全一致", () => {
    const g = loadGolden<ScenariosGolden>("scenarios.json");
    expect(g.near.length).toBe(648);
    const modern = g.near.map((c) => nearSig(rtOf("modern"), c));
    const mvp = g.near.map((c) => nearSig(rtOf("mvp"), c));
    const i = modern.findIndex((row, k) => row !== mvp[k]);
    expect(i, `near 第 ${i} 例（${g.near[i]?.id}）不一致`).toBe(-1);
    expect(mvp).toEqual(modern);
  });
});

// --------------------------------------------------------------------------- 场景层

describe.skipIf(!GOLDEN_AVAILABLE)("场景层：runs.json 端到端重放逐字段一致", () => {
  /**
   * 已落地的场景 key（与 `scenario_runs.test.ts` 同一判据）。
   *
   * ⚠️ 这里必须**自己再判一次** `GOLDEN_AVAILABLE`：`describe.skipIf` 只跳过 `it` 的**体**，
   * describe 的**工厂函数在收集阶段照跑**，所以在工厂里裸调 `loadRuns()` 在 CI 上照样
   * `ENOENT`（这正是本套件当初在 CI 炸掉的那一行）—— 守卫得落在这一行本身。
   */
  const REPLAY: readonly RunCase[] = GOLDEN_AVAILABLE
    ? loadRuns().runs.filter((rec) => registeredKeys().includes(rec.scenario))
    : [];

  it(`已落地场景的 ${REPLAY.length} 条 run 在两份 wasm 上结果相同`, async () => {
    // 一条 `it` 里跑完全部：真正要证的是「两份等价」，不是「每条 run 都对」
    // （后者是 `scenario_runs.test.ts` 的活），拆成 N 条只会让 vitest 开销翻倍。
    const problems: string[] = [];
    for (const rec of REPLAY) {
      const scenario = getScenario(rec.scenario);
      const inputs: Record<string, unknown> = { ...scenario.schema().defaults(), ...rec.inputs };
      const shots: Record<string, string> = {};
      for (const variant of WASM_VARIANTS) {
        const outcome = await scenario.run(inputs, rec.start_seed, { backend: rtOf(variant) });
        shots[variant] = JSON.stringify({
          data: outcome.toDict(),
          notes: outcome.notes.map((note) => note.toDict()),
        });
      }
      if (shots.modern !== shots.mvp) problems.push(`${rec.id}（${rec.scenario}）`);
    }
    expect(problems, `这些 run 在两份 wasm 上结果不同：${problems.join("、")}`).toEqual([]);
  });
});
