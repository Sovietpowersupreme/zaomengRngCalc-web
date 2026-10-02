/**
 * 种子搜索器 ``stars``（``src/SevenStars.py``）—— 逐条对照
 * ``src_forge/tests/test_gameinfo_stars.py`` 的 ``TestRegistry`` / ``TestConst`` /
 * ``TestPlan`` / ``TestBuildSpec`` / ``TestMechanism`` / ``TestGolden``
 * （``slow`` 的全空间枚举那几条**故意不搬**：``fastCrack`` 一次要跑十几秒，
 *  web 侧的 ``scenario_runs.test.ts`` 已经拿枚举 golden 对过一次了）。
 *
 * 分三层，理由与 ``rechild.test.ts`` 一样：
 *
 * 1. **合约层**（不需要后端）—— 预设表、``bossIndex`` / ``advanceAfterMatch`` /
 *    ``scannerFor`` 这些纯函数、``planOf`` 的分支判定与报错文案、``buildSpec`` 的形态；
 * 2. **机制层**（不需要后端）—— ``advanceCount`` / ``randomConsumption``，
 *    以及「``near`` 与预设有起始值这件事矛盾」时应当**在后端之前**就报错；
 * 3. **golden 层**（需要 wasm）—— 冻结的 ``(seed, seed_after, distance,
 *    need_consume, preview)``，顺带证明 ctypes 记下来的值在 wasm 上逐位一致。
 *
 * ⚠️ 与 ``rechild`` 不同，``stars`` 的 ``run`` **不要传 ``near``**：起始值留空
 * 就自动走枚举、填了就自动走局部搜索（``plan.local``），这正是它的语义。
 * 显式传反了会抛 ``ScenarioError`` —— 那一条单独测。
 */

import { beforeAll, describe, expect, it } from "vitest";
// 副作用导入：注册表要先把场景装进去，``getScenario("stars")`` 才拿得到。
import "../src/scenarios/index";
import { pyRepr, saveGameValue } from "../src/core/fromValue";
import { uintBeforeRound, uintBeforeTruncation } from "../src/core/ranges";
import { IntervalConstraint, IntervalSpec, MaskSpec, type SeedSpec } from "../src/core/spec";
import { KMAX, M32 } from "../src/core/values";
import { SearchResult } from "../src/core/search";
import { CONSTS } from "../src/data/consts";
import { getScenario, registeredKeys } from "../src/scenarios/registry";
import { InputSchema, Note, Runtime, ScenarioError } from "../src/scenarios/scenario";
import {
  advanceAfterMatch,
  BOSS_BY_INDEX,
  CRACK2_MAX_SPAN,
  DBQX_MODE,
  DBQX_VALUE_STEP,
  dbqxEqualityValues,
  DEFAULT_PRESET,
  DISTANCE_LIMIT,
  ENUM_MODES,
  FASTCRACK_IMASK,
  KEY,
  MAX_CONSTRAINTS,
  NO_HIT_PREVIEW,
  PRESETS,
  PRESET_NAMES,
  RAW_MODE,
  rawSequence,
  SAVE_GAME_PRESET,
  scannerFor,
  StarsPlan,
  StarsScenario,
  TOO_FEW,
  TOO_FEW_PREVIEW,
  bossIndex,
  presetOf,
} from "../src/scenarios/stars";
import type { WasmRuntime } from "../src/wasm/runtime";
import { testRuntime } from "./helpers/golden";

/** ``src`` 的 31 / C 的 32 位上限用的长序列（35 个观测值）。 */
const LONG_SEQ =
  Array.from({ length: 15 }, (_, i) => String(i)).join(",") +
  "," +
  Array.from({ length: 20 }, (_, i) => String(i)).join(",");

const TOO_LONG_SEQ = Array.from({ length: 33 }, (_, i) => String(i % 10)).join(",");

/** 「保存游戏」的正例：``1207965724 / 0x80000000 * 100000`` 的 ``repr``。 */
const RAW_TEXT = "56250.287406146526";
const RAW_RANDOM_INT = 1207965724;

/** 已注册的那个 ``stars`` 实例（顺带把类型收窄到具体类，好调 ``planOf``）。 */
function stars(): StarsScenario {
  const scenario = getScenario(KEY);
  if (!(scenario instanceof StarsScenario)) {
    throw new Error(`stars 注册的不是 StarsScenario：${scenario.constructor.name}`);
  }
  return scenario;
}

/**
 * 按 schema 默认值组一份七星输入（= Python ``_inputs``）。
 *
 * ⚠️ ``stars`` 的 schema **有** ``start_seed``，所以这里塞进去 ——
 * 少了它 ``scenario_runs`` 的漂移哨兵会对不上。
 */
