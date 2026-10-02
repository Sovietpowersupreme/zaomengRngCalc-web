/**
 * ``src_forge/core/ranges.py`` 的 1:1 翻译 —— ``RangeCodec``：
 * 把「游戏里显示的整数」还原成「原始随机整数区间」的纯函数。
 *
 * 数值行为逐位保持；差异只有两处「错误类型归一化」：
 * Python 侧 ``int("x")`` / ``float("x")`` 抛 ``ValueError``，
 * 这里一律抛 :class:`SpecError`（同样的输入仍然被拒绝，只是异常类型统一）。
 *
 * 术语：``n`` 最小值、``r`` 变化范围（上限 − 下限）、``seq`` 要还原的显示值。
 */

import { SpecError } from "./errors";
import { IntervalConstraint } from "./spec";
import { Interval, u32 } from "./values";

/** 显示值 → 原始浮点的精度（原 ``num_parser.SCALE_FACTOR``）。 */
export const SCALE_FACTOR = 1_000_000;

/** 切分「分隔符串」的分隔符集合（中英文标点都算）。 */
const DELIMITERS_RE = /[,，|~·/、；;\s]+/u;

/** 剥离区间文本里的括号与空白（修掉 Python 原代码把 ``replace`` 当正则用的 bug）。 */
const PAIR_TRIM_RE = /[()\[\]\s]+/gu;

/** 一对浮点边界。 */
export type Pair = readonly [number, number];
/** ``RangeCodec`` 接受的输入：单个数字、分隔符串、或数字数组。 */
export type Seq = string | number | readonly number[];
/** 「标量进标量、序列进序列」的返回形态（对应 Python 的 ``tuple | list``）。 */
export type ScalarOrSeq<T> = T | readonly T[];

// =========================================================================== 解析
function toInt(value: unknown, what: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const text = value.trim();
    if (/^[+-]?\d+$/.test(text)) return Number.parseInt(text, 10);
  }
  throw new SpecError(`${what} 无法解析为整数: ${JSON.stringify(value)}`);
}

function toFloat(value: string, what: string): number {
  const text = value.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) {
    throw new SpecError(`${what} 无法解析为数字: ${JSON.stringify(value)}`);
  }
  return Number.parseFloat(text);
}

/**
 * 把 ``seq`` 归成一个整数列表（``number`` 返回空数组，由调用方走标量分支）。
 *
 * 与 ``num_parser`` 一致：字符串按 :data:`DELIMITERS_RE` 切分后取整 ——
 * 带小数点的显示值在这里会被拒绝，这是既有约定（显示值都是整数）。
 *
 * ⚠️ 开头的分隔符会切出一个空片段（``"/1 2"`` → ``["", "1", "2"]``），
 * Python 侧 ``int("")`` 会抛 ``ValueError``，这里同样抛 :class:`SpecError`
 * —— **不要**出于「顺手」把它过滤掉，那会让 Web 侧悄悄接受 Python 拒绝的输入。
 */
export function parseSequence(seq: Seq): number[] {
  if (typeof seq === "string") {
    const text = seq.trim();
    if (!text) return [];
    // 注意：JS 里是 ``字符串.split(正则)``，不是 ``正则.split(字符串)``
    return text.split(DELIMITERS_RE).map((part) => toInt(part, "显示值"));
  }
  if (Array.isArray(seq)) {
    return (seq as readonly number[]).map((v) => toInt(v, "显示值"));
  }
  return [];
}

/** ``"(1, 2)"`` → ``"1,2"``（剥离括号与所有空白）。 */
export function cleanPairText(text: string): string {
  return text.replace(PAIR_TRIM_RE, "");
}

