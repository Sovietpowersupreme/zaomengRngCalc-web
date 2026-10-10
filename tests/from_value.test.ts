/**
 * ``seed-resolve`` 的**纯函数**对拍：两条换算 + 两格输入的解析 + 校验提示文案。
 *
 * 这一层为什么值得单独测、而不是靠 ``runs.json`` 的重放带过
 * ----------------------------------------------------------
 * ``runs.json`` 里的 7 条 ``seed-resolve`` 用例**全是合法输入**，所以它只钉住了
 * 「happy path」。而下面这些东西它一个字都碰不到：
 *
 * * :func:`saveGameValue` / :func:`randomIntFromValue` 的**舍入方向**与**运算顺序**
 *   —— Python 侧专门写了「合并成一个因子会差 1」，差 1 的错在 golden 上可能
 *   恰好不出现（golden 只有几个采样点），但玩家会碰上；
 * * ``0 < seed`` 与 ``0 <= target`` 这两个**下界不一样**的判定；
 * * 一整类**报错文案**（``SpecError`` 的 message 会直接显示给用户）；
 * * ``parseValue`` **先查 mode 再判整数**、``parseTarget`` **先判整数再查 mode**
 *   这对相反的顺序 —— 抄错了不会有任何测试变红，只会让报错在错误的格子上出现。
 *
 * 常量不重复定义：本文件把 :data:`~src/core/fromValue.SAVE_GAME_SCALE` /
 * ``SAVE_GAME_HALF`` 与 ``consts.json`` 的值**对钉**，只要有人改了一边就红。
 */

import { describe, expect, it } from "vitest";

import {
  pyFloat,
  pyRepr,
  randomIntFromValue,
  SAVE_GAME_HALF,
  SAVE_GAME_SCALE,
  saveGameValue,
} from "../src/core/fromValue";
import { KMAX } from "../src/core/values";
import { CONSTS } from "../src/data/consts";
import {
  MODE_SAVE_GAME,
  MODE_VALUE,
  parseTarget,
  parseValue,
  SeedResolveScenario,
  VALUE_FIELD,
  type ValueInput,
} from "../src/scenarios/seed_resolve";

/** 取 :class:`ValueInput` 的关键字段，断言时不必写整个对象。 */
function shape(parsed: ValueInput): Record<string, unknown> {
  return {
    isSeed: parsed.isSeed,
    seed: parsed.seed,
    randomInt: parsed.randomInt,
    mode: parsed.mode,
    text: parsed.text,
  };
}

