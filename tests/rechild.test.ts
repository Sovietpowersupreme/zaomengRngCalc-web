/**
 * 宠物还童场景 ``rechild``（丹药 / 药园初·中·高级）—— 逐条对照
 * ``src_forge/tests/test_gameinfo_pet.py`` 的 ``TestRechildPlan`` /
 * ``TestNoHit.test_rechild_sentinel`` / ``TestGolden.test_rechild`` /
 * ``test_rechild_extra_fields`` / ``test_danyao_n_is_zero`` /
 * ``test_rebirth_config_matches_src``。
 *
 * 分三层，理由与 ``capture.test.ts`` 一样：
 *
 * 1. **合约层**（不需要后端）—— 表单 schema、``REBIRTH_CONFIG`` 参数表、
 *    ``planOf`` 的槽位与报错文案、``buildSpec`` 的 ``PoolSpec``；
 * 2. **哨兵层**（不需要后端）—— 一个种子都没命中时 :func:`finalize` 走哪条分支。
 *    必须**直调 ``interpret``**：``run`` 会先跑搜索，构造不出「空结果」；
 * 3. **golden 层**（需要 wasm）—— 冻结的 ``(distance, seed, needConsume, consume,
 *    preview)``，顺带证明 ctypes 记下来的值在 wasm 上逐位一致。
 *
 * ⚠️ golden 层显式传 ``near: true``：Python 的 ``TestGolden`` 就是这么调的，
 * 与 TS 侧的默认值（见下）保持字面一致，将来万一默认值变了也是这条用例先红。
 *
 * 起始种子是这一族的**必填**字段（``PetScenario``）。旧版这里没有它，``run()``
 * 的起点被兜底成 ``0``，而 ``FastNext(0) == 0`` —— 捕捉永远搜不到、还童静默给出
 * 「距离 1、还差 -3 次」。旧版 ``src/PetCalculator.py:102`` 一直有那一格。
 */

import { beforeAll, describe, expect, it } from "vitest";
// 副作用导入：注册表要先把场景装进去，``getScenario("rechild")`` 才拿得到。
import "../src/scenarios/index";
import { SearchResult } from "../src/core/search";
import { IntervalConstraint, PoolSpec, type SeedSpec } from "../src/core/spec";
import { getScenario, registeredKeys } from "../src/scenarios/registry";
import { InputSchema, Note, ScenarioError } from "../src/scenarios/scenario";
import { ATTR_ORDER, NO_HIT_PREVIEW, PETS, PET_ORDER } from "../src/scenarios/capture";
import {
  DEFAULT_MODE,
  REBIRTH_CONFIG,
  REBIRTH_MODES,
  RechildPlan,
  RechildScenario,
} from "../src/scenarios/rechild";
import type { WasmRuntime } from "../src/wasm/runtime";
import { testRuntime } from "./helpers/golden";

/** 已注册的那个 ``rechild`` 实例（顺带把类型收窄到具体类，好调 ``planOf``）。 */
function rechild(): RechildScenario {
  const scenario = getScenario("rechild");
  if (!(scenario instanceof RechildScenario)) {
    throw new Error(`rechild 注册的不是 RechildScenario：${scenario.constructor.name}`);
  }
  return scenario;
}

/**
 * 按 schema 默认值组一份还童输入（= Python ``_rc_inputs``）。
 *
 * ``start_seed`` 会在 ``defaults()`` 里带上（值为 ``null``，那时「必填但还没填」的
 * 状态），与 Python 侧逐字一致；真正开搜的起点由 ``startInitial`` 单独传。
 */
function mkRc(
  pet: string,
  mode: string,
  level = 1,
  mainAttr = "生命",
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...rechild().schema().defaults(),
    pet,
    mode,
    level,
    main_attr: mainAttr,
    ...extra,
  };
}

/** 取一个表单字段（不存在就抛，别让 ``?.`` 把断言悄悄变成空操作）。 */
function field(key: string) {
  const schema = rechild().schema();
  const found = schema.keys.includes(key) ? schema.get(key) : null;
  if (!found) throw new Error(`rechild 表单里没有字段 ${key}`);
  return found;
}

/** ``planOf`` 的返回类型已经是具体类，这里只是为了读起来更短。 */
function plan(inputs: Record<string, unknown>): RechildPlan {
  return rechild().planOf(inputs);
}

