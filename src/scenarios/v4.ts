/**
 * M2-11：法宝「属性重置」（``v4-reforge``）。
 *
 * 逐行对照 ``src_forge/gameInfo/v4.py`` + ``src_forge/const/wuxing.py``。
 *
 * 游戏侧的权威实现在 ``Game Scripts/my/AllEquipment.as``：
 *
 * ```text
 * refreshSutraAttribute(sutra)        # ≈ L4485
 * initRondomPro()                     # L2739
 *
 * if getEUpdata() < 2.5:              # 成长没满才动成长
 *     rand = Math.ceil(random() * 3)  # 第 1 抽：变化量 0..3（0.1 为单位）
 *     if random() <= 0.5:             # 第 2 抽：正负
 *         rand *= -1
 *     eup = clamp(eup + rand / 10, 0.8, 2.5)
 * # —— initRondomPro() ——
 * if random() < 0.91:                 # 第 3 抽
 *     wx = round(random() * 4)        # 第 4 抽
 * else:
 *     w1 = round(random() * 4)
 *     w2 = round(random() * 3)        # 第 5 抽
 *     wx = next_wuxing[w1][w2]
 * ```
 *
 * 所以每次候选吃 **4 或 5** 个随机数，而且**顺序敏感** —— 多抽或少抽一次就整体错位。
 * 本模块把它实现成「从起点沿 ``FastNext`` 单向前扫、返回第一个命中的候选」，
 * 见 :meth:`V4Scenario.search`。
 *
 * 关于「吃不吃成长那 2 次随机」
 * ----------------------------
 * 游戏里**只有一个动作**「属性重置」，分支完全看**这件法宝洗之前的成长**：
 * 未满 2.5 → 重算成长（吃 2 次）再洗五行；已满 2.5 → 原样写回成长、只洗五行。
 * 所以本场景只有一个物品（``属性重置``），外加一个 ``growth_state`` 字段让用户
 * 告诉我们那件法宝当前的成长状态 —— 计算器推不出「洗之前」的值：
 *
 * ```text
 * 未满 2.5 → 吃成长 2 次 + 五行 2~3 次 = 4~5 次
 * 已满 2.5 → 不吃成长（成长不变）+ 五行 2~3 次 = 2~3 次
 * ```
 *
 * ⚠️ **变化量恰好为 0 在游戏里不可达**：``Math.ceil(random() * 3) == 0`` 要求
 * ``staticRandom(seed) == 0``，即 ``seed * 71 & 0x7FFFFFFF == 0``，只有
 * ``seed == 0`` 成立，而 ``0`` 不在种子循环里（``FastNext(0) == 0`` 是不动点）。
 * 所以 :func:`parseDelta` 认得 ``"0"``（宽容），但 :meth:`V4Scenario.validate`
 * 会把它当 ``error`` 报出来 —— 与其扫满 999999 再报「没找到」，不如当场说清楚。
 *
 * 浮点上的两处讲究（最容易漂的地方）
 * ----------------------------------
 * * :func:`jsRound` = ``Math.floor(v + 0.5)``，对应游戏/C 侧的
 *   ``(v * k + 0x40000000) >> 31`` —— 和 Python 内置 ``round`` 的唯一差别就是
 *   「恰好 .5」时的方向。搜索是顺序敏感的，所以这里坚持跟游戏一致。
 * * :func:`pyRound1` 才是 Python 的 ``round(x, 1)``（**半值取偶**）。不能偷懒写
 *   ``Math.round(x * 10) / 10``，见那个函数的文档。
 */

import { pyFloat, pyRepr, pyRound1 } from "../core/fromValue";
import type { SearchContext } from "../core/search";
import { SearchResult } from "../core/search";
import { GROWTH_MAX_TENTHS, GROWTH_MIN_TENTHS, GrowthWuxingSpec } from "../core/spec";
import { WUXING_HAS } from "../core/values";
import { CONSTS, isRangePair, type EquipDict } from "../data/consts";
import type { WasmEngine } from "../wasm/engine";
import { register } from "./registry";
import {
  InputField,
  InputSchema,
  Note,
  Outcome,
  type Prepared,
  Runtime,
  Scenario,
  ScenarioError,
  getStr,
} from "./scenario";

