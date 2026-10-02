/**
 * 强化场景 ``strength``（强化石强化）—— 逐条对照
 * ``src_forge/tests/test_gameinfo_strength.py``。
 *
 * 分三层，理由和 Python 侧一样：
 *
 * 1. **合约层**（不需要后端）—— 表单 schema、常量表、``planOf`` 的成功率与下标、
 *    报错文案、``buildSpec`` 的区间；
 * 2. **自动升档层**（纯函数）—— :meth:`StrengthScenario.advance` 的回填值。
 *    ``runs.json`` 里**一格都没覆盖**它（golden 只记 ``Outcome``），所以这一层
 *    必须单独钉；
 * 3. **golden 层**（需要 wasm）—— 冻结的 ``(distance, seed, needConsume, seedAfter)``，
 *    顺带证明 ctypes 记下来的值在 wasm 上逐位一致。
 */

import { beforeAll, describe, expect, it } from "vitest";
// 副作用导入：注册表要先把场景装进去，``getScenario("strength")`` 才拿得到。
import "../src/scenarios/index";
import { CONSTS } from "../src/data/consts";
import { IntervalConstraint, IntervalSpec, type SeedSpec } from "../src/core/spec";
import { allScenarios, getScenario, registeredKeys } from "../src/scenarios/registry";
import { Outcome, ScenarioError } from "../src/scenarios/scenario";
import {
  ALLPRO,
  CHECK_RANDOMS,
  CLICK_OFFSET,
  CONSUME,
  CYCLE_FIXED,
  DEFAULT_STONE_GRADE,
  LEAD_FASTNEXT,
  MAX_LEVEL,
  MAX_STONE_COUNT,
  NEAR_LIMIT,
  NO_HIT_PREVIEW,
  NOISE_HEAD,
  NOISE_TAIL,
  PROB_MAX,
  SPEC_NUM,
  STONE_GRADES,
  TAIL_FASTNEXT,
  StrengthScenario,
  cheapStone,
  cheapStoneIndex,
  cycleLength,
  proIndex,
  successMax,
  successPro,
} from "../src/scenarios/strength";
import type { WasmRuntime } from "../src/wasm/runtime";
import { testRuntime } from "./helpers/golden";

/** 已注册的那个 ``strength`` 实例（顺带把类型收窄到具体类，好调 ``planOf``）。 */
function strength(): StrengthScenario {
  const scenario = getScenario("strength");
  if (!(scenario instanceof StrengthScenario)) {
    throw new Error(`strength 注册的不是 StrengthScenario：${scenario.constructor.name}`);
  }
  return scenario;
}

/**
 * 按 schema 默认值组一份强化输入，再用 ``patch`` 覆盖（``start`` 会盖掉 ``start_seed``）。
 *
 * 与 Python 的 ``_inputs`` 同构 —— **必须**从 ``defaults()`` 打底：``auto_upshift``
 * 这类开关也在里面，``collectInputs`` 才会把完整的一份 inputs 交给 ``advance()``。
 */
function mkInputs(patch: Record<string, unknown> = {}, start = 0): Record<string, unknown> {
  return { ...strength().schema().defaults(), start_seed: start, ...patch };
}

/** 取一个表单字段（不存在就抛，别让 ``?.`` 把断言悄悄变成空操作）。 */
function field(key: string) {
  const schema = strength().schema();
  const found = schema.keys.includes(key) ? schema.get(key) : null;
  if (!found) throw new Error(`strength 表单里没有字段 ${key}`);
  return found;
}

/** ``buildSpec`` 声明的返回类型是母体 ``SeedSpec``，这里收窄成区间规格再读上下界。 */
function asInterval(spec: SeedSpec): IntervalSpec {
  if (!(spec instanceof IntervalSpec)) {
    throw new Error(`强化应该产出 interval 规格，得到 ${spec.constructor.name}`);
  }
  return spec;
}

/** 取区间规格唯一的那个约束（``constraints`` 的元素类型是母体联合，要收窄）。 */
function onlyConstraint(spec: SeedSpec): IntervalConstraint {
  const first = asInterval(spec).constraints[0];
  if (!(first instanceof IntervalConstraint)) {
    throw new Error(`强化应只产出 interval 约束，得到 ${String(first?.kind)}`);
  }
  return first;
}