/** ``buildSpec`` 声明的返回类型是母体 ``SeedSpec``，这里收窄成池规格再读字段。 */
function asPool(spec: SeedSpec): PoolSpec {
  if (!(spec instanceof PoolSpec)) {
    throw new Error(`还童应该产出 pool 规格，得到 ${spec.constructor.name}`);
  }
  return spec;
}

/** 把 ``Pair`` 读成普通数组，避免 ``toEqual`` 里混进冻结标记的干扰。 */
function pairOf(out: { extraRanges: ReadonlyMap<string, readonly [number, number]> }, attr: string) {
  const found = out.extraRanges.get(attr);
  if (found === undefined) throw new Error(`额外资质表里没有 ${attr}`);
  return [found[0], found[1]];
}

/** 取第一条 error note（没有就抛，避免 ``found?.field`` 把断言变成空操作）。 */
function firstError(notes: readonly Note[]): Note {
  const found = notes.find((n) => n.level === "error");
  if (found === undefined) throw new Error(`没有任何 error note：${JSON.stringify(notes.map((n) => n.toDict()))}`);
  return found;
}

/** 一个种子都没命中时的空结果（= Python ``TestNoHit._empty()``）。 */
function emptyResult(): SearchResult {
  return new SearchResult({ seeds: [], head: 0, nearest: null, distance: null, backend: "test" });
}

/** 找一个「基础属性不随机」的宠物（= Python ``next(n for n, p in PETS.items() if not ...)``）。 */
function noBaseRandomPet(): string {
  const found = PET_ORDER.find((name) => PETS[name]?.基础属性随机 === false);
  if (found === undefined) throw new Error("宠物表里没有「基础属性不随机」的宠物");
  return found;
}

