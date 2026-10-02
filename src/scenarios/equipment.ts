/**
 * 装备侧共享内核（打造 / 合成 / 掉落 / 任务）—— `src_forge/gameInfo/equipment.py` 的
 * 1:1 翻译。
 *
 * 五条顺序敏感的事实（照抄 Python 模块 docstring，改动前先读一遍）
 * ------------------------------------------------------------
 * 1. `baseEquip` / `gemRanges` 先做 `(min, max - min)`，**再**乘 `10 ** precision`
 *    放大 —— 两步顺序不能换（`src/making_calc/search.py::mytask` 就是这么写的）；
 * 2. 放大后的 `roll_val` 要 `round()` 一次 —— 取整后为 0 的属性**不进** C 的
 *    `roll_vals`（进去了就会白吃一次随机数）；
 * 3. 宝石后缀（`攻击1` / `攻击2`）既决定 `uniquePermutations` 的去重键，也决定
 *    `gemIndex`；
 * 4. `equip` 的属性顺序 = `base_roll_attrs` + **本排列**新引入的属性；`RollSpec`
 *    的约束个数必须等于这个顺序的长度；
 * 5. 五行分支**完全无视宝石**（`mytask` 里宝石只用在 `else` 分支）。
 *
 * 与 Python 的有意偏差（不是漏译）
 * -------------------------------
 * * 没命中时 `needConsume = 0` + 一条 `warning`，而不是 `src` 先算出来的负数 `H`
 *   （旧实现显示 `-1` 很误导）；
 * * `simulateEquip` 的八卦判据用 `baguaEup[1]`（= C 侧 `if (bagua_growth[1])`），
 *   而不是 `src` 的 `if bagua_EupData:`（`(0, 0)` 在 Python 里也是真值，会白吃
 *   一次随机数）。可达输入下两者等价，只有 `(0, 0)` 这种不可达输入才分道扬镳；
 * * 种子集合**保持 C 的搜索顺序**（离起始种子由近到远），不做数值排序 ——
 *   `src/making_calc/search.py::mytask` 就是 `seed_list += list(seedarr.data)`。
 *
 * 为什么要写常量表而不是直接读 JSON 的键序
 * ----------------------------------------
 * `consts.json` 是用 `json.dumps(..., sort_keys=True)` 导出的，**字典键序全丢**。
 * 装备的「属性顺序」是搜索语义、「物品顺序」是 UI 下拉框顺序，两者都不是排版
 * 细节，所以 exporter 另外导出 `equipment_name_order` / `equipment_attr_order`
 * 两张保序表（schema v3）。本文件一律走那两张表，**不要**改用
 * `Object.keys(CONSTS.equipment[cat][name])`（码点序，错的）或
 * `CONSTS.equipment_names`（排过序，只用来 diff）。
 */

import { CONSTS } from "../data/consts";
import type { EquipValue } from "../data/consts";
import { pyRepr, pyRound, pyRound1, pyRoundN } from "../core/fromValue";
import { parsePair } from "../core/pair";
import { uintBeforeRound } from "../core/ranges";
import type { Pair } from "../core/ranges";
import { RollSpec, WuxingSpec } from "../core/spec";
import type { SeedSpec } from "../core/spec";
import type { WasmEngine } from "../wasm/engine";
import {
  InputField,
  InputSchema,
  Note,
  Outcome,
  Prepared,
  Runtime,
  Scenario,
  ScenarioError,
  getBool,
  getFloat,
  getInt,
  getStr,
  withBackend,
} from "./scenario";
import type { RunOptions } from "./scenario";
import type { SearchContext, SearchResult } from "../core/search";

// =========================================================================== 常量
/** 属性 → `(lo, hi)`。 */
export type RangeMap = ReadonlyMap<string, Pair>;

/** 一件装备的属性表（属性 → 原始值，**保持数据文件顺序**）。 */
export type EquipData = ReadonlyMap<string, EquipValue>;

/** `分类 → 物品 → 属性表`。 */
export type EquipmentTable = ReadonlyMap<string, ReadonlyMap<string, EquipData>>;

/** `宝石种类 → 属性 → 可滚区间`。 */
export type GemTable = ReadonlyMap<string, RangeMap>;

/**
 * 10 个普通属性（顺序即游戏内的属性顺序）。
 *
 * 走 `CONSTS.attrs.common`（导出自 `const/resolution.py`，保序且在
 * `consts.test.ts` 里被钉死）而不是再抄一份字面量 —— 抄两份就会有「改了一处
 * 忘了另一处」的风险。
 */
export const COMMON_ATTRS: readonly string[] = CONSTS.attrs.common;

/** 属性 → 小数位数（`成长` 是唯一带小数的）。 */
export const COMMON_ATTRS_PRECISION: Readonly<Record<string, number>> = CONSTS.attrs.precision;

/** 属性名里的「品质」键。 */
export const QUALITY_ATTR: string = CONSTS.attrs.quality_attr;

/** 属性名里的「五行」键。 */
export const WUXING_ATTR: string = CONSTS.attrs.wuxing_attr;

/** 局部搜索（`*2` 家族）单次调用的最大步数 —— `src.making_calc.data.MAX_SEED_SEARCH`。 */
export const MAX_SEED_SEARCH = 99_999_999;

/** 全空间枚举的哨兵上限（`src` 的 `0x7fffffff`）。 */
export const FULL_SEARCH_LIMIT = 0x7fffffff;

/** 目标属性那一组的分组名（界面按它找表头）。 */
export const GROUP_TARGET = "目标属性";

/** 五行的「存在」位（`0b100000`）。 */
export const WX_MASK: number = CONSTS.wuxing.has;

/** 装备分类的展示顺序（`src.making_calc.data.all_equipment` 的白名单顺序）。 */
export const CATEGORY_ORDER: readonly string[] = Object.freeze([
  "weapons",
  "armors",
  "accessories",
  "drops",
  "fusion-tjbg",
  "fusion-A",
  "fusion-B",
  "fusion-C",
  "redbottle",
  "v4-reforge",
  "unsupported",
  "task-yanma",
]);

/** 需要 `A = 灵魂刷新次数 + 1`（非邪灵）/ `0`（邪灵）的分类。 */
export const RANDOM_CATEGORIES: readonly string[] = Object.freeze([
  "weapons",
  "armors",
  "accessories",
]);

/** 「属性计算前的随机次数」硬编码表（`calcBeforeAttrRandoms`），勿改数值。 */
export const BEFORE_ATTR_RANDOMS: ReadonlyMap<string, number> = new Map([
  ["drops", 0],
  ["unsupported", 0],
  ["redbottle", 1], // 第一次判断是否宝宝
  ["fusion-tjbg", 11],
  ["fusion-a", 7],
  ["fusion-b", 3],
  ["fusion-c", 8],
  ["task-yanma", 13],
]);

function buildEquipment(): EquipmentTable {
  const out = new Map<string, ReadonlyMap<string, EquipData>>();
  for (const category of CATEGORY_ORDER) {
    const items = CONSTS.equipment[category];
    if (!items) continue; // Python: `if category in CRAFTABLE_EQUIPMENT`
    const nameOrder = CONSTS.equipment_name_order[category];
    const attrOrder = CONSTS.equipment_attr_order[category];
    if (nameOrder === undefined || attrOrder === undefined) {
      throw new Error(
        `consts.json 缺少 ${category} 的名字/属性顺序表 —— schema v3 才有，重跑 exporter`,
      );
    }
    const built = new Map<string, EquipData>();
    for (const name of nameOrder) {
      const data = items[name];
      if (data === undefined) continue;
      const attrs = attrOrder[name];
      if (attrs === undefined) {
        throw new Error(`consts.json 的 equipment_attr_order 缺少 ${category}/${name}`);
      }
      const entry = new Map<string, EquipValue>();
      for (const attr of attrs) {
        const value = data[attr];
        if (value === undefined) {
          throw new Error(`consts.json 的 equipment[${category}][${name}] 缺少属性 ${attr}`);
        }
        entry.set(attr, value);
      }
      built.set(name, entry);
    }
    out.set(category, built);
  }
  return out;
}