function mkStars(
  preset = DEFAULT_PRESET,
  sequence: string | readonly number[] = "",
  start = 0,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...stars().schema().defaults(),
    preset,
    sequence,
    start_seed: start,
    ...extra,
  };
}

/** 随机整数 → 「保存游戏」的显示值原文（= 原始浮点 × 100000）。 */
function saveGameText(randomInt: number): string {
  return String((randomInt / CONSTS.stars.save_game_half) * CONSTS.stars.save_game_scale);
}

/** 把一个 wasm 后端包成场景层的 ``Runtime``。 */
function runtimeOf(rt: WasmRuntime): Runtime {
  return Runtime.resolve(rt);
}

// =========================================================================== 1 合约层
describe("注册表与表单", () => {
  it("stars 已经注册", () => {
    expect([...registeredKeys()]).toContain(KEY);
  });

  it("schema 的键序是 start_seed → parallel → preset → sequence", () => {
    const schema = stars().schema();
    // 「并行枚举」紧跟在起始值后面：枚举全部 = 起始值留空，开关就在它旁边。
    expect([...schema.keys]).toEqual(["start_seed", "parallel", "preset", "sequence"]);
  });

  it("preset 的可选项就是 PRESET_NAMES，默认第一项", () => {
    const schema = stars().schema();
    const preset = schema.get("preset");
    expect(preset).not.toBeNull();
    expect([...(preset as NonNullable<typeof preset>).choices]).toEqual([...PRESET_NAMES]);
    expect((preset as NonNullable<typeof preset>).default).toBe(PRESET_NAMES[0]);
  });

  it("start_seed 留空 = 没有起始值（不是 0）", () => {
    const field = stars().schema().get("start_seed");
    expect(field).not.toBeNull();
    const f = field as NonNullable<typeof field>;
    // 0 不在种子迭代循环内（``fastNext(0) === 0``），摆个 0 在框里会让人
    // 误以为「从 0 开始搜」是有效输入。
    expect(f.default).toBeNull();
    expect(f.min).toBe(1);
    expect(f.max).toBe(KMAX);
    expect(f.required).toBe(false);
  });

  it("parallel 是「输入」组里的布尔开关", () => {
    const field = stars().schema().get("parallel");
    const f = field as NonNullable<typeof field>;
    expect(f.kind).toBe("bool");
    expect(f.group).toBe("输入");
    expect(f.default).toBe(true);
  });

  it("describe() 的 7 个键", () => {
    const info = stars().describe();
    expect(Object.keys(info).sort()).toEqual(
      ["hint", "key", "label", "schema", "spec_kind", "supports_near", "version"].sort(),
    );
    expect(info.key).toBe(KEY);
    expect(info.label).toBe("种子搜索器");
    expect(info.spec_kind).toBe("mask");
    expect(info.supports_near).toBe(true);
  });

  it("nearLimit 就是 seedDistance 的上限", () => {
    expect(stars().nearLimit).toBe(DISTANCE_LIMIT);
    expect(stars().nearLimit).toBe(9_999_999);
  });

  it("schema() 的 fieldHints 是空表（stars 没有动态展示值）", () => {
    expect(stars().fieldHints(mkStars())).toEqual({});
  });
});

