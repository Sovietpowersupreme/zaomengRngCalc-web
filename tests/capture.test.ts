/**
 * 宠物捕捉场景 ``capture``（普通葫芦 / 红葫芦）—— 逐条对照
 * ``src_forge/tests/test_gameinfo_pet.py`` 的 ``TestRegistryShapes`` /
 * ``TestCapturePlan`` / ``TestNoHit`` / ``TestGolden``。
 *
 * 分三层，理由和 Python 侧一样：
 *
 * 1. **合约层**（不需要后端）—— 表单 schema、常量表、``planOf`` 的槽位与报错文案、
 *    ``buildSpec`` 的区间；
 * 2. **哨兵层**（不需要后端）—— 一个种子都没命中时 :func:`finalize` 走哪条分支。
 *    这一层必须**直调 ``interpret``**：``run`` 会先跑搜索，构造不出「空结果」；
 * 3. **golden 层**（需要 wasm）—— 冻结的 ``(distance, seed, needConsume, consume,
 *    preview)``，顺带证明 ctypes 记下来的值在 wasm 上逐位一致。
 */

import { beforeAll, describe, expect, it } from "vitest";
// 副作用导入：注册表要先把场景装进去，``getScenario("capture")`` 才拿得到。
import "../src/scenarios/index";
import { CONSTS, type PetInfoRecord } from "../src/data/consts";
import { SearchResult } from "../src/core/search";
import { IntervalConstraint, WuxingSpec, type SeedSpec } from "../src/core/spec";
import { uintBeforeRound } from "../src/core/ranges";
import { getScenario, registeredKeys } from "../src/scenarios/registry";
import { Outcome, ScenarioError } from "../src/scenarios/scenario";
import {
  ATTR_ORDER,
  CaptureScenario,
  DISTANCE_LIMIT,
  MODES,
  NORMAL_MODE,
  NO_HIT_PREVIEW,
  PETS,
  PET_ORDER,
  WILDCARD,
  defaultPet,
  modeConsume,
  petNames,
  pyRound,
  rawPair,
  successMax,
} from "../src/scenarios/capture";
import type { WasmRuntime } from "../src/wasm/runtime";
import { testRuntime } from "./helpers/golden";

/** 已注册的那个 ``capture`` 实例（顺带把类型收窄到具体类，好调 ``planOf``）。 */
function capture(): CaptureScenario {
  const scenario = getScenario("capture");
  if (!(scenario instanceof CaptureScenario)) {
    throw new Error(`capture 注册的不是 CaptureScenario：${scenario.constructor.name}`);
  }
  return scenario;
}

/**
 * 按 schema 默认值组一份捕捉输入（= Python ``_cap_inputs``）。
 *
 * ``start_seed`` 会在 ``defaults()`` 里带上（值为 ``null``，那时「必填但还没填」的
 * 状态），与 Python 侧逐字一致；真正开搜的起点由 ``startInitial`` 单独传。
 */
function mkCap(
  pet: string,
  mode: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...capture().schema().defaults(), pet, mode, ...extra };
}

/** 取一个表单字段（不存在就抛，别让 ``?.`` 把断言悄悄变成空操作）。 */
function field(key: string) {
  const schema = capture().schema();
  const found = schema.keys.includes(key) ? schema.get(key) : null;
  if (!found) throw new Error(`capture 表单里没有字段 ${key}`);
  return found;
}

/** ``buildSpec`` 声明的返回类型是母体 ``SeedSpec``，这里收窄成五行规格再读字段。 */
function asWuxing(spec: SeedSpec): WuxingSpec {
  if (!(spec instanceof WuxingSpec)) {
    throw new Error(`捕捉应该产出 wuxing 规格，得到 ${spec.constructor.name}`);
  }
  return spec;
}

