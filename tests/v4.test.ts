/**
 * 法宝洗练 ``v4-reforge`` —— 逐条对照 ``src_forge/tests/test_gameinfo_v4.py``。
 *
 * 分四层，理由和 Python 侧一样：
 *
 * 1. **合约层**（不需要后端）—— 表单 schema、常量表、``V4_ITEMS`` / ``V4_DELTA``
 *    与 ``consts.json`` 的交叉钉；
 * 2. **浮点层**（纯函数）—— :func:`pyRound1` / :func:`jsRound` / :func:`parseDelta`。
 *    这一层是本场景**最容易漂**的地方（Python 内置 ``round`` 是「半值取偶」，
 *    而 ``Math.round`` 是「半值向上」），也是 ``runs.json`` 八格里**几乎覆盖不到**的
 *    角落（golden 的输入都是 ``""`` / ``"0.3"`` / ``"0.1~0.2"``），所以必须单独钉；
 * 3. **五行层**（纯函数）—— ``wuxingToMask`` / ``maskToNames``：名字顺序即语义
 *    （``金木水火土`` → 位 ``0..4``），掩码是**名字顺序**而不是输入顺序；
 * 4. **搜索层 + golden 层**（需要 wasm）—— 候选匹配的「吃 4 或 5 次」结构、
 *    冻结的 ``(distance, seed, needConsume, preview)``，以及 Python 侧
 *    ``interpret`` 里那两条 no-hit 分支。
 *
 * 为什么这个场景值得单独钉「没命中」：它的搜索上限是 **999999 步**，
 * golden 八格全是「找得到」，所以「扫满之后怎么办」在 ``runs.json`` 里一格都没有。
 */

import { beforeAll, describe, expect, it } from "vitest";
// 副作用导入：注册表要先把场景装进去，``getScenario("v4-reforge")`` 才拿得到。
import "../src/scenarios/index";
import { CONSTS } from "../src/data/consts";
import { GROWTH_MAX_TENTHS, GROWTH_MIN_TENTHS, GrowthWuxingSpec } from "../src/core/spec";
import { WUXING_HAS } from "../src/core/values";
import { getScenario, registeredKeys } from "../src/scenarios/registry";
import { Outcome, Runtime, ScenarioError } from "../src/scenarios/scenario";
import {
  GROWTH_ATTR,
  GROWTH_STATES,
  KEY,
  NO_HIT_PREVIEW,
  SEARCH_LIMIT,
  SPLIT_RE,
  STATE_BELOW,
  STATE_FIELD,
  STATE_FULL,
  V4_DELTA,
  V4_ITEMS,
  V4Plan,
  V4Scenario,
  WUXING_ATTR,
  formatPreview,
  jsRound,
  maskToNames,
  matchCandidate,
  parseDelta,
  pyRound1,
  wuxingToMask,
} from "../src/scenarios/v4";
import type { WasmRuntime } from "../src/wasm/runtime";
import { testRuntime } from "./helpers/golden";

/** 已注册的那个 ``v4-reforge`` 实例（顺带把类型收窄到具体类，好调 ``planOf``）。 */
function v4(): V4Scenario {
  const scenario = getScenario(KEY);
  if (!(scenario instanceof V4Scenario)) {
    throw new Error(`${KEY} 注册的不是 V4Scenario：${scenario.constructor.name}`);
  }
  return scenario;
}

/**
 * 按 schema 默认值组一份输入，再用 ``patch`` 覆盖（``start`` 会盖掉 ``start_seed``）。
 *
 * **必须**从 ``defaults()`` 打底：``item`` 的默认值是带前缀的 ``v4-reforge/属性重置``，
 * 而 :meth:`V4Scenario.planOf` 的真默认值是**裸名** —— 两种写法都得能走通。
 */
function mkInputs(patch: Record<string, unknown> = {}, start = 12345): Record<string, unknown> {
  return { ...v4().schema().defaults(), start_seed: start, ...patch };
}

/** 取一个表单字段（不存在就抛，别让 ``?.`` 把断言悄悄变成空操作）。 */
function field(key: string) {
  const schema = v4().schema();
  const found = schema.keys.includes(key) ? schema.get(key) : null;
  if (!found) throw new Error(`v4 表单里没有字段 ${key}`);
  return found;
}

/** ``fn()`` 抛出的错误信息（不抛就算测试失败）—— 用来逐字比对中文报错。 */
function throwsMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (exc) {
    return exc instanceof Error ? exc.message : String(exc);
  }
  throw new Error("本该抛异常，却正常返回了");
}

/** 一位五行的掩码（``"金"`` → ``1``）。 */
function bitOf(name: string): number {
  const bit = CONSTS.wuxing.bits[name];
  if (bit === undefined) throw new Error(`五行表里没有 ${name}`);
  return bit;
}