describe("常量（const/stars.py）", () => {
  it("5 个预设的顺序与参数与 src 一致", () => {
    const table: Record<string, readonly [string, number, number, number, number]> = {};
    for (const p of PRESETS) {
      table[p.name] = [p.mode, p.minimum, p.span, p.random_pos, p.step];
    }
    expect(table).toEqual({
      斗部群星: ["dbqx", 0, 3, 3, 3],
      "还童丹-四围固定": ["round", 0, 100, 1, 5],
      "还童丹-四围浮动": ["round", 0, 100, 1, 9],
      宠物铠甲强化: ["round", 1, 4, 1, 6],
      保存游戏: ["raw", 0, 0x7fffffff, 2, 2],
    });
    expect(PRESET_NAMES[0]).toBe(DEFAULT_PRESET);
    expect(DEFAULT_PRESET).toBe("斗部群星");
  });

  it("保存游戏是 stars 的一个预设，不是独立场景", () => {
    expect([...PRESET_NAMES]).toContain(SAVE_GAME_PRESET);
    expect(presetOf(SAVE_GAME_PRESET).mode).toBe(RAW_MODE);
  });

  it("presetOf 取参数、报未知名", () => {
    expect(presetOf("宠物铠甲强化").step).toBe(6);
    expect(presetOf("宠物铠甲强化").random_pos).toBe(1);
    expect(presetOf("宠物铠甲强化").random_pos).toBe(1);
    expect(() => presetOf("不存在的预设")).toThrowError();
  });

  it("模式表齐全（DBQX / RAW 都在 ENUM_MODES 之外或之内）", () => {
    expect(DBQX_MODE).toBe("dbqx");
    expect(RAW_MODE).toBe("raw");
    expect([...ENUM_MODES].sort()).toEqual(["dbqx", "round", "t"]);
    expect(ENUM_MODES.has(RAW_MODE)).toBe(false);
  });

  it("驱动常量", () => {
    expect(DBQX_VALUE_STEP).toBe(0x20000000);
    expect(FASTCRACK_IMASK).toBe(0x60000000);
    expect(CRACK2_MAX_SPAN).toBe(20);
    expect(MAX_CONSTRAINTS).toBe(31);
    expect([...BOSS_BY_INDEX]).toEqual(["翁", "猿", "车", "官"]);
  });

  it("bossIndex 认简称也认序号", () => {
    const ok: readonly [unknown, number][] = [
      ["翁", 0],
      ["猿", 1],
      ["车", 2],
      ["官", 3],
      ["0", 0],
      [3, 3],
      [" 2 ", 2],
    ];
    for (const [value, expected] of ok) {
      expect(bossIndex(value), pyRepr(value)).toBe(expected);
    }
  });

  it("bossIndex 拒绝越界与乱码", () => {
    for (const value of ["4", "-1", "翁翁", "", null] as const) {
      expect(() => bossIndex(value), pyRepr(value)).toThrowError();
    }
  });

  it("dbqx 等值目标 = i * 0x20000000", () => {
    expect([...dbqxEqualityValues([0, 1, 2, 3])]).toEqual([
      0x00000000, 0x20000000, 0x40000000, 0x60000000,
    ]);
    // imask 只留第 29~30 位 → 四个 boss 互不重叠。
    const masked = dbqxEqualityValues([0, 1, 2, 3]).map((v) => v & FASTCRACK_IMASK);
    expect(new Set(masked).size).toBe(4);
    // 目标值本身就在保留位上 → 抹掉低位不影响比较。
    expect(dbqxEqualityValues([0, 1, 2, 3]).every((v) => (v & FASTCRACK_IMASK) === v)).toBe(true);
  });

  it("掩码路线的 u32Bounds：min = 目标值，max 无意义但必须是 M32", () => {
    const values = dbqxEqualityValues([0, 1, 2, 3]);
    const spec = MaskSpec.fromValues(values, FASTCRACK_IMASK, 3);
    expect([...spec.u32Bounds]).toEqual(values.map((v) => ({ lo: v, hi: M32 })));
  });

  it("区间路线每边比掩码路线宽一格（num_parser 的外扩）", () => {
    const s = DBQX_VALUE_STEP;
    const out = uintBeforeTruncation([0, 1, 2, 3], 0, 3);
    expect(Array.isArray(out)).toBe(true);
    const pairs = (out as readonly (readonly [number, number])[]).map(([lo, hi]) => [lo, hi]);
    expect(pairs).toEqual([
      [0, s + 1],
      [s - 1, 2 * s + 1],
      [2 * s - 1, 3 * s + 1],
      [3 * s - 1, KMAX],
    ]);
    // 每个桶都盖住自己的掩码目标 → 区间路线是掩码路线的超集。
    expect(pairs.every((p, i) => (p[0] as number) <= i * s && i * s <= (p[1] as number))).toBe(true);
    // 交界处重叠 3 个值（2^31 里共 9 个）—— 两条路线只在这里会分叉。
    expect([0, 1, 2].map((i) => (pairs[i] as number[])[1]! - (pairs[i + 1] as number[])[0]!)).toEqual([
      2, 2, 2,
    ]);
  });

  it("scannerFor：r < 20 用 crack2", () => {
    const rows: readonly [number, string][] = [
      [3, "crack2"],
      [4, "crack2"],
      [9, "crack2"],
      [19, "crack2"],
      [20, "crack"],
      [100, "crack"],
    ];
    for (const [span, scanner] of rows) {
      expect(scannerFor(span), String(span)).toBe(scanner);
    }
  });

  it("advanceAfterMatch：raw 只有尾巴，其余还乘长度", () => {
    const rows: readonly [string, number, number, number, number][] = [
      ["raw", 2, 2, 2, 0],
      ["raw", 1, 2, 2, 0],
      ["dbqx", 1, 3, 3, 0],
      ["dbqx", 2, 3, 3, 3],
      ["dbqx", 8, 3, 3, 21],
      ["round", 4, 1, 6, 23],
      ["round", 0, 1, 6, 5],
    ];
    for (const [mode, len, pos, step, expected] of rows) {
      expect(advanceAfterMatch(mode, len, pos, step), `${mode}/${len}`).toBe(expected);
    }
  });

  it("rawSequence 只留末尾 1 或 2 个数", () => {
    expect([...rawSequence([1, 2, 3], 0)]).toEqual([2, 3]);
    expect([...rawSequence([1, 2, 3], 12345)]).toEqual([3]);
    expect([...rawSequence([7], 0)]).toEqual([7]);
  });

  it("saveGameValue 换算与报错", () => {
    expect(saveGameValue("12345.678")).toBe(Math.trunc((12345.678 / 100000) * 0x80000000));
    expect(saveGameValue(" 0 ")).toBe(0);
    expect(saveGameValue(RAW_TEXT)).toBe(RAW_RANDOM_INT);
    expect(() => saveGameValue("abc")).toThrowError();
    // 换算后越过 31 位 —— src 的 C 侧那侧永远搜不到，契约层直接拦。
    expect(() => saveGameValue("100000")).toThrowError();
  });

  it("显示值往返无损（双精度够宽）", () => {
    for (const value of [0, 1, 12345, 1207959940, 2013265918, KMAX]) {
      expect(saveGameValue(saveGameText(value)), String(value)).toBe(value);
    }
    expect(saveGameText(RAW_RANDOM_INT)).toBe(RAW_TEXT);
  });
});