// =========================================================================== 1 合约层 · schema
describe("合约层 · schema", () => {
  it("capture 已注册", () => {
    expect(registeredKeys()).toContain("capture");
  });

  it("类属性与 Python 一致", () => {
    const sc = capture();
    expect(sc.key).toBe("capture");
    expect(sc.label).toBe("宠物捕捉");
    expect(sc.version).toBe("1.0");
    expect(sc.specKind).toBe("wuxing");
    expect(sc.supportsNear).toBe(true);
    expect(sc.sliceBounds).toBeNull();
    expect(sc.hint).toBe(
      "用葫芦捕捉宠物。选宠物 → 选葫芦 → 填想要的资质范围 → 填起始种子。\n" +
        "普通葫芦要额外过 2 次随机（成功率判定 + 一次无关随机），红葫芦只过 1 次。\n" +
        "资质目标留空 = 该资质全范围（等于不筛）。\n" +
        "",
    );
  });

  it("nearLimit 用场景层的 9999999，而不是 core/search 的 100000", () => {
    expect(capture().nearLimit).toBe(9_999_999);
    // 与 DISTANCE_LIMIT 数值相同但语义不同，两个常量各自独立
    expect(DISTANCE_LIMIT).toBe(9_999_999);
  });

  it("字段顺序与 Python 一致（pet + mode + 4 资质 + 4 基础 + 搜索组）", () => {
    expect(capture().schema().keys).toEqual([
      "pet",
      "mode",
      ...ATTR_ORDER.map((a) => `qual_${a}`),
      ...ATTR_ORDER.map((a) => `base_${a}`),
      "start_seed",
      "full_search",
      "limit",
    ]);
  });

  it("「搜索」组与装备族同款（起始种子必填、默认留空）", () => {
    // 0 不是合法种子（FastNext(0) == 0），所以默认留空 + 必填，1 ~ 2147483647
    expect(field("start_seed").required).toBe(true);
    expect(field("start_seed").default).toBeNull();
    expect(field("start_seed").min).toBe(1);
    expect(field("start_seed").max).toBe(0x7fffffff);
    expect(field("start_seed").group).toBe("搜索");

    expect(field("full_search").kind).toBe("bool");
    expect(field("full_search").default).toBe(false);
    expect(field("full_search").group).toBe("搜索");

    expect(field("limit").kind).toBe("int");
    expect(field("limit").default).toBe(0);
    expect(field("limit").min).toBe(0);
    expect(field("limit").group).toBe("搜索");
  });

  it("每个字段的 kind / group / width / help 与 Python 一致", () => {
    expect(field("pet").kind).toBe("choice");
    expect(field("pet").label).toBe("宠物");
    expect(field("pet").group).toBe("宠物");
    expect(field("pet").width).toBe(12);
    expect(field("pet").help).toBe("");

    expect(field("mode").kind).toBe("choice");
    expect(field("mode").label).toBe("葫芦");
    expect(field("mode").group).toBe("宠物");
    expect(field("mode").width).toBe(14);
    expect(field("mode").help).toBe("普通葫芦需要宠物数据里有「成功率」");
    expect(field("mode").default).toBe(NORMAL_MODE);
    expect([...field("mode").choices]).toEqual([...MODES]);

    for (const attr of ATTR_ORDER) {
      const qual = field(`qual_${attr}`);
      expect(qual.kind).toBe("text");
      expect(qual.label).toBe(`${attr}资质`);
      expect(qual.group).toBe("资质目标");
      expect(qual.width).toBe(12);
      expect(qual.help).toBe("留空=全范围；支持「900~1000」「900-1000」「900」");
      expect(qual.default).toBe("");

      const base = field(`base_${attr}`);
      expect(base.kind).toBe("text");
      expect(base.label).toBe(`${attr}基础`);
      expect(base.group).toBe("基础属性目标");
      expect(base.width).toBe(12);
      expect(base.help).toBe("只有「基础属性随机」的宠物才需要填");
      expect(base.default).toBe("");
    }

    expect(field("start_seed").kind).toBe("int");
    expect(field("start_seed").label).toBe("起始种子");
    expect(field("start_seed").width).toBe(14);
    expect(field("start_seed").help).toBe("游戏里当前的那个种子（1 ~ 2147483647）；留空会直接报错");

    expect(field("full_search").label).toBe("枚举全部");
    expect(field("full_search").help).toBe(
      "不勾=局部搜索（默认，步数上限 9999999）；" +
        "勾上=把搜索上限抬到无上限（慢很多，且会忽略下面的「步数上限」）",
    );

    expect(field("limit").label).toBe("步数上限");
    expect(field("limit").width).toBe(12);
    expect(field("limit").help).toBe("0=用场景默认（9999999）；勾上「枚举全部」时本项被忽略");
  });

  it("表单没有表头（headers 为空 —— Python 传的就是 {}）", () => {
    expect(capture().schema().headers).toEqual({});
  });

  it("describe() 的 spec_kind / supports_near 与 Python 一致", () => {
    const info = capture().describe();
    expect(info.key).toBe("capture");
    expect(info.label).toBe("宠物捕捉");
    expect(info.spec_kind).toBe("wuxing");
    expect(info.supports_near).toBe(true);
  });
});