// =========================================================================== 1 合约层 · schema
describe("合约层 · schema", () => {
  it("rechild 已注册", () => {
    expect(registeredKeys()).toContain("rechild");
  });

  it("类属性与 Python 一致", () => {
    const sc = rechild();
    expect(sc.key).toBe("rechild");
    expect(sc.label).toBe("宠物还童");
    expect(sc.version).toBe("1.0");
    expect(sc.specKind).toBe("pool");
    expect(sc.supportsNear).toBe(true);
    expect(sc.sliceBounds).toBeNull();
    expect(sc.hint).toBe(
      "用丹药或药园还童宠物。选宠物 → 选还童方式 → 填等级与主资质 → 填起始种子。\n" +
        "总额外资质先扣保底（等级决定），剩下的随机分给 3 个属性，最后一个吃残羹。\n" +
        "额外资质留空 = 用默认范围（主属性 [保底, 总额]，其余 [0, 可随机部分]）。\n" +
        "",
    );
  });

  it("nearLimit 用场景层的 9999999", () => {
    expect(rechild().nearLimit).toBe(9_999_999);
  });

  it("字段顺序与 Python 一致（pet + mode + level + main_attr + 4 额外 + 4 基础 + 搜索组）", () => {
    expect(rechild().schema().keys).toEqual([
      "pet",
      "mode",
      "level",
      "main_attr",
      ...ATTR_ORDER.map((a) => `extra_${a}`),
      ...ATTR_ORDER.map((a) => `base_${a}`),
      "start_seed",
      "full_search",
      "limit",
    ]);
    expect(rechild().schema().headers).toEqual({});
  });

  it("「搜索」组与捕捉同款（都是从 PetScenario 继承来的）", () => {
    const capture = getScenario("capture").schema();
    const mine = rechild().schema();
    expect([...mine.fields.filter((f) => f.group === "搜索")]).toEqual([
      ...capture.fields.filter((f) => f.group === "搜索"),
    ]);
    // 0 不是合法种子（FastNext(0) == 0），所以默认留空 + 必填
    expect(field("start_seed").required).toBe(true);
    expect(field("start_seed").default).toBeNull();
    expect(field("start_seed").min).toBe(1);
    expect(field("start_seed").max).toBe(0x7fffffff);
    expect(field("full_search").default).toBe(false);
    expect(field("limit").default).toBe(0);
  });

  it("每个字段的 kind / group / width / help 与 Python 一致", () => {
    expect(field("pet").kind).toBe("choice");
    expect(field("pet").label).toBe("宠物");
    expect(field("pet").group).toBe("宠物");
    expect(field("pet").width).toBe(12);
    expect(field("pet").help).toBe("");

    expect(field("mode").kind).toBe("choice");
    expect(field("mode").label).toBe("还童方式");
    expect(field("mode").default).toBe(DEFAULT_MODE);
    expect(field("mode").choices).toEqual([...REBIRTH_MODES]);
    expect(field("mode").group).toBe("宠物");
    expect(field("mode").width).toBe(14);
    expect(field("mode").help).toBe("");

    expect(field("level").kind).toBe("int");
    expect(field("level").label).toBe("等级");
    expect(field("level").default).toBe(1);
    expect(field("level").min).toBe(1);
    expect(field("level").max).toBeNull();
    expect(field("level").group).toBe("宠物");
    expect(field("level").help).toBe("等级决定保底额外资质");
    expect(field("level").width).toBe(8);

    expect(field("main_attr").kind).toBe("choice");
    expect(field("main_attr").label).toBe("主资质");
    expect(field("main_attr").default).toBe(ATTR_ORDER[0]);
    expect(field("main_attr").choices).toEqual([...ATTR_ORDER]);
    expect(field("main_attr").group).toBe("宠物");
    expect(field("main_attr").width).toBe(12);

    for (const attr of ATTR_ORDER) {
      const extra = field(`extra_${attr}`);
      expect(extra.kind).toBe("text");
      expect(extra.label).toBe(`${attr}额外`);
      expect(extra.default).toBe("");
      expect(extra.group).toBe("额外资质目标");
      expect(extra.help).toBe("留空=默认范围；支持「10~20」「10-20」「10」");
      expect(extra.width).toBe(12);

      const base = field(`base_${attr}`);
      expect(base.kind).toBe("text");
      expect(base.label).toBe(`${attr}基础`);
      expect(base.default).toBe("");
      expect(base.group).toBe("基础属性目标");
      expect(base.help).toBe("只有「基础属性随机」的宠物才需要填");
      expect(base.width).toBe(12);
    }

    // 搜索组：只查三个字段里各自专属的那几项（与 capture 的逐项对拍在上一块）
    expect(field("start_seed").kind).toBe("int");
    expect(field("start_seed").label).toBe("起始种子");
    expect(field("start_seed").group).toBe("搜索");
    expect(field("start_seed").width).toBe(14);
    expect(field("start_seed").help).toBe("游戏里当前的那个种子（1 ~ 2147483647）；留空会直接报错");

    expect(field("full_search").kind).toBe("bool");
    expect(field("full_search").label).toBe("枚举全部");
    expect(field("full_search").group).toBe("搜索");

    expect(field("limit").kind).toBe("int");
    expect(field("limit").label).toBe("步数上限");
    expect(field("limit").group).toBe("搜索");
    expect(field("limit").width).toBe(12);
  });

  it("describe() 的字段集合与 Python 完全一致（没有 near_limit / slice_bounds）", () => {
    const described = rechild().describe();
    expect(Object.keys(described)).toEqual([
      "key",
      "label",
      "version",
      "hint",
      "spec_kind",
      "supports_near",
      "schema",
    ]);
    expect(described.key).toBe("rechild");
    expect(described.spec_kind).toBe("pool");
    expect(described.supports_near).toBe(true);
    // 这份自描述要能原样进 JSON（是 ``make_scenario_fixtures.py`` 的输入）
    expect(JSON.parse(JSON.stringify(described))).toEqual(described);
    // 逐字段的对拍在 scenarios.test.ts 里做（那边直接比夹具），这里只保证可往返
    expect(InputSchema.fromDict(described.schema).keys).toEqual(rechild().schema().keys);
  });
});