// =========================================================================== 1 合约层
describe("合约层 · schema", () => {
  it("v4-reforge 已注册", () => {
    expect(registeredKeys()).toContain(KEY);
  });

  it("类属性与 Python 一致", () => {
    const sc = v4();
    expect(sc.key).toBe("v4-reforge");
    expect(sc.label).toBe("法宝洗练");
    expect(sc.version).toBe("1.0");
    expect(sc.specKind).toBe("growth-wuxing");
    expect(sc.supportsNear).toBe(true);
    expect(sc.nearLimit).toBe(SEARCH_LIMIT);
    expect(sc.nearLimit).toBe(999_999);
    // 不可枚举：没有哪种种子空间枚举能表达「单向前扫」。
    expect(sc.sliceBounds).toBeNull();
    // 成长那 2 次随机是场景内部的事，不走「先过 n 次」那条路（golden 记的是 consume 0）。
    expect(sc.randomConsumption({})).toBe(0);
    expect(sc.advanceCount({})).toBe(1);
  });

  it("hint 三句话与「四或五抽」都写清楚了", () => {
    const hint = v4().hint;
    expect(hint).toContain("属性重置");
    expect(hint).toContain("每次候选吃 4 或 5 个随机数");
    expect(hint).toContain("±0.1 / ±0.2 / ±0.3");
    expect(hint).toContain("[0.8, 2.5]");
    expect(hint).toContain("未满 2.5 会重算成长");
    // 三句话：句号数是硬指标（多写一句就说明语义漂了）。
    expect(hint.split("\n")).toHaveLength(3);
  });

  it("字段顺序与上下限", () => {
    const schema = v4().schema();
    expect(schema.keys).toEqual(["item", "growth_state", "growth", "wuxing", "start_seed"]);
    expect(schema.title).toBe("法宝洗练");
    expect(schema.hint).toBe(v4().hint);
    // 分组：前四格是「法宝」，起始种子归「搜索」（保持首次出现顺序）。
    expect(Object.entries(schema.groups()).map(([group, fields]) => [group, fields.map((f) => f.key)])).toEqual([
      ["法宝", ["item", "growth_state", "growth", "wuxing"]],
      ["搜索", ["start_seed"]],
    ]);
  });

  it("item 是单选，默认带前缀（但裸名也认）", () => {
    const item = field("item");
    expect(item.kind).toBe("choice");
    expect(item.label).toBe("法宝");
    expect(item.default).toBe("v4-reforge/属性重置");
    expect(item.choices).toEqual(["v4-reforge/属性重置"]);
    expect(item.group).toBe("法宝");
    expect(item.width).toBe(18);
    expect(item.required).toBe(false);
    // 下拉框 = ``KEY/物品名``。
    expect(v4().itemChoices()).toEqual(["v4-reforge/属性重置"]);
  });

  it("growth_state 是单选，默认「未满 2.5」", () => {
    const state = field(STATE_FIELD);
    expect(state.kind).toBe("choice");
    expect(state.label).toBe("成长状态");
    expect(state.default).toBe(STATE_BELOW);
    expect(state.choices).toEqual(GROWTH_STATES);
    expect(state.choices).toEqual([
      "未满 2.5（重算成长）",
      "已满 2.5（只洗五行）",
    ]);
    expect(state.group).toBe("法宝");
    expect(state.width).toBe(18);
  });

  it("growth / wuxing 都是留空的文本框", () => {
    const growth = field("growth");
    expect(growth.kind).toBe("text");
    expect(growth.label).toBe("成长变化量");
    expect(growth.default).toBe("");
    expect(growth.width).toBe(10);
    const wuxing = field("wuxing");
    expect(wuxing.kind).toBe("text");
    expect(wuxing.label).toBe("五行");
    expect(wuxing.default).toBe("");
    expect(wuxing.width).toBe(10);
  });

  it("start_seed 必填、0 不是合法种子", () => {
    const seed = field("start_seed");
    expect(seed.kind).toBe("int");
    expect(seed.default).toBeNull();
    expect(seed.required).toBe(true);
    expect(seed.min).toBe(1);
    expect(seed.max).toBe(0x7fffffff);
    expect(seed.group).toBe("搜索");
    expect(seed.width).toBe(14);
  });

  it("describe() 只报基类那七格（near_limit / slice_bounds 由测试自己比）", () => {
    const described = v4().describe();
    expect(Object.keys(described)).toEqual([
      "key",
      "label",
      "version",
      "hint",
      "spec_kind",
      "supports_near",
      "schema",
    ]);
    expect(described.spec_kind).toBe("growth-wuxing");
    expect(described.supports_near).toBe(true);
  });

  it("去掉了基类的自动升档（法宝洗练没有「下一轮」）", () => {
    const outcome = new Outcome({ seed: 1, seedAfter: 12345, distance: 3 });
    expect(v4().advance(outcome, mkInputs())).toBeNull();
  });
});

