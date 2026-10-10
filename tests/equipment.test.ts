/**
 * 装备侧共享内核 —— 逐条对照 ``src_forge/tests/test_gameinfo_equip.py``。
 *
 * 三层里搬了两层：
 *
 * 1. **合约层**（不需要后端）—— 注册表 / 表单 / ``planOf`` 的纯计算 / 排列枚举；
 * 2. **golden 层**（需要 wasm）—— 冻结的
 *    ``(distance, seed, preview, permutation, need_consume, consume)``。
 *
 * ``TestParity``（和 ``src.making_calc.search.mytask`` 对拍）**故意不搬**：
 * 它要 import ``src/`` 并走 ctypes DLL，web 侧没有也不该有这条依赖 —— 那条硬
 * 约束由 ``scenario_runs.test.ts`` 的 ``runs.json`` 回放来兑现（``runs.json``
 * 本身就是 ctypes 后端跑出来的）。
 */

import { beforeAll, describe, expect, it } from "vitest";
// 副作用导入：注册表要先装好场景。
import "../src/scenarios/index";
import type { Pair } from "../src/core/ranges";
import { RollSpec, WuxingSpec } from "../src/core/spec";
import { CONSTS } from "../src/data/consts";
import type { EquipValue } from "../src/data/consts";
import { getScenario, registeredKeys } from "../src/scenarios/registry";
import { ScenarioError } from "../src/scenarios/scenario";
import {
  abSum,
  addRanges,
  asRange,
  ATTR_WITH_NONE,
  buildBaguaEup,
  buildBaguaRange,
  buildBaseRanges,
  buildDefaultRanges,
  buildGemRanges,
  buildTargetRanges,
  calcBeforeAttrRandoms,
  CATEGORY_ORDER,
  categoryItems,
  COMMON_ATTRS,
  EquipScenario,
  EQUIPMENT,
  findItem,
  formatRange,
  FULL_SEARCH_LIMIT,
  GEM_KINDS,
  GEMS,
  getBase,
  GROUP_TARGET,
  isRollable,
  MAX_SEED_SEARCH,
  NO_HIT_PREVIEW,
  normalizeQuality,
  parseTargetRange,
  parseWuxing,
  permutationSpecs,
  qualityOf,
  RANDOM_CATEGORIES,
  scalePlan,
  simulateEquip,
  splitItem,
  TARGET_UNPARSABLE,
  targetIssue,
  targetRaw,
  uniquePermutations,
  validateTargetRanges,
  WX_MASK,
  type EquipData,
  type GemRangesResult,
  type GemTable,
  type RangeMap,
} from "../src/scenarios/equipment";
import type { WasmRuntime } from "../src/wasm/runtime";
import { testRuntime } from "./helpers/golden";

/** 本文件负责的装备侧场景（宠物侧见 ``rechild.test.ts``）。 */
const DONE_KEYS = ["making", "fusion", "drops", "task"] as const;

/** 每个场景允许的装备分类。 */
const EXPECTED_CATEGORIES: Readonly<Record<string, readonly string[]>> = {
  making: ["weapons", "armors", "accessories"],
  fusion: ["fusion-tjbg", "fusion-A", "fusion-B", "fusion-C"],
  drops: ["drops"],
  task: ["task-yanma"],
};

/** 硬编码的随机数消耗（``src/making_calc/data.py`` 的 ``BEFORE_ATTR_RANDOMS``）。 */
const EXPECTED_CONSUME: Readonly<Record<string, number>> = {
  "fusion-tjbg": 11,
  "fusion-A": 7,
  "fusion-B": 3,
  "fusion-C": 8,
  "task-yanma": 13,
  drops: 0,
};

/** 邪灵品质（制作书本身不触发随机数）。 */
const XIELING = "邪灵";

/** 白板里没有任何「可随机」属性 → ``Permutation.spec is None``，搜不了。 */
const ZERO_ROLLABLE: readonly string[] = [
  "weapons/若禅",
  "weapons/祁水",
  "weapons/夷图",
  "weapons/琉璃",
  "armors/斗战",
  "armors/旃檀",
  "armors/净坛",
  "armors/金身",
  "accessories/玲珑玉",
  "accessories/镇魂花坠",
  "accessories/破幻花链",
  "accessories/不朽花翼",
  "fusion-B/渊邪",
];

const NO_GEMS: RangeMap = new Map();

/** 场景实例（收窄成 ``EquipScenario`` 好调 ``planOf`` / ``categories``）。 */
function equip(key: string): EquipScenario {
  const scenario = getScenario(key);
  if (!(scenario instanceof EquipScenario)) throw new Error(`${key} 不是装备侧场景`);
  return scenario;
}

/** 按 schema 默认值组一份输入。 */
function mkEquip(
  key: string,
  item: string,
  extra: Record<string, unknown> = {},
  gems: readonly (readonly [string, string])[] = [],
): Record<string, unknown> {
  const data: Record<string, unknown> = { ...equip(key).schema().defaults(), item };
  gems.forEach(([kind, attr], i) => {
    data[`gem${String(i + 1)}_kind`] = kind;
    data[`gem${String(i + 1)}_attr`] = attr;
  });
  return { ...data, ...extra };
}

/** 分类下的第一件装备（= 数据文件里的第一件，顺序敏感）。 */
function firstItem(category: string): string {
  const names = [...categoryItems(category).keys()];
  if (names.length === 0) throw new Error(`分类 ${category} 里没有装备`);
  return names[0] as string;
}

/** 负责某个分类的场景。 */
function ownerOf(category: string): string {
  for (const key of DONE_KEYS) {
    if (equip(key).categories.includes(category)) return key;
  }
  throw new Error(`没有场景负责分类 ${category}`);
}

/** 某个场景里某个属性的目标范围（缺键立刻抛，别让断言变成空操作）。 */
function targetOf(key: string, item: string, attr: string, extra = {}): Pair {
  const pair = equip(key).planOf(mkEquip(key, item, extra)).targetEquip.get(attr);
  if (pair === undefined) throw new Error(`${item} 的目标范围里没有「${attr}」`);
  return pair;
}