// =========================================================================== 1 合约层
describe("合约层 · schema", () => {
  it("strength 已注册", () => {
    expect(registeredKeys()).toContain("strength");
  });

  it("类属性与 Python 一致", () => {
    const sc = strength();
    expect(sc.key).toBe("strength");
    expect(sc.label).toBe("强化");
    expect(sc.version).toBe("1.0");
    expect(sc.hint).toContain("强化石强化");
    expect(sc.specKind).toBe("interval");
    expect(sc.supportsNear).toBe(true);
    expect(sc.nearLimit).toBe(NEAR_LIMIT);
    expect(sc.nearLimit).toBe(9999);
    expect(sc.sliceBounds).toBeNull();
  });

  it("字段顺序与上下限", () => {
    const schema = strength().schema();
    expect(schema.keys).toEqual([
      "start_seed",
      "roll_count",
      "level",
      "stone",
      "stone_count",
      "auto_upshift",
    ]);
    expect(field("stone").choices).toEqual(STONE_GRADES);
    expect(field("stone").default).toBe(STONE_GRADES[0]);
    expect(field("level").min).toBe(1);
    expect(field("level").max).toBe(MAX_LEVEL);
    expect(field("stone_count").min).toBe(1);
    expect(field("stone_count").max).toBe(MAX_STONE_COUNT);
    expect(field("start_seed").required).toBe(true);
    expect(field("start_seed").default).toBeNull();
  });

  it("「自动升档」是参数栏里的开关，不是工具栏开关", () => {
    const f = field("auto_upshift");
    expect(f.kind).toBe("bool");
    // 它一度是工具栏开关（``toolbar: true``），现在和「枚举全部」一样回了表单。
    expect(f.toolbar).toBe(false);
    expect(f.inToolbar).toBe(false);
    // 它管的是「算完要不要改参数」，而它改的正是这三项，所以与它们同组（``强化``）。
    expect(f.group).toBe("强化");
    expect(f.default).toBe(true);
    // 进表单了，但也得留在 ``defaults()`` 里 —— ``collectInputs`` 走的是全量 schema。
    expect(strength().schema().onForm().keys).toContain("auto_upshift");
    expect(strength().schema().defaults()["auto_upshift"]).toBe(true);
  });
});