/**
 * 装备数据（`{category: {name: {attr: value}}}`）。
 *
 * 两个顺序都来自 exporter 的保序表：分类顺序 = `CATEGORY_ORDER` 的白名单序，
 * 物品顺序 = `equipment_name_order`，属性顺序 = `equipment_attr_order`。
 */
export const EQUIPMENT: EquipmentTable = buildEquipment();

/** 宝石数据（键序取自 `CONSTS.gems`，但只用于查表，顺序不影响任何语义）。 */
export const GEMS: GemTable = (() => {
  const out = new Map<string, RangeMap>();
  for (const [kind, attrs] of Object.entries(CONSTS.gems)) {
    const inner = new Map<string, Pair>();
    for (const [attr, rng] of Object.entries(attrs)) inner.set(attr, rng);
    out.set(kind, inner);
  }
  return out;
})();

/**
 * 宝石种类下拉框的选项（前置「无」）。
 *
 * ⚠️ 用 `attrs.gem_kinds`（= `resolution.GEM_KINDS` 的顺序）而不是
 * `Object.keys(CONSTS.gems)`（那是 `sort_keys=True` 排过的码点序，下拉框顺序会乱）。
 */
export const GEM_KINDS: readonly string[] = CONSTS.attrs.gem_kinds;

/** 属性下拉框的选项（前置「无」）。 */
export const ATTR_WITH_NONE: readonly string[] = CONSTS.attrs.with_none;

// =========================================================================== 取值
/** 把数据表里的值规整成 `(lo, hi)`。非二元组、非数字一律报错。 */
export function asRange(value: EquipValue | undefined): Pair {
  if (Array.isArray(value)) {
    if (value.length !== 2) {
      throw new ScenarioError(`属性值 ${pyRepr(value)} 不是二元组`);
    }
    return [Number(value[0]), Number(value[1])];
  }
  if (typeof value === "number") return [value, value];
  throw new ScenarioError(`属性值 ${pyRepr(value)} 既不是范围也不是数字`);
}

/** 区间相加（`(a0 + b0, a1 + b1)`）。 */
export function addRanges(a: Pair, b: Pair): Pair {
  return [a[0] + b[0], a[1] + b[1]];
}

/** 去掉**一个**尾部数字（`"攻击1"` → `"攻击"`）。 */
export function getBase(key: string): string {
  // Python 是 `key[-1].isdigit()`（认全角数字等 unicode 数字）；属性名只有 ASCII
  // 后缀，`\d` 足够。空串 `slice(-1)` 得 `""`，正则不匹配 → 原样返回。
  if (key !== "" && /^\d$/.test(key.slice(-1))) return key.slice(0, -1);
  return key;
}

/**
 * 这个属性是否会参与随机计算。
 *
 * ⚠️ `(-100, -100)` 这种「上下限相等」的**不算** —— 固定值不吃随机数。
 */
export function isRollable(value: EquipValue | undefined): boolean {
  return Array.isArray(value) && value[0] !== value[1];
}

/**
 * `(lo, hi)` → 一行展示文本。
 *
 * `precision` 省略时：两端都是整数用 0，否则用 1。
 */
export function formatRange(
  lo: number | string,
  hi: number | string,
  precision?: number | null,
): string {
  let mn = Number(lo);
  let mx = Number(hi);
  let places = precision ?? null;
  if (places === null) {
    places = Number.isInteger(mn) && Number.isInteger(mx) ? 0 : 1;
  }
  mn = pyRoundN(mn, places);
  mx = pyRoundN(mx, places);
  const same = Math.abs(mn - mx) < 1e-9;
  if (places <= 0) {
    const a = String(pyRound(mn));
    return same ? a : `${a}~${String(pyRound(mx))}`;
  }
  // `toFixed` 与 Python 的 `f"{v:.{p}f}"` 在「已被 pyRoundN 规整过的值」上等价。
  const digits = Math.max(0, Math.trunc(places));
  return same ? mn.toFixed(digits) : `${mn.toFixed(digits)}~${mx.toFixed(digits)}`;
}

/** 某个分类下的物品表副本。 */
export function categoryItems(category: string): ReadonlyMap<string, EquipData> {
  return EQUIPMENT.get(category) ?? new Map<string, EquipData>();
}

/** 按 `CATEGORY_ORDER`（外层）+ 数据文件内层顺序遍历所有装备。 */
export function* iterItems(): Generator<readonly [string, string, EquipData]> {
  for (const [category, items] of EQUIPMENT) {
    for (const [name, data] of items) yield [category, name, data] as const;
  }
}

/** `itertools.permutations` 的等价物（**位置**的字典序，与 Python 逐位一致）。 */
function permutationsOf<T>(items: readonly T[]): T[][] {
  const n = items.length;
  const out: T[][] = [];
  const used: boolean[] = new Array<boolean>(n).fill(false);
  const current: T[] = [];
  const walk = (): void => {
    if (current.length === n) {
      out.push([...current]);
      return;
    }
    for (let i = 0; i < n; i += 1) {
      if (used[i]) continue;
      used[i] = true;
      current.push(items[i] as T);
      walk();
      current.pop();
      used[i] = false;
    }
  };
  walk();
  return out;
}

/**
 * 宝石键的所有排列，**去重后**仍按原排列顺序返回。
 *
 * 去重键是 `(getBase(key), ranges[key])` —— 也就是「同一个属性 + 同一段区间」的
 * 两块宝石互换位置不产生新结果。同组内多个有序键时，把组内**排好序**的键塞回
 * 原来那几个槽位（`canonical`），只留第一次出现的那个排列。返回的是**原始**排列
 * （`canonical` 只用来算去重令牌）。
 *
 * `keys` 为空时返回 `[[]]`（一个空排列），不是 `[]` —— Python 是 `((),)`。
 */
export function uniquePermutations(
  keys: readonly string[],
  ranges: RangeMap,
): readonly (readonly string[])[] {
  const items = [...keys];
  if (items.length === 0) return [[]];
  const groups = new Map<string, { index: number; key: string }[]>();
  for (const [index, key] of items.entries()) {
    const value = ranges.get(key);
    const token = JSON.stringify([getBase(key), value ?? null]);
    const bucket = groups.get(token);
    if (bucket === undefined) groups.set(token, [{ index, key }]);
    else bucket.push({ index, key });
  }
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const perm of permutationsOf(items)) {
    const canonical = [...perm];
    for (const members of groups.values()) {
      if (members.length <= 1) continue;
      const sortedKeys = members
        .map((m) => m.key)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const slots = members.map((m) => m.index).sort((a, b) => a - b);
      for (const slot of slots) canonical[slot] = sortedKeys[slot] as string;
    }
    const token = canonical.join("\u0000");
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(perm);
  }
  return out;
}

/** 过滤掉「无」并校验宝石种类/属性是否存在于数据表。 */
export function gemSelectionsOf(
  pairs: readonly (readonly [string, string])[] | null | undefined,
  gemData: GemTable = GEMS,
): readonly (readonly [string, string])[] {
  const out: (readonly [string, string])[] = [];
  for (const [kind, attr] of pairs ?? []) {
    if (!kind || !attr || kind === "无" || attr === "无") continue;
    if (!gemData.has(kind) || gemData.get(kind)?.has(attr) !== true) continue;
    out.push([String(kind), String(attr)]);
  }
  return out;
}

/** `buildGemRanges` 的产物：属性表 + 单值宝石的告警三元组。 */
export interface GemRangesResult {
  readonly ranges: RangeMap;
  /** `(种类, 属性, 值)` —— 与 `src` 的告警格式一致。 */
  readonly singleValue: readonly (readonly [string, string, number])[];
}

/**
 * 宝石选择 → `{属性名(带数字后缀): (min, max)}` + 单值宝石的告警。
 *
 * 同名属性追加**递增**数字后缀，`mytask` 的顺序敏感计算依赖这些后缀。
 */