/** 造一份白板（值类型收窄成 ``EquipValue``）。 */
function makeData(entries: readonly (readonly [string, EquipValue])[]): EquipData {
  return new Map(entries);
}

// =========================================================================== 合约层 · 注册表与表单
describe("注册表与表单", () => {
  it("四个装备侧场景都注册了", () => {
    for (const key of DONE_KEYS) expect([...registeredKeys()]).toContain(key);
  });

  it("分类与 Python 的 EXPECTED_CATEGORIES 一致，且真的存在于装备表里", () => {
    for (const key of DONE_KEYS) {
      expect([...equip(key).categories], key).toEqual([...EXPECTED_CATEGORIES[key]!]);
      for (const cat of equip(key).categories) expect(EQUIPMENT.has(cat), cat).toBe(true);
    }
  });

  it("itemChoices 就是分类下的全部装备（顺序 = 分类序 + 数据文件序）", () => {
    for (const key of DONE_KEYS) {
      const want: string[] = [];
      for (const cat of equip(key).categories) {
        for (const name of categoryItems(cat).keys()) want.push(`${cat}/${name}`);
      }
      expect(equip(key).itemChoices(), key).toEqual(want);
    }
  });

  it("每个场景 describe() 自洽", () => {
    for (const key of DONE_KEYS) {
      const info = equip(key).describe();
      expect(info.key, key).toBe(key);
      expect(info.label, key).toBeTruthy();
      expect(info.hint, key).toBeTruthy();
      expect(info.spec_kind, key).toBe("roll");
      expect(info.supports_near, key).toBe(true);
      expect(Object.keys(info.schema).length, key).toBeGreaterThan(0);
    }
  });

  it("公共字段：item / start_seed / full_search / limit + 10 个 target_*", () => {
    for (const key of DONE_KEYS) {
      const keys = equip(key).schema().keys;
      for (const field of ["item", "start_seed", "full_search", "limit"]) {
        expect(keys, `${key}/${field}`).toContain(field);
      }
      const targets = keys.filter((k) => k.startsWith("target_"));
      expect(targets.length, key).toBe(10);
      // 品质不是可随机属性
      expect(targets, key).not.toContain("target_品质");
    }
  });

  it("start_seed 必填、默认留空（0 不是合法种子）", () => {
    for (const key of DONE_KEYS) {
      const field = equip(key).schema().get("start_seed");
      expect(field, key).not.toBeNull();
      const f = field!;
      expect(f.default, key).toBeNull();
      expect(f.required, key).toBe(true);
      expect(f.min, key).toBe(1);
      expect(f.max, key).toBe(0x7fffffff);
    }
  });

  it("宝石字段只对打造开放（3 组 = 6 格）", () => {
    const making = equip("making").schema().keys;
    for (const i of [1, 2, 3]) {
      expect(making).toContain(`gem${String(i)}_kind`);
      expect(making).toContain(`gem${String(i)}_attr`);
    }
    expect(equip("making").allowGems).toBe(true);
    for (const key of ["fusion", "drops", "task"]) {
      const keys = equip(key).schema().keys;
      expect(keys, key).not.toContain("gem1_kind");
      expect(keys, key).not.toContain("gem2_kind");
      expect(keys, key).not.toContain("gem3_kind");
      expect(equip(key).allowGems, key).toBe(false);
    }
  });

  it("宝石下拉框的选项顺序 = attrs.gem_kinds（不是 consts.json 的键序）", () => {
    expect([...GEM_KINDS]).toEqual([...CONSTS.attrs.gem_kinds]);
    expect([...(equip("making").schema().get("gem1_kind")?.choices ?? [])]).toEqual([
      ...GEM_KINDS,
    ]);
    expect([...(equip("making").schema().get("gem1_attr")?.choices ?? [])]).toEqual([
      ...ATTR_WITH_NONE,
    ]);
  });

  it("五行字段跟着 allowWuxing 走", () => {
    for (const key of DONE_KEYS) {
      const has = equip(key).schema().keys.includes("wuxing");
      expect(has, key).toBe(equip(key).allowWuxing);
    }
    expect(equip("drops").allowWuxing).toBe(true);
    expect(equip("fusion").allowWuxing).toBe(true);
    expect(equip("making").allowWuxing).toBe(false);
  });

  it("成长和字段跟着 allowBagua 走", () => {
    for (const key of DONE_KEYS) {
      const has = equip(key).schema().keys.includes("bagua");
      expect(has, key).toBe(equip(key).allowBagua);
    }
    expect(equip("fusion").allowBagua).toBe(true);
    expect(equip("making").allowBagua).toBe(false);
  });

  it("目标属性分组的表头与 GROUP_TARGET 一致", () => {
    expect(equip("making").schema().headers[GROUP_TARGET]).toEqual([
      "属性名",
      "展示值",
      "目标上下限",
    ]);
  });

  it("默认值 + 第一件装备 = 合法输入（UI 打开就能按）", () => {
    for (const key of DONE_KEYS) {
      const item = equip(key).itemChoices()[0] as string;
      const notes = equip(key).validate(mkEquip(key, item));
      expect(notes.filter((n) => n.isError), key).toEqual([]);
    }
  });
});