describe("合约层 · 常量表", () => {
  it("ALLPRO 与 consts.json 是同一份数据", () => {
    expect(ALLPRO).toEqual([1, 0.375, 0.09, 0.02, 0.0058, 0, 0, 0, 0]);
    expect([...ALLPRO]).toEqual([...CONSTS.strength.allpro]);
  });

  it("强化石等级表与 consts.json 是同一份数据", () => {
    expect(STONE_GRADES).toEqual(["一", "二", "三", "四"]);
    expect(DEFAULT_STONE_GRADE).toBe("一");
    expect([...STONE_GRADES]).toEqual([...CONSTS.strength.stone_grades]);
  });

  it("偏移量与上限都与 consts.json 对钉", () => {
    expect(CLICK_OFFSET).toBe(3);
    expect(CONSUME).toBe(CLICK_OFFSET - 1);
    expect(CONSUME).toBe(2);
    expect(LEAD_FASTNEXT).toBe(4);
    expect(TAIL_FASTNEXT).toBe(2);
    expect(NEAR_LIMIT).toBe(9999);
    expect(MAX_LEVEL).toBe(7);
    expect(PROB_MAX).toBe(1.0);
    expect(MAX_STONE_COUNT).toBe(3);
    expect(SPEC_NUM).toBe(1);

    // 这几个在 ``consts.json`` 里有副本（给 UI 直接显示用），漂了要立刻发现。
    expect(LEAD_FASTNEXT).toBe(CONSTS.strength.lead_fastnext);
    expect(TAIL_FASTNEXT).toBe(CONSTS.strength.tail_fastnext);
    expect(CLICK_OFFSET).toBe(CONSTS.strength.click_offset);
    expect(NEAR_LIMIT).toBe(CONSTS.strength.near_limit);
    expect(MAX_LEVEL).toBe(CONSTS.strength.max_level);
    expect(PROB_MAX).toBe(CONSTS.strength.prob_max);
  });

  it("下标与 src 的 c - d + 1 等价（1 基 vs 0 基）", () => {
    for (let level = 1; level <= MAX_LEVEL; level++) {
      for (let d1 = 1; d1 <= STONE_GRADES.length; d1++) {
        const srcIndex = Math.max(level - d1 + 1, 0);
        const name = STONE_GRADES[d1 - 1] as string;
        expect(proIndex(level, name), `等级${level}/${name}`).toBe(srcIndex);
      }
    }
  });

  it("cycle 公式 = 无关2 + 判断1 + 白板随机属性n + 无关2", () => {
    expect([NOISE_HEAD, CHECK_RANDOMS, NOISE_TAIL]).toEqual([2, 1, 2]);
    expect(CYCLE_FIXED).toBe(NOISE_HEAD + CHECK_RANDOMS + NOISE_TAIL);
    expect(CYCLE_FIXED).toBe(5);
    // 失败会回档、回档不吃随机数 → 公式里没有「失败」这一项。
    expect(MAX_LEVEL).toBe(7);
  });

  it("CLICK_OFFSET 是「判断位」，不是搜索起点那个 4", () => {
    expect(CLICK_OFFSET).toBe(NOISE_HEAD + CHECK_RANDOMS);
    expect(CLICK_OFFSET).toBe(3);
    // 搜索起点的 4 是 ``src`` 自己加的「不要拿到太近的种子」偏移，不是同一个数。
    expect(LEAD_FASTNEXT).not.toBe(NOISE_HEAD + CHECK_RANDOMS);
  });

  it("cycleLength = 5 + n", () => {
    const cases: readonly (readonly [number, number])[] = [
      [0, 5],
      [1, 6],
      [2, 7],
      [3, 8],
      [10, 15],
    ];
    for (const [roll, expected] of cases) {
      expect(cycleLength(roll), `n=${roll}`).toBe(expected);
    }
  });

  it("successPro 查表 + clamp", () => {
    const cases: readonly (readonly [number, string, number, number])[] = [
      [1, "一", 1, 0.375],
      [2, "一", 1, 0.09],
      [4, "二", 1, 0.02],
      [4, "二", 2, 0.04],
      [1, "一", 3, 1.0], // 超过 1 会被 clamp
      [7, "三", 1, 0.0],
      [1, "四", 1, 1.0], // 下标被夹到 0
    ];
    for (const [level, stone, count, expected] of cases) {
      expect(successPro(level, stone, count), `${level}级/${stone}/${count}颗`).toBe(expected);
    }
  });

  it("cheapStone 沿用旧版的 max(等级 - 4, 0)", () => {
    const levels = [1, 2, 3, 4, 5, 6, 7];
    expect(levels.map((lv) => cheapStone(lv))).toEqual(["一", "一", "一", "一", "二", "三", "四"]);
    expect(levels.map((lv) => cheapStoneIndex(lv))).toEqual([0, 0, 0, 0, 1, 2, 3]);
    // 超出上限也不越界（真到不了，纯防御）。
    expect(cheapStone(99)).toBe(STONE_GRADES[STONE_GRADES.length - 1]);
  });

  it("成功率表下标越界当场报错（Python 那里是 IndexError）", () => {
    // ``planOf`` 已经把等级限死在 1~7，所以这条是纯防御 ——
    // 但也不能把 NaN 悄悄带进区间上界。
    expect(() => successPro(9, "一", 1)).toThrow(/成功概率表没有下标 9/);
  });

  it("cycleLength 与「宠物铠甲强化」预设对得上", () => {
    // 预设表是 ``src`` 的**另一份**数据，它和强化公式对得上就不算巧合：
    // ``step === cycleLength(minimum) === 6``。
    const preset = CONSTS.stars.presets.find((p) => p.name === "宠物铠甲强化");
    expect(preset).toBeTruthy();
    expect(preset?.minimum).toBe(1); // 变动范围 1~5
    expect(preset?.span).toBe(4);
    expect(preset?.step).toBe(6);
    expect(cycleLength(preset?.minimum ?? -1)).toBe(preset?.step);
  });
});