export function buildGemRanges(
  selections: readonly (readonly [string, string])[],
  gemData: GemTable = GEMS,
): GemRangesResult {
  const ranges = new Map<string, Pair>();
  const singleValue: (readonly [string, string, number])[] = [];
  for (const [kind, attr] of selections) {
    const value = gemData.get(kind)?.get(attr);
    if (value === undefined) continue;
    const rng = asRange(value);
    if (rng[0] === rng[1]) singleValue.push([kind, attr, rng[0]]);
    let key = attr;
    let i = 1;
    while (ranges.has(key)) {
      key = `${attr}${String(i)}`;
      i += 1;
    }
    ranges.set(key, rng);
  }
  return { ranges, singleValue };
}

/**
 * 白板数据 → 参与随机计算的属性表。
 *
 * 纳入条件：白板自身可变，**或**该属性（基名）有宝石加成 —— 固定值但带宝石
 * 加成的属性也要进来，因为宝石会让它在随机属性计算里变成可变项。
 *
 * ⚠️ 迭代顺序 = `equip_data` 的**数据文件顺序**（Python 的 `equip_data.items()`）。
 * TS 侧因此必须按 `equipment_attr_order[cat][name]` 迭代 —— `consts.json` 里
 * 属性键已被 `sort_keys=True` 按码点重排过（例：`天残` 源顺序 `魔法, 攻击`
 * 变成 `攻击, 魔法`），照着 JSON 的键序走会把随机值发错属性。
 */
export function buildBaseRanges(
  equipData: EquipData,
  gemRanges: RangeMap | null = null,
): RangeMap {
  const gemAttrs = new Set<string>();
  for (const key of gemRanges?.keys() ?? []) gemAttrs.add(getBase(key));
  const base = new Map<string, Pair>();
  for (const [attr, value] of equipData) {
    if (attr === QUALITY_ATTR || attr === WUXING_ATTR) continue;
    if (isRollable(value) || gemAttrs.has(attr)) base.set(attr, asRange(value));
  }
  return base;
}

/**
 * 太极八卦「成长」的允许范围 `(round(g/3, 1), round(g/3 + 0.8, 1))`。
 *
 * `g` 是八卦面板上的「小件总成长」，即 `成长 = round(g/3 + 0.8 * random())` 里的
 * `g`，所以上限**就是** `g/3 + 0.8`，不要再往上夹。曾经这里写过
 * `Math.min(3.0, ...)`：`g` 上千时 `g/3 + 0.8` 恒大于 3.0，整个 `+0.8` 被夹掉，
 * 范围退化成 `(g/3, g/3)` 一个点，连带 `buildBaguaEup` 反推出的随机数窗口被压成
 * `[0, 0.0625)` 而查不到种子。
 */
export function buildBaguaRange(baguaTotal: number): Pair {
  const g = baguaTotal;
  return [pyRound1(g / 3.0), pyRound1(g / 3.0 + 0.8)];
}

/** 基名等于 `attr` 的所有宝石区间的和。 */
function gemSum(attr: string, gemRanges: RangeMap): Pair {
  let lo = 0.0;
  let hi = 0.0;
  for (const [key, rng] of gemRanges) {
    if (getBase(key) === attr) {
      lo += rng[0];
      hi += rng[1];
    }
  }
  return [lo, hi];
}

/**
 * 每个目标属性的**最大允许范围**（白板 + 宝石）。
 *
 * `fusion-tjbg` 的「成长」白板里没有这个字段，由成长和算出来额外纳入。
 * ⚠️ 外层按 `COMMON_ATTRS` 的**游戏内属性顺序**迭代，与装备表里的属性顺序无关。
 */
export function buildDefaultRanges(
  equipData: EquipData,
  gemRanges: RangeMap,
  category: string,
  baguaTotal = 0.0,
): RangeMap {
  const gemAttrs = new Set<string>();
  for (const key of gemRanges.keys()) gemAttrs.add(getBase(key));
  const fallback = new Map<string, Pair>();
  for (const attr of COMMON_ATTRS) {
    const value = equipData.get(attr);
    if (isRollable(value) || gemAttrs.has(attr)) {
      const [lo, hi] = asRange(value ?? 0);
      const [gl, gh] = gemSum(attr, gemRanges);
      fallback.set(attr, [lo + gl, hi + gh]);
    } else if (category === "fusion-tjbg" && attr === "成长") {
      fallback.set(attr, buildBaguaRange(baguaTotal));
    }
  }
  return fallback;
}

/**
 * 解析用户输入的目标范围；空输入沿用最大允许范围。
 *
 * 括号**只去掉括号字符本身** —— 所以 `"16(16)"` 会变成 `1616`。**不要**改成
 * 「连内容一起删」，那是 `parsing.strip_parentheses` 的语义，用在别的路径上。
 */
export function buildTargetRanges(
  userInputs: Readonly<Record<string, unknown>>,
  defaultRanges: RangeMap,
): RangeMap {
  const target = new Map<string, Pair>();
  for (const [attr, [lo, hi]] of defaultRanges) {
    const supplied = userInputs[attr];
    // Python `str(user_inputs.get(attr) or "").strip()`：`0` / `false` / `null`
    // 都算空（`or` 的语义），非空值再 `str()`。
    let raw = (supplied ? String(supplied) : "").trim();
    if (raw) raw = raw.split("(").join("").split(")").join("");
    if (!raw) {
      target.set(attr, [lo, hi]);
      continue;
    }
    const pair = parsePair(raw, { stripParenContent: false });
    if (pair === null) {
      throw new ScenarioError(
        `属性「${attr}」的目标范围无法解析：${pyRepr(userInputs[attr])}`,
      );
    }
    let out: Pair = [pair[0], pair[1]];
    if (attr === "成长") {
      out = [pyRoundN(out[0], 1), pyRoundN(out[1], 1)];
    } else if (COMMON_ATTRS.includes(attr)) {
      out = [pyRound(out[0]), pyRound(out[1])];
    }
    if (out[0] > out[1]) out = [out[1], out[0]];
    target.set(attr, out);
  }
  return target;
}

/** 确认目标范围落在最大允许范围内，且 `min <= max`。 */
export function validateTargetRanges(targetEquip: RangeMap, defaultRanges: RangeMap): void {
  for (const [attr, [mn, mx]] of targetEquip) {
    const limit = defaultRanges.get(attr);
    if (limit === undefined) throw new ScenarioError(`属性「${attr}」的目标范围超出限制`);
    if (mn < limit[0] - 1e-9 || mx > limit[1] + 1e-9 || mn > mx) {
      throw new ScenarioError(`属性「${attr}」的目标范围超出限制`);
    }
  }
}

/**
 * 目标成长范围 → 八卦 `EupData` 的原始随机整数范围。
 *
 * `0.05` 是容差，`0.8` 是八卦成长随机系数，`0x80000000` 是 uint 刻度。
 */
export function buildBaguaEup(targetGrowth: readonly number[], baguaTotal: number): Pair {
  const loc1 = targetGrowth[0] ?? 0;
  const loc2 = targetGrowth[1] ?? 0;
  const loc3 = baguaTotal / 3.0;
  const lo = Math.max(0.0, (loc1 - 0.05 - loc3) / 0.8);
  const hi = Math.min(1.0, (loc2 + 0.05 - loc3) / 0.8);
  return [Math.trunc(lo * 0x80000000), Math.trunc(hi * 0x80000000)];
}

/** 属性计算**前**的随机次数（游戏机制硬编码，勿改数值）。 */
export function calcBeforeAttrRandoms(
  category: string,
  refreshCount = 0,
  fixedCount = 0,
): number {
  const cat = String(category).toLowerCase();
  if (RANDOM_CATEGORIES.includes(cat)) return refreshCount + fixedCount;
  return BEFORE_ATTR_RANDOMS.get(cat) ?? 0;
}

/**
 * 返回 `[A, B]`。
 *
 * `A`：非邪灵品质放上宝石后再换制作书各触发 1 次，所以是「已选宝石数 + 1」；
 * 邪灵制作书本身不触发，所以是 0。
 * `B`：固定 2 次。
 */
export function abSum(
  category: string,
  quality: string,
  gemCount: number,
  fixedCount = 2,
): readonly [number, number] {
  const cat = String(category).toLowerCase();
  if (!RANDOM_CATEGORIES.includes(cat)) return [0, 0];
  const a = String(quality) !== "邪灵" ? gemCount + 1 : 0;
  return [a, fixedCount];
}