// =========================================================================== 1 合约层 · 常量表
describe("合约层 · 常量表", () => {
  it("REBIRTH_MODES 的顺序就是 Python 的 tuple(REBIRTH_CONFIG)", () => {
    expect([...REBIRTH_MODES]).toEqual([
      "丹药还童",
      "药园初级还童",
      "药园中级还童",
      "药园高级还童",
    ]);
    // 键序漂移哨兵：增删模式时两处必须一起改
    expect(Object.keys(REBIRTH_CONFIG)).toEqual([...REBIRTH_MODES]);
  });

  it("DEFAULT_MODE 是药园初级还童，而**不是** REBIRTH_MODES[0]", () => {
    expect(DEFAULT_MODE).toBe("药园初级还童");
    expect(DEFAULT_MODE).not.toBe(REBIRTH_MODES[0]);
    expect(REBIRTH_MODES).toContain(DEFAULT_MODE);
  });

  it("总额与 n 逐项对应 src.PetCalculator.REBIRTH_CONFIG", () => {
    const expected: Record<string, readonly [number, number]> = {
      丹药还童: [100, 0],
      药园初级还童: [100, 3],
      药园中级还童: [200, 3],
      药园高级还童: [250, 3],
    };
    expect(new Set(Object.keys(REBIRTH_CONFIG))).toEqual(new Set(Object.keys(expected)));
    for (const [mode, [pool, n]] of Object.entries(expected)) {
      const cfg = REBIRTH_CONFIG[mode];
      expect(cfg?.totalPool).toBe(pool);
      expect(cfg?.n).toBe(n);
    }
  });

  it("保底函数逐级对上（含 1 / 5 / 42 / 100 四个等级）", () => {
    const want: Record<string, (level: number) => number> = {
      丹药还童: () => 0,
      药园初级还童: (l) => l * 1,
      药园中级还童: (l) => l * 2,
      药园高级还童: (l) => l * 2,
    };
    for (const mode of REBIRTH_MODES) {
      for (const level of [1, 5, 42, 100]) {
        expect(REBIRTH_CONFIG[mode]?.guarantee(level)).toBe(want[mode]?.(level));
      }
    }
  });

  it("丹药还童的 n = 0（照抄 src，别按注释「修正」成 1）", () => {
    expect(REBIRTH_CONFIG["丹药还童"]?.n).toBe(0);
    const p = plan(mkRc("年兽", "丹药还童", 5));
    expect(p.consume).toBe(0);
    expect(p.guarantee).toBe(0);
    expect(p.randomTotal).toBe(100);
  });
});