describe("合约层 · planOf / validate / buildSpec", () => {
  it("plan 数字（下标 / 概率 / 上界 / 数量）", () => {
    const cases: readonly (readonly [number, string, number, number, number])[] = [
      [1, "一", 1, 1, 0.375],
      [1, "一", 2, 1, 0.75],
      [2, "一", 1, 2, 0.09],
      [4, "二", 2, 3, 0.04],
      [7, "四", 1, 4, 0.0058],
      [1, "四", 1, 0, 1.0],
    ];
    for (const [level, stone, count, index, prob] of cases) {
      const plan = strength().planOf(mkInputs({ level, stone, stone_count: count }));
      const label = `${level}级/${stone}/${count}颗`;
      expect(plan.index, label).toBe(index);
      expect(plan.prob, label).toBe(prob);
      expect(plan.successMax, label).toBe(Math.trunc(prob * 0x80000000));
      expect(plan.num, label).toBe(SPEC_NUM);
      expect(plan.num, label).toBe(1);
      expect(plan.consume, label).toBe(CONSUME);
    }
  });

  it("plan 带出「点一次吃几次随机」", () => {
    expect(strength().planOf(mkInputs({ roll_count: 0 })).cycle).toBe(5);
    expect(strength().planOf(mkInputs({ roll_count: 3 })).cycle).toBe(8);
  });

  it("successMax 是 int() 截断，不是 round", () => {
    // 0.0058 * 2^31 = 12455405.158…：截断和四舍五入碰巧同值
    expect(successMax(4, "一")).toBe(12455405);
    // 0.02 * 2^31 = 42949672.96：**这里两者不一样**，所以「用截断」是能被抓住的
    expect(successMax(4, "二")).toBe(42949672);
    expect(Math.round(0.02 * 0x80000000)).toBe(42949673);
  });

  it("概率 0 只是 warning，不是 error", () => {
    const notes = strength().validate(mkInputs({ level: 7, stone: "三" }));
    expect(notes.some((n) => n.message.includes("成功率为 0"))).toBe(true);
    expect(notes.filter((n) => n.isError)).toHaveLength(0);
  });

  it("坏输入一律是 error，且 prepare 会抛", () => {
    const bad: readonly Record<string, unknown>[] = [
      { level: 0 },
      { level: MAX_LEVEL + 1 },
      { stone_count: 0 },
      { stone_count: MAX_STONE_COUNT + 1 },
      { stone: "五" },
      { stone: "1.5" },
      { roll_count: -1 },
    ];
    for (const patch of bad) {
      const label = JSON.stringify(patch);
      const inputs = mkInputs(patch);
      expect(
        strength()
          .validate(inputs)
          .filter((n) => n.isError),
        label,
      ).not.toHaveLength(0);
      expect(() => strength().prepare(inputs, 12345), label).toThrow(ScenarioError);
    }
  });

  it("报错文案与 Python 逐字一致", () => {
    expect(() => strength().planOf(mkInputs({ level: 8 }))).toThrow(
      "目标等级必须是 1~7 的整数，得到 8",
    );
    expect(() => strength().planOf(mkInputs({ stone_count: 4 }))).toThrow(
      "强化石数量必须是 1~3 的整数，得到 4",
    );
    expect(() => strength().planOf(mkInputs({ stone: "五" }))).toThrow(
      "强化石等级只能是 一/二/三/四 或 1..4，得到 '五'",
    );
    expect(() => strength().planOf(mkInputs({ roll_count: -1 }))).toThrow("随机属性数不能为负");
  });

  it("默认值可跑", () => {
    const notes = strength().validate(mkInputs());
    expect(notes.filter((n) => n.isError)).toEqual([]);
  });

  it("buildSpec = 单区间 (0, successMax)，step 1", () => {
    const spec = asInterval(
      strength().buildSpec(mkInputs({ level: 1, stone: "一", stone_count: 1 }), 12345),
    );
    expect(spec.num).toBe(1);
    expect(spec.step).toBe(1);
    expect(spec.constraints.length).toBe(1);
    expect(onlyConstraint(spec).lo).toBe(0);
    expect(onlyConstraint(spec).hi).toBe(805306368); // int(0.375 * 2^31)
  });

  it("概率 1 时上界就是 2^31（等价于「不筛」）", () => {
    expect(successMax(1, "四")).toBe(0x80000000);
    const spec = asInterval(strength().buildSpec(mkInputs({ level: 1, stone: "四" }), 12345));
    expect(onlyConstraint(spec).lo).toBe(0);
    expect(onlyConstraint(spec).hi).toBe(0x80000000);
  });

  it("契约钩子：搜索起点 = 起始值走 4 次，记账消耗 = 2", () => {
    const sc = strength();
    expect(sc.advanceCount(mkInputs())).toBe(LEAD_FASTNEXT);
    expect(sc.randomConsumption(mkInputs())).toBe(CONSUME);
  });
});

// =========================================================================== 2 自动升档
/** Python 侧 ``TestAutoUpshift._outcome`` 的等价物。 */
function outcomeWith(seedAfter: number): Outcome {
  return new Outcome({ seed: 1090519811, distance: 4, needConsume: 1, consume: 2, seedAfter });
}