/**
 * 五行文本 → 掩码。
 *
 * `"无"` / `"_"` → `0`（表示不筛五行）；`""` → `WX_MASK`（只要「有五行」即可）；
 * 非法或重复字符 → `null`。
 */
export function parseWuxing(text: string): number | null {
  if (text === "无" || text === "_") return 0;
  let mask = WX_MASK;
  for (const ch of text) {
    const index = CONSTS.wuxing.bits[ch];
    if (index === undefined) return null;
    const bit = 1 << index;
    if (mask & bit) return null;
    mask |= bit;
  }
  return mask;
}

/**
 * 品质名归一化：去掉空格（游戏脚本里写的是 `"普 通"`）；`null` → `""`。
 *
 * `src_forge/const/quality.py::normalize_quality` 的翻译 —— TS 侧此前没有这份。
 */
export function normalizeQuality(name: unknown): string {
  if (name === null || name === undefined) return "";
  return String(name).split(" ").join("").split("\u3000").join("").trim();
}

/** 从装备数据里取品质名（没有就返回 `""`）。 */
export function qualityOf(equipData: EquipData | null | undefined): string {
  if (equipData === null || equipData === undefined) return "";
  return normalizeQuality(equipData.get(QUALITY_ATTR) ?? "");
}

// =========================================================================== 计划
/** `buildPlan` 的可选参数。 */
export interface BuildPlanOptions {
  gemPairs?: readonly (readonly [string, string])[] | null;
  wuxingText?: string | null;
  baguaTotal?: number;
  fixedCount?: number;
}

/** 一次装备搜索的全部中间量（组装好、可直接出 spec）。 */
export class EquipPlan {
  readonly category: string;
  readonly item: string;
  readonly quality: string;
  readonly consume: number;
  readonly baseEquip: RangeMap;
  readonly gemRanges: RangeMap;
  readonly targetEquip: RangeMap;
  readonly defaultRanges: RangeMap;
  readonly targetWx: number;
  readonly baguaEup: Pair;
  readonly baguaTotal: number;
  readonly gemOrder: readonly string[];
  readonly warnings: readonly (readonly [string, string, number])[];
  readonly notes: readonly Note[];
  readonly extra: Readonly<Record<string, unknown>>;

  constructor(init: {
    category: string;
    item: string;
    quality: string;
    consume: number;
    baseEquip: RangeMap;
    gemRanges: RangeMap;
    targetEquip: RangeMap;
    defaultRanges: RangeMap;
    targetWx: number;
    baguaEup: Pair;
    baguaTotal: number;
    gemOrder: readonly string[];
    warnings?: readonly (readonly [string, string, number])[];
    notes?: readonly Note[];
    extra?: Readonly<Record<string, unknown>>;
  }) {
    this.category = init.category;
    this.item = init.item;
    this.quality = init.quality;
    this.consume = init.consume;
    this.baseEquip = init.baseEquip;
    this.gemRanges = init.gemRanges;
    this.targetEquip = init.targetEquip;
    this.defaultRanges = init.defaultRanges;
    this.targetWx = init.targetWx;
    this.baguaEup = init.baguaEup;
    this.baguaTotal = init.baguaTotal;
    this.gemOrder = Object.freeze([...init.gemOrder]);
    this.warnings = Object.freeze([...(init.warnings ?? [])]);
    this.notes = Object.freeze([...(init.notes ?? [])]);
    this.extra = Object.freeze({ ...(init.extra ?? {}) });
  }

  /** 是否走 `findFabao2` 分支（`targetWx != 0`）。 */
  get hasWuxing(): boolean {
    return Boolean(this.targetWx);
  }

  get searchLimit(): number {
    return MAX_SEED_SEARCH;
  }
}

/** 把「分类 + 物品 + 三个宝石 + 用户输入」组装成 `EquipPlan`。任何一步不合法都会抛。 */
export function buildPlan(
  category: string,
  item: string,
  userInputs: Readonly<Record<string, unknown>>,
  options: BuildPlanOptions = {},
): EquipPlan {
  const gemPairs = options.gemPairs ?? null;
  const wuxingText = options.wuxingText ?? null;
  const baguaTotal = options.baguaTotal ?? 0.0;
  const fixedCount = options.fixedCount ?? 2;

  const cat = String(category);
  const items = EQUIPMENT.get(cat);
  if (items === undefined || items.size === 0) {
    throw new ScenarioError(`未知的装备分类：${pyRepr(cat)}`);
  }
  const data = items.get(item);
  if (data === undefined) {
    throw new ScenarioError(`分类 ${pyRepr(cat)} 下没有物品 ${pyRepr(item)}`);
  }

  const notes: Note[] = [];
  const lower = cat.toLowerCase();

  const selections = RANDOM_CATEGORIES.includes(lower) ? gemSelectionsOf(gemPairs) : [];
  const { ranges: gemRanges, singleValue } = buildGemRanges(selections);
  for (const [kind, attr, value] of singleValue) {
    notes.push(
      new Note({
        level: "warning",
        message: `宝石 ${kind} 的属性 ${attr} 是单个值 ${pythonFloatRepr(value)}，可能选错`,
      }),
    );
  }

  // 五行会单独走一条分支，所以先把「品质」键摘掉（它不参与属性计算）。
  const equipData = new Map<string, EquipValue>();
  for (const [key, value] of data) {
    if (key !== QUALITY_ATTR) equipData.set(key, value);
  }
  const quality = qualityOf(data);

  const baseEquip = buildBaseRanges(equipData, gemRanges);
  const defaultRanges = buildDefaultRanges(equipData, gemRanges, lower, baguaTotal);
  const targetEquip = buildTargetRanges(userInputs, defaultRanges);
  validateTargetRanges(targetEquip, defaultRanges);

  const [a, b] = abSum(lower, quality, selections.length, fixedCount);
  const consume = calcBeforeAttrRandoms(lower, a, b);

  let targetWx: number;
  if (equipData.has(WUXING_ATTR)) {
    const text = wuxingText === null ? "无" : String(wuxingText);
    if (text.length > 2) throw new ScenarioError("输入的五行不对（最多两个字）");
    const parsed = parseWuxing(text);
    if (parsed === null) throw new ScenarioError("输入的五行不对");
    targetWx = parsed;
  } else {
    targetWx = 0;
    if (wuxingText) {
      notes.push(
        new Note({
          level: "info",
          message: `${item} 没有五行字段，已忽略五行输入`,
          field: "wuxing",
        }),
      );
    }
  }

  const baguaEup: Pair =
    lower === "fusion-tjbg"
      ? buildBaguaEup(targetEquip.get("成长") ?? [0.0, 0.0], baguaTotal)
      : [0, 0];

  return new EquipPlan({
    category: cat,
    item,
    quality,
    consume,
    baseEquip,
    gemRanges,
    targetEquip,
    defaultRanges,
    targetWx,
    baguaEup,
    baguaTotal,
    gemOrder: [...gemRanges.keys()],
    warnings: singleValue,
    notes,
    extra: { a, b },
  });
}

/** 精度放大后的三张表（`mytask` 内部真正在用的那一份）。 */
export interface ScaledPlan {
  readonly baseEquip: RangeMap;
  readonly gemRanges: RangeMap;
  readonly targetEquip: RangeMap;
}

/**
 * `(min, max-min)` 变换 + 精度放大（**顺序不可换**）。
 *
 * `base` / `gem` 走 `(v0, v1 - v0)`，`target` 走 `(v0, v1)`；然后三张表统一按
 * `COMMON_ATTRS_PRECISION` 乘 `10 ** p` 并 `round(v, p)` 一次。
 */
export function scalePlan(plan: EquipPlan): ScaledPlan {
  const baseEquip = new Map<string, Pair>();
  for (const [k, v] of plan.baseEquip) baseEquip.set(k, [v[0], v[1] - v[0]]);
  const gemRanges = new Map<string, Pair>();
  for (const [k, v] of plan.gemRanges) gemRanges.set(k, [v[0], v[1] - v[0]]);
  const targetEquip = new Map<string, Pair>();
  for (const [k, v] of plan.targetEquip) targetEquip.set(k, [v[0], v[1]]);
  for (const table of [baseEquip, gemRanges, targetEquip]) {
    for (const k of [...table.keys()]) {
      const places = COMMON_ATTRS_PRECISION[k] ?? 0;
      if (!places) continue;
      const values = table.get(k) as Pair;
      const scale = 10 ** places;
      table.set(k, [pyRoundN(values[0] * scale, places), pyRoundN(values[1] * scale, places)]);
    }
  }
  return { baseEquip, gemRanges, targetEquip };
}