// =========================================================================== 1 合约层 · planOf
describe("合约层 · planOf", () => {
  const TABLE: [string, number, number, number][] = [
    ["丹药还童", 5, 0, 100],
    ["药园初级还童", 5, 5, 95],
    ["药园中级还童", 5, 10, 190],
    ["药园高级还童", 5, 10, 240],
    ["药园高级还童", 100, 200, 50],
  ];

  for (const [mode, level, guarantee, randomTotal] of TABLE) {
    it(`${mode} 等级 ${level} → 保底 ${guarantee} / 可随机 ${randomTotal}`, () => {
      const p = plan(mkRc("年兽", mode, level));
      expect(p.guarantee).toBe(guarantee);
      expect(p.randomTotal).toBe(randomTotal);
      expect(p.consume).toBe(REBIRTH_CONFIG[mode]?.n);
      expect(p.consume).toBe(rechild().randomConsumption(mkRc("年兽", mode, level)));
      expect(rechild().advanceCount(mkRc("年兽", mode, level))).toBe(p.consume + 1);
    });
  }

  it("额外资质默认范围：主属性 [保底, 总额]，其余 [0, 可随机部分]", () => {
    const p = plan(mkRc("年兽", "药园初级还童", 5, "生命"));
    expect(pairOf(p, "生命")).toEqual([5, 100]);
    for (const attr of ATTR_ORDER.slice(1)) {
      expect(pairOf(p, attr)).toEqual([0, 95]);
    }
    // 槽位 1~3 是「池分配」：主属性要减掉保底，于是三条都成了 [0, 95]
    expect(p.targets[0]).toEqual([0, 95]);
    expect(p.targets[1]).toEqual([0, 95]);
    expect(p.targets[2]).toEqual([0, 95]);
  });

  it("主资质换到哪个属性，它就占第一个槽位（其余仍按 ATTR_ORDER）", () => {
    const p = plan(
      mkRc("年兽", "药园初级还童", 5, "攻击", { extra_攻击: "15~60" }),
    );
    expect(p.targets[0]).toEqual([10, 55]); // 15-5, 60-5
    expect(p.targets[1]).toEqual([0, 95]); // 生命
    expect(p.targets[2]).toEqual([0, 95]); // 魔法
  });

  it("额外资质**不做**上界检查（strict = false 的回归）", () => {
    const inputs = mkRc("年兽", "药园初级还童", 5, "生命", { extra_魔法: "0~200" });
    const notes = rechild().validate(inputs);
    expect(notes.filter((n) => n.level === "error")).toEqual([]);
    const p = plan(inputs);
    expect(pairOf(p, "魔法")).toEqual([0, 200]);
    expect(p.targets[1]).toEqual([0, 200]);
  });

  it("额外资质**要**查负数（这条分支在越界检查之前）", () => {
    const inputs = mkRc("年兽", "药园初级还童", 5, "生命", { extra_魔法: "-5~10" });
    const notes = rechild().validate(inputs);
    expect(firstError(notes).field).toBe("extra_魔法");
    expect(firstError(notes).message).toBe("魔法 额外资质不能为负数，已按默认处理");
    // 退回默认范围：非主轴 = [0, 可随机部分]
    expect(pairOf(plan(inputs), "魔法")).toEqual([0, 95]);
  });

  it("基础属性目标是严格的（越界记 error）", () => {
    const inputs = mkRc("年兽", "药园初级还童", 5, "生命", { base_生命: "1~99999" });
    const notes = rechild().validate(inputs);
    expect(firstError(notes).field).toBe("base_生命");
    expect(firstError(notes).message).toBe("生命 基础属性 1~99999 超出 500~1000，已按默认处理");
    expect(() => rechild().prepare(inputs, 0)).toThrow(ScenarioError);
  });

  it("基础属性随机时多出 4 个槽位与 4 个倍率", () => {
    const p = plan(mkRc("年兽", "药园初级还童", 5));
    expect(p.baseRandom).toBe(true);
    expect(p.targets).toHaveLength(3 + 4);
    expect(p.num).toBe(7);
    const source = PETS["年兽"]?.基础属性范围;
    expect(source).toBeDefined();
    expect([...p.baseRolls]).toEqual(
      ATTR_ORDER.map((attr) => {
        const range = source?.[attr];
        if (range === undefined) throw new Error(`年兽缺少「${attr}」的基础属性范围`);
        return range[1] - range[0];
      }),
    );
  });

  it("基础属性**不**随机时只有 3 个槽位、没有倍率、没有基础范围表", () => {
    const p = plan(mkRc(noBaseRandomPet(), "药园初级还童", 5));
    expect(p.baseRandom).toBe(false);
    expect(p.num).toBe(3);
    expect(p.attrRanges.size).toBe(0);
    expect([...p.baseRolls]).toEqual([]);
    // 显式填了 base_* 也没用 —— 那条分支根本不看输入
    expect(plan(mkRc(noBaseRandomPet(), "药园初级还童", 5, "生命", { base_生命: "1~2" })).num).toBe(3);
  });

  it("等级 / 主资质 / 模式 / 宠物名各自会抛 ScenarioError", () => {
    expect(() => plan(mkRc("年兽", "药园初级还童", 0))).toThrow(ScenarioError);
    expect(() => plan(mkRc("年兽", "药园初级还童", 5, "敏捷"))).toThrow(ScenarioError);
    expect(() => plan(mkRc("年兽", "洗点还童", 5))).toThrow(ScenarioError);
    expect(() => plan(mkRc("不存在", "药园初级还童", 5))).toThrow(ScenarioError);
  });

  it("保底 > 总额时抛错（药园高级 250 / 2 = 125 级封顶）", () => {
    expect(plan(mkRc("年兽", "药园高级还童", 125)).randomTotal).toBe(0);
    expect(() => plan(mkRc("年兽", "药园高级还童", 126))).toThrow(ScenarioError);
  });

  it("每条 targets 都是 0 <= lo <= hi", () => {
    for (const pet of PET_ORDER) {
      for (const mode of REBIRTH_MODES) {
        const p = plan(mkRc(pet, mode, 5));
        for (const [lo, hi] of p.targets) {
          expect(lo).toBeGreaterThanOrEqual(0);
          expect(lo).toBeLessThanOrEqual(hi);
        }
      }
    }
  });

  it("默认值在所有模式 × 所有宠物上都能跑", () => {
    for (const pet of PET_ORDER) {
      for (const mode of REBIRTH_MODES) {
        const notes = rechild().validate(mkRc(pet, mode, 10));
        expect(notes.filter((n) => n.level === "error")).toEqual([]);
      }
    }
  });
});