describe("自动升档 advance（纯函数）", () => {
  it("下一轮 = 等级 +1、强化石最省的一档、数量回 1", () => {
    const got = strength().advance(
      outcomeWith(2084569280),
      mkInputs({ level: 1, stone: "一", stone_count: 3 }),
    );
    expect(got).toEqual({
      start_seed: 2084569280,
      level: 2,
      stone: "一",
      stone_count: 1,
    });
  });

  it("5 级升 6 级时强化石跟着跳档", () => {
    const got = strength().advance(outcomeWith(6419400), mkInputs({ level: 5, stone: "二", stone_count: 3 }));
    expect(got).not.toBeNull();
    expect(got?.["level"]).toBe(6);
    expect(got?.["stone"]).toBe("三");
  });

  it("不碰「随机属性数B」（那是装备自己的属性）", () => {
    const got = strength().advance(outcomeWith(7), mkInputs({ level: 1, roll_count: 5 }));
    expect(got).not.toBeNull();
    expect(got).not.toHaveProperty("roll_count");
  });

  it("到 7 级整块跳过 —— 连 A 都不换", () => {
    expect(
      strength().advance(outcomeWith(1333644125), mkInputs({ level: MAX_LEVEL, stone: "四" })),
    ).toBeNull();
  });

  it("开关关掉就什么都不做", () => {
    expect(
      strength().advance(outcomeWith(2084569280), mkInputs({ level: 1, auto_upshift: false })),
    ).toBeNull();
  });

  it("没命中（seedAfter = 0）也不动，别把 A 清成 0", () => {
    expect(strength().advance(outcomeWith(0), mkInputs({ level: 1 }))).toBeNull();
  });

  it("别的场景默认 opt-out（基类 advance 一律返回 null）", () => {
    // 这一测就是基类那个默认实现的契约：界面只对**自己声明了**它的场景生效。
    for (const scenario of allScenarios()) {
      if (scenario.key === "strength") continue;
      expect(scenario.advance(outcomeWith(123), {}), scenario.key).toBeNull();
    }
  });
});

// =========================================================================== 3 golden 层
/** ``(level, stone, count, roll, start, distance, seed, needConsume, seedAfter)``。 */
const GOLDEN: readonly (readonly [number, string, number, number, number, number, number, number, number])[] = [
  [1, "一", 1, 0, 12345, 4, 1090519811, 1, 2084569280],
  [4, "二", 2, 2, 987654321, 10, 350926746, 7, 1531882361],
];

/** 成功率 0 → 区间退化成 ``(0, 0)``，一个种子都搜不到。 */
const NO_HIT: readonly [number, string, number, number, number] = [7, "三", 1, 5, 12345];

describe("golden 层：与 Python 冻结的值逐字段一致（跨后端）", () => {
  let rt: WasmRuntime;
  beforeAll(async () => {
    rt = await testRuntime();
  });

  for (const [level, stone, count, roll, start, distance, seed, need, after] of GOLDEN) {
    it(`L${level}${stone}x${count}roll${roll}@${start}`, async () => {
      const inputs = mkInputs({ level, stone, stone_count: count, roll_count: roll }, start);
      const out = await strength().run(inputs, start, { backend: rt });
      expect([out.distance, out.seed, out.needConsume, out.seedAfter]).toEqual([
        distance,
        seed,
        need,
        after,
      ]);
      expect(out.preview).toBe(`连点器: ${need}\n末种子: ${after}`);
      expect(out.consume).toBe(CONSUME);
      expect(out.extra["index"]).toBe(proIndex(level, stone));
    });
  }

  it("概率 0 的 no-hit：seed 0 / distance 0 / needConsume -1", async () => {
    const [level, stone, count, roll, start] = NO_HIT;
    const inputs = mkInputs({ level, stone, stone_count: count, roll_count: roll }, start);
    const out = await strength().run(inputs, start, { backend: rt });
    expect([out.seed, out.distance, out.needConsume]).toEqual([0, 0, -1]);
    expect(out.seedAfter).toBe(0);
    expect(out.preview).toBe(NO_HIT_PREVIEW);
    expect(out.notes.map((n) => n.message)).toEqual([
      "7 级用「三」级强化石的成功率为 0，区间退化成 (0, 0)，实际上搜不到任何种子",
      "在给定上限内没有找到任何种子",
    ]);
  });

  it("真实一轮也带出「点一次 = 吃几次随机」", async () => {
    const inputs = mkInputs({ level: 1, stone: "一", roll_count: 2 }, 12345);
    const out = await strength().run(inputs, 12345, { backend: rt });
    expect(out.seed).toBeTruthy();
    expect(out.extra["cycle_randoms"]).toBe(cycleLength(2));
    expect(out.extra["cycle_randoms"]).toBe(7);
  });

  it("near=false 会被拒 —— 强化只有局部搜索", async () => {
    await expect(
      strength().run(mkInputs(), 12345, { near: false, backend: rt }),
    ).rejects.toThrow(ScenarioError);
  });
});