export const KEY = "v4-reforge";

/** 成长属性名（``COMMON_ATTRS`` 的最后一个）。 */
export const GROWTH_ATTR = "成长";

/** 五行属性名（与 ``const/resolution.py::WUXING_ATTR`` 同一个字符串）。 */
export const WUXING_ATTR = "五行";

/**
 * 游戏里的软上限（``Game Scripts/my/AllEquipment.as::initRun`` 的 999999），
 * 与 ``src`` 的 ``findRefreshSutraAttribute`` 保持一致。
 */
export const SEARCH_LIMIT = 999_999;

/** 「没找到」时的预览（对应 ``findRefreshSutraAttribute`` 的 ``(0, 0, '无')``）。 */
export const NO_HIT_PREVIEW = `${GROWTH_ATTR}: -\n${WUXING_ATTR}: -`;

/**
 * ``v4-reforge`` 分类下的物品（顺序即 UI 下拉框顺序）。
 *
 * ⚠️ Python 的 ``V4_ITEMS = tuple(CRAFTABLE_EQUIPMENT["v4-reforge"])`` 用的是
 * **dict 插入顺序**，而 ``consts.json`` 是 ``export_json.py::_equipment_table()``
 * 的 ``for name in sorted(items)`` 产出的**字典序**。本分类只有 ``属性重置``
 * 一项，现在看不出差别；等做 ``weapons`` 那种多物品分类时要单独处理
 * （``runs.json`` 只存物品名不存索引，测试抓不到这个漂移）。
 */
export const V4_ITEMS: readonly string[] = Object.freeze(
  Object.keys(CONSTS.equipment[KEY] ?? {}),
);

/** 把 ``makingObject`` 里一条装备记录的「成长」读成 ``[lo, hi]``（不是区间就取那个数）。 */
function deltaRangeOf(equip: EquipDict): readonly [number, number] {
  const raw = equip[GROWTH_ATTR];
  if (raw !== undefined && isRangePair(raw)) return [Number(raw[0]), Number(raw[1])];
  const single = Number(raw ?? 0);
  return [single, single];
}

/**
 * 每个物品的默认成长**变化量**区间 —— 直接读 ``CONSTS.equipment``，
 * 不在这里抄数字（``属性重置`` 是 ``(-0.3, 0.3)``）。
 *
 * 用显式循环而不是 ``Object.fromEntries``：后者是 ES2019（Chrome 73），
 * 而 legacy 档要兼容 Chromium 70。顺带把「键顺序 = 源顺序」写死在这里，
 * 不依赖 ``Object.entries`` 之外的任何隐式行为（``runs.json`` 的回归比对对这个敏感）。
 */
export const V4_DELTA: Readonly<Record<string, readonly [number, number]>> = Object.freeze(
  (() => {
    const out: Record<string, readonly [number, number]> = {};
    for (const [name, data] of Object.entries(CONSTS.equipment[KEY] ?? {})) {
      out[name] = deltaRangeOf(data);
    }
    return out;
  })(),
);

/** ``growth_state`` 表单字段名。 */
export const STATE_FIELD = "growth_state";

/** 洗之前成长**未满** 2.5 —— 游戏重算成长（吃 2 次随机）再洗五行（默认）。 */
export const STATE_BELOW = "未满 2.5（重算成长）";

/**
 * 洗之前成长**已满** 2.5 —— 游戏跳过成长（成长不变），只洗五行。
 *
 * 注意这是**同一件装备、同一个「属性重置」按钮**，只是当前成长状态不同。
 */
export const STATE_FULL = "已满 2.5（只洗五行）";

/** ``growth_state`` 的可选值（顺序即 UI 下拉框顺序）。 */
export const GROWTH_STATES: readonly string[] = Object.freeze([STATE_BELOW, STATE_FULL]);