// =========================================================================== 合约层 · 取值小工具
describe("取值小工具", () => {
  it("asRange：二元组 / 数字 / 报错", () => {
    expect(asRange([1, 2])).toEqual([1, 2]);
    expect(asRange(7)).toEqual([7, 7]);
    // 三元组不在 EquipValue 的类型里，但运行期确实要报错 → 故意强转
    expect(() => asRange([1, 2, 3] as never)).toThrowError(ScenarioError);
    expect(() => asRange("x")).toThrowError(ScenarioError);
    expect(() => asRange(undefined)).toThrowError(ScenarioError);
  });

  it("addRanges 逐端相加", () => {
    expect(addRanges([1, 2], [10, 20])).toEqual([11, 22]);
  });

  it("getBase 去掉一个尾部数字", () => {
    expect(getBase("攻击1")).toBe("攻击");
    expect(getBase("攻击")).toBe("攻击");
    expect(getBase("")).toBe("");
  });

  it("isRollable：上下限相等的不算", () => {
    expect(isRollable([1, 2])).toBe(true);
    expect(isRollable([-100, -100])).toBe(false);
    expect(isRollable(5)).toBe(false);
    expect(isRollable(undefined)).toBe(false);
  });

  it("formatRange 的几种形态", () => {
    expect(formatRange(1, 3)).toBe("1~3");
    expect(formatRange(5, 5)).toBe("5");
    expect(formatRange(1.25, 3.75, 2)).toBe("1.25~3.75");
    // 省略 precision 时：整数用 0 位，否则 1 位
    expect(formatRange(1.5, 2.5)).toBe("1.5~2.5");
    // 半值取偶：1.25 → 1.2（不是 1.3）
    expect(formatRange(1.25, 1.25, 1)).toBe("1.2");
  });

  it("splitItem / findItem", () => {
    expect(splitItem("weapons/尾火棍")).toEqual(["weapons", "尾火棍"]);
    // 没有斜杠 → 分类留空
    expect(splitItem("尾火棍")).toEqual(["", "尾火棍"]);
    const [cat, name, data] = findItem("weapons/尾火棍");
    expect(cat).toBe("weapons");
    expect(name).toBe("尾火棍");
    expect(data.size).toBeGreaterThan(0);
    expect(() => findItem("weapons/不存在")).toThrowError(ScenarioError);
    expect(() => findItem("不存在的装备")).toThrowError(ScenarioError);
  });

  it("normalizeQuality / qualityOf", () => {
    expect(normalizeQuality("普 通")).toBe("普通");
    expect(normalizeQuality(null)).toBe("");
    const data = EQUIPMENT.get("weapons")?.get("尾火棍") ?? null;
    expect(qualityOf(data)).toBe(normalizeQuality(data?.get("品质") ?? ""));
    expect(qualityOf(null)).toBe("");
  });

  it("常量表", () => {
    expect(MAX_SEED_SEARCH).toBe(99_999_999);
    expect(FULL_SEARCH_LIMIT).toBe(0x7fffffff);
    expect(WX_MASK).toBe(0b100000);
    expect(CONSTS.wuxing.has).toBe(WX_MASK);
    expect([...COMMON_ATTRS]).toEqual([...CONSTS.attrs.common]);
    expect(COMMON_ATTRS).not.toContain("品质");
    expect([...RANDOM_CATEGORIES]).toEqual(["weapons", "armors", "accessories"]);
    expect([...CATEGORY_ORDER]).toContain("task-yanma");
    expect(NO_HIT_PREVIEW).toBe("无");
    // 装备场景的默认局部搜索上限就是 MAX_SEED_SEARCH
    expect(equip("making").nearLimit).toBe(MAX_SEED_SEARCH);
  });
});