describe("fromValue：两条换算共用一份常量（与 consts.json 对钉）", () => {
  it("SAVE_GAME_SCALE / SAVE_GAME_HALF 与 consts.json 的 stars 表逐字相同", () => {
    // 三个地方说的是同一件事：Python const/stars.py 的模块常量、export_json 导出的
    // JSON、以及本文件的 TS 常量。任何一个被单独改动都会在这里变红。
    expect(SAVE_GAME_SCALE).toBe(100_000);
    expect(SAVE_GAME_HALF).toBe(2_147_483_648);
    expect(SAVE_GAME_SCALE).toBe(CONSTS.stars.save_game_scale);
    expect(SAVE_GAME_HALF).toBe(CONSTS.stars.save_game_half);
  });

  it("SAVE_GAME_HALF 是数学值 2147483648，不是 i32 的 -2147483648", () => {
    // 这条是给未来的自己看的：0x80000000 | 0 === -2147483648，一旦有人「顺手」
    // 给常量套个位运算，两个换算会静默全错（负的随机整数 → 恒返回空集）。
    expect(SAVE_GAME_HALF).toBeGreaterThan(0);
    expect(SAVE_GAME_HALF).toBe(KMAX + 1);
  });

  it("原始浮点：int(v × 0x80000000)", () => {
    expect(randomIntFromValue("0.5")).toBe(1_073_741_824); // 0.5 × 2^31
    expect(randomIntFromValue(0.5)).toBe(1_073_741_824); // 数字入参走 str() 再 float()
    expect(randomIntFromValue("0.5625")).toBe(1_207_959_552); // 2^27 × 9
    expect(randomIntFromValue("0")).toBe(0);
    expect(randomIntFromValue("0.9999999999")).toBe(KMAX); // 差 0.215 个刻度，仍截到 KMAX
    expect(randomIntFromValue(" 0.5 ")).toBe(1_073_741_824); // 首尾空白无妨
  });

  it("显示值：int(v ÷ 100000 × 0x80000000)", () => {
    expect(saveGameValue("56250")).toBe(1_207_959_552); // 56250 ÷ 100000 = 0.5625
    expect(saveGameValue("50000")).toBe(1_073_741_824);
    expect(saveGameValue("0.5625")).toBe(12_079); // 5.625e-6 × 2^31 = 12079.59552
    expect(saveGameValue("0")).toBe(0);
  });

  it("两条换算在「显示值 = 原始浮点 × 100000」上互为反解（取二进制精确的那些点）", () => {
    // 只挑 v × 100000 与再除回来都不丢精度的值，避免这条断言本身变成
    // 「舍入误差快照」。0.5 / 0.25 / 0.5625 都是 2 的负幂的整数倍。
    for (const value of ["0.5", "0.25", "0.5625", "0.75"]) {
      const raw = randomIntFromValue(value);
      expect(saveGameValue(String(Number(value) * SAVE_GAME_SCALE))).toBe(raw);
    }
  });

  it("31 位是闭区间 0..KMAX：下界 0 收、上界 KMAX 收、KMAX+1 不收", () => {
    expect(randomIntFromValue("0")).toBe(0);
    expect(randomIntFromValue("0.9999999999")).toBe(KMAX);
    // 显示值的最大值恰好是 100000，也就是「原始浮点 = 1」—— 刚好越界一格。
    expect(() => saveGameValue("100000")).toThrow(/超出 31 位随机数范围/);
    expect(saveGameValue("99999.99")).toBeLessThanOrEqual(KMAX);
  });

  it("越界 / 负数 / 非数字 / inf / nan 都报 SpecError，且文案与 Python 一致", () => {
    expect(() => randomIntFromValue("1")).toThrow(
      "「原始浮点」 '1' 换算成 2147483648，超出 31 位随机数范围（0~2147483647）",
    );
    expect(() => randomIntFromValue("-0.5")).toThrow(/超出 31 位随机数范围/);
    expect(() => randomIntFromValue("abc")).toThrow("「原始浮点」必须是数字，得到 'abc'");
    expect(() => randomIntFromValue("")).toThrow("「原始浮点」必须是数字，得到 ''");
    expect(() => randomIntFromValue(null)).toThrow("必须是数字，得到 None");
    // inf / nan 走的是「换算不出」而不是「必须是数字」—— 与 Python 的
    // float("inf") 成功、int(inf) 抛 OverflowError 一致。
    expect(() => randomIntFromValue("inf")).toThrow(/换算不出 31 位随机数/);
    expect(() => randomIntFromValue("nan")).toThrow(/换算不出 31 位随机数/);
    expect(() => randomIntFromValue(Number.POSITIVE_INFINITY)).toThrow(/换算不出 31 位随机数/);
    // 十六进制必须挡：Python 的 float("0x10") 会 ValueError，而 Number("0x10") 是 16。
    expect(() => randomIntFromValue("0x10")).toThrow(/必须是数字/);
    expect(() => randomIntFromValue("0b11")).toThrow(/必须是数字/);
  });
});

describe("pyFloat / pyRepr：只做「能不能转成数」和「拼报错文案」", () => {
  it("pyFloat 认十进制与科学计数，不认空串与进制前缀", () => {
    expect(pyFloat("0.5")).toBe(0.5);
    expect(pyFloat(".5")).toBe(0.5);
    expect(pyFloat("5.")).toBe(5);
    expect(pyFloat("1e3")).toBe(1000);
    expect(pyFloat("1E-3")).toBe(0.001);
    expect(pyFloat("+1.5")).toBe(1.5);
    expect(pyFloat(" 1.5 ")).toBe(1.5);
    expect(pyFloat(0.5)).toBe(0.5);
    expect(pyFloat("")).toBeNull();
    expect(pyFloat("   ")).toBeNull();
    expect(pyFloat(null)).toBeNull();
    expect(pyFloat("abc")).toBeNull();
    expect(pyFloat("0x10")).toBeNull();
    expect(pyFloat("0o7")).toBeNull();
  });

  it("pyFloat 的 inf / nan 返回一个数（留给范围检查去挡）", () => {
    expect(pyFloat("inf")).toBe(Number.POSITIVE_INFINITY);
    expect(pyFloat("-Infinity")).toBe(Number.NEGATIVE_INFINITY);
    expect(Number.isNaN(pyFloat("nan") as number)).toBe(true);
  });

  it("pyRepr 说的是 Python 的话", () => {
    expect(pyRepr("abc")).toBe("'abc'");
    expect(pyRepr(0.5)).toBe("0.5");
    expect(pyRepr(12)).toBe("12");
    expect(pyRepr(null)).toBe("None");
    expect(pyRepr(undefined)).toBe("None");
    expect(pyRepr(true)).toBe("True");
    expect(pyRepr(false)).toBe("False");
    expect(pyRepr(Number.POSITIVE_INFINITY)).toBe("inf");
    expect(pyRepr(Number.NaN)).toBe("nan");
  });
});