/**
 * 与 ``src/making_calc/parsing.py::parse_range`` 同一套分隔符
 * （**不含** ``-``，因为 ``-`` 是负号）。
 */
export const SPLIT_RE = /[,，|~·/、；;\s]+/;

// =========================================================================== 浮点
/**
 * JS ``Math.round`` / C 侧 ``(v * k + 0x40000000) >> 31`` 的等价物。
 *
 * 与 Python 内置 ``round`` 的唯一差别是「恰好 .5」时的方向（Python 取偶数）。
 * 搜索是顺序敏感的，所以这里坚持跟游戏一致。
 */
export function jsRound(value: number): number {
  return Math.floor(value + 0.5);
}

// ``pyRound1`` 曾经定义在这里，现在住在 ``core/fromValue.ts``（``pyRoundN(value, 1)``）——
// 装备预览（``scenarios/equipment.ts``）也要用它，而核心模块依赖场景模块是倒挂的。
// 这里原样再导出一次，别处 ``import { pyRound1 } from "../scenarios/v4"`` 照旧可用。
export { pyRound1 };

// =========================================================================== 解析
/**
 * ``"0.3"`` / ``"0.1~0.3"`` / ``"-0.3"`` → ``(lo, hi)``；解析不了返回 ``null``。
 *
 * 空串按 ``null`` 处理（调用方应该回落到物品默认值）。
 */
export function parseDelta(text: string): readonly [number, number] | null {
  // Python 的 ``.strip("()（）")`` 是「两端**各自**剥掉一串」，所以两端都要带全套括号。
  const body = text
    .trim()
    .replace(/^[()（）]+/, "")
    .replace(/[()（）]+$/, "");
  if (body === "") return null;
  const parts = body.split(SPLIT_RE).filter((p) => p !== "");
  const values: number[] = [];
  for (const part of parts) {
    const value = pyFloat(part);
    // ``inf`` / ``nan`` 这里**故意**当解析失败：Python 的 ``round(inf, 1)`` 会原样返回，
    // 于是区间变成 ``(inf, inf)``、永远不命中，用户要白白扫满 999999 才知道白搜。
    if (value === null || !Number.isFinite(value)) return null;
    values.push(value);
  }
  const first = values[0];
  if (first === undefined) return null;
  if (values.length === 1) {
    const value = pyRound1(first);
    return [value, value];
  }
  const second = values[1];
  if (values.length === 2 && second !== undefined) {
    const lo = pyRound1(first);
    const hi = pyRound1(second);
    return lo <= hi ? [lo, hi] : [hi, lo];
  }
  return null;
}

/** 一次候选的匹配结果：``(变化量, 五行掩码)``；变化量 ``null`` = 这次没吃成长随机。 */
export type V4Match = readonly [number | null, number];

/**
 * 在 ``seed`` 这个起点上试一次。
 *
 * 命中返回 ``(变化量, 五行掩码)``；不命中返回 ``null``。
 * **只读**，不改 ``seed``。
 */
export function matchCandidate(
  engine: WasmEngine,
  seed: number,
  spec: GrowthWuxingSpec,
): V4Match | null {
  let cursor = Math.trunc(seed);
  let delta: number | null = null;
  if (spec.grows) {
    const [first, afterFirst] = engine.randomValue(cursor);
    let steps = Math.ceil(first * 3); // 第 1 抽：变化量 0..3
    cursor = afterFirst;
    const [second, afterSecond] = engine.randomValue(cursor);
    if (second <= 0.5) steps = -steps; // 第 2 抽：正负
    cursor = afterSecond;
    // ``steps`` 只可能是 ``0..±3``，所以 ``steps / 10`` 已经是「最近的 double」，
    // ``pyRound1`` 在这里是恒等映射 —— 但写出来才对得上 Python 的 ``round(_, 1)``。
    delta = pyRound1(steps / 10);
    if (!(spec.growth[0] <= delta && delta <= spec.growth[1])) return null;
  }
  const [third, afterThird] = engine.randomValue(cursor);
  const [fourth, afterFourth] = engine.randomValue(afterThird);
  const wx1 = jsRound(fourth * 4);
  let wuxing = WUXING_HAS | (1 << wx1);
  if (third >= CONSTS.wuxing.double_at) {
    const [fifth] = engine.randomValue(afterFourth);
    const wx2 = jsRound(fifth * 3);
    wuxing |= 1 << (CONSTS.wuxing.next[wx1]?.[wx2] ?? wx1);
  }
  if ((wuxing & spec.targetWx) !== spec.targetWx) return null;
  return [delta, wuxing];
}