/** 一个宝石排列对应的搜索需求。 */
export class Permutation {
  readonly index: number;
  readonly labels: readonly string[];
  /** 属性（白板）的键顺序 —— 与 `gemOrder` 不是一回事。 */
  readonly order: readonly string[];
  readonly spec: SeedSpec | null;
  readonly baseValSeq: readonly number[];
  /**
   * 宝石键的**排列顺序**（回放时按这个顺序抽随机数，决定谁拿到哪个随机值）。
   */
  readonly gemOrder: readonly string[];

  constructor(init: {
    index: number;
    labels: readonly string[];
    order: readonly string[];
    spec: SeedSpec | null;
    baseValSeq?: readonly number[];
    gemOrder?: readonly string[];
  }) {
    this.index = init.index;
    this.labels = Object.freeze([...init.labels]);
    this.order = Object.freeze([...init.order]);
    this.spec = init.spec;
    this.baseValSeq = Object.freeze([...(init.baseValSeq ?? [])]);
    this.gemOrder = Object.freeze([...(init.gemOrder ?? [])]);
  }

  /** UI 的 `N` 列：宝石顺序（`gemRanges` 里的 1 基下标，找不到写 `-1`）。 */
  get label(): string {
    return this.labels.join(" ");
  }
}

/** `target_equip[attr]` —— 缺键在 Python 侧是 `KeyError`，这里显式报出来。 */
function targetOf(targetEquip: RangeMap, attr: string): Pair {
  const found = targetEquip.get(attr);
  if (found === undefined) throw new ScenarioError(`内部错误：属性「${attr}」没有目标范围`);
  return found;
}

/**
 * 把计划展开成**每个宝石排列一个**搜索需求。
 *
 * 五行分支只有 1 个（且忽略宝石），与 `mytask` 一致。
 */
export function permutationSpecs(plan: EquipPlan, step = 1): readonly Permutation[] {
  const scaled = scalePlan(plan);
  const { baseEquip, gemRanges, targetEquip } = scaled;

  if (plan.hasWuxing) {
    const useq: Pair[] = [];
    for (const [attr, [baseVal, rollVal]] of baseEquip) {
      const [targetLo, targetHi] = targetOf(targetEquip, attr);
      const mini = targetLo - baseVal;
      const maxi = targetHi - baseVal;
      // ⚠️ r 必须是**未 round 的浮点**：uintBeforeRound 直接拿它当除数，
      //    5.999999999999999 与 6 在极值上会差一格，src 传的就是浮点。
      const lo = uintBeforeRound(pyRound(mini), 0, rollVal);
      const hi = uintBeforeRound(pyRound(maxi), 0, rollVal);
      if (!Array.isArray(lo) || !Array.isArray(hi)) {
        throw new ScenarioError("内部错误：uintBeforeRound 没有返回二元组");
      }
      useq.push([lo[0], hi[1]]);
    }
    // 全固定属性（没有可随机项）时 useq 为空 —— src 交给 C 之后 C 会打印
    // 「输入的区间数量为0」并返回空集，这里显式记成 spec = null。
    const spec =
      useq.length > 0
        ? WuxingSpec.fromPairs(useq, plan.targetWx, plan.baguaEup, step)
        : null;
    return [new Permutation({ index: 0, labels: [], order: [...baseEquip.keys()], spec })];
  }

  // ---------------- 非五行：按宝石排列枚举 ----------------
  const baseValSeq: number[] = [];
  const baseRollAttrs: string[] = [];
  const equipUnsorted = new Map<string, Pair>();
  for (const key of targetEquip.keys()) equipUnsorted.set(key, [0.0, 0.0]);
  for (const [attr, [baseVal, rollVal]] of baseEquip) {
    const rollValR = pyRound(rollVal);
    if (rollValR !== 0) {
      baseRollAttrs.push(attr);
      baseValSeq.push(rollValR);
    }
    const prev = equipUnsorted.get(attr) ?? [0.0, 0.0];
    equipUnsorted.set(attr, [prev[0] + baseVal, prev[1] + rollValR]);
  }

  const perms = uniquePermutations(plan.gemOrder, gemRanges);
  const names = plan.gemOrder;
  const out: Permutation[] = [];
  for (const [index, perm] of perms.entries()) {
    const gemValSeq: number[] = [];
    const gemIndex: number[] = [];
    const equip = new Map(equipUnsorted);
    const order = [...baseRollAttrs];
    for (const key of perm) {
      const range = gemRanges.get(key);
      if (range === undefined) throw new ScenarioError(`内部错误：宝石键 ${key} 没有区间`);
      const [baseVal, rollVal] = range;
      const attr = getBase(key);
      if (!order.includes(attr)) order.push(attr);
      gemValSeq.push(Math.trunc(rollVal));
      gemIndex.push(order.indexOf(attr));
      const prev = equip.get(attr) ?? [0.0, 0.0];
      equip.set(attr, [prev[0] + baseVal, prev[1] + rollVal]);
    }

    const pairs: Pair[] = [];
    for (const attr of order) {
      const baseVal = targetOf(equip, attr)[0];
      const [mini, maxi] = targetOf(targetEquip, attr);
      // 保持 src 的 int() 截断语义（RollSpec.fromPairs 直接 u32(x)，不会截断）
      pairs.push([pyRound(mini - baseVal), pyRound(maxi - baseVal)]);
    }

    const labels = perm.map((key) => {
      const at = names.indexOf(key);
      return at < 0 ? "-1" : String(at + 1);
    });
    const spec =
      pairs.length > 0
        ? RollSpec.fromPairs(pairs, baseValSeq, gemValSeq, gemIndex, step)
        : null;
    out.push(
      new Permutation({
        index,
        labels,
        order,
        spec,
        baseValSeq,
        gemOrder: perm,
      }),
    );
  }
  return out;
}

// =========================================================================== 预览
/** Python `repr()` 一个浮点数的等价物（`2.0` 而不是 `2`）。 */
function pythonFloatRepr(value: number): string {
  return Number.isInteger(value) ? `${String(value)}.0` : String(value);
}

/** 一次属性回放的结果。 */
export class EquipPreview {
  /** 与 `src.making_calc.simulation.gen_equip` 逐字一致的字符串。 */
  readonly text: string;
  /**
   * 同一份数据的结构化形式（UI 用，不必再解析字符串）。
   *
   * ⚠️ Python 的 `attrs` 把「五行」也塞在这张表里（值是字符串）；TS 拆成两栏
   * （`attrs` 只放数值、`wuxing` 放五行文本），`text` 与 Python 逐字一致。
   */
  readonly attrs: ReadonlyMap<string, number>;
  /** 五行文本（`targetWx` 为 0 时是 `""`）。 */
  readonly wuxing: string;
  /**
   * 所有属性随机数抽完之后的种子。
   *
   * `src` 的 `L` 列一直是 0（历史遗留），这里给真值。
   */
  readonly seedAfter: number;

  constructor(init: {
    text: string;
    attrs: ReadonlyMap<string, number>;
    wuxing: string;
    seedAfter: number;
  }) {
    this.text = init.text;
    this.attrs = init.attrs;
    this.wuxing = init.wuxing;
    this.seedAfter = init.seedAfter;
  }
}

/**
 * 回放一次装备属性（`src.making_calc.simulation.gen_equip`）。
 *
 * 这里的 `baseEquip` / `gemRanges` 必须是**已按精度放大**的那份（即
 * `permutationSpecs` 内部用的量），因为返回时要把成长缩回去。
 *
 * ⚠️ 取整一律用 `pyRound` / `pyRoundN`（Python 的 `round()` 是**半值取偶**）。
 * 例如 `rv * 4` 在 `rv = 0.125` 时正好是 `0.5`：Python 给 0，`Math.round` 给 1
 * —— 差这一格就会把随机值发到别的五行位上。
 */