// =========================================================================== 1b 合约层 · 常量表
describe("合约层 · 常量表", () => {
  it("ATTR_ORDER 是四条属性、顺序固定", () => {
    expect([...ATTR_ORDER]).toEqual(["生命", "魔法", "攻击", "防御"]);
  });

  it("MODES / NORMAL_MODE", () => {
    expect([...MODES]).toEqual(["普通葫芦捕捉", "红葫芦捕捉"]);
    expect(NORMAL_MODE).toBe("普通葫芦捕捉");
    expect(NORMAL_MODE).toBe(MODES[0]);
    expect(defaultPet()).toBe("月兔");
    expect(defaultPet()).toBe(PET_ORDER[0]);
  });

  it("WILDCARD 是 31 位全范围", () => {
    expect([...WILDCARD]).toEqual([0, 0x7fffffff]);
  });

  it("NO_HIT_PREVIEW 逐字与 Python 相同（含尾部空格与两个换行）", () => {
    expect(NO_HIT_PREVIEW).toBe("属性预览: -        \n\n");
  });

  it("漂移哨兵：PET_ORDER 与 CONSTS.pets 的键**集合**完全一致", () => {
    // ``consts.json`` 用 ``sort_keys=True`` 导出 ⇒ 顺序在这里，集合在那边。
    // Python 侧加/删一只宠物而 TS 的 PET_ORDER 没跟 → 这条立刻红（另一个方向
    // 「顺序变了」由 ``scenarios.test.ts`` 的 describe() 快照挡）。
    expect([...PET_ORDER].slice().sort()).toEqual(Object.keys(CONSTS.pets).slice().sort());
    expect([...petNames()]).toEqual([...PET_ORDER]);
  });

  it("PET_ORDER 就是 Python 的插入顺序（月兔第一）", () => {
    expect([...PET_ORDER]).toEqual([
      "月兔",
      "子鼠",
      "丑牛",
      "寅虎",
      "年兽",
      "虎丸",
      "龟布",
      "雀蛋",
      "龙仔",
      "火丸",
      "雪球",
      "灵猴",
      "雪马",
      "小飞",
    ]);
  });

  it("pet 下拉框的选项就是宠物表（顺序也一致）", () => {
    expect([...field("pet").choices]).toEqual([...PET_ORDER]);
    expect(field("pet").default).toBe("月兔");
    // 顺序与 consts.json 的**排序后**键不同 —— 这正是 PET_ORDER 存在的理由
    expect([...field("pet").choices]).not.toEqual(Object.keys(CONSTS.pets).slice().sort());
  });

  it("数据体检：14 只宠物都写了成功率（普通葫芦可用的前提）", () => {
    expect(Object.keys(PETS)).toHaveLength(14);
    expect(Object.keys(PETS).filter((n) => !("成功率" in (PETS[n] as object)))).toEqual([]);
  });
});

// =========================================================================== 2 合约层 · 纯函数
describe("合约层 · 纯函数", () => {
  it("modeConsume：普通 2 / 红 1", () => {
    expect(modeConsume("普通葫芦捕捉")).toBe(2);
    expect(modeConsume("红葫芦捕捉")).toBe(1);
  });

  it("pyRound 是 Python 的 round —— 半值取偶，不是 Math.round 的半值向上", () => {
    expect(pyRound(0.5)).toBe(0);
    expect(pyRound(1.5)).toBe(2);
    expect(pyRound(2.5)).toBe(2);
    expect(pyRound(3.5)).toBe(4);
    expect(pyRound(-0.5)).toBe(0); // Python round(-0.5) == 0（-0 与 0 相等）
    expect(pyRound(-1.5)).toBe(-2);
    expect(pyRound(-2.5)).toBe(-2);
    expect(pyRound(2.4)).toBe(2);
    expect(pyRound(2.6)).toBe(3);
    expect(pyRound(0)).toBe(0);
    expect(pyRound(1_500_000)).toBe(1_500_000);
    // 对照：这三个半值上 JS 的 Math.round 与 Python 不同（Math.round 一律向 +∞）
    expect(Math.round(0.5)).not.toBe(pyRound(0.5));
    expect(Math.round(2.5)).not.toBe(pyRound(2.5));
    expect(Math.round(-1.5)).not.toBe(pyRound(-1.5));
    // 但不是每个半值都不同 —— -2.5 两边恰好都是 -2
    expect(Math.round(-2.5)).toBe(pyRound(-2.5));
  });

  it("successMax = round(成功率 * 2^31)，且四种成功率的取值都被钉住", () => {
    const seen: Record<string, number> = {};
    for (const name of PET_ORDER) {
      const pet = PETS[name] as PetInfoRecord;
      seen[String(pet.成功率)] = successMax(pet);
      expect(successMax(pet)).toBe(pyRound(Number(pet.成功率) * 0x80000000));
    }
    // 数据里只有四档：0.2 / 0.4 / 0.7 / 1（半值附近没有 tie，round 与 trunc 也不冲突）
    expect(seen).toEqual({
      "0.2": 429_496_730,
      "0.4": 858_993_459,
      "0.7": 1_503_238_554,
      "1": 2_147_483_648,
    });
  });

  it("rawPair：下界取 [0]、上界取 [1] —— 两次标量调用，不能捆成一个元组", () => {
    const [lo, hi] = [800, 1100]; // 月兔 生命
    const roll = hi - lo;
    expect([...rawPair(950, 1050, lo, roll, "生命")]).toEqual([
      uintBeforeRound(950 - lo, 0, roll)[0],
      uintBeforeRound(1050 - lo, 0, roll)[1],
    ]);
    // 中段目标一定比全范围窄
    const [rlo, rhi] = rawPair(950, 1050, lo, roll, "生命");
    expect(rlo).toBeGreaterThan(0);
    expect(rhi).toBeLessThan(0x7fffffff);

    // 反例：把 (vmin, vmax) 当元组传会走「序列」分支，得到一串**区间**而不是一个
    const asTable = uintBeforeRound([950 - lo, 1050 - lo], 0, roll);
    expect(Array.isArray(asTable[0])).toBe(true); // 表里的元素是区间
    expect(typeof rlo).toBe("number"); // 标量调用的元素是数字
  });

  it("rawPair：roll <= 0（min == max）直接抛，文案与 Python 逐字相同", () => {
    expect(() => rawPair(10, 20, 5, 0, "生命")).toThrow(ScenarioError);
    expect(() => rawPair(10, 20, 5, 0, "生命")).toThrow("生命 没有变化范围（min == max），无法构造搜索");
  });
});