describe("planOf 的分支判定", () => {
  it("五个预设 × 有没有起始值 = 9 种情形", () => {
    const rows: readonly [
      string, string, number, boolean, boolean, boolean, boolean, string,
    ][] = [
      ["斗部群星", "翁,猿", 0, false, true, false, false, "crack2"],
      ["斗部群星", "翁,猿", 12345, true, false, true, false, "crack2"],
      ["还童丹-四围固定", "0,0,3,1,0", 0, false, true, false, false, "crack"],
      ["还童丹-四围固定", "0,0,3,1,0", 12345, true, false, false, false, "crack"],
      // 还童丹两个预设的 r 都是 100 → 一律 crack（≥20 用不了 crack2）。
      ["还童丹-四围浮动", "0,1,2", 0, false, true, false, false, "crack"],
      ["宠物铠甲强化", "1,2,3,4", 0, false, true, false, false, "crack2"],
      ["宠物铠甲强化", "1,2,3,4", 12345, true, false, false, false, "crack2"],
      ["保存游戏", "1234.5,6789.1", 0, false, false, false, true, "crack"],
      ["保存游戏", "1234.5,6789.1", 12345, true, false, true, true, "crack"],
    ];
    for (const [preset, text, start, local, enumerating, truncating, raw, scanner] of rows) {
      const plan = stars().planOf(mkStars(preset, text, start));
      const label = `${preset}/${start}`;
      expect(plan.presetName, label).toBe(preset);
      expect([plan.local, plan.enumerating, plan.truncating, plan.raw], label).toEqual([
        local,
        enumerating,
        truncating,
        raw,
      ]);
      expect(plan.scanner, label).toBe(scanner);
      expect(plan.notes.filter((n) => n.isError), label).toEqual([]);
    }
  });

  it("sequence 长度与 advance / consume", () => {
    const rows: readonly [string, string, number, number, number][] = [
      ["斗部群星", "翁", 0, 1, 0],
      ["斗部群星", "翁,猿", 0, 2, 3],
      ["斗部群星", "翁,猿,车,官,翁,猿,车,官", 12345, 8, 21],
      ["宠物铠甲强化", "1,2,3,4", 12345, 4, 23],
      ["还童丹-四围固定", "0,0,3,1,0", 0, 5, 24],
      // (9-1)*9 + (9-1) = 80
      ["还童丹-四围浮动", "0,0,3,1,0,2,3,4,1", 987654321, 9, 80],
      ["还童丹-四围浮动", "0,0,3,1,0", 12345, 5, 44],
      ["保存游戏", "1234.5,6789.1", 0, 2, 0],
      ["保存游戏", "1234.5,6789.1", 12345, 1, 0],
    ];
    for (const [preset, text, start, length, advance] of rows) {
      const plan = stars().planOf(mkStars(preset, text, start));
      const label = `${preset}/${start}`;
      expect(plan.length, label).toBe(length);
      expect(plan.advance, label).toBe(advance);
      expect(plan.consume, label).toBe(advance);
    }
  });

  it("两张路线的区间表确实不同（同一预设）", () => {
    // 枚举分支走 round，局部分支走 t —— 这是 src 的原样。
    const enumPlan = stars().planOf(mkStars("斗部群星", "翁,猿", 0));
    const localPlan = stars().planOf(mkStars("斗部群星", "翁,猿", 12345));
    expect(enumPlan.truncating).toBe(false);
    expect(localPlan.truncating).toBe(true);
    expect(enumPlan.pairs).not.toEqual(localPlan.pairs);
  });

  it("局部搜索的区间来自 uintBeforeRound（还童丹）", () => {
    const plan = stars().planOf(mkStars("还童丹-四围固定", "0,0,3,1,0", 12345));
    expect(plan.pairs.length).toBe(5);
    expect(plan.pairs.every(([lo, hi]) => lo <= hi)).toBe(true);
    expect([...plan.pairs[0]!]).toEqual([0, 10737419]);
    const direct = uintBeforeRound([0], 0, 100) as readonly (readonly [number, number])[];
    expect([...plan.pairs[0]!]).toEqual([...(direct[0] as readonly [number, number])]);
  });

  it("用户手点的那 20 次能原样解析（notes/test_seed.py）", () => {
    const text = "1,0,0,3,0,3,1,0,2,1,2,0,1,0,3,1,1,0,0,1";
    const expected = [1, 0, 0, 3, 0, 3, 1, 0, 2, 1, 2, 0, 1, 0, 3, 1, 1, 0, 0, 1];
    const local = stars().planOf(mkStars("斗部群星", text, 12345));
    expect([...local.sequence]).toEqual(expected);
    const direct = uintBeforeTruncation(expected, 0, 3) as readonly (readonly [number, number])[];
    expect(local.pairs.map(([lo, hi]) => [lo, hi])).toEqual(direct.map(([lo, hi]) => [lo, hi]));
    // 没有起始值 → 拿 boss 序号算掩码目标（不看 n/r）。
    const en = stars().planOf(mkStars("斗部群星", text, 0));
    expect([...en.equalityValues]).toEqual([...dbqxEqualityValues(expected)]);
  });

  it("局部搜索只取前 31 个区间，但 length 用真实长度", () => {
    const plan = stars().planOf(mkStars("还童丹-四围浮动", LONG_SEQ, 12345));
    expect(plan.pairs.length).toBe(MAX_CONSTRAINTS);
    expect(plan.pairs.length).toBe(31);
    expect(plan.length).toBe(35);
    expect(plan.notes.some((n) => n.message.includes("31"))).toBe(true);
  });

  it("枚举分支超过 32 个观测值直接报错（C 的 max_input）", () => {
    const plan = stars().planOf(mkStars("还童丹-四围浮动", TOO_LONG_SEQ, 0));
    expect(plan.notes.some((n) => n.message.includes("最多 32"))).toBe(true);
    expect(plan.notes.some((n) => n.isError)).toBe(true);
  });

  it("raw 只用末尾 1 / 2 个数", () => {
    const sc = stars();
    const two = sc.planOf(mkStars("保存游戏", "1.1,2.2,3.3", 0));
    expect([...two.sequence]).toEqual([saveGameValue("2.2"), saveGameValue("3.3")]);
    expect(two.randomInt).toBe(saveGameValue("2.2"));
    expect(two.target).toBe(saveGameValue("3.3"));

    const one = sc.planOf(mkStars("保存游戏", "1.1,2.2,3.3", 12345));
    expect([...one.sequence]).toEqual([saveGameValue("3.3")]);
    expect(one.randomInt).toBe(saveGameValue("3.3"));
    expect(one.target).toBe(0); // arg2 缺省就是 0

    const raw = sc.planOf(mkStars("保存游戏", "1.2,345.6", 0));
    expect(raw.pairs.length).toBe(1);
    expect([...(raw.pairs[0] as readonly [number, number])]).toEqual([raw.target, raw.target]);
    expect(raw.target).not.toBe(0);
    expect(raw.randomInt).toBe(saveGameValue("1.2"));
  });

  it("坏输入都记成 error，且 prepare 会拦下来", () => {
    const rows: readonly [string, string][] = [
      ["斗部群星", ""],
      ["斗部群星", "翁,赵"],
      ["斗部群星", "4"],
      ["还童丹-四围固定", "101"], // 0±100 之外
      ["还童丹-四围固定", "abc"],
      ["宠物铠甲强化", "-4"], // 1±4 之外
      ["保存游戏", ""],
      ["保存游戏", "abc"],
      ["保存游戏", "200000"], // 换算后越界
    ];
    for (const [preset, text] of rows) {
      const label = `${preset}/${text}`;
      const inputs = mkStars(preset, text);
      expect(stars().validate(inputs).some((n) => n.isError), label).toBe(true);
      expect(() => stars().prepare(inputs, 0), label).toThrowError(ScenarioError);
    }
  });

  it("未知预设是错误", () => {
    expect(stars().validate(mkStars("不存在", "翁")).some((n) => n.isError)).toBe(true);
  });

  it("start_seed 参数优先于表单，且会被夹到 31 位", () => {
    const sc = stars();
    expect(sc.planOf(mkStars("斗部群星", "翁,猿", 12345)).userSeed).toBe(12345);
    expect(sc.planOf(mkStars("斗部群星", "翁,猿", 12345), 0).userSeed).toBe(0);
    expect(sc.planOf(mkStars("斗部群星", "翁,猿", 0), 0xffffffff).userSeed).toBe(KMAX);
  });

  it("负的起始值当 0（= 没有起始值）", () => {
    expect(stars().planOf(mkStars("斗部群星", "翁,猿", -5)).userSeed).toBe(0);
  });

  it("StarsPlan 的字段是冻结的", () => {
    const plan = stars().planOf(mkStars("斗部群星", "翁,猿", 12345));
    expect(Object.isFrozen(plan.sequence)).toBe(true);
    expect(Object.isFrozen(plan.pairs)).toBe(true);
    expect(plan instanceof StarsPlan).toBe(true);
  });
});