// =========================================================================== 2 常量表
describe("合约层 · 常量表与 consts.json 的交叉钉", () => {
  it("V4_ITEMS 就是装备表里那一类（顺序即下拉框顺序）", () => {
    expect([...V4_ITEMS]).toEqual(["属性重置"]);
    expect([...V4_ITEMS]).toEqual(Object.keys(CONSTS.equipment[KEY] ?? {}));
  });

  it("V4_DELTA 直接读装备表，不抄数字", () => {
    expect(V4_DELTA["属性重置"]).toEqual([-0.3, 0.3]);
    // 交叉钉：必须是同一份数据的同一组数（抄一遍就会各自漂）。
    expect(V4_DELTA["属性重置"]).toEqual(
      CONSTS.equipment[KEY]?.["属性重置"]?.[GROWTH_ATTR] as readonly [number, number],
    );
  });

  it("成长 / 五行 两个属性名与 consts.json 一致", () => {
    expect(CONSTS.attrs.common[CONSTS.attrs.common.length - 1]).toBe(GROWTH_ATTR);
    expect(CONSTS.attrs.wuxing_attr).toBe(WUXING_ATTR);
  });

  it("上限 999999 与提示文案", () => {
    expect(SEARCH_LIMIT).toBe(999_999);
    expect(NO_HIT_PREVIEW).toBe("成长: -\n五行: -");
    expect(NO_HIT_PREVIEW).toBe(`${GROWTH_ATTR}: -\n${WUXING_ATTR}: -`);
  });

  it("成长状态的「夹取区间」来自 spec.ts 的十分位常量", () => {
    // hint 里的 [0.8, 2.5] 不是硬编码的字符串，是 GROWTH_*_TENTHS / 10。
    expect(GROWTH_MIN_TENTHS / 10).toBe(0.8);
    expect(GROWTH_MAX_TENTHS / 10).toBe(2.5);
    expect(v4().hint).toContain(`[${(GROWTH_MIN_TENTHS / 10).toFixed(1)}, ${(GROWTH_MAX_TENTHS / 10).toFixed(1)}]`);
  });

  it("分隔符与 Python 的 _SPLIT 一致：**不含** 减号", () => {
    for (const sep of [",", "，", "|", "~", "·", "/", "、", "；", ";", " ", "\n"]) {
      expect(("0.1" + sep + "0.3").split(SPLIT_RE).filter((p) => p !== "")).toEqual(["0.1", "0.3"]);
    }
    // ``-`` 是负号，**不能**当分隔符：`"-0.3"` 必须整体留在一段里。
    expect("-0.3".split(SPLIT_RE)).toEqual(["-0.3"]);
    expect(SPLIT_RE.test("-0.3")).toBe(false);
  });
});