export function simulateEquip(
  engine: WasmEngine,
  seed: number,
  baseEquip: RangeMap,
  gemRanges: RangeMap,
  targetWx: number,
  targetEquip: RangeMap,
  baguaEup: readonly number[] = [],
  baguaTotal = 0,
): EquipPreview {
  let cursor = Math.trunc(seed);
  const compare = new Map<string, number>();
  /** 哪些键当前是 Python `int`（含小数时 `str()` 会带 `.0`，预览文本要一致）。 */
  const isInt = new Set<string>();
  for (const k of targetEquip.keys()) {
    compare.set(k, 0);
    isInt.add(k);
  }

  for (const [k, [baseVal, rollVal]] of baseEquip) {
    if (rollVal) {
      const [value, next] = engine.randomValue(cursor);
      cursor = next;
      compare.set(k, (compare.get(k) ?? 0) + pyRound(baseVal + rollVal * value));
    } else {
      // `int + float` → float：`baseVal` 来自 asRange，恒为浮点。
      compare.set(k, (compare.get(k) ?? 0) + baseVal);
      isInt.delete(k);
    }
  }

  let wx = WX_MASK;
  if (targetWx) {
    wx = WX_MASK;
    const [r1, next1] = engine.randomValue(cursor);
    cursor = next1;
    const [rv, next2] = engine.randomValue(cursor);
    cursor = next2;
    const wx1 = pyRound(rv * 4);
    wx |= 1 << wx1;
    if (r1 >= 0.91) {
      const [rv2, next3] = engine.randomValue(cursor);
      cursor = next3;
      const wx2 = pyRound(rv2 * 3);
      wx |= 1 << (CONSTS.wuxing.next[wx1]?.[wx2] ?? 0);
    }
  }

  // 1 次无关调用（`cracker.random(p_seed)`，结果丢弃、种子前进）
  cursor = engine.randomValue(cursor)[1];

  for (const [k, range] of gemRanges) {
    const k2 = getBase(k);
    const [value, next] = engine.randomValue(cursor);
    cursor = next;
    const prevInt = compare.has(k2) ? isInt.has(k2) : true;
    compare.set(k2, (compare.get(k2) ?? 0) + pyRound(range[0] + range[1] * value));
    if (prevInt) isInt.add(k2);
    else isInt.delete(k2);
  }

  // 与 `src.making_calc.simulation.gen_equip` 的**有意偏差**：那边写的是
  // `if bagua_EupData:`，`(0, 0)` 也算真 → 会白吃一次随机数；这边跟着 C 侧
  // `if (bagua_growth[1])` 判。可达输入下两者等价（`calc2` 对非太极八卦传
  // `tuple()`），只有 `(0, 0)` 这种不可达输入才分道扬镳。
  if (baguaEup.length > 0 && baguaEup[1]) {
    const [value, next] = engine.randomValue(cursor);
    cursor = next;
    // `成长 = round(g/3 + 0.8 * random())`。这里在 0.1 单位下算，下面的精度
    // 循环再除以 10。换算前**不要**夹上限 —— 旧实现
    // `src.making_calc.simulation.gen_equip` 同样不夹（曾写过
    // `min(30, raw_growth)`，等价于把最终成长夹到 3.0，明显不对）。
    compare.set("成长", pyRound(baguaTotal * 10 / 3 + 8 * value));
    isInt.add("成长");
  }

  for (const k of [...compare.keys()]) {
    const places = COMMON_ATTRS_PRECISION[k] ?? 0;
    if (!places) continue;
    compare.set(k, pyRoundN((compare.get(k) ?? 0) / 10 ** places, places));
    isInt.delete(k);
  }

  const parts: string[] = [];
  for (const [k, value] of compare) {
    parts.push(`${pyRepr(k)}:${isInt.has(k) ? String(value) : pythonFloatRepr(value)}`);
  }
  let wuxing = "";
  if (targetWx) {
    // `bin(wx)[:-6:-1]` —— 最后 5 位（bit0..bit4）反向，bit5 是「有五行」位不算。
    const bits = wx.toString(2).slice(-5).split("").reverse();
    for (const [i, bit] of bits.entries()) {
      if (bit === "1") wuxing += CONSTS.wuxing.names[i] ?? "";
    }
    parts.push(`${pyRepr(WUXING_ATTR)}:${pyRepr(wuxing)}`);
  }

  return new EquipPreview({
    text: `{${parts.join(",")}}`,
    attrs: compare,
    wuxing,
    seedAfter: cursor,
  });
}

// =========================================================================== 场景基类
/** `"分类/物品"` → `[分类, 物品]`；没有 `/` 时分类是 `""`。 */
export function splitItem(value: unknown): readonly [string, string] {
  const text = (value ? String(value) : "").trim();
  const slash = text.indexOf("/");
  if (slash < 0) return ["", text];
  return [text.slice(0, slash).trim(), text.slice(slash + 1).trim()];
}

/**
 * `"分类/物品"` → `[分类, 物品, 属性表]`。
 *
 * 不带分类前缀时按唯一名字反查；撞名要用户补分类。
 */
export function findItem(value: unknown): readonly [string, string, EquipData] {
  const [category, name] = splitItem(value);
  if (category) {
    const data = EQUIPMENT.get(category)?.get(name);
    if (data === undefined) {
      throw new ScenarioError(`装备分类 ${pyRepr(category)} 里没有 ${pyRepr(name)}`);
    }
    return [category, name, data];
  }
  const hits: (readonly [string, string, EquipData])[] = [];
  for (const [cat, items] of EQUIPMENT) {
    const data = items.get(name);
    if (data !== undefined) hits.push([cat, name, data]);
  }
  if (hits.length === 0) throw new ScenarioError(`没有名为 ${pyRepr(name)} 的装备`);
  if (hits.length > 1) {
    const cats = hits
      .map((h) => h[0])
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .join("、");
    throw new ScenarioError(
      `${pyRepr(name)} 出现在多个分类里（${cats}），请写成「分类/物品」`,
    );
  }
  return hits[0] as readonly [string, string, EquipData];
}

/** 装备场景「没找到」时的预览文本。 */
export const NO_HIT_PREVIEW = "无";

/**
 * 装备类场景的共用实现（打造 / 合成 / 掉落 / 任务）。
 *
 * 子类只声明「允许哪些分类、要不要宝石 / 五行 / 八卦」，其余全部由这里驱动。
 *
 * 搜索流程与 `src/making_calc/search.py::mytask` 一一对应：
 *
 * 1. `planOf` 组 `EquipPlan`（含 `consume`）；
 * 2. `permutationSpecs` 展开成若干「宝石摆放顺序」候选；
 * 3. `_start = fastNext × (consume + 1)`（C 的 `_start`）；
 * 4. 每个候选各跑一次**局部搜索**，各自的上限见 `searchLimits`；
 * 5. 命中种子里取 `seedDistance` 最小的那个；
 * 6. `distance >= distanceLimit` → `distance = 0`（`src` 的失败哨兵）。
 *
 * 装备场景**只支持局部搜索**：`src` 全程用 `findFabao2` / `findEquip2` 这两个
 * `*2` 家族，没有全空间枚举的对应物。
 *
 * ⚠️ 本类**没有 `key`**（Python 侧也是抽象基类）—— 只有子类才注册进注册表。
 */
export abstract class EquipScenario extends Scenario {
  /** 允许的装备分类（`CATEGORY_ORDER` 里的小写键）。 */
  readonly categories: readonly string[] = [];
  /** 是否暴露 3 组宝石选择（仅 `weapons` / `armors` / `accessories`）。 */
  readonly allowGems: boolean = false;
  /** 是否暴露五行筛选。 */
  readonly allowWuxing: boolean = false;
  /** 是否暴露太极成长和。 */
  readonly allowBagua: boolean = false;

  override readonly specKind = "roll";
  override readonly supportsNear = true;
  /** ⚠️ 装备侧的默认局部搜索上限是 `MAX_SEED_SEARCH`（99_999_999）。 */
  override readonly nearLimit = MAX_SEED_SEARCH;
  override readonly version = "1.0";