// =========================================================================== 合约层 · 区间组装
describe("区间组装", () => {
  it("buildGemRanges：同名属性追加递增后缀", () => {
    const sel: readonly (readonly [string, string])[] = [
      ["一级宝石", "攻击"],
      ["二级宝石", "攻击"],
      ["三级宝石", "攻击"],
    ];
    const { ranges, singleValue } = buildGemRanges(sel);
    expect([...ranges.keys()]).toEqual(["攻击", "攻击1", "攻击2"]);
    expect(singleValue).toEqual([]);
  });

  it("buildGemRanges：单值宝石记一条告警", () => {
    const single: GemTable = new Map([
      [
        "测试宝石",
        new Map<string, Pair>([
          ["攻击", [5, 5]],
          ["生命", [1, 3]],
        ]),
      ],
    ]);
    const out: GemRangesResult = buildGemRanges(
      [
        ["测试宝石", "攻击"],
        ["测试宝石", "生命"],
      ],
      single,
    );
    expect([...out.ranges]).toEqual([
      ["攻击", [5, 5]],
      ["生命", [1, 3]],
    ]);
    expect(out.singleValue).toEqual([["测试宝石", "攻击", 5]]);
  });

  it("buildGemRanges：不认识 / 「无」的选择直接跳过", () => {
    const sel: readonly (readonly [string, string])[] = [
      ["无", "无"],
      ["不存在", "攻击"],
      ["一级宝石", "无"],
    ];
    expect([...buildGemRanges(sel).ranges]).toEqual([]);
  });

  it("数据表里每一档宝石都必须是真区间", () => {
    for (const [kind, attrs] of GEMS) {
      expect(attrs.size, kind).toBeGreaterThan(0);
      for (const [attr, rng] of attrs) {
        expect(rng[0], `${kind}/${attr}`).toBeLessThan(rng[1]);
      }
    }
  });

  it("uniquePermutations：空键 → 一个空排列（不是空数组）", () => {
    expect(uniquePermutations([], NO_GEMS)).toEqual([[]]);
  });

  it("uniquePermutations：同属性同区间去重，区间不同不去重", () => {
    const same: RangeMap = new Map([
      ["攻击", [1, 2]],
      ["攻击1", [1, 2]],
    ]);
    const perms = uniquePermutations(["攻击", "攻击1"], same);
    expect(perms.length).toBe(1);
    expect(perms[0]).toEqual(["攻击", "攻击1"]);

    const diff: RangeMap = new Map([
      ["攻击", [1, 2]],
      ["攻击1", [3, 4]],
    ]);
    expect(uniquePermutations(["攻击", "攻击1"], diff).length).toBe(2);
  });

  it("buildBaseRanges 的属性顺序 = 数据文件顺序（不排序）", () => {
    const data = makeData([
      ["魔法", [1, 3]],
      ["品质", "普通"],
      ["攻击", [2, 4]],
      ["五行", ""],
    ]);
    const base = buildBaseRanges(data);
    expect([...base.keys()]).toEqual(["魔法", "攻击"]);
    expect([...base.values()]).toEqual([
      [1, 3],
      [2, 4],
    ]);
  });

  it("buildBaseRanges：固定值但有宝石加成也要进来", () => {
    const data = makeData([["生命", 100]]);
    expect(buildBaseRanges(data).size).toBe(0);
    const gems: RangeMap = new Map([["生命", [1, 2]]]);
    expect([...buildBaseRanges(data, gems).keys()]).toEqual(["生命"]);
  });

  it("buildDefaultRanges 按 COMMON_ATTRS 的属性顺序排", () => {
    const data = makeData([
      ["攻击", [1, 2]],
      ["生命", [3, 4]],
    ]);
    const out = buildDefaultRanges(data, NO_GEMS, "weapons");
    expect([...out.keys()]).toEqual(COMMON_ATTRS.filter((a) => a === "攻击" || a === "生命"));
    expect([...out.values()]).toEqual([
      [3, 4],
      [1, 2],
    ]);
  });

  it("buildDefaultRanges：白板 + 各宝石区间相加", () => {
    const data = makeData([["攻击", [10, 20]]]);
    const gems: RangeMap = new Map([
      ["攻击", [1, 2]],
      ["攻击1", [3, 4]],
    ]);
    expect(buildDefaultRanges(data, gems, "weapons").get("攻击")).toEqual([14, 26]);
  });

  it("buildDefaultRanges：只有 fusion-tjbg 才额外给「成长」", () => {
    const data = makeData([]);
    expect(buildDefaultRanges(data, NO_GEMS, "fusion-tjbg", 9999).has("成长")).toBe(true);
    expect(buildDefaultRanges(data, NO_GEMS, "fusion-A", 9999).has("成长")).toBe(false);
  });

  it("buildTargetRanges：括号只去掉括号本身（16(16) → 1616）", () => {
    const defaults: RangeMap = new Map([["攻击", [0, 2000]]]);
    expect([...buildTargetRanges({ 攻击: "16(16)" }, defaults)]).toEqual([["攻击", [1616, 1616]]]);
    expect([...buildTargetRanges({ 攻击: "10~20" }, defaults)]).toEqual([["攻击", [10, 20]]]);
    expect([...buildTargetRanges({ 攻击: "10" }, defaults)]).toEqual([["攻击", [10, 10]]]);
    // 上下界写反了自动交换
    expect([...buildTargetRanges({ 攻击: "900~600" }, defaults)]).toEqual([["攻击", [600, 900]]]);
    // 半角连字符**不是**分隔符（`_RANGE_SPLIT` 里没有 `-`）→ 解析失败
    expect(() => buildTargetRanges({ 攻击: "10-20" }, defaults)).toThrowError(ScenarioError);
  });

  it("buildTargetRanges：空输入沿用默认（0 / false / null 都算空）", () => {
    const defaults: RangeMap = new Map([["攻击", [0, 2000]]]);
    for (const value of ["", null, 0, false, undefined]) {
      expect([...buildTargetRanges({ 攻击: value }, defaults)], String(value)).toEqual([
        ["攻击", [0, 2000]],
      ]);
    }
  });

  it("buildTargetRanges：解析不了就抛", () => {
    const defaults: RangeMap = new Map([["攻击", [0, 2000]]]);
    expect(() => buildTargetRanges({ 攻击: "abc" }, defaults)).toThrowError(ScenarioError);
  });

  it("validateTargetRanges：越界 / 反序 / 缺键都抛", () => {
    const defaults: RangeMap = new Map([["攻击", [0, 100]]]);
    expect(() => validateTargetRanges(new Map([["攻击", [0, 50]]]), defaults)).not.toThrow();
    expect(() => validateTargetRanges(new Map([["攻击", [-1, 50]]]), defaults)).toThrowError(
      ScenarioError,
    );
    expect(() => validateTargetRanges(new Map([["攻击", [0, 101]]]), defaults)).toThrowError(
      ScenarioError,
    );
    expect(() => validateTargetRanges(new Map([["攻击", [80, 20]]]), defaults)).toThrowError(
      ScenarioError,
    );
    expect(() => validateTargetRanges(new Map([["魔法", [0, 1]]]), defaults)).toThrowError(
      ScenarioError,
    );
  });

  it("buildBaguaRange 不在 3.0 处夹（曾经踩过的坑）", () => {
    expect(buildBaguaRange(9999)).toEqual([3333.0, 3333.8]);
    expect(buildBaguaRange(0)).toEqual([0.0, 0.8]);
    const [lo, hi] = buildBaguaRange(9999);
    expect(hi - lo).toBeCloseTo(0.8, 10);
  });

  it("buildBaguaEup：目标成长 → 原始随机整数窗口", () => {
    // (3333 - 0.05 - 3333) / 0.8 < 0 → 夹到 0；(3333.8 + 0.05 - 3333)/0.8 > 1 → 夹到 1
    expect(buildBaguaEup([3333.0, 3333.8], 9999)).toEqual([0, 0x80000000]);
    const mid = buildBaguaEup([3333.2, 3333.4], 9999);
    expect(mid[0]).toBeLessThan(mid[1]);
  });

  it("calcBeforeAttrRandoms / abSum", () => {
    expect(calcBeforeAttrRandoms("weapons", 2, 1)).toBe(3);
    expect(calcBeforeAttrRandoms("armors", 0, 2)).toBe(2);
    for (const [cat, expected] of Object.entries(EXPECTED_CONSUME)) {
      expect(calcBeforeAttrRandoms(cat), cat).toBe(expected);
    }
    expect(abSum("weapons", "普通", 2)).toEqual([3, 2]);
    expect(abSum("weapons", XIELING, 2)).toEqual([0, 2]);
    expect(abSum("drops", "普通", 2)).toEqual([0, 0]);
  });

  it("parseWuxing：无 / _ / 空 / 单字 / 双字 / 非法", () => {
    expect(parseWuxing("无")).toBe(0);
    expect(parseWuxing("_")).toBe(0);
    expect(parseWuxing("")).toBe(WX_MASK);
    expect(parseWuxing("金")).toBe(WX_MASK | (1 << CONSTS.wuxing.bits["金"]!));
    expect(parseWuxing("金木")).toBe(WX_MASK | 0b11);
    expect(parseWuxing("木金")).toBe(WX_MASK | 0b11);
    expect(parseWuxing("金金")).toBeNull();
    expect(parseWuxing("赵")).toBeNull();
    // parseWuxing 自身**不限字数**（「最多两个字」是 planOf 的额外检查）
    expect(parseWuxing("金木水火土")).toBe(WX_MASK | 0b11111);
    expect(parseWuxing("金木水火土金")).toBeNull();
  });
});

