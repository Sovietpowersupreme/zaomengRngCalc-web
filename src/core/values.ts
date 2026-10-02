/**
 * ``src_forge/core/values.py`` 的 1:1 翻译（常量 + int32/uint32 工具 + 校验）。
 *
 * ⚠️ JS 的位运算**全是 int32 语义**，所以不能照抄 Python 的 ``x & M32``：
 * 在 JS 里 ``0xFFFFFFFF`` 先被 ToInt32 成 ``-1``，``x & M32`` 得到的是**有符号**结果。
 * 正确写法只有两种：``x >>> 0``（ToUint32）与 ``x | 0``（ToInt32）。
 * 两者都精确到 ``|x| <= 2^53``（ToUint32/ToInt32 就是「向 0 截断后模 2^32」），
 * 本项目的种子乘积最大 ``(2^32-1) * 71 < 2^39``，安全。
 */

import { SpecError } from "./errors";

// --------------------------------------------------------------------------- 常量
/** ``uRange`` / ``fRange`` 的槽位数（C: ``max_input``）。实测 ``wc_max_input() == 32``。 */
export const MAX_INPUT = 32;
/** 种子枚举上界与随机数最大值（C: ``kRandomPureMax``）。实测 ``wc_rand_pure_max() == 2147483647``。 */
export const KMAX = 0x7fffffff;
/** 模 2^32 掩码（仅用于文档；运算请用 ``>>> 0``）。 */
export const M32 = 0xffffffff;
/** ``seedArray.data`` 的容量；写满即提前返回（「缓存炸了」）。实测 ``wc_seed_array_cap() == 999``。 */
export const SEED_CAP = 999;
/** ``step < 1`` 时 C 会回落到 ``defaultStep``。 */
export const DEFAULT_STEP = 1;
/** 高匹配率阈值（≈25% 命中）。 */
export const MED = 0x60000000;
/** ``target_wx`` 的「必须含五行」位。 */
export const WUXING_HAS = 0b100000;
/**
 * 五行「双抽」的门限（约 91% 单抽）。``>=`` 该值时抽两个五行。
 *
 * ⚠️ 这里有**两个**判据，它们在 ``v == 1954210119`` 这一个值上结论相反
 * （概率 1/2³¹，见 ``src_forge/tests/test_gameinfo_v4.py`` 的「偏差③」）：
 *
 * * 游戏 / 场景回放：浮点判据 ``random() >= 0.91``（``const/wuxing.py``）；
 * * ``csrc`` 与后端枚举：整数判据 ``v < 1954210119`` 才单抽（本常量）。
 *
 * 本常量是**整数**版本，与 ``csrc``/``core/values.py`` 保持一致。
 */
export const WUXING_DOUBLE_AT = 1954210119;
/** ``getBossTypeUltraFast`` 的与掩码。 */
export const BOSS_MASK = 0x60000000;

// --------------------------------------------------------------------------- 整数
/** 按 32 位无符号回绕（= Python 的 ``x & M32``）。 */
export function u32(x: number): number {
  return x >>> 0;
}

/** 按 32 位有符号回绕（= Python 的 ``i32``）。 */
export function i32(x: number): number {
  return x | 0;
}

/**
 * ``tuple(u32(int(v)) for v in values)`` —— 逐项回绕到 uint32。
 *
 * 注意返回的是**新数组**（Python 的 tuple 不可变，这里用 ``readonly`` 表达）。
 * 与 Python 一样不做长度校验 —— 长度约束在各自的 spec 构造器里。
 */
export function coerceU32Tuple(values: Iterable<number>): readonly number[] {
  return Array.from(values, (v) => u32(Math.trunc(v)));
}

/**
 * ``tuple(int(v) for v in values)`` —— **不回绕**，允许负数。
 *
 * ``gem_index`` 用它：负数要保留下来，好在 :func:`checkEquip` 里被拒（Python
 * 里同样如此）。
 */
export function coerceIntTuple(values: Iterable<number>): readonly number[] {
  return Array.from(values, (v) => Math.trunc(v));
}

// --------------------------------------------------------------------------- 值对象
/**
 * 「一个有 ``lo``/``hi`` 的东西」—— 纯结构视图。
 *
 * ⚠️ 这**不是** ``core/spec.py`` 里那个 :class:`IntervalConstraint`（后者带
 * ``kind`` / ``contains`` / ``to_c_min``，住在 ``core/spec.ts``）。这里只描述形状：
 * ``RangeCodec`` 的 ``toU32Interval`` 产出它，``layout.writeURange`` 消费它，
 * 而 ``spec.ts`` 的 :class:`IntervalConstraint` 天然满足它（结构化子类型）。
 * 这样 ``layout`` / ``ranges`` 就不必依赖 ``spec``，也就没有循环依赖。
 */
export interface U32Pair {
  readonly lo: number;
  readonly hi: number;
}

/** 一个闭区间；``uint`` 与 ``float`` 语义共用（选定语义的责任在调用方）。 */
export class Interval {
  readonly lo: number;
  readonly hi: number;

  constructor(lo: number, hi: number) {
    if (lo > hi) throw new SpecError(`区间上下界反了: [${lo}, ${hi}]`);
    this.lo = lo;
    this.hi = hi;
  }

  static fullU32(): Interval {
    return new Interval(0, M32);
  }

  static fullFloat(): Interval {
    return new Interval(0, 1);
  }

  contains(value: number): boolean {
    return this.lo <= value && value <= this.hi;
  }

  [Symbol.iterator](): Iterator<number> {
    return [this.lo, this.hi][Symbol.iterator]();
  }
}

// --------------------------------------------------------------------------- 校验
/** 校验区间数量（C 的 ``_crackerRangeOk``；这里改成抛错，避免 C 端读越界内存）。 */
export function checkRangeNum(num: number): number {
  if (num < 1) {
    throw new SpecError("区间数量不能为 0（C 端会打印「输入的区间数量为0」并返回空集）");
  }
  if (num > MAX_INPUT) {
    throw new SpecError(`区间数量 ${num} 超过上限 ${MAX_INPUT}`);
  }
  return num;
}

/** 校验 ``findEquip`` 家族的可变长数组长度关系（C: ``_crackerEquipOk``）。 */
export function checkEquip(num: number, rollNum: number, gemIndex: readonly number[]): void {
  if (rollNum > num) {
    throw new SpecError(`roll 数量 ${rollNum} 超过区间数量 ${num}`);
  }
  for (const [i, gi] of gemIndex.entries()) {
    if (gi < 0 || gi >= num) {
      throw new SpecError(`第 ${i} 颗宝石的索引 ${gi} 越界（区间数量 ${num}）`);
    }
  }
}

/** 校验 ``findRechild`` 家族：前 3 次池分配 + ``rollNum`` 次固定 roll。 */
export function checkRechild(num: number, rollNum: number): void {
  if (3 + rollNum > num) {
    throw new SpecError(`3 + roll 数量 ${rollNum} = ${3 + rollNum} 超过区间数量 ${num}`);
  }
}