describe("parseValue：浮点 = 随机值，整数 = 种子（那一格是多态的）", () => {
  it("带小数点 → 按格式换算成随机整数", () => {
    expect(shape(parseValue("0.5625"))).toEqual({
      isSeed: false,
      seed: 0,
      randomInt: 1_207_959_552,
      mode: MODE_VALUE,
      text: "0.5625",
    });
  });

  it("没有小数点 → 当作种子（= 起始值）", () => {
    expect(shape(parseValue("1779036211"))).toEqual({
      isSeed: true,
      seed: 1_779_036_211,
      randomInt: 0,
      mode: MODE_VALUE,
      text: "1779036211",
    });
  });

  it("种子的下界是 1（不是 0），上界是 KMAX", () => {
    // 1 与 KMAX 收；0 与 KMAX+1 不收 —— 「恢复值」这一格与「匹配值」那格
    // 的下界判定**故意不一样**（那边 0 是合法的），抄错不会有别的测试变红。
    expect(shape(parseValue("1")).seed).toBe(1);
    expect(shape(parseValue(` ${KMAX} `)).seed).toBe(KMAX);
    expect(() => parseValue("0")).toThrow("「恢复值」当种子用时必须落在 1..2147483647，得到 '0'");
    expect(() => parseValue("-1")).toThrow(/必须落在 1\.\.2147483647/);
    expect(() => parseValue(String(KMAX + 1))).toThrow(/必须落在 1\.\.2147483647/);
  });

  it("「1e3」「1.0」算浮点写法，于是被 31 位范围挡下（而不是变成种子）", () => {
    expect(() => parseValue("1.0")).toThrow(/超出 31 位随机数范围/);
    expect(() => parseValue("1e3")).toThrow(/超出 31 位随机数范围/);
  });

  it("空输入与纯空白都报「还没填」", () => {
    for (const raw of ["", "   ", null, undefined]) {
      expect(() => parseValue(raw)).toThrow("「恢复值」还没填");
    }
  });

  it("「保存游戏」格式：同一串数字换算出来的值小得多", () => {
    expect(shape(parseValue("0.5625", MODE_SAVE_GAME))).toEqual({
      isSeed: false,
      seed: 0,
      randomInt: 12_079,
      mode: MODE_SAVE_GAME,
      text: "0.5625",
    });
    // 小数点决定「走哪条语义」，格式只决定「怎么换算」—— 整数写法与格式无关。
    expect(shape(parseValue("12345", MODE_SAVE_GAME))).toEqual({
      isSeed: true,
      seed: 12345,
      randomInt: 0,
      mode: MODE_SAVE_GAME,
      text: "12345",
    });
  });

  it("先查格式再判整数：格式不认识时连合法整数也报格式错", () => {
    // 这是 Python 的调用顺序（`_converter` 在 `_integer_of` 之前）。反过来的话，
    // 用户选了个坏格式又填了整数，就会「静默按默认格式算」—— 错得无声无息。
    expect(() => parseValue("12345", "不认识")).toThrow(
      "「恢复值格式」不认识 '不认识'，可选 ['原始浮点', '保存游戏']",
    );
    expect(() => parseValue("0.5", "不认识")).toThrow(/不认识/);
  });
});

describe("parseTarget：永远按随机整数理解，只有最后一个参与", () => {
  it("空 / 纯分隔符 → 0", () => {
    expect(parseTarget("")).toBe(0);
    expect(parseTarget("   ")).toBe(0);
    expect(parseTarget(null)).toBe(0);
    for (const raw of [" ", ",", "，，"]) expect(parseTarget(raw)).toBe(0);
  });

  it("浮点写法按「恢复值格式」换算", () => {
    expect(parseTarget("0.3")).toBe(644_245_094); // 0.3 × 2^31 = 644245094.4
    expect(parseTarget("345.6", MODE_SAVE_GAME)).toBe(7_421_703); // 345.6 ÷ 100000 × 2^31
  });

  it("只有最后一个参与（前面那些是「原样抄进来的读数」）", () => {
    expect(parseTarget("0.1 0.2 0.3")).toBe(644_245_094);
    expect(parseTarget("0.1,0.2、0.3；0.4：0.5")).toBe(1_073_741_824); // 最后一个 0.5
    expect(parseTarget("0.3 0.9")).toBe(parseTarget("0.9"));
  });

  it("整数写法按随机整数理解（不是种子），下界含 0", () => {
    // 「匹配值」的位置永远是 arg2 —— 与「恢复值」那格「整数 = 种子」的语义不同。
    expect(parseTarget("0")).toBe(0);
    expect(parseTarget("123")).toBe(123);
    expect(parseTarget(String(KMAX))).toBe(KMAX);
    expect(() => parseTarget(String(KMAX + 1))).toThrow(
      "「匹配值」当随机整数用时不能超出 0..2147483647，得到 '2147483648'",
    );
    expect(() => parseTarget("abc")).toThrow("「原始浮点」必须是数字，得到 'abc'");
  });

  it("先判整数再查格式：整数写法根本用不到换算表，格式坏了也不该在这里报错", () => {
    // 与 parseValue 的顺序**相反**，这是照抄 Python 的。
    expect(parseTarget("12345", "不认识")).toBe(12345);
    expect(() => parseTarget("0.3", "不认识")).toThrow(/恢复值格式」不认识/);
  });
});