/** ``"(1,2)|(3,4)"`` → ``[[1, 2], [3, 4]]``（修好的字符串分支）。 */
function parsePairsText(text: string): Pair[] {
  if (!text.trim()) return [];
  const out: Pair[] = [];
  const chunks = text.split("|");
  for (const [i, chunk] of chunks.entries()) {
    const cleaned = cleanPairText(chunk);
    if (!cleaned) continue;
    const parts = cleaned.split(",");
    if (parts.length !== 2) {
      throw new SpecError(`第 ${i} 段的区间文本 '${chunk}' 不是 '(min,max)' 形式`);
    }
    out.push([
      toFloat(parts[0] as string, `第 ${i} 段的区间下界`),
      toFloat(parts[1] as string, `第 ${i} 段的区间上界`),
    ]);
  }
  return out;
}

function asPairs(seq: string | Iterable<Pair>): Pair[] {
  if (typeof seq === "string") return parsePairsText(seq);
  return Array.from(seq, ([lo, hi]) => [Number(lo), Number(hi)] as Pair);
}

/** 标量 / 序列两条分支的公共骨架（分支顺序与 ``num_parser`` 一致）。 */
function scalarPairs(seq: Seq, mapper: (value: number) => Pair): ScalarOrSeq<Pair> {
  if (typeof seq === "number") return mapper(Math.trunc(seq));
  return parseSequence(seq).map(mapper);
}

/**
 * 区分「一个区间」与「一串区间」。
 *
 * ⚠️ 不能用 ``Array.isArray`` —— ``Pair`` 本身就是数组，``[lo, hi]`` 会被误判成
 * 「列表」，于是 ``toU32Interval`` 收到一个 ``number`` 而不是 ``[lo, hi]``，
 * 抛 ``TypeError: bounds is not iterable``。
 */
function isPair(value: ScalarOrSeq<Pair>): value is Pair {
  return Array.isArray(value) && typeof value[0] === "number";
}

// =========================================================================== 浮点
/**
 * 「向 0 取整（截断小数）」→ 原始浮点区间。
 *
 * 区间数 = ``r + 1``（**只有 truncation 家族会 ``+1``**，round 家族不会）。
 * ⚠️ 上下界用 ``i`` 与 ``i + 1``（不是 ``i ± 0.5``），且**不做** ``[0,1]`` 夹取。
 */
export function floatBeforeTruncation(
  seq: Seq,
  n: number,
  r: number,
  scaleFactor: number = SCALE_FACTOR,
): ScalarOrSeq<Pair> {
  const count = r + 1;
  if (count <= 0) {
    throw new SpecError(`变化范围 r=${r} 非法：r + 1 = ${count} 不能作为除数`);
  }
  const one = (value: number): Pair => {
    const i = value - n;
    return [
      Math.floor((i / count) * scaleFactor) / scaleFactor,
      Math.ceil(((i + 1) / count) * scaleFactor) / scaleFactor,
    ];
  };
  return scalarPairs(seq, one);
}

/**
 * 「四舍五入」→ 原始浮点区间。
 *
 * ⚠️ 除数是 ``r`` 而不是 ``r + 1``（与 truncation 不同），极值减半后夹到 ``[0, 1]``。
 */
export function floatBeforeRound(
  seq: Seq,
  n: number,
  r: number,
  scaleFactor: number = SCALE_FACTOR,
): ScalarOrSeq<Pair> {
  if (r <= 0) throw new SpecError(`变化范围 r=${r} 非法：不能作为除数`);
  const one = (value: number): Pair => {
    const i = value - n;
    const lo = Math.floor(((i - 0.5) / r) * scaleFactor) / scaleFactor;
    const hi = Math.ceil(((i + 0.5) / r) * scaleFactor) / scaleFactor;
    return [lo < 0 ? 0 : lo, hi > 1 ? 1 : hi];
  };
  return scalarPairs(seq, one);
}

/** 「向上取整」→ 原始浮点区间（与 truncation 相同：区间表示法表达不了开闭）。 */
export function floatBeforeCeil(
  seq: Seq,
  n: number,
  r: number,
  scaleFactor: number = SCALE_FACTOR,
): ScalarOrSeq<Pair> {
  return floatBeforeTruncation(seq, n, r, scaleFactor);
}