// =========================================================================== 合约层 · 目标范围与填错归因
describe("目标范围：展示值 + 哪一格填错了", () => {
  // 「一个错字把整栏展示值打成「—」」是这次要修的问题：展示值（fieldHints）
  // 只依赖装备本身，填错归因（fieldHintIssues）逐字段给。
  const ITEM = "armors/翼火甲";
  const RANGES: Readonly<Record<string, string>> = {
    target_生命: "280~330",
    target_魔法: "130~150",
    target_防御: "10~12",
  };

  /** 有 3 个可随机属性的装备（少了就不够验「只标一格」）。 */
  function sel(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return mkEquip("making", ITEM, extra);
  }

  it("targetRaw：去空白、去圆括号，空值保持空", () => {
    expect(targetRaw(" 280~330 ")).toBe("280~330");
    expect(targetRaw("(13~17)")).toBe("13~17");
    expect(targetRaw("")).toBe("");
    expect(targetRaw(undefined)).toBe("");
    expect(targetRaw(null)).toBe("");
    expect(targetRaw(0)).toBe("");            // falsy 当作「没填」
    expect(targetRaw("（13~17）")).toBe("（13~17）"); // 全角括号不剥（与 Python 一致）
  });

  it("parseTargetRange：单值 / 区间 / 定序 / 成长保留一位小数", () => {
    expect(parseTargetRange("生命", "300")).toEqual([300, 300]);
    expect(parseTargetRange("生命", "350~280")).toEqual([280, 350]);
    expect(parseTargetRange("生命", "(300)")).toEqual([300, 300]);
    expect(parseTargetRange("成长", "1.14~1.36")).toEqual([1.1, 1.4]);
    // 空值不是「解析失败」，是「没填」——由 buildTargetRanges 保留默认值
    expect(() => parseTargetRange("生命", "")).toThrow(ScenarioError);
  });

  it("targetIssue：空 → null，解析不了 → 无法解析，越界 → 带允许范围", () => {
    const life: Pair = [280, 330];
    expect(targetIssue("生命", "", life)).toBeNull();
    expect(targetIssue("生命", "   ", life)).toBeNull();
    expect(targetIssue("生命", "abc", life)).toBe(TARGET_UNPARSABLE);
    expect(targetIssue("生命", "10-15", life)).toBe(TARGET_UNPARSABLE); // 半角连字符不认
    expect(targetIssue("生命", "~", life)).toBe(TARGET_UNPARSABLE);
    expect(targetIssue("生命", "10~20", life)).toBe("超出 280~330");
    expect(targetIssue("生命", "99999999", life)).toBe("超出 280~330");
    expect(targetIssue("生命", "-5", life)).toBe("超出 280~330");
    expect(targetIssue("生命", "280~330", life)).toBeNull();  // 边界
    expect(targetIssue("生命", "300", life)).toBeNull();      // 落在区间里
    expect(TARGET_UNPARSABLE).toBe("无法解析");
  });

  it("fieldHints：默认（target_* 全空）就是该装备的默认范围", () => {
    expect(equip("making").fieldHints(sel())).toEqual(RANGES);
  });

  it("fieldHintIssues：默认没有一格填错", () => {
    expect(equip("making").fieldHintIssues(sel())).toEqual({});
  });

  it("**一个属性填错不连累别的属性**（本次修复的核心）", () => {
    const bad = sel({ target_生命: "abc" });
    // 展示值照旧（旧实现在这里会整栏塌成空表 → UI 全变「—」）
    expect(equip("making").fieldHints(bad)).toEqual(RANGES);
    expect(equip("making").fieldHintIssues(bad)).toEqual({
      target_生命: TARGET_UNPARSABLE,
    });
  });

  it("越界的格子说清「允许的是多少」", () => {
    for (const text of ["99999999", "10~20", "-5"]) {
      expect(equip("making").fieldHintIssues(sel({ target_生命: text }))).toEqual({
        target_生命: "超出 280~330",
      });
    }
  });

  it("两格同时填错 → 两条都报出来", () => {
    const issues = equip("making").fieldHintIssues(
      sel({ target_生命: "abc", target_魔法: "9999999" }),
    );
    expect(issues).toEqual({ target_生命: "无法解析", target_魔法: "超出 130~150" });
    expect(equip("making").fieldHints(
      sel({ target_生命: "abc", target_魔法: "9999999" }),
    )).toEqual(RANGES);
  });

  it("改回合法值以后归因就空了", () => {
    const sc = equip("making");
    expect(sc.fieldHintIssues(sel({ target_生命: "abc" }))).not.toEqual({});
    expect(sc.fieldHintIssues(sel({ target_生命: "" }))).toEqual({});
    expect(sc.fieldHintIssues(sel({ target_生命: "280~330" }))).toEqual({});
    expect(sc.fieldHintIssues(sel({ target_生命: "300" }))).toEqual({});
  });

  it("装备名写错 → 展示值和归因都是空表（整栏「—」是对的）", () => {
    const broken = mkEquip("making", "没有这件装备");
    expect(equip("making").fieldHints(broken)).toEqual({});
    expect(equip("making").fieldHintIssues(broken)).toEqual({});
  });

  it("没有可随机属性的白板 → 一栏都没有", () => {
    expect(equip("making").fieldHints(mkEquip("making", "armors/斗战"))).toEqual({});
  });

  it("归因只加在展示值那一栏上：planOf / validate 该抛还得抛", () => {
    const sc = equip("making");
    expect(() => sc.planOf(sel({ target_生命: "abc" }))).toThrow(/无法解析/);
    expect(() => sc.planOf(sel({ target_生命: "99999999" }))).toThrow(/超出限制/);
    const notes = sc.validate(sel({ target_生命: "abc" }));
    expect(notes.filter((n) => n.isError).length).toBe(1);
  });

  it("四个装备侧场景在默认输入下都没有归因", () => {
    for (const key of DONE_KEYS) {
      expect(equip(key).fieldHintIssues(mkEquip(key, firstItem(EXPECTED_CATEGORIES[key]![0]!)))).toEqual({});
    }
  });
});