describe("buildSpec 的形态", () => {
  it("斗部群星枚举 → MaskSpec（等值 + 掩码）", () => {
    const spec = stars().buildSpec(mkStars("斗部群星", "翁,猿,车", 0), 0);
    expect(spec).toBeInstanceOf(MaskSpec);
    const mask = spec as MaskSpec;
    expect(mask.imask).toBe(FASTCRACK_IMASK);
    expect(mask.step).toBe(3);
    expect([...mask.u32Bounds]).toEqual([
      { lo: 0x00000000, hi: M32 },
      { lo: 0x20000000, hi: M32 },
      { lo: 0x40000000, hi: M32 },
    ]);
  });

  it("斗部群星有起始值 → IntervalSpec（不是掩码）", () => {
    const spec = stars().buildSpec(mkStars("斗部群星", "翁,猿", 111), 111);
    expect(spec).toBeInstanceOf(IntervalSpec);
    const interval = spec as IntervalSpec;
    expect(interval.scanner).toBe("crack");
    expect(interval.step).toBe(3);
  });

  it("其余预设的区间变体（step 与 scanner）", () => {
    const rows: readonly [string, string, number, number, string][] = [
      ["还童丹-四围固定", "0,0,3,1,0", 0, 5, "crack"],
      ["还童丹-四围浮动", "0,0,3,1,0", 0, 9, "crack"],
      ["宠物铠甲强化", "1,2,3,4", 0, 6, "crack2"],
      ["宠物铠甲强化", "1,2,3,4", 12345, 6, "crack"],
    ];
    for (const [preset, text, start, step, scanner] of rows) {
      const spec = stars().buildSpec(mkStars(preset, text, start), start);
      expect(spec, `${preset}/${start}`).toBeInstanceOf(IntervalSpec);
      expect((spec as IntervalSpec).step, `${preset}/${start}`).toBe(step);
      expect((spec as IntervalSpec).scanner, `${preset}/${start}`).toBe(scanner);
    }
  });

  it("保存游戏 → 单点区间、step = 1", () => {
    const inputs = mkStars("保存游戏", `${RAW_TEXT},1.2`, 0);
    const plan = stars().planOf(inputs);
    expect(plan.randomInt).toBe(RAW_RANDOM_INT);
    expect(plan.target).toBe(saveGameValue("1.2"));
    const spec = stars().buildSpec(inputs, 0) as IntervalSpec;
    expect(spec).toBeInstanceOf(IntervalSpec);
    expect(spec.step).toBe(1);
    const first = spec.constraints[0];
    if (!(first instanceof IntervalConstraint)) {
      throw new Error("raw 的约束应当是 IntervalConstraint");
    }
    expect(first.lo).toBe(plan.target);
    expect(first.hi).toBe(plan.target);
  });

  it("未知预设 + 有起始值也能构造出 spec（回落到默认预设）", () => {
    const spec: SeedSpec = stars().buildSpec(mkStars("不存在", "翁,猿", 12345), 12345);
    expect(spec).toBeInstanceOf(IntervalSpec);
  });
});