// =========================================================================== 3 浮点层
describe("浮点层 · pyRound1 是「半值取偶」，jsRound 是「半值向上」", () => {
  it("jsRound = floor(v + 0.5)（游戏/C 侧的口径）", () => {
    expect(jsRound(0)).toBe(0);
    expect(jsRound(0.5)).toBe(1);
    expect(jsRound(0.4999999)).toBe(0);
    expect(jsRound(3.9999999995)).toBe(4);
    expect(jsRound(-0.5)).toBe(0);
    expect(jsRound(-0.51)).toBe(-1);
  });

  it("pyRound1 在半值上取偶（0.25 → 0.2）", () => {
    expect(pyRound1(0.25)).toBe(0.2);
    expect(pyRound1(0.75)).toBe(0.8);
    expect(pyRound1(-0.25)).toBe(-0.2);
    expect(pyRound1(1.25)).toBe(1.2);
    // 先乘后舍就是那个「经典错法」，这里顺手把它钉成反例。
    expect(Math.round(0.25 * 10) / 10).toBe(0.3);
  });

  it("pyRound1 看的是**精确二进制值**（0.35 → 0.3，不是 0.4）", () => {
    // 0.35 的 double 比 0.35 小 ⇒ Python 舍到 0.3；而 ``0.35 * 10`` 先被舍成
    // 3.5000000000000004 ⇒ ``Math.round`` 给 0.4。差一格，命中的种子全不一样。
    expect(pyRound1(0.35)).toBe(0.3);
    expect(Math.round(0.35 * 10) / 10).toBe(0.4);
    expect(pyRound1(0.15)).toBe(0.1);
    expect(pyRound1(-0.35)).toBe(-0.3);
  });

  it("pyRound1 在非半值上就是普通四舍五入", () => {
    expect(pyRound1(0.1)).toBe(0.1);
    expect(pyRound1(0.2)).toBe(0.2);
    expect(pyRound1(0.3)).toBe(0.3);
    expect(pyRound1(-0.3)).toBe(-0.3);
    expect(pyRound1(0.05)).toBe(0.1);
    expect(pyRound1(0.45)).toBe(0.5);
    expect(pyRound1(0.94)).toBe(0.9);
    expect(pyRound1(0.96)).toBe(1);
  });

  it("pyRound1 对 0 / 非有限数原样返回（对应 Python 的 round(inf, 1)）", () => {
    expect(pyRound1(0)).toBe(0);
    expect(pyRound1(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(pyRound1(Number.NEGATIVE_INFINITY)).toBe(Number.NEGATIVE_INFINITY);
    expect(Number.isNaN(pyRound1(Number.NaN))).toBe(true);
  });

  it("pyRound1 对可达的那几个值都是恒等映射（steps / 10 用得上）", () => {
    for (const step of [-3, -2, -1, 0, 1, 2, 3]) {
      expect(pyRound1(step / 10)).toBe(step / 10);
    }
  });
});

describe("浮点层 · parseDelta", () => {
  it("空串 / 空白 → null（调用方回落到物品默认值）", () => {
    expect(parseDelta("")).toBeNull();
    expect(parseDelta("   ")).toBeNull();
    expect(parseDelta("()")).toBeNull();
  });

  it("单值 → 退化成同一个上下界", () => {
    expect(parseDelta("0.3")).toEqual([0.3, 0.3]);
    expect(parseDelta("-0.3")).toEqual([-0.3, -0.3]);
    expect(parseDelta(" 0.3 ")).toEqual([0.3, 0.3]);
    expect(parseDelta("（-0.3）")).toEqual([-0.3, -0.3]);
    // ``strip("()（）")`` 是「两端各自剥一串」，混着写也要认。
    expect(parseDelta(")0.3(")).toEqual([0.3, 0.3]);
  });

  it("两值 → 排序（上界写小于下界也认）", () => {
    expect(parseDelta("0.1~0.3")).toEqual([0.1, 0.3]);
    expect(parseDelta("0.3~0.1")).toEqual([0.1, 0.3]);
    expect(parseDelta("-0.3~0.1")).toEqual([-0.3, 0.1]);
    expect(parseDelta("0.1,0.3")).toEqual([0.1, 0.3]);
    expect(parseDelta("0.1 0.3")).toEqual([0.1, 0.3]);
  });

  it("三段以上 → null（Python 的 else 分支）", () => {
    expect(parseDelta("0.1~0.2~0.3")).toBeNull();
    expect(parseDelta("0.1,0.2,0.3")).toBeNull();
  });

  it("不是数字 → null", () => {
    expect(parseDelta("abc")).toBeNull();
    expect(parseDelta("0.1~abc")).toBeNull();
    expect(parseDelta("0x10")).toBeNull();
  });

  it("一段是空的就当没有（Python 的行为，别自作聪明报错）", () => {
    expect(parseDelta("0.1~")).toEqual([0.1, 0.1]);
    expect(parseDelta("~0.1")).toEqual([0.1, 0.1]);
    expect(parseDelta("~")).toBeNull();
  });

  it("数字一律过 pyRound1（一位小数）", () => {
    expect(parseDelta("0.25")).toEqual([0.2, 0.2]);
    expect(parseDelta("0.35")).toEqual([0.3, 0.3]);
    expect(parseDelta("0.25~0.75")).toEqual([0.2, 0.8]);
    expect(parseDelta("0")).toEqual([0, 0]);
  });

  it("inf / nan **故意**当成解析失败（Python 那边会变成永远搜不到的区间）", () => {
    expect(parseDelta("inf")).toBeNull();
    expect(parseDelta("nan")).toBeNull();
  });
});

// =========================================================================== 4 五行层
describe("五行层 · wuxingToMask / maskToNames", () => {
  it("空 / 无 / 下划线 / 减号 → 0（不是 error）", () => {
    for (const text of ["", "  ", "无", "_", "-"]) {
      expect(wuxingToMask(text)).toBe(0);
    }
  });

  it("单个字 → 必需位 + 该字的位", () => {
    for (const name of CONSTS.wuxing.names) {
      expect(wuxingToMask(name)).toBe(WUXING_HAS | (1 << bitOf(name)));
    }
    expect(wuxingToMask("金")).toBe(33);
    expect(wuxingToMask("木")).toBe(34);
    expect(wuxingToMask("火")).toBe(40);
    expect(wuxingToMask("土")).toBe(48);
  });

  it("两个字 → 三位（含必需位）", () => {
    expect(wuxingToMask("金火")).toBe(WUXING_HAS | (1 << bitOf("金")) | (1 << bitOf("火")));
    expect(wuxingToMask("金火")).toBe(41);
    expect(wuxingToMask("木火")).toBe(42);
  });

  it("重复字 / 生字 → null", () => {
    expect(wuxingToMask("金金")).toBeNull();
    expect(wuxingToMask("金火金")).toBeNull();
    expect(wuxingToMask("A")).toBeNull();
    expect(wuxingToMask("金A")).toBeNull();
  });

  it("分隔符只是被跳过（不引入第三位）", () => {
    expect(wuxingToMask("金,火")).toBe(41);
    expect(wuxingToMask("金、火")).toBe(41);
    expect(wuxingToMask("金 火")).toBe(41);
    expect(wuxingToMask("金/火")).toBe(41);
  });

  it("掩码 → 名字按**名字顺序**而不是输入顺序", () => {
    expect(maskToNames(0)).toBe("无");
    expect(maskToNames(WUXING_HAS)).toBe("无");
    expect(maskToNames(wuxingToMask("金") as number)).toBe("金");
    expect(maskToNames(wuxingToMask("火金") as number)).toBe("金火");
    expect(maskToNames(wuxingToMask("土金") as number)).toBe("金土");
    expect(maskToNames(wuxingToMask("金木水火土") as number)).toBe("金木水火土");
  });

  it("名字顺序 = 位序（金木水火土 → 0..4）", () => {
    expect([...CONSTS.wuxing.names]).toEqual(["金", "木", "水", "火", "土"]);
    CONSTS.wuxing.names.forEach((name, index) => {
      expect(bitOf(name)).toBe(index);
      expect(CONSTS.wuxing.next[index]).toHaveLength(4);
      // 每一行都**不含**自己（``next_wuxing`` 的语义）。
      expect(CONSTS.wuxing.next[index]).not.toContain(index);
    });
  });

  it("formatPreview 三态", () => {
    expect(formatPreview(null, WUXING_HAS)).toBe("成长: 不变\n五行: 无");
    expect(formatPreview(-0.3, WUXING_HAS | (1 << bitOf("木")))).toBe("成长: -0.3\n五行: 木");
    expect(formatPreview(0.1, WUXING_HAS | (1 << bitOf("金")) | (1 << bitOf("木")))).toBe(
      "成长: +0.1\n五行: 金木",
    );
    // 正数一定带 ``+``（Python 的 ``{:+.1f}``）。
    expect(formatPreview(0.3, WUXING_HAS)).toBe("成长: +0.3\n五行: 无");
  });
});

// =========================================================================== 5 计划层
describe("计划层 · planOf / validate / buildSpec", () => {
  it("默认输入：未满 2.5 + 物品默认区间 + 任意五行", () => {
    const plan = v4().planOf(mkInputs());
    expect(plan).toBeInstanceOf(V4Plan);
    expect(plan.item).toBe("属性重置");
    expect(plan.grows).toBe(true);
    expect(plan.full).toBe(false);
    expect(plan.delta).toEqual([-0.3, 0.3]);
    expect(plan.targetWx).toBe(WUXING_HAS);
    expect(plan.hasWuxing).toBe(true);
    expect(plan.limit).toBe(SEARCH_LIMIT);
  });

  it("裸物品名 / 什么都不传都认（Python 的默认值是裸名）", () => {
    expect(v4().planOf({}).item).toBe("属性重置");
    expect(v4().planOf({ item: "属性重置" }).item).toBe("属性重置");
    expect(v4().planOf({ item: "v4-reforge/属性重置" }).item).toBe("属性重置");
    // 多级前缀只取最后一段（``rsplit("/", 1)[-1]``）。
    expect(v4().planOf({ item: "x/y/属性重置" }).item).toBe("属性重置");
  });

  it("已满 2.5 → 不吃成长随机，区间被抹成 0", () => {
    const plan = v4().planOf(mkInputs({ [STATE_FIELD]: STATE_FULL, growth: "0.3" }));
    expect(plan.grows).toBe(false);
    expect(plan.full).toBe(true);
    expect(plan.delta).toEqual([0, 0]);
  });

  it("给了成长区间就用它（不再回落物品默认值）", () => {
    expect(v4().planOf(mkInputs({ growth: "0.1~0.3" })).delta).toEqual([0.1, 0.3]);
    expect(v4().planOf(mkInputs({ growth: "0.2" })).delta).toEqual([0.2, 0.2]);
    expect(v4().planOf(mkInputs({ growth: "-0.2" })).delta).toEqual([-0.2, -0.2]);
    // 解析不了 → 回落默认值（校验的报错由 validate 负责）。
    expect(v4().planOf(mkInputs({ growth: "abc" })).delta).toEqual([-0.3, 0.3]);
  });

  it("五行「无」也算「不筛五行」（0 会被规范化成必需位）", () => {
    expect(v4().planOf(mkInputs({ wuxing: "无" })).targetWx).toBe(WUXING_HAS);
    expect(v4().planOf(mkInputs({ wuxing: "金" })).targetWx).toBe(WUXING_HAS | 1);
    expect(v4().planOf(mkInputs({ wuxing: "金火" })).targetWx).toBe(WUXING_HAS | 1 | 8);
  });

  it("三种不认识的输入各报各的错", () => {
    expect(throwsMessage(() => v4().planOf(mkInputs({ item: "v4-reforge/不存在" })))).toBe(
      "没有名为 'v4-reforge/不存在' 的法宝（可选：属性重置）",
    );
    expect(throwsMessage(() => v4().planOf(mkInputs({ [STATE_FIELD]: "乱写" })))).toBe(
      "成长状态 '乱写' 不认识（可选：未满 2.5（重算成长）、已满 2.5（只洗五行））",
    );
    expect(throwsMessage(() => v4().planOf(mkInputs({ wuxing: "金金" })))).toBe(
      "五行 '金金' 里有非法或重复的字",
    );
  });

  it("合法输入一条 warning 都没有", () => {
    expect(v4().validate(mkInputs())).toEqual([]);
    expect(v4().validate(mkInputs({ growth: "0.3", wuxing: "金木" }))).toEqual([]);
    expect(v4().validate(mkInputs({ [STATE_FIELD]: STATE_FULL, wuxing: "金" }))).toEqual([]);
    expect(v4().validate(mkInputs({ wuxing: "无" }))).toEqual([]);
  });

  it("报错文案（含 field）逐字对齐 Python", () => {
    const notes = v4().validate(mkInputs({ item: "v4-reforge/不存在" }));
    expect(notes.map((n) => [n.level, n.field, n.message])).toEqual([
      ["error", "item", "没有名为 'v4-reforge/不存在' 的法宝（可选：属性重置）"],
    ]);
    expect(notes[0]?.isError).toBe(true);
  });

  it("不认识的成长状态报 error，并回落默认状态继续查后面的字段", () => {
    const notes = v4().validate(mkInputs({ [STATE_FIELD]: "乱写", wuxing: "金金" }));
    expect(notes.map((n) => [n.field, n.message])).toEqual([
      [STATE_FIELD, "成长状态 '乱写' 不认识（可选：未满 2.5（重算成长）、已满 2.5（只洗五行））"],
      ["wuxing", "五行 '金金' 里有非法或重复的字"],
    ]);
  });

  it("成长变化量：解析不了 / 恰好 0 各一条", () => {
    expect(v4().validate(mkInputs({ growth: "abc" })).map((n) => [n.field, n.message])).toEqual([
      ["growth", "成长变化量 'abc' 解析不了（示例：0.3 / -0.3 / 0.1~0.3）"],
    ]);
    const zero = v4().validate(mkInputs({ growth: "0" }));
    expect(zero.map((n) => n.field)).toEqual(["growth"]);
    expect(zero[0]?.message).toBe(
      "成长变化量恰好 0 在游戏里不可达：Math.ceil(random() * 3) == 0 要求 " +
        "staticRandom == 0，而那要 seed == 0，0 不在种子循环里 —— " +
        "想筛「变化量 0」永远搜不到，请改成 ±0.1 / ±0.2 / ±0.3",
    );
    // ``"0.1~0.1"`` 不是 0，反而合法（游戏里 ±0.1 是可达的）。
    expect(v4().validate(mkInputs({ growth: "0.1~0.1" }))).toEqual([]);
  });

  it("已满 2.5 还给变化量区间 → 报「没有意义」", () => {
    const notes = v4().validate(mkInputs({ [STATE_FIELD]: STATE_FULL, growth: "0.3" }));
    expect(notes.map((n) => [n.field, n.message])).toEqual([
      [
        "growth",
        "「属性重置」在「已满 2.5（只洗五行）」下不重算成长（只洗五行），" +
          "给变化量区间没有任何意义；想筛变化量请选「未满 2.5」",
      ],
    ]);
  });

  it("「0 不可达」比「已满」先判（Python 的 if/elif 顺序）", () => {
    const notes = v4().validate(mkInputs({ [STATE_FIELD]: STATE_FULL, growth: "0" }));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.message).toContain("成长变化量恰好 0 在游戏里不可达");
  });

  it("五行最多两位（91% 单抽）", () => {
    const notes = v4().validate(mkInputs({ wuxing: "金木水" }));
    expect(notes.map((n) => [n.field, n.message])).toEqual([
      ["wuxing", "游戏最多只会给 2 个五行（91% 是单抽），要 3 个以上永远搜不到"],
    ]);
    expect(v4().validate(mkInputs({ wuxing: "金木" }))).toEqual([]);
    // 重复字走的是「非法或重复」那条，不是「超过两位」。
    expect(v4().validate(mkInputs({ wuxing: "金金火" }))[0]?.message).toContain("非法或重复");
  });

  it("validate 报错时 prepare 直接抛（多条用「；」连起来）", () => {
    expect(throwsMessage(() => v4().prepare(mkInputs({ growth: "abc" }), 12345))).toBe(
      "成长变化量 'abc' 解析不了（示例：0.3 / -0.3 / 0.1~0.3）",
    );
    expect(throwsMessage(() => v4().prepare(mkInputs({ wuxing: "金金", growth: "abc" }), 12345))).toBe(
      "成长变化量 'abc' 解析不了（示例：0.3 / -0.3 / 0.1~0.3）；五行 '金金' 里有非法或重复的字",
    );
  });

  it("buildSpec 产出 growth-wuxing 规格（不是枚举子集）", () => {
    const spec = v4().buildSpec(mkInputs({ growth: "0.1~0.3", wuxing: "金火" }), 0);
    expect(spec).toBeInstanceOf(GrowthWuxingSpec);
    expect(spec.kind).toBe("growth-wuxing");
    expect(spec.grows).toBe(true);
    expect(spec.growth).toEqual([0.1, 0.3]);
    expect(spec.targetWx).toBe(WUXING_HAS | 1 | 8);
    expect(spec.step).toBe(1);
    // 不可枚举 ⇒ 一条区间约束都没有。
    expect(spec.num).toBe(0);
    expect(spec.constraints).toEqual([]);
  });

  it("buildSpec：已满 2.5 时 grows=false 且区间是 (0, 0)", () => {
    const spec = v4().buildSpec(mkInputs({ [STATE_FIELD]: STATE_FULL }), 0);
    expect(spec.grows).toBe(false);
    expect(spec.growth).toEqual([0, 0]);
  });
});

// =========================================================================== 6 搜索层
describe("搜索层 · 候选匹配「吃 4 或 5 次」", () => {
  let rt: WasmRuntime;
  beforeAll(async () => {
    rt = await testRuntime();
  });

  /** 冻结点：``v4-below-default`` 记录的那个种子与预览。 */
  const BELOW_SEED = 1_207_965_724;
  const BELOW_DELTA = -0.3;
  const BELOW_MASK = WUXING_HAS | (1 << 1); // 木

  it("冻结点上命中，且第 1 个随机数决定变化量、第 3/4 个决定五行", () => {
    const spec = GrowthWuxingSpec.fromParts(WUXING_HAS, [BELOW_DELTA, BELOW_DELTA], true);
    const hit = matchCandidate(rt.engine, BELOW_SEED, spec);
    expect(hit).not.toBeNull();
    expect(hit?.[0]).toBe(BELOW_DELTA);
    expect(hit?.[1]).toBe(BELOW_MASK);
    expect(formatPreview(hit?.[0] ?? null, hit?.[1] ?? 0)).toBe("成长: -0.3\n五行: 木");
  });

  it("只读：同一个种子连着算两次结果完全一样", () => {
    const spec = GrowthWuxingSpec.fromParts(WUXING_HAS, [BELOW_DELTA, BELOW_DELTA], true);
    expect(matchCandidate(rt.engine, BELOW_SEED, spec)).toEqual(
      matchCandidate(rt.engine, BELOW_SEED, spec),
    );
  });

  it("成长区间不含变化量 → 不命中（哪怕五行本来就对）", () => {
    const narrow = GrowthWuxingSpec.fromParts(WUXING_HAS, [0.1, 0.1], true);
    expect(matchCandidate(rt.engine, BELOW_SEED, narrow)).toBeNull();
    const other = GrowthWuxingSpec.fromParts(WUXING_HAS, [0.2, 0.3], true);
    expect(matchCandidate(rt.engine, BELOW_SEED, other)).toBeNull();
  });

  it("五行对不上 → 不命中", () => {
    // 那一位是「木」，却要求「土」。
    const spec = GrowthWuxingSpec.fromParts(1 << bitOf("土"), [BELOW_DELTA, BELOW_DELTA], true);
    expect(matchCandidate(rt.engine, BELOW_SEED, spec)).toBeNull();
    // 「木」自己就命中。
    const ok = GrowthWuxingSpec.fromParts(1 << bitOf("木"), [BELOW_DELTA, BELOW_DELTA], true);
    expect(matchCandidate(rt.engine, BELOW_SEED, ok)?.[1]).toBe(BELOW_MASK);
  });

  it("已满 2.5 时变化量是 null（不吃成长那 2 抽）", () => {
    const spec = GrowthWuxingSpec.fromParts(WUXING_HAS, [0, 0], false);
    const hit = matchCandidate(rt.engine, BELOW_SEED, spec);
    expect(hit?.[0]).toBeNull();
  });

  it("同一个种子、两种状态给出不同的五行（顺序真的敏感）", () => {
    // 未满：五行读第 3/4 抽；已满：五行读第 1/2 抽 —— 位置不同，结果就不该一样。
    // golden 两格钉的正是这个：同一个种子 1207965724，未满是「木」、已满是「水」。
    const seed = rt.engine.fastNext(12345);
    expect(seed).toBe(BELOW_SEED);
    const below = matchCandidate(
      rt.engine,
      seed,
      GrowthWuxingSpec.fromParts(WUXING_HAS, [-0.3, 0.3], true),
    );
    const full = matchCandidate(
      rt.engine,
      seed,
      GrowthWuxingSpec.fromParts(WUXING_HAS, [0, 0], false),
    );
    expect([...(below ?? [])]).toEqual([BELOW_DELTA, BELOW_MASK]);
    expect([...(full ?? [])]).toEqual([null, WUXING_HAS | (1 << bitOf("水"))]);
    expect(below?.[1]).not.toBe(full?.[1]);
  });

  it("91% 之外才吃第 5 抽，且要用 next_wuxing 查表", () => {
    // 沿 FastNext 找第一个「双抽」候选，然后按 .as 的公式手工推出期望掩码。
    // 这一步的价值是钉住「第 5 抽 + next_wuxing 表」这条支路**真的实现了**
    // （golden 八格未必落在这条支路上）。
    let seed = rt.engine.fastNext(12345);
    let found: { seed: number; first: number; second: number; fourth: number; fifth: number } | null = null;
    for (let step = 1; step <= 500 && found === null; step++) {
      const [first, s1] = rt.engine.randomValue(seed);
      const [second, s2] = rt.engine.randomValue(s1);
      const [third, s3] = rt.engine.randomValue(s2);
      const [fourth, s4] = rt.engine.randomValue(s3);
      if (third >= CONSTS.wuxing.double_at) {
        const [fifth] = rt.engine.randomValue(s4);
        found = { seed, first, second, fourth, fifth };
      }
      seed = rt.engine.fastNext(seed);
    }
    expect(found).not.toBeNull();
    const probe = found as { seed: number; first: number; second: number; fourth: number; fifth: number };
    const wx1 = jsRound(probe.fourth * 4);
    const wx2 = jsRound(probe.fifth * 3);
    const next = CONSTS.wuxing.next[wx1]?.[wx2];
    expect(next).toBeDefined();
    const expected = WUXING_HAS | (1 << wx1) | (1 << (next as number));
    const steps = probe.second <= 0.5 ? -Math.ceil(probe.first * 3) : Math.ceil(probe.first * 3);
    const delta = pyRound1(steps / 10);
    expect(delta).toBeGreaterThanOrEqual(-0.3);
    expect(delta).toBeLessThanOrEqual(0.3);
    const spec = GrowthWuxingSpec.fromParts(expected, [delta, delta], true);
    expect(matchCandidate(rt.engine, probe.seed, spec)).toEqual([delta, expected]);
  });
});

// =========================================================================== 7 golden 层
/** ``(输入补丁, start, distance, seed, needConsume, preview)`` —— 摘 ``runs.json`` 里四格。 */
const GOLDEN: readonly (readonly [
  Record<string, unknown>,
  number,
  number,
  number,
  number,
  string,
])[] = [
  [{}, 12345, 1, 1207965724, 0, "成长: -0.3\n五行: 木"],
  [{ wuxing: "金木" }, 12345, 162, 988519980, 161, "成长: +0.1\n五行: 金木"],
  [{ growth: "0.3" }, 12345, 7, 1042284640, 6, "成长: +0.3\n五行: 水"],
  [
    { [STATE_FIELD]: STATE_FULL, wuxing: "金木" },
    12345,
    164,
    247129995,
    163,
    "成长: 不变\n五行: 金木",
  ],
  // 同一个种子（1207965724）在两种状态下的五行不同：未满读第 3/4 抽（木），
  // 已满读第 1/2 抽（水）—— 顺序敏感性最直观的一格。
  [
    { [STATE_FIELD]: STATE_FULL },
    12345,
    1,
    1207965724,
    0,
    "成长: 不变\n五行: 水",
  ],
];

describe("golden 层：与 Python 冻结的值逐字段一致（跨后端）", () => {
  let rt: WasmRuntime;
  beforeAll(async () => {
    rt = await testRuntime();
  });

  for (const [patch, start, distance, seed, need, preview] of GOLDEN) {
    it(`${JSON.stringify(patch)}@${start} → ${seed}（距离 ${distance}）`, async () => {
      const out = await v4().run(mkInputs(patch, start), start, { backend: rt });
      expect([out.distance, out.seed, out.needConsume]).toEqual([distance, seed, need]);
      expect(out.preview).toBe(preview);
      // 法宝洗练不消耗属性随机，也没有末种子。
      expect(out.consume).toBe(0);
      expect(out.seedAfter).toBe(0);
      expect(out.seeds).toEqual([seed]);
      expect(out.notes).toEqual([]);
    });
  }

  it("距离与 wasm 的 seedDistance 自洽（循环下标没错位）", async () => {
    const inputs = mkInputs();
    const out = await v4().run(inputs, 12345, { backend: rt });
    // ``advanceCount`` 是 1 ⇒ 第一个候选就是 ``fastNext(12345)``，距离 1。
    expect(v4().advanceCount(inputs)).toBe(1);
    expect(rt.engine.fastNextK(12345, 1)).toBe(out.seed);
    expect(rt.engine.seedDistance(12345, out.seed, SEARCH_LIMIT)).toBe(out.distance);
    expect(out.distance).toBe(1);
  });

  it("near 参数被忽略（本场景只有这一种搜索）", async () => {
    const inputs = mkInputs();
    const off = await v4().run(inputs, 12345, { backend: rt });
    const on = await v4().run(inputs, 12345, { near: true, backend: rt });
    expect([on.distance, on.seed, on.needConsume, on.preview]).toEqual([
      off.distance,
      off.seed,
      off.needConsume,
      off.preview,
    ]);
  });

  it("给个小 limit：扫满之后 distance 0 / needConsume 0 / 一条 warning", async () => {
    // ``v4-below-growth`` 的第 7 步才命中，卡在 3 步上必然空手而归。
    const out = await v4().run(mkInputs({ growth: "0.3" }), 12345, { limit: 3, backend: rt });
    expect([out.seed, out.distance, out.needConsume]).toEqual([0, 0, 0]);
    expect(out.seeds).toEqual([]);
    expect(out.preview).toBe(NO_HIT_PREVIEW);
    expect(out.preview).toBe("成长: -\n五行: -");
    // ⚠️ 文案里报的是**场景自己的上限**（999999），不是这次调用传的 limit。
    expect(out.notes.map((n) => [n.level, n.message])).toEqual([
      ["warning", "999999 步之内没有找到符合条件的种子"],
    ]);
  });

  it("preview() 在不命中时给占位符", async () => {
    // ``preview`` 收的是 ``Runtime``（带上池子的那个壳），不是裸 backend。
    const runtime = Runtime.resolve(rt);
    // 起点直接给定「命中不了」的输入 + 一个不会匹配的种子。
    const inputs = mkInputs({ growth: "0.3" });
    expect(v4().preview(1, inputs, runtime)).toBe(NO_HIT_PREVIEW);
    expect(v4().preview(1207965724, inputs, runtime)).toBe(NO_HIT_PREVIEW);
    // 换回默认区间就认得那个种子了。
    expect(v4().preview(1207965724, mkInputs(), runtime)).toBe("成长: -0.3\n五行: 木");
  });

  it("validate 的 error 会让 run 直接抛", async () => {
    await expect(
      v4().run(mkInputs({ growth: "0" }), 12345, { backend: rt }),
    ).rejects.toThrow(ScenarioError);
  });
});