  /** 本场景可选的 `"分类/物品"` 列表（顺序 = 分类白名单序 + 数据文件序）。 */
  itemChoices(): readonly string[] {
    const out: string[] = [];
    for (const [cat, items] of EQUIPMENT) {
      if (!this.categories.includes(cat)) continue;
      for (const name of items.keys()) out.push(`${cat}/${name}`);
    }
    return out;
  }

  override schema(): InputSchema {
    const choices = this.itemChoices();
    const fields: InputField[] = [
      new InputField({
        key: "item",
        label: "装备",
        kind: "choice",
        default: choices[0] ?? "",
        choices,
        group: "装备",
        help: "格式「分类/物品」；分类前缀必填，重名装备靠它区分",
        width: 22,
      }),
    ];
    if (this.allowGems) {
      for (const i of [1, 2, 3]) {
        fields.push(
          new InputField({
            key: `gem${String(i)}_kind`,
            label: `宝石${String(i)}`,
            kind: "choice",
            default: "无",
            choices: GEM_KINDS,
            group: "宝石",
            width: 10,
          }),
          new InputField({
            key: `gem${String(i)}_attr`,
            label: `宝石${String(i)}属性`,
            kind: "choice",
            default: "无",
            choices: ATTR_WITH_NONE,
            group: "宝石",
            width: 10,
          }),
        );
      }
    }
    if (this.allowWuxing) {
      fields.push(
        new InputField({
          key: "wuxing",
          label: "五行",
          kind: "text",
          default: "无",
          group: "装备",
          help: "留空=不筛五行；「无」/「_」=要求五行位全空；否则填 1~2 个五行字（如「金」「金木」）",
          width: 8,
        }),
      );
    }
    if (this.allowBagua) {
      fields.push(
        new InputField({
          key: "bagua",
          label: "成长和",
          kind: "float",
          default: 0.0,
          min: 0.0,
          group: "装备",
          help: "太极八卦的「八卦」总数值；决定成长范围与额外成长",
          width: 10,
        }),
      );
    }
    for (const attr of COMMON_ATTRS) {
      fields.push(
        new InputField({
          key: `target_${attr}`,
          label: attr,
          kind: "text",
          default: "",
          group: GROUP_TARGET,
          help: "留空=用左边显示的装备上下限；也支持「10~15」「10-15」「10」",
          width: 12,
          inline: true,
        }),
      );
    }
    fields.push(
      new InputField({
        key: "start_seed",
        label: "起始种子",
        kind: "int",
        // 默认**留空**、且必填：0 不是合法种子（`FastNext(0) == 0`，整条序列全
        // 是 0），所以这里不给「0」这个假默认值。
        default: null,
        min: 1,
        max: 0x7fffffff,
        required: true,
        group: "搜索",
        help: "游戏里当前的那个种子（1 ~ 2147483647）；留空会直接报错",
        width: 14,
      }),
      new InputField({
        key: "full_search",
        label: "枚举全部",
        kind: "bool",
        default: false,
        group: "搜索",
        help: "不勾=局部搜索（默认）；勾上=把每次搜索的上限抬到无上限（慢很多，且会忽略下面的「步数上限」）",
      }),
      new InputField({
        key: "limit",
        label: "步数上限",
        kind: "int",
        default: 0,
        min: 0,
        group: "搜索",
        help: "0=用场景默认（见 search_limits）；勾上「枚举全部」时本项被忽略",
        width: 12,
      }),
    );
    return new InputSchema({
      fields,
      title: this.label || this.key,
      hint: this.hint,
      headers: { [GROUP_TARGET]: ["属性名", "展示值", "目标上下限"] },
    });
  }

  /**
   * 目标属性右边那一栏：这件装备（含已选宝石）该属性的**上下限**。
   *
   * 就是 `EquipPlan.defaultRanges` —— 用户「留空」时实际用的那个范围。
   *
   * 输入还不完整（装备名没写对、宝石选了一半）时 `planOf` 会抛，这里吞掉返回
   * 空字典：每敲一个键都会调一次，不能因为半截输入就报错。
   */
  override fieldHints(inputs: Readonly<Record<string, unknown>>): Readonly<Record<string, string>> {
    if (!inputs || Object.keys(inputs).length === 0) return {};
    let plan: EquipPlan;
    try {
      plan = this.planOf(inputs);
    } catch {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [attr, [lo, hi]] of plan.defaultRanges) {
      out[`target_${attr}`] = formatRange(lo, hi, COMMON_ATTRS_PRECISION[attr] ?? 0);
    }
    return out;
  }

  /** 纯函数：表单 → `EquipPlan`。 */
  planOf(inputs: Readonly<Record<string, unknown>>): EquipPlan {
    const [cat, name] = findItem(getStr(inputs, "item")).slice(0, 2) as [string, string];
    if (!this.categories.includes(cat)) {
      throw new ScenarioError(`${this.label} 不支持分类 ${pyRepr(cat)}`);
    }
    const gemPairs: [string, string][] = [];
    if (this.allowGems) {
      for (const i of [1, 2, 3]) {
        gemPairs.push([
          orDefault(inputs[`gem${String(i)}_kind`], "无"),
          orDefault(inputs[`gem${String(i)}_attr`], "无"),
        ]);
      }
    }
    const userInputs: Record<string, unknown> = {};
    for (const attr of COMMON_ATTRS) userInputs[attr] = inputs[`target_${attr}`];
    return buildPlan(cat, name, userInputs, {
      gemPairs: this.allowGems ? gemPairs : null,
      wuxingText: this.allowWuxing ? orDefault(inputs["wuxing"], "") : null,
      baguaTotal: this.allowBagua ? pyRound1(getFloat(inputs, "bagua", 0.0)) : 0.0,
    });
  }

  override validate(inputs: Readonly<Record<string, unknown>>): readonly Note[] {
    try {
      return this.planOf(inputs).notes;
    } catch (error) {
      if (error instanceof ScenarioError) {
        return [new Note({ level: "error", message: error.message, field: "item" })];
      }
      throw error;
    }
  }

  override randomConsumption(inputs: Readonly<Record<string, unknown>>): number {
    return this.planOf(inputs).consume;
  }

  override advanceCount(inputs: Readonly<Record<string, unknown>>): number {
    return this.randomConsumption(inputs) + 1;
  }

  /**
   * 契约要求：返回**第一个能搜的**宝石排列的规格。
   *
   * 装备场景实际要搜全部排列（见 `run`），`buildSpec` 只用于「看一眼需求长什么
   * 样」和单排列的调试。整件装备一个可随机属性都没有（白板全固定 —— `src` 会把
   * 空区间交给 C，C 打印「输入的区间数量为0」）时没有规格可返回，直接报错，
   * 别把 `null` 传给调用方。
   */
  override buildSpec(inputs: Readonly<Record<string, unknown>>, _startSeed: number): SeedSpec {
    for (const perm of permutationSpecs(this.planOf(inputs))) {
      if (perm.spec !== null) return perm.spec;
    }
    throw new ScenarioError(
      `${this.label}：${pyRepr(inputs["item"])} 没有任何可随机的属性，无从搜索`,
    );
  }

  /**
   * 返回 `[搜索上限, 距离上限]`。
   *
   * 对应 `src/making_calc/search.py::mytask` 的两条分支：
   *
   * * 五行分支：`searchLimit = FULL_SEARCH_LIMIT 或 MAX_SEED_SEARCH`，
   *   `distanceLimit = MAX_SEED_SEARCH`（**与 full 无关**）；
   * * 其它分支：两者都等于 `MAX_SEED_SEARCH // 排列数`（`full` 时都是
   *   `FULL_SEARCH_LIMIT`）。
   *
   * 注意**五行默认路径的上限正好等于 `MAX_SEED_SEARCH`**，而 `searchNearest`
   * 的并行门槛 `PARALLEL_MIN_STEPS` 也是这个数，所以这一条会自动走有序并行
   * （结果与串行逐位相同，只是更快）。
   */
  searchLimits(plan: EquipPlan, count: number, full: boolean): readonly [number, number] {
    if (plan.hasWuxing) {
      return [full ? FULL_SEARCH_LIMIT : MAX_SEED_SEARCH, MAX_SEED_SEARCH];
    }
    const limit = full
      ? FULL_SEARCH_LIMIT
      : Math.max(1, Math.trunc(MAX_SEED_SEARCH / Math.max(1, count)));
    return [limit, limit];
  }