describe("机制：随机消耗与 near 的自洽", () => {
  it("搜索起点就是起始值本身，不再往前推", () => {
    const sc = stars();
    expect(sc.advanceCount(mkStars("斗部群星", "翁,猿", 111))).toBe(0);
    // seedFindbyRange 自己会退 step 步。
    expect(sc.randomConsumption(mkStars("斗部群星", "翁,猿,车", 0))).toBe(6);
  });

  it("searchSeed 原样返回（不推进）", () => {
    const sc = stars();
    // 不给后端也要能算 —— 这一步根本不碰后端，用的是 ``Math.trunc``。
    expect(sc.searchSeed(12345, mkStars(), null as unknown as Runtime)).toBe(12345);
  });

  it("并行开关只翻 preferParallel", () => {
    expect(stars().searchOptions(mkStars("斗部群星", "翁,猿", 0))).toEqual({
      preferParallel: true,
    });
    expect(
      stars().searchOptions(mkStars("斗部群星", "翁,猿", 0, { parallel: false })),
    ).toEqual({});
  });

  it("near 与「有没有起始值」矛盾时直接报错（在后端之前）", async () => {
    const sc = stars();
    const rows: readonly [string, string, number, boolean][] = [
      ["斗部群星", "翁,猿", 12345, false], // 有起始值 → 不能全枚举
      ["还童丹-四围固定", "0,0,3,1,0", 12345, false],
      ["斗部群星", "翁,猿", 0, true], // 没起始值 → 只能枚举
      ["宠物铠甲强化", "1,2,3,4", 0, true],
    ];
    for (const [preset, text, start, near] of rows) {
      // 不给后端也要抛 —— 说明检查发生在 Runtime.resolve 之前。
      await expect(
        sc.run(mkStars(preset, text, start), start, { near }),
        `${preset}/${start}`,
      ).rejects.toThrowError(ScenarioError);
    }
  });
});