// =========================================================================== 3 合约层 · planOf / validate / buildSpec
describe("合约层 · planOf", () => {
  it("consume 跟着模式走", () => {
    expect(capture().planOf(mkCap("年兽", "普通葫芦捕捉")).consume).toBe(2);
    expect(capture().planOf(mkCap("年兽", "红葫芦捕捉")).consume).toBe(1);
  });

  it("advanceCount = consume + 1（search 起点走 fastNext^(n+1) 次）", () => {
    expect(capture().randomConsumption(mkCap("年兽", "普通葫芦捕捉"))).toBe(2);
    expect(capture().advanceCount(mkCap("年兽", "普通葫芦捕捉"))).toBe(3);
    expect(capture().advanceCount(mkCap("年兽", "红葫芦捕捉"))).toBe(2);
  });

  it("普通葫芦前两个槽位 = 成功率阈值 + 占位全范围", () => {
    const pet = PETS["年兽"] as PetInfoRecord;
    const plan = capture().planOf(mkCap("年兽", "普通葫芦捕捉"));
    expect([...plan.targets[0]!]).toEqual([0, successMax(pet)]);
    expect([...plan.targets[1]!]).toEqual([0, 0x7fffffff]);
  });

  it("槽位数 = 葫芦前缀 + 4 资质（+ 4 基础，若随机）", () => {
    const sc = capture();
    for (const name of PET_ORDER) {
      const pet = PETS[name] as PetInfoRecord;
      const base = pet.基础属性随机 ? 4 : 0;
      const red = sc.planOf(mkCap(name, "红葫芦捕捉"));
      expect(red.num, name).toBe(4 + base);
      expect(red.baseRandom, name).toBe(pet.基础属性随机);
      const normal = sc.planOf(mkCap(name, "普通葫芦捕捉"));
      expect(normal.num, name).toBe(2 + 4 + base);
    }
  });

  it("每个槽位都是 lo <= hi 的原始随机区间，且首槽下界是 0", () => {
    const sc = capture();
    for (const name of PET_ORDER) {
      const plan = sc.planOf(mkCap(name, "红葫芦捕捉"));
      for (const [lo, hi] of plan.targets) {
        expect(0 <= lo && lo <= hi, name).toBe(true);
      }
      expect(plan.targets[0]![0], name).toBe(0);
    }
  });

  it("填了目标范围 → 该槽位比全范围窄", () => {
    const sc = capture();
    const whole = sc.planOf(mkCap("年兽", "红葫芦捕捉"));
    const banded = sc.planOf(mkCap("年兽", "红葫芦捕捉", { qual_生命: "1125~1375" }));
    const [lo, hi] = whole.targets[0]!;
    expect(banded.targets[0]![0]).toBeGreaterThanOrEqual(lo);
    expect(banded.targets[0]![1]).toBeLessThanOrEqual(hi);
    expect([...banded.targets[0]!]).not.toEqual([...whole.targets[0]!]);
  });

  it("只影响被填的那一格（其余保持全范围）", () => {
    const sc = capture();
    const whole = sc.planOf(mkCap("年兽", "红葫芦捕捉"));
    const banded = sc.planOf(mkCap("年兽", "红葫芦捕捉", { qual_魔法: "125~175" }));
    expect([...banded.targets[0]!]).toEqual([...whole.targets[0]!]);
    expect([...banded.targets[1]!]).not.toEqual([...whole.targets[1]!]);
  });

  it("基础属性槽位只在「基础属性随机」时才出现，且值来自基础属性范围", () => {
    const pet = PETS["年兽"] as PetInfoRecord;
    const plan = capture().planOf(mkCap("年兽", "红葫芦捕捉", { base_生命: "600~700" }));
    expect(plan.num).toBe(8);
    const baseRange = pet.基础属性范围!["生命"]!;
    const roll = baseRange[1] - baseRange[0];
    expect([...plan.targets[4]!]).toEqual([
      uintBeforeRound(600 - baseRange[0], 0, roll)[0],
      uintBeforeRound(700 - baseRange[0], 0, roll)[1],
    ]);
    // 不随机的宠物给了 base_* 也不加槽位（Python 直接跳过）
    const noRandom = capture().planOf(mkCap("月兔", "红葫芦捕捉", { base_生命: "600~700" }));
    expect(noRandom.num).toBe(4);
    expect(noRandom.attrRanges.size).toBe(0);
    expect(noRandom.baseRandom).toBe(false);
  });

  it("potential 就是资质范围原样（预览要用）", () => {
    const plan = capture().planOf(mkCap("年兽", "红葫芦捕捉"));
    for (const attr of ATTR_ORDER) {
      expect([...plan.potential.get(attr)!]).toEqual([
        ...(PETS["年兽"] as PetInfoRecord).资质范围[attr]!,
      ]);
    }
  });

  it("默认输入可以直接跑（validate 无 error）", () => {
    const sc = capture();
    for (const [pet, mode] of [
      ["年兽", "普通葫芦捕捉"],
      ["虎丸", "红葫芦捕捉"],
    ] as const) {
      const notes = sc.validate(mkCap(pet, mode));
      expect(notes.filter((n) => n.isError), `${pet}/${mode}`).toEqual([]);
    }
    // 每只宠物 × 两种模式都不能报错
    for (const name of PET_ORDER) {
      for (const mode of MODES) {
        expect(sc.validate(mkCap(name, mode)).filter((n) => n.isError), `${name}/${mode}`).toEqual(
          [],
        );
      }
    }
  });

  it("未知宠物 / 未知模式抛 ScenarioError", () => {
    const sc = capture();
    expect(() => sc.planOf(mkCap("不存在", "红葫芦捕捉"))).toThrow(ScenarioError);
    expect(() => sc.planOf(mkCap("不存在", "红葫芦捕捉"))).toThrow("未知的宠物：'不存在'");
    expect(() => sc.planOf(mkCap("月兔", "金葫芦捕捉"))).toThrow(ScenarioError);
    expect(() => sc.planOf(mkCap("月兔", "金葫芦捕捉"))).toThrow("宠物捕捉 不支持的模式：'金葫芦捕捉'");
  });

  it("没有「成功率」的宠物不能用普通葫芦，但红葫芦照用", () => {
    // 数据里没有这种宠物 —— 临时塞一只走分支（等价于 Python 的 monkeypatch.setitem）。
    const fake = {
      资质范围: Object.fromEntries(ATTR_ORDER.map((a) => [a, [10, 20]])),
      基础属性范围: null,
      基础属性随机: false,
    } as unknown as PetInfoRecord;
    (PETS as Record<string, PetInfoRecord>)["测试宠物"] = fake;
    try {
      const sc = capture();
      expect(() => sc.planOf(mkCap("测试宠物", "普通葫芦捕捉"))).toThrow(ScenarioError);
      expect(() => sc.planOf(mkCap("测试宠物", "普通葫芦捕捉"))).toThrow(
        "测试宠物 没有设置成功率，不能用普通葫芦捕捉",
      );
      expect(sc.planOf(mkCap("测试宠物", "红葫芦捕捉")).consume).toBe(1);
      // ⚠️ 与 Python 的一处已知差异：Python 的 ``choices=tuple(PETS)`` 是**调用时**
      // 才取的，所以临时塞进去的宠物会出现在下拉框里；TS 的 PET_ORDER 是冻结常量，
      // 不会。这里显式承认这个差异，免得以后有人以为漏了。
      expect([...field("pet").choices]).not.toContain("测试宠物");
    } finally {
      delete (PETS as Record<string, PetInfoRecord>)["测试宠物"];
    }
  });
});