  // ------------------------------------------------------------------ 执行
  /**
   * 装备场景的唯一入口（**只支持局部搜索**）。
   *
   * 重写整个 `run` 而不复用基类：基类只处理「一个 spec 一次搜索」，装备要先按
   * 宝石排列展开成 N 个候选、各自搜一次、再取 `seedDistance` 最小的那个。
   */
  override async run(
    inputs: Readonly<Record<string, unknown>>,
    startSeed: number,
    options: RunOptions = {},
  ): Promise<Outcome> {
    if (options.near === false) {
      throw new ScenarioError(`${this.key} 只支持局部搜索（near=True）`);
    }
    const rt = Runtime.resolve(options.backend ?? null, options.pool ?? null);
    const plan = this.planOf(inputs);
    const perms = permutationSpecs(plan);
    const full = getBool(inputs, "full_search", false);
    let [searchLimit, distanceLimit] = this.searchLimits(plan, perms.length, full);
    // 表单里填的「步数上限」（原样留着，只为了在下面写提示）。
    let askedLimit = 0;
    let limit = options.limit ?? null;
    if (limit === null) {
      // 表单里的「步数上限」（0 = 用默认）。调用方**显式**传 `limit` 时以它为准
      // （那是程序化调用的低层覆盖）。
      // **勾了「枚举全部」就把表单这一格整格作废**：枚举全部的优先级在步数上限
      // 之上（用户 2026-09 定的），否则顺手填一个步数就把「抬到无上限」这个语义
      // 覆盖掉了。
      askedLimit = getInt(inputs, "limit", 0);
      limit = (full ? 0 : askedLimit) || null;
    }
    if (limit) searchLimit = Math.trunc(limit);
    const ctx: SearchContext = options.ctx ?? this.searchContext();

    const start = rt.engine.fastNextK(Math.trunc(startSeed), plan.consume + 1);

    const seedList: number[] = [];
    const collect = new Map<number, readonly [number, Permutation]>();
    const total = perms.length;
    for (const [done, perm] of perms.entries()) {
      ctx.checkCancel();
      const step = done + 1;
      if (perm.spec === null) {
        // 该排列一个随机属性都没有（src 的「区间数量为0」），搜不了
        ctx.report(step, total, `宝石排列 ${String(step)}/${String(total)}（无可随机属性）`, "perm");
        continue;
      }
      // 走基类的 `search` 而不是直接调 searcher：这样有 worker 池时能按
      // `shouldParallelNear` 的判据派给池子（Python 侧是 `search_nearest` 内部
      // 自己挑 `*2_ord_mp`，两者等价）。
      const found: SearchResult = await this.search(
        new Prepared({ spec: perm.spec, consume: plan.consume }),
        start,
        { near: true, limit: searchLimit, rt, ctx },
      );
      const first = Math.trunc(found.nearest ?? 0);
      if (found.seeds.length > 0) {
        for (const s of found.seeds) seedList.push(Math.trunc(s));
      }
      if (first) {
        // `src` 用 `seedDistance(start_seed, seed, distance_limit)` 从**用户起始
        // 种子**量距离；上限之外一律记成 `distanceLimit`。
        const distance = plan.consume + 1 + Math.trunc(found.distance ?? 0);
        collect.set(
          distance < distanceLimit ? distance : distanceLimit,
          [first, perm],
        );
      }
      ctx.report(step, total, `宝石排列 ${String(step)}/${String(total)}`, "perm");
    }

    const notes = [...plan.notes];
    if (full && askedLimit) {
      notes.push(
        new Note({
          level: "info",
          message:
            `已勾「枚举全部」：表单里的步数上限 ${String(askedLimit)} 被忽略` +
            `（搜索上限抬到无上限 ${String(searchLimit)}）`,
          field: "limit",
        }),
      );
    }
    if (collect.size === 0) {
      notes.push(new Note({ level: "warning", message: "在给定上限内没有找到任何种子", field: "item" }));
      return withBackend(
        this.makeOutcome(plan, perms, 0, 0, -1, -1, [], notes, distanceLimit, NO_HIT_PREVIEW),
        rt,
      );
    }

    let distance = Math.min(...collect.keys());
    const [seed, perm] = collect.get(distance) as readonly [number, Permutation];
    const preview = this.previewPerm(seed, plan, perm, rt);
    if (distance >= distanceLimit) {
      notes.push(
        new Note({
          level: "warning",
          message: `距离 ${String(distance)} 已超出上限 ${String(distanceLimit)}，按 0 处理`,
          field: "item",
        }),
      );
      distance = 0;
    }
    // 保序去重：按 C 的**搜索顺序**（离起始种子由近到远）摆，不是数值升序。
    const seeds = [...new Set(seedList)];
    return withBackend(
      this.makeOutcome(
        plan,
        perms,
        seed,
        distance,
        perm.index,
        distance - plan.consume - 1,
        seeds,
        notes,
        distanceLimit,
        preview,
      ),
      rt,
    );
  }

  /** 组 `Outcome`（`run` 的两条出口共用）。 */
  makeOutcome(
    plan: EquipPlan,
    perms: readonly Permutation[],
    seed: number,
    distance: number,
    index: number,
    needConsume: number,
    seeds: readonly number[],
    notes: readonly Note[],
    distanceLimit: number,
    preview = "",
  ): Outcome {
    const labels = index >= 0 && index < perms.length ? (perms[index] as Permutation).label : "";
    return new Outcome({
      seed: Math.trunc(seed),
      distance: Math.trunc(distance),
      needConsume: Math.trunc(needConsume),
      consume: plan.consume,
      preview,
      seeds: seeds.map((s) => Math.trunc(s)),
      permutation: labels,
      truncated: seeds.length > 0 && seeds.length >= 999,
      unordered: false,
      notes,
      extra: {
        category: plan.category,
        item: plan.item,
        quality: plan.quality,
        target_wx: plan.targetWx,
        bagua_eup: [plan.baguaEup[0], plan.baguaEup[1]],
        bagua_total: plan.baguaTotal,
        perm_count: perms.length,
        distance_limit: distanceLimit,
      },
    });
  }

  /** 只回放**命中的那个宝石排列**（`src` 的 `M` 列）。 */
  previewPerm(seed: number, plan: EquipPlan, perm: Permutation, rt: Runtime): string {
    if (!seed) return NO_HIT_PREVIEW;
    const scaled = scalePlan(plan);
    const gemScaled = new Map<string, Pair>();
    if (!plan.hasWuxing) {
      // ⚠️ 必须按**宝石排列**的顺序构造（`src` 的 `gem_ranges_sorted`），不能按
      //    属性顺序 —— 否则随机值会发错属性。
      for (const k of perm.gemOrder) {
        const range = scaled.gemRanges.get(k);
        if (range !== undefined) gemScaled.set(k, range);
      }
    }
    return simulateEquip(
      rt.engine,
      Math.trunc(seed),
      scaled.baseEquip,
      gemScaled,
      plan.targetWx,
      scaled.targetEquip,
      plan.baguaEup,
      plan.baguaTotal,
    ).text;
  }

  /** 回放**每一个**宝石排列（` | ` 分隔），用于「这个种子能出什么」。 */
  override preview(
    seed: number,
    inputs: Readonly<Record<string, unknown>>,
    rt: Runtime,
  ): string {
    const plan = this.planOf(inputs);
    if (!seed) return NO_HIT_PREVIEW;
    const parts: string[] = [];
    for (const perm of permutationSpecs(plan)) {
      if (perm.spec === null) continue;
      const text = this.previewPerm(Math.trunc(seed), plan, perm, rt);
      parts.push(perm.label ? `${perm.label}:${text}` : text);
    }
    return parts.join(" | ") || NO_HIT_PREVIEW;
  }
}

/** Python `str(inputs.get(key, fallback) or fallback)` —— `0` / `""` / `null` 都回落到 `fallback`。 */
function orDefault(value: unknown, fallback: string): string {
  return value ? String(value) : fallback;
}