describe("SeedResolveScenario.validate：四种分支的提示文案", () => {
  const scenario = new SeedResolveScenario();

  it("describe() 的三件套与 Python 夹具一致", () => {
    expect(scenario.key).toBe("seed-resolve");
    expect(scenario.label).toBe("种子恢复");
    expect(scenario.version).toBe("1.2");
    expect(scenario.specKind).toBe("interval");
    expect(scenario.nearLimit).toBe(9_999_999);
    expect(scenario.supportsNear).toBe(true);
    expect(scenario.sliceBounds).toBeNull();
    expect(scenario.randomConsumption({})).toBe(0);
    expect(scenario.advanceCount({})).toBe(1);
  });

  it("「恢复值」读不出来 → 只留一条 error，不再讨论「匹配值」", () => {
    const notes = scenario.validate({ [VALUE_FIELD]: "", target: "" }).map((n) => n.toDict());
    expect(notes).toEqual([
      {
        level: "error",
        message: "「恢复值」还没填 —— 浮点（random() 的值）或整数（已有的种子）都行",
        field: VALUE_FIELD,
      },
    ]);
    // 「匹配值」也填错时依然只有一条 —— 早退，不叠错。
    expect(
      scenario.validate({ [VALUE_FIELD]: "abc", target: "abc" }).map((n) => n.toDict()),
    ).toHaveLength(1);
  });

  it("「匹配值」读不出来 → error 挂在 target 那一格", () => {
    expect(
      scenario.validate({ [VALUE_FIELD]: "0.5625", target: "abc" }).map((n) => n.toDict()),
    ).toEqual([
      { level: "error", message: "「原始浮点」必须是数字，得到 'abc'", field: "target" },
    ]);
  });

  it("浮点「恢复值」：匹配值空 → warning（只提醒、不拦），有 → info", () => {
    const empty = scenario.validate({ [VALUE_FIELD]: "0.5625", target: "" }).map((n) => n.toDict());
    expect(empty).toEqual([
      {
        level: "warning",
        message:
          "「匹配值」空着 → 只靠一个随机值恢复，多半对应多个候选种子，" +
          "拿不到唯一解时本场景会拒绝给答案",
        field: "target",
      },
    ]);
    const filled = scenario.validate({ [VALUE_FIELD]: "0.5625", target: "0.29" }).map((n) =>
      n.toDict(),
    );
    expect(filled).toEqual([
      {
        level: "info",
        message:
          "「匹配值」用来筛候选：手里还有上次算出的种子的话，" +
          "把它填进「恢复值」（整数写法）比只靠「匹配值」更稳",
        field: "target",
      },
    ]);
  });

  it("整数「恢复值」：info 说明它变成起始值；没有匹配值才是 error", () => {
    expect(
      scenario.validate({ [VALUE_FIELD]: "12345", target: "0.29" }).map((n) => n.toDict()),
    ).toEqual([
      {
        level: "info",
        message: "「恢复值」是整数 → 当作起始值（种子 12345），要恢复的随机值由「匹配值」提供",
        field: VALUE_FIELD,
      },
    ]);
    expect(
      scenario.validate({ [VALUE_FIELD]: "12345", target: "" }).map((n) => n.toDict()),
    ).toEqual([
      {
        level: "info",
        message: "「恢复值」是整数 → 当作起始值（种子 12345），要恢复的随机值由「匹配值」提供",
        field: VALUE_FIELD,
      },
      {
        level: "error",
        message:
          "「恢复值」当起始值用时「匹配值」不能空 —— " +
          "那里要填那一次读到的随机值，否则没东西可恢复",
        field: "target",
      },
    ]);
  });

  it("startSeed：整数用法优先，浮点用法回落到入参，越界一律 0", () => {
    // ``scenario.run(inputs, startSeed)`` 这个后门：UI 里没有对应的格子，
    // 所以浮点那一支永远是 0；整数那一支「恢复值」自己就是起始值。
    expect(SeedResolveScenario.startSeed(parseValue("12345"), 999)).toBe(12345);
    expect(SeedResolveScenario.startSeed(parseValue("0.5625"), 999)).toBe(999);
    expect(SeedResolveScenario.startSeed(parseValue("0.5625"))).toBe(0);
    expect(SeedResolveScenario.startSeed(parseValue("0.5625"), -1)).toBe(0);
    expect(SeedResolveScenario.startSeed(parseValue("0.5625"), KMAX + 1)).toBe(0);
  });
});