describe("合约层 · validate（越界 / 解析失败都记 error 并退回全范围）", () => {
  it("越界 → field 指向那一格，且 prepare 会抛", () => {
    const sc = capture();
    const inputs = mkCap("月兔", "红葫芦捕捉", { qual_生命: "1~2" });
    const errors = sc.validate(inputs).filter((n) => n.isError);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe("qual_生命");
    expect(errors[0]!.message).toBe("生命 目标范围 1~2 超出 800~1100，已按全范围处理");
    expect(() => sc.prepare(inputs, 0)).toThrow(ScenarioError);
    // 退回全范围 = 与什么都不填的计划一致
    const fresh = sc.planOf(mkCap("月兔", "红葫芦捕捉"));
    expect([...sc.planOf(inputs).targets[0]!]).toEqual([...fresh.targets[0]!]);
  });

  it("解析不了 → 记 error（文案带 repr）", () => {
    const sc = capture();
    const errors = sc.validate(mkCap("月兔", "红葫芦捕捉", { qual_生命: "abc" })).filter(
      (n) => n.isError,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe("qual_生命");
    expect(errors[0]!.message).toBe("生命 目标范围无法解析（'abc'），已按全范围处理");
  });

  it("下界大于上界会自动交换（Python 的 swap）", () => {
    const sc = capture();
    const swapped = sc.planOf(mkCap("月兔", "红葫芦捕捉", { qual_生命: "1000~900" }));
    const ordered = sc.planOf(mkCap("月兔", "红葫芦捕捉", { qual_生命: "900~1000" }));
    expect(sc.validate(mkCap("月兔", "红葫芦捕捉", { qual_生命: "1000~900" }))).toEqual([]);
    expect([...swapped.targets[0]!]).toEqual([...ordered.targets[0]!]);
  });

  it("单值写法 = 上下界相同（区间退化，但仍然合法）", () => {
    const sc = capture();
    expect(sc.validate(mkCap("月兔", "红葫芦捕捉", { qual_生命: "1000" }))).toEqual([]);
    const plan = sc.planOf(mkCap("月兔", "红葫芦捕捉", { qual_生命: "1000" }));
    const [lo, hi] = plan.targets[0]!;
    expect(lo).toBeLessThanOrEqual(hi);
  });

  it("区间方言：能不能解析取决于分隔符表（与 Python 的 ``_RANGE_SPLIT`` 一致）", () => {
    const sc = capture();
    for (const text of ["900~1000", "900,1000", "900，1000", "900 1000", "900/1000", "900|1000", "900·1000", "900"]) {
      expect(sc.validate(mkCap("月兔", "红葫芦捕捉", { qual_生命: text })), text).toEqual([]);
    }
    // 反例 1：``-`` 不在分隔符表里（``~ , ， | · / 、 ； ; 空白``），所以 help 文案里写的
    // 「900-1000」其实解析不了 —— Python 完全一样，属于上游 help 文案的老毛病，不动。
    // 反例 2：``parse_pair`` 默认带 ``strip_paren_content``，会把整个括号**内容**删掉，
    // 所以 "(900,1000)" 剩空串（数据表路径要的正是这个，用户输入路径才会传 False）。
    for (const text of ["900-1000", "(900,1000)"]) {
      const errors = sc.validate(mkCap("月兔", "红葫芦捕捉", { qual_生命: text })).filter(
        (n) => n.isError,
      );
      expect(errors, text).toHaveLength(1);
      expect(errors[0]!.field, text).toBe("qual_生命");
      expect(errors[0]!.message, text).toContain("目标范围无法解析");
    }
  });

  it("空输入（默认）没有任何 note", () => {
    expect(capture().validate(mkCap("月兔", "红葫芦捕捉"))).toEqual([]);
    expect(capture().planOf(mkCap("月兔", "红葫芦捕捉")).notes).toEqual([]);
  });

  it("错的宠物/模式在 validate 里也只是一条 error note（不抛）", () => {
    const notes = capture().validate(mkCap("不存在", "红葫芦捕捉"));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.isError).toBe(true);
    expect(notes[0]!.message).toBe("未知的宠物：'不存在'");
  });
});