// =========================================================================== 1 合约层 · validate 报错文案
describe("合约层 · validate 报错文案", () => {
  const CASES: [string, Record<string, unknown>][] = [
    ["未知的宠物：'不存在'", mkRc("不存在", "药园初级还童", 5)],
    ["宠物还童 不支持的模式：'洗点还童'", mkRc("年兽", "洗点还童", 5)],
    ["宠物等级必须为正整数", mkRc("年兽", "药园初级还童", 0)],
    ["主资质必须是 ['生命', '魔法', '攻击', '防御'] 之一，得到 '敏捷'", mkRc("年兽", "药园初级还童", 5, "敏捷")],
    ["保底值超过总额外资质，等级太高了", mkRc("年兽", "药园高级还童", 126)],
  ];

  for (const [message, inputs] of CASES) {
    it(`validate 把「${message}」变成一条 error note`, () => {
      const notes = rechild().validate(inputs);
      expect(notes).toHaveLength(1);
      expect(firstError(notes).message).toBe(message);
      // 这几条是 planOf 直接抛出来的，走 validate 的 except 分支 → 没有 field
      expect(firstError(notes).field).toBe("");
    });
  }

  it("解析不了的额外资质：文案是「已按默认处理」，field 指向那个框", () => {
    const notes = rechild().validate(mkRc("年兽", "药园初级还童", 5, "生命", { extra_生命: "abc" }));
    expect(notes).toHaveLength(1);
    expect(firstError(notes).field).toBe("extra_生命");
    expect(firstError(notes).message).toBe("生命 额外资质范围无法解析（'abc'），已按默认处理");
  });

  it("解析不了的基础属性：同一个 kind 词，文案仍是「已按默认处理」", () => {
    const notes = rechild().validate(mkRc("年兽", "药园初级还童", 5, "生命", { base_攻击: "abc" }));
    expect(notes).toHaveLength(1);
    expect(firstError(notes).field).toBe("base_攻击");
    expect(firstError(notes).message).toBe("攻击 基础属性范围无法解析（'abc'），已按默认处理");
  });

  it("上下界写反了自动交换，不算错", () => {
    const inputs = mkRc("年兽", "药园初级还童", 5, "生命", { base_生命: "900~600" });
    expect(rechild().validate(inputs)).toEqual([]);
    const p = plan(inputs);
    // 基础属性槽位是「显示值 - 下限」的偏移
    expect(p.targets[3]).toEqual([100, 400]);
  });

  it("单值合法（等价于 lo == hi 的一个点）", () => {
    const inputs = mkRc("年兽", "药园初级还童", 5, "生命", { extra_魔法: "42" });
    expect(rechild().validate(inputs)).toEqual([]);
    expect(pairOf(plan(inputs), "魔法")).toEqual([42, 42]);
  });
});

// =========================================================================== 1 合约层 · buildSpec
describe("合约层 · buildSpec", () => {
  it("是一个 PoolSpec，total = 可随机点数，roll_vals = 基础属性倍率", () => {
    const inputs = mkRc("年兽", "药园初级还童", 5);
    const p = plan(inputs);
    const spec = asPool(rechild().buildSpec(inputs, 0));
    expect(spec.kind).toBe("pool");
    expect(spec.total).toBe(p.randomTotal);
    expect([...spec.rollVals]).toEqual([...p.baseRolls]);
    expect(spec.rollNum).toBe(p.baseRolls.length);
    expect(spec.constraints).toHaveLength(p.num);
  });

  it("constraints 逐条都是 IntervalConstraint，且与 plan.targets 一一对应", () => {
    const inputs = mkRc("雀蛋", "药园初级还童", 1, "魔法", {
      extra_生命: "1~98",
      base_生命: "200~283",
    });
    const p = plan(inputs);
    const spec = asPool(rechild().buildSpec(inputs, 7));
    p.targets.forEach(([lo, hi], index) => {
      const constraint = spec.constraints[index];
      if (!(constraint instanceof IntervalConstraint)) {
        throw new Error(`constraints[${index}] 不是 IntervalConstraint`);
      }
      expect(constraint.lo).toBe(lo);
      expect(constraint.hi).toBe(hi);
    });
  });

  it("基础属性不随机时 roll_vals 为空", () => {
    const spec = asPool(rechild().buildSpec(mkRc(noBaseRandomPet(), "丹药还童", 5), 0));
    expect([...spec.rollVals]).toEqual([]);
    expect(spec.rollNum).toBe(0);
    expect(spec.constraints).toHaveLength(3);
  });
});