// =========================================================================== uint
/**
 * 浮点区间 ``[lo, hi]`` → 原始随机整数区间（``uint32``）。
 *
 * 逐位复刻 ``num_parser`` 的算式（含 ``-1`` / ``+1`` 的「外扩一格」）::
 *
 *     lo = int(lo * 2^31 - 1)   并夹到 >= 0
 *     hi = int(hi * 2^31 + 1)   并夹到 <= 0x7FFFFFFF
 *
 * ⚠️ ``int()`` 是**向 0 截断**（= ``Math.trunc``），所以下面显式写成
 * ``a > 0 ? a : 0``（与原代码一致，不要"顺手"改成 ``Math.max``）。
 */
export function toU32Interval(bounds: Pair): Pair {
  const [loF, hiF] = bounds;
  const a = Math.trunc(loF * 0x80000000 - 1);
  const b = Math.trunc(hiF * 0x80000000 + 1);
  return [a > 0 ? a : 0, b <= 0x7fffffff ? b : 0x7fffffff];
}

/** 「向 0 取整」→ 原始随机整数区间。 */
export function uintBeforeTruncation(
  seq: Seq,
  n: number,
  r: number,
  scaleFactor: number = SCALE_FACTOR,
): ScalarOrSeq<Pair> {
  const raw = floatBeforeTruncation(seq, n, r, scaleFactor);
  return isPair(raw) ? toU32Interval(raw) : raw.map(toU32Interval);
}

/** 「四舍五入」→ 原始随机整数区间（``mytask`` 用的就是这个）。 */
export function uintBeforeRound(
  seq: Seq,
  n: number,
  r: number,
  scaleFactor: number = SCALE_FACTOR,
): ScalarOrSeq<Pair> {
  const raw = floatBeforeRound(seq, n, r, scaleFactor);
  return isPair(raw) ? toU32Interval(raw) : raw.map(toU32Interval);
}

/** 「向上取整」→ 原始随机整数区间（同 truncation）。 */
export function uintBeforeCeil(
  seq: Seq,
  n: number,
  r: number,
  scaleFactor: number = SCALE_FACTOR,
): ScalarOrSeq<Pair> {
  return uintBeforeTruncation(seq, n, r, scaleFactor);
}

// =========================================================================== 区间
/** 把 ``"(0,1)|(0.2,0.9)"`` 或 ``[[0,1], ...]`` 归成 :class:`Interval` 序列。 */
export function floatIntervals(seq: string | Iterable<Pair>): Interval[] {
  return asPairs(seq).map(([lo, hi]) => new Interval(lo, hi));
}

/** ``convert2FloatRange`` 的纯函数版（不含 ctypes）。 */
export function convertToIntervals(seq: string | Iterable<Pair>): Interval[] {
  return floatIntervals(seq);
}

/**
 * ``convert2Range`` 的纯函数版（字符串分支已修好）。
 *
 * 与 ``num_parser.convert2Range`` 的区别只有一处：**返回约束值对象而不是
 * ``ctypes`` 结构体**。数值仍是 ``int(float(text))``（向 0 截断后 ``u32`` 回绕）。
 */
export function convertToConstraints(seq: string | Iterable<Pair>): IntervalConstraint[] {
  const pairs = asPairs(seq);
  if (pairs.length === 0) {
    throw new SpecError("区间列表为空：num == 0 会被 C 端静默拒绝，请先在调用方补默认区间");
  }
  // ⚠️ 构造真正的 ``IntervalConstraint``（不是匿名对象）：Python 这边正是这么写的，
  // 于是 ``lo > hi`` / 越出 uint32 会被**当场**拒掉，而不是拖到写 wasm 时。
  return pairs.map(([lo, hi]) => new IntervalConstraint(u32(Math.trunc(lo)), u32(Math.trunc(hi))));
}