describe("合约层 · buildSpec", () => {
  it("产出 WuxingSpec：target_wx = 0、bagua_growth = (0, 0)、槽位数 = num", () => {
    const sc = capture();
    const inputs = mkCap("年兽", "普通葫芦捕捉", { qual_生命: "1125~1375" });
    const plan = sc.planOf(inputs);
    const spec = asWuxing(sc.buildSpec(inputs, 0));
    expect(spec.kind).toBe("wuxing");
    expect(spec.targetWx).toBe(0);
    expect([...spec.baguaGrowth]).toEqual([0, 0]);
    expect(spec.hasBaguaGrowth).toBe(false);
    expect(spec.constraints).toHaveLength(plan.num);
    for (const c of spec.constraints) {
      expect(c).toBeInstanceOf(IntervalConstraint);
    }
  });

  it("约束的上下界就是 plan.targets（逐位）", () => {
    const sc = capture();
    const inputs = mkCap("年兽", "红葫芦捕捉", { qual_魔法: "125~175", base_攻击: "35~50" });
    const spec = asWuxing(sc.buildSpec(inputs, 0));
    const want = sc.planOf(inputs).targets;
    expect(
      spec.constraints.map((c) => {
        if (!(c instanceof IntervalConstraint)) throw new Error("不是区间约束");
        return [c.lo, c.hi];
      }),
    ).toEqual(want.map((t) => [t[0], t[1]]));
  });

  it("成功率 1 的宠物首槽上界是 2^31（u32 里仍然是正数）", () => {
    const name = PET_ORDER.find((n) => (PETS[n] as PetInfoRecord).成功率 === 1);
    expect(name).toBeDefined();
    const spec = asWuxing(capture().buildSpec(mkCap(name!, "普通葫芦捕捉"), 0));
    const first = spec.constraints[0];
    if (!(first instanceof IntervalConstraint)) throw new Error("不是区间约束");
    expect(first.lo).toBe(0);
    expect(first.hi).toBe(2_147_483_648);
  });
});

// =========================================================================== 4 哨兵层（直调 interpret）
/** = Python ``TestNoHit._empty()``。 */
function emptyResult(): SearchResult {
  return new SearchResult({
    seeds: [],
    head: 0,
    nearest: null,
    distance: null,
    backend: "test",
  });
}