// =========================================================================== 合约层 · planOf
describe("planOf：消耗与分类", () => {
  it("硬编码的随机数消耗表", () => {
    for (const [cat, expected] of Object.entries(EXPECTED_CONSUME)) {
      const key = ownerOf(cat);
      const plan = equip(key).planOf(mkEquip(key, `${cat}/${firstItem(cat)}`));
      expect(plan.consume, cat).toBe(expected);
    }
  });

  it("打造：consume = 宝石数 + 3", () => {
    const gemPool: readonly (readonly [string, string])[] = [
      ["一级宝石", "攻击"],
      ["一级宝石", "生命"],
      ["一级宝石", "防御"],
    ];
    for (const count of [0, 1, 2, 3]) {
      const plan = equip("making").planOf(
        mkEquip("making", "weapons/尾火棍", {}, gemPool.slice(0, count)),
      );
      expect(plan.consume, String(count)).toBe(count + 3);
    }
  });

  it("邪灵装备不吃灵魂刷新（A = 0，只剩 B = 2）", () => {
    const xieling = [...categoryItems("weapons")]
      .filter(([, data]) => data.get("品质") === XIELING)
      .map(([name]) => name);
    expect(xieling.length).toBeGreaterThan(0);
    const plan = equip("making").planOf(
      mkEquip("making", `weapons/${xieling[0] as string}`, {}, [
        ["一级宝石", "攻击"],
        ["一级宝石", "生命"],
      ]),
    );
    expect(plan.consume).toBe(2);
  });

  it("未知 / 跨分类 / 空装备名都抛 ScenarioError", () => {
    expect(() => equip("making").planOf(mkEquip("making", "weapons/不存在"))).toThrowError(
      ScenarioError,
    );
    expect(() => equip("making").planOf(mkEquip("making", "task-yanma/炎马"))).toThrowError(
      ScenarioError,
    );
    expect(() => equip("making").planOf(mkEquip("making", ""))).toThrowError(ScenarioError);
  });

  it("五行：无 / _ / 空 / 单字 / 双字（顺序无关）", () => {
    const item = "drops/药王葫芦";
    const rows: readonly (readonly [string, number])[] = [
      ["无", 0],
      ["_", 0],
      ["", WX_MASK],
      ["金", WX_MASK | (1 << CONSTS.wuxing.bits["金"]!)],
      ["金木", WX_MASK | 0b11],
      ["木金", WX_MASK | 0b11],
    ];
    for (const [text, expected] of rows) {
      const plan = equip("drops").planOf(mkEquip("drops", item, { wuxing: text }));
      expect(plan.targetWx, text).toBe(expected);
      expect(plan.hasWuxing, text).toBe(Boolean(expected));
    }
  });

  it("五行超过两个字 / 重复字都是 error note，且 planOf 会抛", () => {
    for (const text of ["金木水火", "金金"]) {
      const notes = equip("drops").validate(mkEquip("drops", "drops/药王葫芦", { wuxing: text }));
      expect(
        notes.some((n) => n.isError),
        text,
      ).toBe(true);
      expect(() =>
        equip("drops").planOf(mkEquip("drops", "drops/药王葫芦", { wuxing: text })),
      ).toThrowError(ScenarioError);
    }
  });

  it("太极八卦的成长范围由成长和推出：(g/3, g/3 + 0.8)", () => {
    expect(targetOf("fusion", "fusion-tjbg/太极八卦", "成长", { bagua: 9999 })).toEqual([
      9999 / 3,
      9999 / 3 + 0.8,
    ]);
    const plan = equip("fusion").planOf(
      mkEquip("fusion", "fusion-tjbg/太极八卦", { bagua: 9999 }),
    );
    expect(plan.baguaTotal).toBe(9999);
  });

  it("成长和对非太极八卦无效", () => {
    const plan = equip("fusion").planOf(mkEquip("fusion", "fusion-A/流邪", { bagua: 9999 }));
    expect(plan.baguaEup[1]).toBe(0);
  });
});