/** ``(变化量, 五行掩码)`` → 两行可读文本（没吃成长随机时写「不变」）。 */
export function formatPreview(delta: number | null, wuxing: number): string {
  // ``delta`` 只可能是 ``{0, ±0.1, ±0.2, ±0.3}``，所以 ``toFixed(1)`` 与 Python 的
  // ``f"{delta:+.1f}"`` 逐字一致（碰不到 ``toFixed`` 那种「半值向上」）。
  const growth = delta === null ? "不变" : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}`;
  return `${GROWTH_ATTR}: ${growth}\n${WUXING_ATTR}: ${maskToNames(wuxing)}`;
}

// =========================================================================== 五行
/**
 * ``"金火"`` → 掩码；非法或重复返回 ``null``。空串 / ``"无"`` / ``"_"`` / ``"-"`` → ``0``。
 *
 * 与 ``src/making_calc/parsing.py::parse_wuxing`` 等价。
 *
 * ⚠️ Python 那份还能接 ``int``（掩码直通）与序列；本函数只收字符串 —— 调用点
 * 全是 ``get_str(...)`` 的结果，多态分支译过来是死代码（同 ``seed_resolve.ts``
 * 不译 ``ValueInput.__bool__`` 的理由）。
 */
export function wuxingToMask(names: string): number | null {
  const text = names.trim();
  if (text === "" || text === "无" || text === "_" || text === "-") return 0;
  let mask = WUXING_HAS;
  let seen = 0;
  for (const ch of text) {
    if (ch === " " || ch === "、" || ch === "," || ch === "，" || ch === "|" || ch === "/" || ch === "+") {
      continue;
    }
    const bit = CONSTS.wuxing.bits[ch];
    if (bit === undefined) return null;
    const flag = 1 << bit;
    if ((seen & flag) !== 0) return null;
    seen |= flag;
    mask |= flag;
  }
  return mask;
}

/** 掩码 → ``"金火"``（无五行时返回 ``"无"``）。 */
export function maskToNames(mask: number): string {
  const value = Math.trunc(mask);
  if ((value & WUXING_HAS) === 0) return "无";
  const names = CONSTS.wuxing.names.filter((_name, index) => (value & (1 << index)) !== 0);
  return names.length > 0 ? names.join("") : "无";
}

/** ``mask & 0b11111`` 里置了几位。 */
function popcount5(value: number): number {
  let count = 0;
  for (let i = 0; i < 5; i++) {
    if ((value & (1 << i)) !== 0) count += 1;
  }
  return count;
}

// =========================================================================== 计划
export interface V4PlanInit {
  item: string;
  /** 洗之前成长是否没满（= 要不要吃成长那 2 次随机）。 */
  grows: boolean;
  /** 目标变化量区间（单位「成长」）。 */
  delta: readonly [number, number];
  /** 必须包含的五行位（``0`` 已被规范化成 ``WUXING_HAS``）。 */
  targetWx: number;
  limit: number;
}

/** 一次法宝洗练的搜索需求（用户输入 + 物品数据 → 全部中间量）。 */
export class V4Plan {
  readonly item: string;
  readonly grows: boolean;
  readonly delta: readonly [number, number];
  readonly targetWx: number;
  readonly limit: number;

  constructor(init: V4PlanInit) {
    this.item = init.item;
    this.grows = Boolean(init.grows);
    this.delta = Object.freeze([Number(init.delta[0]), Number(init.delta[1])]) as readonly [
      number,
      number,
    ];
    this.targetWx = Math.trunc(init.targetWx);
    this.limit = Math.trunc(init.limit);
  }

  get full(): boolean {
    return !this.grows;
  }

  get hasWuxing(): boolean {
    return this.targetWx !== 0;
  }
}

// =========================================================================== 场景
/**
 * 法宝洗练（只有一个动作：``属性重置``）。
 *
 * 与别的场景最大的不同：**它不可枚举**。匹配必须沿 ``FastNext`` 一步步往前走，
 * 而且每一步都要真抽几次随机数看结果 —— 没有哪种种子空间枚举能表达它。
 * 所以本场景直接重写 :meth:`search`，不走 ``rt.searcher``。
 *
 * ``near`` 参数被忽略（永远走这条单向前扫）；:attr:`nearLimit` 就是那个软上限
 * ``999999``。也因为没有枚举模式，``run()`` 用默认的 ``near=false`` 就对了
 * （``make_scenario_runs.py`` 从来不传 ``near``）。
 */
export class V4Scenario extends Scenario {
  override readonly key = KEY;
  override readonly label = "法宝洗练";
  override readonly version = "1.0";
  override readonly hint =
    "法宝洗练只有一个动作「属性重置」，每次候选吃 4 或 5 个随机数（成长 2 次 + 五行 2~3 次）。\n" +
    `成长变化量可达 ±0.1 / ±0.2 / ±0.3（0 不可达），最终值会被夹到 ` +
    `[${(GROWTH_MIN_TENTHS / 10).toFixed(1)}, ${(GROWTH_MAX_TENTHS / 10).toFixed(1)}]。\n` +
    "分支只看这件法宝洗之前的成长：未满 2.5 会重算成长（共 4~5 抽）；" +
    "已满 2.5 则成长不变、只洗五行（共 2~3 抽）。";

  override readonly specKind = "growth-wuxing";
  override readonly supportsNear = true;
  override readonly nearLimit = SEARCH_LIMIT;
  /** 不可枚举 —— ``null`` 表示「别指望 ``searchAll``」。 */
  override readonly sliceBounds: readonly [number, number] | null = null;

  // ------------------------------------------------------------------ 表单
  /** 下拉框里的物品名（``分类/物品``）。 */
  itemChoices(): readonly string[] {
    return V4_ITEMS.map((name) => `${KEY}/${name}`);
  }

  override schema(): InputSchema {
    return new InputSchema({
      fields: [
        new InputField({
          key: "item",
          label: "法宝",
          kind: "choice",
          default: this.itemChoices()[0],
          choices: this.itemChoices(),
          group: "法宝",
          help: "法宝洗练只有这一个动作；分支由下面的「成长状态」决定",
          width: 18,
        }),
        new InputField({
          key: STATE_FIELD,
          label: "成长状态",
          kind: "choice",
          default: STATE_BELOW,
          choices: GROWTH_STATES,
          group: "法宝",
          help: "这件法宝洗之前的成长：未满 2.5 会重算成长；已满 2.5 只洗五行",
          width: 18,
        }),
        new InputField({
          key: "growth",
          label: "成长变化量",
          kind: "text",
          default: "",
          group: "法宝",
          help: "可达 ±0.1 / ±0.2 / ±0.3（0 不可达）；留空 = 用物品默认值",
          width: 10,
        }),
        new InputField({
          key: "wuxing",
          label: "五行",
          kind: "text",
          default: "",
          group: "法宝",
          help: "最多 2 个字（如「金」「金火」）；留空 = 任意",
          width: 10,
        }),
        new InputField({
          key: "start_seed",
          label: "起始种子",
          kind: "int",
          // 0 不是合法种子（``FastNext(0) == 0``），所以默认留空 + 必填。
          default: null,
          min: 1,
          max: 0x7fffffff,
          required: true,
          group: "搜索",
          help: "游戏里当前的那个种子（1 ~ 2147483647）；留空会直接报错",
          width: 14,
        }),
      ],
      title: this.label,
      hint: this.hint,
    });
  }

  // ------------------------------------------------------------------ 解析
  /** 取 ``growth_state``；不认识就抛 :class:`ScenarioError`。 */
  growthStateOf(inputs: Readonly<Record<string, unknown>>): string {
    const state = getStr(inputs, STATE_FIELD, STATE_BELOW).trim() || STATE_BELOW;
    if (!GROWTH_STATES.includes(state)) {
      throw new ScenarioError(`成长状态 ${pyRepr(state)} 不认识（可选：${GROWTH_STATES.join("、")}）`);
    }
    return state;
  }

  /** 纯函数：表单 → :class:`V4Plan`。 */
  planOf(inputs: Readonly<Record<string, unknown>>): V4Plan {
    const item = getStr(inputs, "item", V4_ITEMS[0] ?? "");
    const name = item.substring(item.lastIndexOf("/") + 1);
    if (!V4_ITEMS.includes(name)) {
      throw new ScenarioError(`没有名为 ${pyRepr(item)} 的法宝（可选：${V4_ITEMS.join("、")}）`);
    }
    // 吃不吃成长那 2 次随机：只看这件法宝洗之前的成长状态。
    const grows = this.growthStateOf(inputs) !== STATE_FULL;
    const text = getStr(inputs, "growth", "").trim();
    let delta = text !== "" ? parseDelta(text) : null;
    if (delta === null) delta = V4_DELTA[name] ?? [0, 0];
    if (!grows) delta = [0.0, 0.0];
    const mask = wuxingToMask(getStr(inputs, "wuxing", "").trim());
    if (mask === null) {
      throw new ScenarioError(`五行 ${pyRepr(getStr(inputs, "wuxing", ""))} 里有非法或重复的字`);
    }
    return new V4Plan({
      item: name,
      grows,
      delta,
      targetWx: mask !== 0 ? mask : WUXING_HAS,
      limit: SEARCH_LIMIT,
    });
  }

  override validate(inputs: Readonly<Record<string, unknown>>): readonly Note[] {
    const notes: Note[] = [];
    const item = getStr(inputs, "item", V4_ITEMS[0] ?? "");
    const name = item.substring(item.lastIndexOf("/") + 1);
    if (!V4_ITEMS.includes(name)) {
      notes.push(
        new Note({
          level: "error",
          message: `没有名为 ${pyRepr(item)} 的法宝（可选：${V4_ITEMS.join("、")}）`,
          field: "item",
        }),
      );
      return notes;
    }
    const text = getStr(inputs, "growth", "").trim();
    let state: string;
    try {
      state = this.growthStateOf(inputs);
    } catch (exc) {
      notes.push(
        new Note({
          level: "error",
          message: exc instanceof Error ? exc.message : String(exc),
          field: STATE_FIELD,
        }),
      );
      state = STATE_BELOW;
    }
    // 洗之前成长已满 → 游戏跳过成长那 2 抽，变化量区间没有意义。
    const full = state === STATE_FULL;
    if (text !== "") {
      const delta = parseDelta(text);
      if (delta === null) {
        notes.push(
          new Note({
            level: "error",
            message: `成长变化量 ${pyRepr(text)} 解析不了（示例：0.3 / -0.3 / 0.1~0.3）`,
            field: "growth",
          }),
        );
      } else if (delta[0] === 0 && delta[1] === 0) {
        notes.push(
          new Note({
            level: "error",
            message:
              "成长变化量恰好 0 在游戏里不可达：Math.ceil(random() * 3) == 0 要求 " +
              "staticRandom == 0，而那要 seed == 0，0 不在种子循环里 —— " +
              "想筛「变化量 0」永远搜不到，请改成 ±0.1 / ±0.2 / ±0.3",
            field: "growth",
          }),
        );
      } else if (full) {
        notes.push(
          new Note({
            level: "error",
            message:
              `「${name}」在「${state}」下不重算成长（只洗五行），` +
              "给变化量区间没有任何意义；想筛变化量请选「未满 2.5」",
            field: "growth",
          }),
        );
      }
    }
    const wuxingText = getStr(inputs, "wuxing", "").trim();
    const mask = wuxingToMask(wuxingText);
    if (mask === null) {
      notes.push(
        new Note({
          level: "error",
          message: `五行 ${pyRepr(wuxingText)} 里有非法或重复的字`,
          field: "wuxing",
        }),
      );
    } else if (popcount5(mask & 0b11111) > 2) {
      notes.push(
        new Note({
          level: "error",
          message: "游戏最多只会给 2 个五行（91% 是单抽），要 3 个以上永远搜不到",
          field: "wuxing",
        }),
      );
    }
    return notes;
  }

  override buildSpec(
    inputs: Readonly<Record<string, unknown>>,
    _startSeed: number,
  ): GrowthWuxingSpec {
    const plan = this.planOf(inputs);
    return GrowthWuxingSpec.fromParts(plan.targetWx, plan.delta, plan.grows);
  }

  // ------------------------------------------------------------------ 搜索
  /**
   * 沿 ``FastNext`` 单向前扫，返回第一个命中的候选。
   *
   * ``near`` 被忽略（本场景只有这一种搜索）。``searchSeed`` 已经是「起点推进
   * :meth:`~Scenario.advanceCount` 次」的结果，也就是
   * ``findRefreshSutraAttribute`` 里 ``for`` 循环的第一次迭代；循环变量 ``step``
   * 就是 ``seedDistance(start, seed)``。
   */
  override async search(
    prepared: Prepared,
    searchSeed: number,
    options: { near: boolean; limit: number | null; rt: Runtime; ctx: SearchContext },
  ): Promise<SearchResult> {
    const { limit, rt, ctx } = options;
    const spec = prepared.spec;
    if (!(spec instanceof GrowthWuxingSpec)) {
      throw new ScenarioError(
        `${this.key} 只接受 GrowthWuxingSpec，得到 ${spec.constructor.name}`,
      );
    }
    // ``limit`` 为 0 / ``null`` 时回落到软上限（Python 的 ``if limit``）。
    const span = Math.trunc(limit ? limit : this.nearLimit);
    const engine = rt.engine;
    let seed = Math.trunc(searchSeed);
    for (let step = 1; step <= span; step++) {
      ctx.checkCancel();
      const hit = matchCandidate(engine, seed, spec);
      if (hit !== null) {
        return new SearchResult({
          seeds: [seed],
          head: seed,
          nearest: seed,
          distance: step,
          consumed: 0,
          backend: rt.backend.name,
          specKind: spec.kind,
        });
      }
      seed = engine.fastNext(seed);
      if (step % 8192 === 0) ctx.report(step, span, "正在洗练...", "步");
    }
    ctx.forceReport(span, span, "没找到", "步");
    return new SearchResult({ backend: rt.backend.name, specKind: spec.kind });
  }

  /**
   * 命中时就是默认语义（``needConsume = distance - 1``）。
   *
   * 没命中时 ``src`` 会把 ``H`` 算成 ``-1`` 直接显示；这里统一成 ``0`` +
   * 一条 ``warning``。
   */
  override interpret(
    result: SearchResult,
    inputs: Readonly<Record<string, unknown>>,
    startSeed: number,
    rt: Runtime | null = null,
  ): Outcome {
    const outcome = super.interpret(result, inputs, startSeed, rt);
    if (result.nearest === null) {
      return outcome.with({
        distance: 0,
        needConsume: 0,
        preview: NO_HIT_PREVIEW,
        notes: [
          ...outcome.notes,
          new Note({
            level: "warning",
            message: `${this.nearLimit} 步之内没有找到符合条件的种子`,
          }),
        ],
      });
    }
    return outcome;
  }

  override preview(
    seed: number,
    inputs: Readonly<Record<string, unknown>>,
    rt: Runtime,
  ): string {
    const hit = matchCandidate(rt.engine, Math.trunc(seed), this.buildSpec(inputs, 0));
    if (hit === null) return NO_HIT_PREVIEW;
    return formatPreview(hit[0], hit[1]);
  }
}

register(V4Scenario);