describe("哨兵层 · 一个种子都没命中（直调 interpret，绕开搜索）", () => {
  it("seed 0 / distance 0 / needConsume -1 + 一条 warning + 预览换成 NO_HIT", () => {
    const sc = capture();
    const out = sc.interpret(emptyResult(), mkCap("月兔", "红葫芦捕捉"), 12345, null);
    expect([out.seed, out.distance, out.needConsume]).toEqual([0, 0, -1]);
    expect(out.seedAfter).toBe(0);
    expect(out.preview).toBe(NO_HIT_PREVIEW);
    expect(out.notes.map((n) => n.toDict())).toEqual([
      { level: "warning", message: "在给定上限内没有找到任何种子", field: "pet" },
    ]);
  });

  it("extra 是**合并**不是覆盖：pet / mode / num / targets 都在", () => {
    const sc = capture();
    const out = sc.interpret(emptyResult(), mkCap("月兔", "红葫芦捕捉"), 1, null);
    expect(out.extra["pet"]).toBe("月兔");
    expect(out.extra["mode"]).toBe("红葫芦捕捉");
    expect(out.extra["num"]).toBe(4);
    expect(out.extra["num"]).toBe((out.extra["targets"] as unknown[]).length);
  });

  it("rt = null 时普通葫芦同样走哨兵（不碰 seedDistance）", () => {
    const sc = capture();
    const out = sc.interpret(emptyResult(), mkCap("年兽", "普通葫芦捕捉"), 12345, null);
    expect([out.seed, out.distance, out.needConsume]).toEqual([0, 0, -1]);
    expect(out.extra["num"]).toBe(10); // 年兽基础属性随机 → 2 + 4 + 4
  });

  it("有 seeds 但首个种子是 0 → 走 recomputeDistance 的早返回（needConsume = -1 - consume）", () => {
    // 这就是 runs.json 里 capture-red 记 ``need_consume = -2``、``notes = []`` 的那条路。
    const sc = capture();
    const res = new SearchResult({ seeds: [0, 1, 2], head: 0, backend: "test" });
    const out = sc.interpret(res, mkCap("月兔", "红葫芦捕捉"), 12345, null);
    expect(out.seed).toBe(0);
    expect(out.needConsume).toBe(-2);
    expect(out.notes).toEqual([]);
    // 单例 Outcome 也认这个结果（seeds 非空 ⇒ found 为真）
    expect(out.found).toBe(true);
    expect(out.count).toBe(3);
  });

  it("Outcome 的 found / count 语义：哨兵下是「空」", () => {
    const out = capture().interpret(emptyResult(), mkCap("月兔", "红葫芦捕捉"), 1, null);
    expect(out.found).toBe(false);
    expect(out.count).toBe(0);
  });
});

// =========================================================================== 5 golden 层
/**
 * ``(pet, mode, start, extra, (distance, seed, needConsume, consume, preview))``。
 *
 * 值由 ``src/PetCalculator.py`` 的骨架独立算出后冻结（``test_gameinfo_pet.py``
 * 的 ``GOLDEN_CAPTURE``，同一份）。
 */
const GOLDEN: readonly (readonly [string, string, number, Record<string, unknown>, readonly [number, number, number, number, string]])[] = [
  [
    "月兔",
    "红葫芦捕捉",
    1000,
    {},
    [
      2,
      250,
      0,
      1,
      "属性预览: -        \n\n生命资质: 817    \n魔法资质: 877    \n攻击资质: 1023    \n防御资质: 300    \n\n",
    ],
  ],
  [
    "月兔",
    "普通葫芦捕捉",
    12345,
    {},
    [
      4,
      1090519811,
      1,
      2,
      "属性预览: -        \n\n生命资质: 812    \n魔法资质: 831    \n攻击资质: 986    \n防御资质: 320    \n\n",
    ],
  ],
  [
    "年兽",
    "红葫芦捕捉",
    777,
    {
      qual_生命: "1125~1375",
      base_生命: "500~750",
      qual_魔法: "125~175",
      base_魔法: "200~300",
      qual_攻击: "900~1100",
      base_攻击: "30~45",
      qual_防御: "175~325",
      base_防御: "5~7",
    },
    [
      717,
      772272382,
      715,
      1,
      "属性预览: -        \n\n生命资质: 1143    \n魔法资质: 148    \n攻击资质: 1017    \n防御资质: 319    \n\n生命: 640    \n魔法: 252    \n攻击: 34    \n防御: 7    \n",
    ],
  ],
  [
    "虎丸",
    "普通葫芦捕捉",
    2024,
    {
      qual_生命: "850~950",
      base_生命: "200~350",
      qual_魔法: "575~725",
      base_魔法: "100~125",
      qual_攻击: "850~950",
      base_攻击: "15~22",
      qual_防御: "325~375",
      base_防御: "2~5",
    },
    [
      284,
      377495526,
      281,
      2,
      "属性预览: -        \n\n生命资质: 947    \n魔法资质: 679    \n攻击资质: 950    \n防御资质: 353    \n\n生命: 215    \n魔法: 113    \n攻击: 22    \n防御: 3    \n",
    ],
  ],
  [
    "小飞",
    "红葫芦捕捉",
    999,
    {},
    [
      2,
      1811939577,
      0,
      1,
      "属性预览: -        \n\n生命资质: 847    \n魔法资质: 739    \n攻击资质: 870    \n防御资质: 224    \n\n生命: 203    \n魔法: 146    \n攻击: 27    \n防御: 7    \n",
    ],
  ],
  [
    "雪马",
    "普通葫芦捕捉",
    555,
    {
      qual_生命: "580~680",
      base_生命: "100~125",
      qual_魔法: "715~865",
      base_魔法: "150~175",
      qual_攻击: "700~800",
      base_攻击: "15~20",
      qual_防御: "250~350",
      base_防御: "4~5",
    },
    [
      384,
      759880739,
      381,
      2,
      "属性预览: -        \n\n生命资质: 619    \n魔法资质: 812    \n攻击资质: 725    \n防御资质: 254    \n\n生命: 121    \n魔法: 165    \n攻击: 20    \n防御: 5    \n",
    ],
  ],
];