// =========================================================================== 合约层 · 排列枚举
describe("排列枚举", () => {
  it("零可随机属性的 13 件白板：有排列但 spec 全是 null，buildSpec 抛", () => {
    for (const spec of ZERO_ROLLABLE) {
      const cat = spec.split("/")[0] as string;
      const key = ownerOf(cat);
      const inputs = mkEquip(key, spec);
      const perms = permutationSpecs(equip(key).planOf(inputs));
      expect(perms.length, spec).toBeGreaterThan(0);
      expect(
        perms.every((p) => p.spec === null),
        spec,
      ).toBe(true);
      expect(() => equip(key).buildSpec(inputs, 0), spec).toThrowError(ScenarioError);
    }
  });

  it("有可变白板属性的装备必须真能组出 spec", () => {
    for (const [key, cats] of Object.entries(EXPECTED_CATEGORIES)) {
      for (const cat of cats) {
        for (const name of categoryItems(cat).keys()) {
          const item = `${cat}/${name}`;
          if (ZERO_ROLLABLE.includes(item)) continue;
          const spec = equip(key).buildSpec(mkEquip(key, item), 0);
          expect(["roll", "wuxing"], item).toContain(spec.kind);
        }
      }
    }
  });

  it("全表冒烟：每件装备都至少有一个排列，且 spec 能 toDict", () => {
    let empty = 0;
    for (const key of DONE_KEYS) {
      for (const cat of equip(key).categories) {
        for (const name of categoryItems(cat).keys()) {
          const plan = equip(key).planOf(mkEquip(key, `${cat}/${name}`));
          const perms = permutationSpecs(plan);
          expect(perms.length, `${cat}/${name}`).toBeGreaterThan(0);
          for (const perm of perms) {
            if (perm.spec === null) empty += 1;
            else perm.spec.toDict();
          }
        }
      }
    }
    expect(empty).toBeLessThanOrEqual(20);
  });

  it("宝石排列数：两个不同属性 → 2 个；同名属性加后缀 → 仍然 2 个", () => {
    const two = equip("making").planOf(
      mkEquip("making", "weapons/尾火棍", {}, [
        ["一级宝石", "攻击"],
        ["一级宝石", "生命"],
      ]),
    );
    const perms = permutationSpecs(two);
    expect(perms.length).toBe(2);
    expect(perms.map((p) => p.label)).toEqual(["1 2", "2 1"]);

    const same = equip("making").planOf(
      mkEquip("making", "weapons/尾火棍", {}, [
        ["一级宝石", "攻击"],
        ["二级宝石", "攻击"],
      ]),
    );
    const samePerms = permutationSpecs(same);
    // 「攻击」/「攻击1」是两个不同的键 → 不去重
    expect(samePerms.length).toBe(2);
    expect([...samePerms[0]!.gemOrder].sort()).toEqual(["攻击", "攻击1"]);
  });

  it("order 是属性顺序、gemOrder 是宝石顺序 —— 两者独立", () => {
    const perms = permutationSpecs(equip("making").planOf(mkEquip("making", "weapons/尾火棍")));
    expect(perms.length).toBe(1);
    const perm = perms[0]!;
    expect(perm.spec).toBeInstanceOf(RollSpec);
    expect(perm.order.length).toBeGreaterThan(0);
    expect([...perm.gemOrder]).toEqual([]);
    expect(perm.label).toBe("");
    expect(perm.index).toBe(0);
  });

  it("五行分支只有一个排列，且忽略宝石", () => {
    const plan = equip("drops").planOf(mkEquip("drops", "drops/药王葫芦", { wuxing: "金" }));
    const perms = permutationSpecs(plan);
    expect(perms.length).toBe(1);
    expect(perms[0]!.spec).toBeInstanceOf(WuxingSpec);
    expect(perms[0]!.labels).toEqual([]);
    expect(permutationSpecs(plan, 2)[0]!.spec?.step).toBe(2);
  });

  it("spec 的步长可以覆盖", () => {
    const perms = permutationSpecs(equip("making").planOf(mkEquip("making", "weapons/尾火棍")), 5);
    expect(perms[0]!.spec).toBeInstanceOf(RollSpec);
    expect(perms[0]!.spec?.step).toBe(5);
  });

  it("scalePlan 按精度放大（品质 / 五行不进 baseEquip）", () => {
    const plan = equip("making").planOf(mkEquip("making", "weapons/尾火棍"));
    const scaled = scalePlan(plan);
    expect(scaled.baseEquip.size).toBeGreaterThan(0);
    expect([...scaled.baseEquip.keys()]).not.toContain("品质");
    expect([...scaled.baseEquip.keys()]).not.toContain("五行");
    expect(scaled.targetEquip.size).toBe(plan.targetEquip.size);
  });
});

// =========================================================================== golden 层
/** ``(key, item, start, extra, gems, expected)``；expected = ``(distance, seed, preview, permutation, need_consume, consume)``。 */
const GOLDEN: readonly [
  string,
  string,
  number,
  Record<string, unknown>,
  readonly (readonly [string, string])[],
  readonly [number, number, string, string, number, number],
][] = [
  ["making", "weapons/尾火棍", 12345, {}, [], [4, 1090519811, "{'攻击':11}", "", 0, 3]],
  [
    "making",
    "weapons/尾火棍",
    12345,
    {},
    [["一级宝石", "攻击"]],
    [5, 1753219457, "{'攻击':24}", "1", 0, 4],
  ],
  [
    "making",
    "weapons/尾火棍",
    12345,
    {},
    [
      ["一级宝石", "攻击"],
      ["一级宝石", "生命"],
    ],
    [6, 2084569280, "{'生命':13,'攻击':17}", "2 1", 0, 5],
  ],
  [
    "making",
    "armors/翼火甲",
    777777,
    {},
    [
      ["三级宝石", "生命"],
      ["二级宝石", "防御"],
    ],
    [6, 1849700216, "{'生命':423,'魔法':140,'防御':14}", "2 1", 0, 5],
  ],
  [
    "making",
    "accessories/通风灵戒",
    42,
    {},
    [
      ["灵珠", "暴击"],
      ["灵珠", "闪避"],
    ],
    [6, 1585446912, "{'生命':112,'魔法':106,'暴击':2,'闪避':1}", "2 1", 0, 5],
  ],
  [
    "fusion",
    "fusion-tjbg/太极八卦",
    1000,
    { wuxing: "金", bagua: 9999 },
    [],
    [
      18,
      7512064,
      "{'暴击':7,'闪避':7,'回血':15,'回魔':6,'魔抗':6,'成长':3333.1,'五行':'金水'}",
      "",
      6,
      11,
    ],
  ],
  [
    "fusion",
    "fusion-A/流邪",
    1000,
    { wuxing: "金" },
    [],
    [12, 480772096, "{'成长':2.4,'五行':'金'}", "", 4, 7],
  ],
  [
    "fusion",
    "fusion-B/沙邪",
    1000,
    { wuxing: "金" },
    [],
    [7, 1694498823, "{'成长':1.7,'五行':'金火'}", "", 3, 3],
  ],
  ["fusion", "fusion-C/玉净瓶", 1000, {}, [], [9, 1967128577, "{'魔抗':6,'成长':2.0}", "", 0, 8]],
  [
    "drops",
    "drops/药王葫芦",
    1000,
    { wuxing: "金" },
    [],
    [5, 603979807, "{'回血':11,'魔抗':4,'成长':2.1,'五行':'金火'}", "", 4, 0],
  ],
  [
    "drops",
    "drops/药王葫芦",
    1000,
    { wuxing: "金木" },
    [],
    [113, 2048500, "{'回血':12,'魔抗':6,'成长':2.2,'五行':'金木'}", "", 112, 0],
  ],
  ["drops", "drops/枯叶杖", 1000, {}, [], [1, 500, "{'魔法':108,'攻击':12}", "", 0, 0]],
  [
    "task",
    "task-yanma/炎马",
    1000,
    {},
    [],
    [14, 120193024, "{'生命':709,'魔法':924,'攻击':1263,'防御':323}", "", 0, 13],
  ],
];