// =========================================================================== 2 哨兵层
describe("哨兵层 · 一个种子都没命中", () => {
  it("走 finalize 的哨兵分支：seed = distance = 0、needConsume = -1、预览占位", () => {
    const inputs = mkRc("年兽", "药园初级还童", 5);
    const out = rechild().interpret(emptyResult(), inputs, 12345, null);
    expect(out.seed).toBe(0);
    expect(out.distance).toBe(0);
    expect(out.needConsume).toBe(-1);
    expect(out.seedAfter).toBe(0);
    expect(out.preview).toBe(NO_HIT_PREVIEW);
    expect(out.found).toBe(false);
    expect(out.count).toBe(0);
  });

  it("哨兵只加一条 warning，field 指向 pet（沿用 capture 的既有约定）", () => {
    const out = rechild().interpret(emptyResult(), mkRc("年兽", "药园初级还童", 5), 12345, null);
    expect(out.notes.map((n) => n.toDict())).toEqual([
      { level: "warning", message: "在给定上限内没有找到任何种子", field: "pet" },
    ]);
  });

  it("extra 带上还童自己的六个字段（合并，不是覆盖）", () => {
    const out = rechild().interpret(emptyResult(), mkRc("年兽", "药园初级还童", 5), 12345, null);
    expect(out.extra).toMatchObject({
      pet: "年兽",
      mode: "药园初级还童",
      level: 5,
      main_attr: "生命",
      guarantee: 5,
      random_total: 95,
    });
  });

  it("丹药还童的哨兵：guarantee = 0、random_total = 100", () => {
    const out = rechild().interpret(emptyResult(), mkRc("年兽", "丹药还童", 5), 1, null);
    expect([out.seed, out.distance, out.needConsume]).toEqual([0, 0, -1]);
    expect(out.extra["guarantee"]).toBe(0);
    expect(out.extra["random_total"]).toBe(100);
  });
});

// =========================================================================== 3 golden 层
/**
 * ``(pet, mode, level, mainAttr, seed, extra, expected)``；
 * expected = ``(distance, seed, needConsume, consume, preview)``。
 *
 * 逐字抄自 ``src_forge/tests/test_gameinfo_pet.py::GOLDEN_RECHILD``
 * （值由 ``src/PetCalculator.py`` 的骨架独立算出后冻结）。
 * 第一条同时覆盖「丹药还童 n = 0」与「只填基础属性」两种极端。
 */
const GOLDEN: [
  string,
  string,
  number,
  string,
  number,
  Record<string, unknown>,
  [number, number, number, number, string],
][] = [
  [
    "年兽",
    "丹药还童",
    5,
    "生命",
    1000,
    {},
    [
      1,
      500,
      0,
      0,
      "属性预览: -        \n\n生命资质: 39    \n魔法资质: 4    \n攻击资质: 54    \n防御资质: 3    \n\n生命: 872    \n魔法: 300    \n攻击: 47    \n防御: 6    \n",
    ],
  ],
  [
    "年兽",
    "药园初级还童",
    5,
    "生命",
    1000,
    { base_生命: "500~666", base_魔法: "200~266", base_攻击: "30~40", base_防御: "5~6" },
    [
      69,
      1800667143,
      65,
      3,
      "属性预览: -        \n\n生命资质: 23    \n魔法资质: 73    \n攻击资质: 2    \n防御资质: 2    \n\n生命: 542    \n魔法: 205    \n攻击: 33    \n防御: 5    \n",
    ],
  ],
  [
    "虎丸",
    "药园中级还童",
    3,
    "攻击",
    4242,
    { extra_生命: "1~193", extra_魔法: "1~193", extra_攻击: "7~199", extra_防御: "1~193" },
    [
      4,
      301990153,
      0,
      3,
      "属性预览: -        \n\n生命资质: 39    \n魔法资质: 9    \n攻击资质: 147    \n防御资质: 5    \n\n生命: 274    \n魔法: 118    \n攻击: 19    \n防御: 5    \n",
    ],
  ],
  [
    "龟布",
    "药园高级还童",
    10,
    "防御",
    99,
    {},
    [
      4,
      452984838,
      0,
      3,
      "属性预览: -        \n\n生命资质: 3    \n魔法资质: 0    \n攻击资质: 70    \n防御资质: 177    \n\n生命: 585    \n魔法: 144    \n攻击: 12    \n防御: 5    \n",
    ],
  ],
  [
    "雀蛋",
    "药园初级还童",
    1,
    "魔法",
    7,
    {
      extra_生命: "1~98",
      base_生命: "200~283",
      extra_魔法: "2~99",
      base_魔法: "120~146",
      extra_攻击: "1~98",
      base_攻击: "16~21",
      extra_防御: "1~98",
      base_防御: "2~3",
    },
    [
      78,
      262080,
      74,
      3,
      "属性预览: -        \n\n生命资质: 72    \n魔法资质: 22    \n攻击资质: 3    \n防御资质: 3    \n\n生命: 257    \n魔法: 131    \n攻击: 20    \n防御: 3    \n",
    ],
  ],
];