describe("golden 层：与 Python 冻结的值逐字段一致（跨后端）", () => {
  let rt: WasmRuntime;
  beforeAll(async () => {
    rt = await testRuntime();
  });

  for (const [pet, mode, start, extra, expected] of GOLDEN) {
    const [distance, seed, need, consume, preview] = expected;
    it(`${pet}/${mode}@${start}`, async () => {
      const inputs = mkCap(pet, mode, extra);
      // 显式带 near:true，与 Python 的 TestGolden 逐字对齐（TS 侧的默认值也是
      // true —— PetScenario 只做局部搜索，near:false 直接抛）
      const out = await capture().run(inputs, start, { near: true, backend: rt });
      expect([out.distance, out.seed, out.needConsume, out.consume, out.preview]).toEqual([
        distance,
        seed,
        need,
        consume,
        preview,
      ]);
      expect(out.extra["pet"]).toBe(pet);
      expect(out.extra["mode"]).toBe(mode);
      expect(out.extra["num"]).toBe((out.extra["targets"] as unknown[]).length);
    });
  }

  it("不带 near 时默认就走局部搜索（= runs.json 的 capture-default）", async () => {
    // 旧版这里走的是「全空间枚举的头部」：distance 0 、还挂一条「过于遥远」的
    // warning。那是起始种子没接上（兜底成 0）+ near=False 的 bug ，不是语义。
    const out = await capture().run(mkCap("月兔", "普通葫芦捕捉"), 12345, { backend: rt });
    expect([out.distance, out.seed, out.needConsume, out.consume]).toEqual([4, 1090519811, 1, 2]);
    expect(out.preview).toBe(
      "属性预览: -        \n\n生命资质: 812    \n魔法资质: 831    \n攻击资质: 986    \n防御资质: 320    \n\n",
    );
    expect(out.notes).toEqual([]);
  });

  it("红葫芦：不带 near 也从起始种子往近处找（= runs.json 的 capture-red）", async () => {
    const out = await capture().run(mkCap("月兔", "红葫芦捕捉"), 12345, { backend: rt });
    expect([out.seed, out.distance, out.needConsume, out.consume]).toEqual([603982862, 2, 0, 1]);
    expect(out.preview).toBe(
      "属性预览: -        \n\n生命资质: 929    \n魔法资质: 778    \n攻击资质: 866    \n防御资质: 398    \n\n",
    );
    expect(out.notes).toEqual([]);
    expect(out.count).toBeGreaterThan(0);
    expect(out.truncated).toBe(true);
  });

  it("窄区间：命中种子变了、但消耗量不变（= runs.json 的 capture-narrow）", async () => {
    const out = await capture().run(mkCap("月兔", "普通葫芦捕捉", { qual_生命: "900~1000" }), 12345, {
      backend: rt,
    });
    expect([out.seed, out.distance, out.consume]).toEqual([2084569280, 6, 2]);
    expect(out.preview).toBe(
      "属性预览: -        \n\n生命资质: 986    \n魔法资质: 739    \n攻击资质: 930    \n防御资质: 253    \n\n",
    );
  });

  it("不带 near 与带 near 是同一条路（不再是「枚举头部」）", async () => {
    const inputs = mkCap("月兔", "红葫芦捕捉");
    const near = await capture().run(inputs, 1000, { near: true, backend: rt });
    expect([near.distance, near.seed, near.needConsume]).toEqual([2, 250, 0]);
    expect(near.preview).toContain("资质");
    const auto = await capture().run(inputs, 1000, { backend: rt });
    expect([auto.seed, auto.distance, auto.needConsume]).toEqual([
      near.seed,
      near.distance,
      near.needConsume,
    ]);
  });

  it("宠物场景只支持局部搜索（near=False 直接抛）", async () => {
    await expect(
      capture().run(mkCap("月兔", "红葫芦捕捉"), 1000, { near: false, backend: rt }),
    ).rejects.toThrow(/只支持局部搜索/);
  });
});

// =========================================================================== 6 与基类的约定
describe("与基类的约定", () => {
  it("capture 没有自动升档（基类默认返回 null）", () => {
    const sc = capture();
    const outcome = new Outcome({ seed: 4, distance: 4, needConsume: 1, consume: 2, seedAfter: 5 });
    expect(sc.advance(outcome, mkCap("月兔", "红葫芦捕捉"))).toBeNull();
  });

  it("capture 没有字段提示（fieldHints / fieldHintIssues 都用基类默认的空表）", () => {
    expect(capture().fieldHints(mkCap("月兔", "红葫芦捕捉"))).toEqual({});
    expect(capture().fieldHintIssues(mkCap("月兔", "红葫芦捕捉"))).toEqual({});
  });

  it("toDict() 里 extra 原样带出（含 targets 的嵌套数组）", () => {
    const out = capture().interpret(emptyResult(), mkCap("月兔", "红葫芦捕捉"), 1, null);
    const dict = out.toDict();
    expect(dict["extra"]).toEqual(out.extra);
    expect(dict["seed"]).toBe(0);
    expect(dict["need_consume"]).toBe(-1);
  });
});