// =========================================================================== 3 golden 层
/** ``(preset, text, start, seed, seedAfter, distance, advance)`` */
const GOLDEN_LOCAL: readonly [string, string, number, number, number, number, number][] = [
  ["斗部群星", "翁,猿,车,官,翁,猿,车,官", 12345, 604229498, 249189408, 4111, 21],
  ["斗部群星", "猿,车,官", 987654321, 200941459, 586147966, 144, 6],
  ["斗部群星", "0,1", 1, 144, 18, 27, 3],
  ["宠物铠甲强化", "1,2,3,4", 12345, 808473803, 912151040, 239, 23],
];

/** 局部搜索搜不到（区间太窄或压根对不上）。 */
const GOLDEN_NO_HIT: readonly [string, string, number][] = [
  ["还童丹-四围固定", "0,0,3,1,0", 12345],
  ["还童丹-四围固定", "0,0,3,1,0,2,3,4,1", 987654321],
];

describe("golden 层：局部搜索逐字段一致", () => {
  let rt: WasmRuntime;
  beforeAll(async () => {
    rt = await testRuntime();
  });

  for (const [preset, text, start, seed, after, distance, advance] of GOLDEN_LOCAL) {
    it(`${preset}：${text}（start=${start}）`, async () => {
      const out = await stars().run(mkStars(preset, text, start), start, { backend: rt });
      expect([out.seed, out.seedAfter, out.distance]).toEqual([seed, after, distance]);
      expect(out.needConsume).toBe(distance - 1 - advance);
      expect(out.consume).toBe(advance);
      expect(out.preview).toBe(`距离: ${distance || "-"}\n结果: ${after}`);
      expect(out.extra["preset"]).toBe(preset);
      expect(out.extra["advance"]).toBe(advance);
      expect(out.extra["result_int"]).toBe(after);
    });
  }

  for (const [preset, text, start] of GOLDEN_NO_HIT) {
    it(`搜不到：${preset}（start=${start}）`, async () => {
      const out = await stars().run(mkStars(preset, text, start), start, { backend: rt });
      expect([out.seed, out.seedAfter, out.distance, out.needConsume]).toEqual([0, 0, 0, -1]);
      expect([...out.seeds]).toEqual([]);
      expect(out.preview).toBe(NO_HIT_PREVIEW);
      expect(out.notes.some((n) => n.message.includes("没有搜到任何种子"))).toBe(true);
    });
  }

  it("preview 与 run 的结论一致", () => {
    const inputs = mkStars("斗部群星", "翁,猿,车,官,翁,猿,车,官", 12345);
    const runtime = runtimeOf(rt);
    expect(stars().preview(604229498, inputs, runtime)).toBe("距离: 4111\n结果: 249189408");
    expect(stars().preview(0, inputs, runtime)).toBe(NO_HIT_PREVIEW);
  });

  it("保存游戏正例：显示值 → 反查 → 唯一解", async () => {
    expect(saveGameValue(RAW_TEXT)).toBe(RAW_RANDOM_INT);
    const out = await stars().run(mkStars("保存游戏", RAW_TEXT, 1779036211), 1779036211, {
      backend: rt,
    });
    expect(out.seed).toBe(1779036211);
    expect(out.seedAfter).toBe(1779036211); // raw 的 advance 是 0
    expect(out.distance).toBe(0); // src 显示 '-'
    expect(out.extra["mode"]).toBe(RAW_MODE);
    expect(out.notes.filter((n) => n.isError)).toEqual([]);
  });

  it("随手编的显示值反查不到（无解就是无解）", async () => {
    const rows: readonly [string, number][] = [
      ["12345.678", 0],
      ["1234.5,6789.1", 0],
      ["1234.5,6789.1", 12345],
      ["9999.9999,1.2,345.6", 987654321],
    ];
    for (const [text, start] of rows) {
      const out = await stars().run(mkStars("保存游戏", text, start), start, { backend: rt });
      const label = `${text}/${start}`;
      expect(out.seed, label).toBe(0);
      expect(out.preview, label).toBe(NO_HIT_PREVIEW);
      expect(
        out.notes.some(
          (n) =>
            n.message.includes("反查不到") ||
            n.message.includes("筛选条件") ||
            n.message.includes("唯一确定"),
        ),
        label,
      ).toBe(true);
    }
  });

  it("枚举分支多解时的哨兵：seed = 0 + TOO_FEW + 专门的预览文案", () => {
    // 直接喂一个人造结果 —— 真跑 ``fastCrack`` 一次要十几秒，而这里要测的
    // 只是 ``_seed_of`` 拿到「多个命中」时走哪条分支。
    const inputs = mkStars("斗部群星", "翁", 0);
    const result = new SearchResult({
      seeds: [11, 22, 33],
      head: 11,
      nearest: null,
      distance: null,
      backend: "test",
    });
    const out = stars().interpret(result, inputs, 0, runtimeOf(rt));
    expect(out.seed).toBe(0);
    expect([out.distance, out.needConsume]).toEqual([0, -1]);
    expect([...out.seeds]).toEqual([11, 22, 33]);
    expect(out.preview).toBe(TOO_FEW_PREVIEW);
    expect(out.notes.map((n) => n.message)).toEqual([
      TOO_FEW,
      "共 3 个候选种子已随结果返回",
    ]);
    expect(out.notes.every((n) => n.field === "sequence")).toBe(true);
  });

  it("枚举分支只有唯一解时才认（一个种子就够）", () => {
    const result = new SearchResult({
      seeds: [4242],
      head: 4242,
      nearest: null,
      distance: null,
      backend: "test",
    });
    const inputs = mkStars("斗部群星", "翁,猿", 0);
    const plan = stars().planOf(inputs);
    const out = stars().interpret(result, inputs, 0, runtimeOf(rt));
    expect(plan.advance).toBe(3);
    expect(out.seed).toBe(4242);
    // 没有起始值 → distance 一律 0（src 显示 '-'），也躲开从 0 出发的 1e7 空转
    expect(out.distance).toBe(0);
    expect(out.consume).toBe(plan.advance);
    expect(out.seedAfter).toBe(rt.engine.fastNextK(4242, 3));
    expect(out.preview).toBe(`距离: -\n结果: ${out.seedAfter}`);
    expect(out.notes).toEqual([]);
  });

  it("局部搜索分支的哨兵：nearest 为空 = 没搜到", () => {
    const result = new SearchResult({
      seeds: [],
      head: 0,
      nearest: null,
      distance: null,
      backend: "test",
    });
    const out = stars().interpret(
      result,
      mkStars("斗部群星", "翁,猿", 12345),
      12345,
      runtimeOf(rt),
    );
    expect([out.seed, out.distance, out.needConsume]).toEqual([0, 0, -1]);
    expect(out.preview).toBe(NO_HIT_PREVIEW);
    expect(out.notes.map((n) => n.message)).toEqual(["没有搜到任何种子"]);
    expect(out.notes[0]?.field).toBe("start_seed");
  });

  it("rt = null 时 interpret 只给占位（不测距、不预览）", () => {
    const result = new SearchResult({
      seeds: [1, 2],
      head: 1,
      nearest: null,
      distance: null,
      backend: "test",
    });
    const out = stars().interpret(result, mkStars("斗部群星", "翁", 0), 0, null);
    expect(out.seed).toBe(0);
    expect(out.preview).toBe("");
    expect(out.extra).toEqual({ preset: DEFAULT_PRESET, mode: DBQX_MODE });
    expect(out.notes.map((n) => n.message)).toEqual([
      TOO_FEW,
      "共 2 个候选种子已随结果返回",
    ]);
  });

  it("未命中种子的预览文案分两种：搜不到 vs 输入太少", () => {
    expect(NO_HIT_PREVIEW).toBe("距离: -\n结果: -");
    expect(TOO_FEW_PREVIEW).toBe(`距离: -\n结果: -（${TOO_FEW}）`);
    expect(TOO_FEW).toBe("输入太少, 未找到唯一种子，请增加输入");
  });

  it("InputSchema.fromDict 能吃下自己的 describe()", () => {
    const info = stars().describe();
    const round = InputSchema.fromDict(info.schema);
    expect(round.keys).toEqual(stars().schema().keys);
  });

  it("Note.toDict / fromDict 往返", () => {
    const note = new Note({ level: "error", message: "x", field: "sequence" });
    expect(Note.fromDict(note.toDict()).toDict()).toEqual(note.toDict());
  });
});