describe("golden 层 · 冻结的还童结果", () => {
  let rt: WasmRuntime;

  beforeAll(async () => {
    rt = await testRuntime();
  });

  for (const [pet, mode, level, mainAttr, seed, extra, expected] of GOLDEN) {
    it(`${pet} / ${mode} / L${level} / ${mainAttr} @${seed}`, async () => {
      const inputs = mkRc(pet, mode, level, mainAttr, extra);
      // ⚠️ near: true 是必须的 —— Python 的 TestGolden 就是这么调的
      const out = await rechild().run(inputs, seed, { near: true, backend: rt });
      expect([out.distance, out.seed, out.needConsume, out.consume, out.preview]).toEqual([
        ...expected,
      ]);
      // extra 也顺带钉一下（槽位数量随「基础属性随机」变）
      expect(out.extra["pet"]).toBe(pet);
      expect(out.extra["mode"]).toBe(mode);
      expect(out.extra["main_attr"]).toBe(mainAttr);
    });
  }

  it("extra 里的 guarantee / random_total 跟着模式与等级走", async () => {
    const out = await rechild().run(mkRc("年兽", "药园中级还童", 5, "攻击"), 1000, {
      near: true,
      backend: rt,
    });
    expect(out.extra["guarantee"]).toBe(10);
    expect(out.extra["random_total"]).toBe(190);
    expect(out.extra["main_attr"]).toBe("攻击");
    expect(out.extra["level"]).toBe(5);
  });

  it("不带 near 与带 near 是同一条路（默认就是局部搜索）", async () => {
    const inputs = mkRc("年兽", "药园初级还童", 5);
    const near = await rechild().run(inputs, 12345, { near: true, backend: rt });
    const auto = await rechild().run(inputs, 12345, { backend: rt });
    expect(near.preview).not.toBe(NO_HIT_PREVIEW);
    expect([auto.seed, auto.distance, auto.needConsume]).toEqual([
      near.seed,
      near.distance,
      near.needConsume,
    ]);
  });

  it("宠物场景只支持局部搜索（near=False 直接抛）", async () => {
    await expect(
      rechild().run(mkRc("年兽", "药园初级还童", 5), 12345, { near: false, backend: rt }),
    ).rejects.toThrow(/只支持局部搜索/);
  });
});

// =========================================================================== 与基类的约定
describe("与基类的约定", () => {
  it("没有「算完自动准备下一轮」（advance 返回 null）", () => {
    const inputs = mkRc("年兽", "药园初级还童", 5);
    const out = rechild().interpret(emptyResult(), inputs, 1, null);
    expect(rechild().advance(out, inputs)).toBeNull();
  });

  it("没有逐字段动态提示（fieldHints 返回空表）", () => {
    expect(rechild().fieldHints(mkRc("年兽", "药园初级还童", 5))).toEqual({});
  });

  it("toDict() 带上 extra 且用 snake_case", () => {
    const out = rechild().interpret(emptyResult(), mkRc("年兽", "药园初级还童", 5), 1, null);
    const dict = out.toDict();
    expect(dict["seed"]).toBe(0);
    expect(dict["need_consume"]).toBe(-1);
    expect(dict["extra"]).toMatchObject({ pet: "年兽", random_total: 95 });
  });
});