describe("golden 层：逐字段一致", () => {
  let rt: WasmRuntime;

  beforeAll(async () => {
    rt = await testRuntime();
  });

  for (const [key, item, start, extra, gems, expected] of GOLDEN) {
    it(`${key}：${item}（start=${String(start)}）`, async () => {
      const out = await equip(key).run(mkEquip(key, item, extra, gems), start, { backend: rt });
      expect([
        out.distance,
        out.seed,
        out.preview,
        out.permutation,
        out.needConsume,
        out.consume,
      ]).toEqual([...expected]);
    });
  }

  it("种子集合保序去重，打满 999 时 truncated = true", async () => {
    const out = await equip("making").run(mkEquip("making", "weapons/尾火棍"), 12345, {
      backend: rt,
    });
    expect(out.seeds.length).toBeGreaterThan(0);
    expect(new Set(out.seeds).size).toBe(out.seeds.length);
    expect(out.truncated).toBe(true);
  });

  it("extra 里的字段名与 Python 一致，且 toDict 能直接序列化", async () => {
    const inputs = mkEquip("fusion", "fusion-tjbg/太极八卦", { wuxing: "金", bagua: 9999 });
    const out = await equip("fusion").run(inputs, 1000, { backend: rt });
    expect(out.extra["category"]).toBe("fusion-tjbg");
    expect(out.extra["item"]).toBe("太极八卦");
    expect(out.extra["quality"]).toBe("传说");
    expect(out.extra["bagua_total"]).toBe(9999);
    expect(out.extra["perm_count"]).toBe(1);
    expect(out.extra["target_wx"]).toBe(WX_MASK | (1 << CONSTS.wuxing.bits["金"]!));
    expect(out.toDict()["seed"]).toBe(out.seed);
  });

  it("零可随机属性 → 全 0 + 预览「无」+ 需要点 0 次", async () => {
    const out = await equip("making").run(mkEquip("making", "weapons/若禅"), 12345, {
      backend: rt,
    });
    expect([out.seed, out.distance, out.preview]).toEqual([0, 0, NO_HIT_PREVIEW]);
    expect(out.needConsume).toBe(-1);
    expect([...out.seeds]).toEqual([]);
    expect(out.notes.some((n) => n.message.includes("没有找到任何种子"))).toBe(true);
  });

  it("勾「枚举全部」会把距离上限抬上去", async () => {
    const near = await equip("making").run(mkEquip("making", "weapons/尾火棍"), 12345, {
      backend: rt,
    });
    const full = await equip("making").run(
      mkEquip("making", "weapons/尾火棍", { full_search: true }),
      12345,
      { backend: rt },
    );
    expect(full.extra["distance_limit"] as number).toBeGreaterThan(
      near.extra["distance_limit"] as number,
    );
  });

  it("勾「枚举全部」时「步数上限」整格作废（填 1 与不填逐字段相同）", async () => {
    const plain = await equip("making").run(
      mkEquip("making", "weapons/尾火棍", { full_search: true }),
      12345,
      { backend: rt },
    );
    const tiny = await equip("making").run(
      mkEquip("making", "weapons/尾火棍", { full_search: true, limit: 1 }),
      12345,
      { backend: rt },
    );
    expect(tiny.extra["distance_limit"]).toBe(plain.extra["distance_limit"]);
    expect(tiny.seed).toBe(plain.seed);
    expect(tiny.distance).toBe(plain.distance);
    expect([...tiny.seeds]).toEqual([...plain.seeds]);
    expect(tiny.notes.some((n) => n.field === "limit" && n.message.includes("被忽略"))).toBe(true);
    expect(plain.notes.some((n) => n.field === "limit")).toBe(false);
  });

  it("不勾「枚举全部」时「步数上限」照旧生效（收到 10 步就够不着 112 步外的种子）", async () => {
    const inputs = mkEquip("drops", "drops/药王葫芦", { wuxing: "金木" });
    const unlimited = await equip("drops").run(inputs, 1000, { backend: rt });
    expect(unlimited.seed).toBe(2048500);

    const tiny = await equip("drops").run(
      mkEquip("drops", "drops/药王葫芦", { wuxing: "金木", limit: 10 }),
      1000,
      { backend: rt },
    );
    expect(tiny.seed).toBe(0);
    expect(tiny.distance).toBe(0);
    expect(tiny.notes.some((n) => n.message.includes("没有找到任何种子"))).toBe(true);
  });

  it("装备场景只支持局部搜索（near=False 直接抛）", async () => {
    await expect(
      equip("making").run(mkEquip("making", "weapons/尾火棍"), 12345, {
        backend: rt,
        near: false,
      }),
    ).rejects.toThrowError(ScenarioError);
  });

  it("searchLimits：五行分支与其它分支不同", () => {
    const wuxing = equip("drops").planOf(mkEquip("drops", "drops/药王葫芦", { wuxing: "金" }));
    // 五行分支：距离上限与 full 无关
    expect(equip("drops").searchLimits(wuxing, 1, false)).toEqual([
      MAX_SEED_SEARCH,
      MAX_SEED_SEARCH,
    ]);
    expect(equip("drops").searchLimits(wuxing, 1, true)).toEqual([
      FULL_SEARCH_LIMIT,
      MAX_SEED_SEARCH,
    ]);
    // 其它分支：两者都 = MAX / 排列数
    const plain = equip("making").planOf(mkEquip("making", "weapons/尾火棍"));
    expect(equip("making").searchLimits(plain, 2, false)).toEqual([
      Math.trunc(MAX_SEED_SEARCH / 2),
      Math.trunc(MAX_SEED_SEARCH / 2),
    ]);
    expect(equip("making").searchLimits(plain, 2, true)).toEqual([
      FULL_SEARCH_LIMIT,
      FULL_SEARCH_LIMIT,
    ]);
  });

  it("simulateEquip 逐字复现预览文本（取整一律半值取偶）", () => {
    const plan = equip("making").planOf(mkEquip("making", "weapons/尾火棍"));
    const scaled = scalePlan(plan);
    const preview = simulateEquip(
      rt.engine,
      1090519811,
      scaled.baseEquip,
      new Map(),
      plan.targetWx,
      scaled.targetEquip,
      plan.baguaEup,
      plan.baguaTotal,
    );
    expect(preview.text).toBe("{'攻击':11}");
    expect(preview.seedAfter).not.toBe(0);
  });
});
