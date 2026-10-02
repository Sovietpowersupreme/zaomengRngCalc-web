/**
 * ``src_forge/const/stars.py`` 里那两个「显示值 → 原始随机整数」的换算（纯函数）。
 *
 * 为什么单独成文件
 * ----------------
 * 「种子反查」（``seed-resolve``）与七星（``stars``）**共用**这套换算 —— 玩家能拿到
 * 手的只有游戏界面上的数字，而 ``recover_seeds`` / ``seedFindbyRange`` 要的是 31 位
 * 随机整数。两个场景各写一遍必然会漂，而它漂了是「差 1」这种最难查的错。
 *
 * 两条式子
 * --------
 *
 * .. code-block:: text
 *
 *     原始浮点 → 随机整数 = int(v × 0x80000000)             # randomIntFromValue
 *     显示值   → 随机整数 = int(v ÷ 100000 × 0x80000000)    # saveGameValue
 *
 * 显示值 = 原始浮点 × ``SAVE_GAME_SCALE``（游戏界面把数乘了五个零），所以「保存游戏」
 * 多一步除法、也就多一次舍入 —— 能拿到原始浮点就该走前者。
 *
 * ⚠️ 三条不可动的细节
 * ------------------
 * 1. **运算顺序是契约的一部分**。Python 侧专门写了这件事：``v / 100000 * 2**31``
 *    与 ``v * (2**31 / 100000)`` 差一次舍入，在 ``int()`` 那一步上**真的会差 1**。
 *    所以下面照抄顺序，不许「化简」。
 * 2. **``SAVE_GAME_HALF`` 不能过位运算**。JS 的 ``0x80000000 | 0`` 是
 *    ``-2147483648``（ToInt32），而这里需要的是**数学上的** ``2147483648``。
 *    本文件里它只参与浮点乘法，所以安全 —— 但别把它挪去做位运算。
 * 3. ``Math.trunc`` 才是 Python ``int(x)``（向 0 截断）；正数上和 ``floor`` 等价，
 *    负数上不等价（``int(-1.5) == -1``，``Math.floor(-1.5) == -2``）。
 *
 * ⚠️ 这里**不**校验 31 位以外的范围、也**不**做游戏侧的合法性判断 —— 那是调用方
 * （``parseValue`` / ``parseTarget``）的事。
 */

import { SpecError } from "./errors";
import { KMAX } from "./values";

/**
 * 游戏显示时乘的那个 ``100000``。
 *
 * = Python ``const/stars.py::SAVE_GAME_SCALE``。``web/tests/consts.test.ts`` 把
 * ``consts.json`` 的 ``stars.save_game_scale`` 钉在同一个字面量上，两边不会各说各话。
 */
export const SAVE_GAME_SCALE = 100_000;

/**
 * 31 位随机数的分母 ``0x80000000``（**数学值** ``2147483648``，不是 ``-2147483648``）。
 *
 * = Python ``const/stars.py::SAVE_GAME_HALF``。参见文件头第 2 条。
 */
export const SAVE_GAME_HALF = 2_147_483_648;

/**
 * Python ``repr()`` 的近似物 —— **只用来拼报错文案**。
 *
 * 报错原文里那些 ``{value!r}`` 是 Python 的 ``repr``：字符串带引号、``None`` 不叫
 * ``null``。UI 上少一对引号无伤大雅，但 ``'abc'`` 与 ``abc`` 的差别会让「这到底是
 * 用户填的字符串还是某个内部值」变得看不出来，所以值得照抄。
 *
 * 已知的不追求项：字符串**内部**的引号/反斜杠不做 Python 那套转义（``repr`` 会在
 * 含单引号时改用双引号）。那种输入在两格文本框里不现实。
 */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return `'${value}'`;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "nan";
    if (value === Number.POSITIVE_INFINITY) return "inf";
    if (value === Number.NEGATIVE_INFINITY) return "-inf";
    return String(value);
  }
  return String(value);
}

/** ``inf`` / ``infinity`` / ``nan`` 的字面量（Python ``float()`` 认这些）。 */
const INF_NAN_RE = /^[+-]?(inf(inity)?|nan)$/i;

/**
 * Python ``float(text)`` 的等价物（``null`` = 转不动，即会 ValueError）。
 *
 * 与 ``Number(text)`` 的差别两处，都会**静默算错**，所以都得挡：
 *
 * * ``Number()`` 认 ``0x`` / ``0b`` / ``0o`` 前缀，Python 的 ``float()`` 不认 ——
 *   不挡就会把「十六进制当十进制」（同 ``scenario.ts::getFloat`` 的写法）；
 * * ``Number()`` 认 ``""`` 为 ``0``，Python 的 ``float("")`` 抛 ValueError ——
 *   空串在这里直接返回 ``null``。
 *
 * ``inf`` / ``nan`` 按 Python 那样**返回一个数**（而不是当成「不是数字」）：后面的
 * 31 位范围检查会挡下它们，报错文案也因此与 Python 逐字一致（「换算不出 31 位随机数」，
 * 而不是「必须是数字」）。
 */
export function pyFloat(value: unknown): number | null {
  const text = (value === null || value === undefined ? "" : String(value)).trim();
  if (text === "") return null;
  if (INF_NAN_RE.test(text)) {
    if (/nan/i.test(text)) return Number.NaN;
    return text.startsWith("-") ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  if (/^[+-]?0[xXbBoO]/.test(text)) return null;
  const number = Number(text);
  return Number.isNaN(number) ? null : number;
}

// =========================================================================== 取整
/** 复用一块 buffer 取 IEEE-754 位模式（``pyRoundN`` 每轮要调几次，别每轮 new）。 */
const F64_VIEW = new DataView(new ArrayBuffer(8));

/**
 * Python ``round(value, ndigits)``（``ndigits >= 0``）的等价物 —— **包括半值取偶**。
 *
 * 三件事不能偷懒：
 *
 * 1. ``Math.round`` 在半值上**向上**取整（``0.25 → 0.3``），Python 取偶（``0.2``）；
 * 2. 更阴的是 ``value * 10`` 这个乘法本身会**先舍入一次**：
 *    ``0.35 * 10 === 3.5000000000000004``，于是 ``Math.round`` 给出 ``0.4``，
 *    而 Python 看的是 0.35 的**精确二进制值**（比 0.35 小）⇒ ``0.3``；
 * 3. ``toFixed`` 的规则是「相等时取绝对值大的那个」，也不对。
 *
 * 所以这里走精确路线：把 double 拆成 ``m * 2^e``（``m`` 用 ``BigInt``），
 * 对 ``m * 10^n * 2^e`` 做**精确有理数**的「四舍六入五取偶」，再除 ``10^n``。
 * 输入范围就是玩家能敲出来的东西（装备侧 ``|value|`` 很小），商很小，
 * ``Number()`` 无损。
 *
 * ``ndigits < 0`` 按原样返回（本仓库用不到，Python 那份语义也容易记错）。
 */
export function pyRoundN(value: number, ndigits: number): number {
  const places = Math.trunc(ndigits);
  if (!Number.isFinite(value) || value === 0 || places < 0) return value;
  const scale = 10n ** BigInt(places);
  F64_VIEW.setFloat64(0, value);
  const bits = F64_VIEW.getBigUint64(0);
  const negative = bits >> 63n !== 0n;
  const rawExponent = Number((bits >> 52n) & 0x7ffn);
  const rawMantissa = bits & 0xfffffffffffffn;
  // 精确值 |value| = m * 2^e
  const m = rawExponent === 0 ? rawMantissa : rawMantissa + (1n << 52n);
  const e = rawExponent === 0 ? -1074 : rawExponent - 1023 - 52;
  // 要舍入的是 |value| * 10^n = (m * 10^n) * 2^e
  const scaled = m * scale;
  let quotient: bigint;
  if (e >= 0) {
    quotient = scaled << BigInt(e);
  } else {
    const denominator = 1n << BigInt(-e);
    quotient = scaled / denominator;
    const remainder = scaled % denominator;
    const doubled = remainder * 2n;
    // 四舍六入**五取偶**：正好一半时，取偶的那个。
    if (doubled > denominator || (doubled === denominator && quotient % 2n !== 0n)) {
      quotient += 1n;
    }
  }
  const magnitude = Number(quotient) / Number(scale);
  return negative ? -magnitude : magnitude;
}

/** Python ``round(value, 1)`` —— 一位小数、半值取偶（``0.25 → 0.2``、``0.35 → 0.3``）。 */
export function pyRound1(value: number): number {
  return pyRoundN(value, 1);
}

/**
 * Python ``round(value)``（**单参**）的等价物 —— 半值取偶到整数。
 *
 * 与 :func:`pyRoundN` 的分工：单参那支 Python 不缩放（走 ``float.__round__``），
 * 所以这里用 ``Math.floor`` + 余数判断精确处理，不需要 BigInt，快得多 ——
 * 装备预览每命中一次就要调十几次。
 *
 * 与 ``Math.round`` 的唯一差别是「恰好 .5」的方向：``Math.round(0.5) === 1``，
 * Python 取偶 ⇒ ``0``；``Math.round(-0.5) === -0``，Python ⇒ ``0``。
 */
export function pyRound(value: number): number {
  if (!Number.isFinite(value)) return value;
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  // 恰好一半 ⇒ 取偶（``floor % 2`` 对负数返回 ``-0`` / ``-1``，与 ``!== 0`` 配合正确）。
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * 一格输入 → 原始随机整数，顺带做 31 位范围检查。
 *
 * :param convert: ``number → number`` 的换算本体。**故意收成回调而不是一个因子** ——
 *     两个换算的运算顺序不一样（``v / 100000 * 2**31`` 与 ``v * 2**31``），
 *     合并成 ``v * (2**31 / 100000)`` 会多一次舍入、可能差 1，那是真的会改结果。
 * :param what: 报错文案里的主语（比如「原始浮点」）。
 * :throws SpecError: 不是数字，或换算后超出 ``0..KMAX``（``inf`` / ``nan`` 也算）。
 */
function randomIntOf(value: unknown, convert: (v: number) => number, what: string): number {
  const number = pyFloat(value);
  if (number === null) {
    throw new SpecError(`${what}必须是数字，得到 ${pyRepr(value)}`);
  }
  const converted = Math.trunc(convert(number));
  if (!Number.isFinite(converted)) {
    // ``inf`` / ``nan`` 落这里（= Python 的 OverflowError / ValueError）。
    throw new SpecError(`${what} ${pyRepr(value)} 换算不出 31 位随机数（0~${KMAX}）`);
  }
  if (!(0 <= converted && converted <= KMAX)) {
    throw new SpecError(`${what} ${pyRepr(value)} 换算成 ${converted}，超出 31 位随机数范围（0~${KMAX}）`);
  }
  return converted;
}

/**
 * 「保存游戏」的一格输入（显示值）→ 原始随机整数。
 *
 * 即 ``src`` 的 ``int(float(s) / 100000 * 0x80000000)`` —— 显示值 = 原始浮点 ×
 * ``SAVE_GAME_SCALE``，而原始浮点 = 原始整数 ÷ ``SAVE_GAME_HALF``，两步反解。
 *
 * :throws SpecError: 不是数字，或者换算后超出 31 位（``0..0x7fffffff``）。
 *     后者在游戏里不可能出现（显示值最大 = ``SAVE_GAME_SCALE``），但 ``src`` 的 C 侧
 *     ``check_seed`` 拿未掩码的入参去比，一旦入参带上第 31 位就**永远返回空集**；
 *     这里直接报错，比默默给出空结果好。
 */
export function saveGameValue(text: unknown): number {
  return randomIntOf(text, (v) => (v / SAVE_GAME_SCALE) * SAVE_GAME_HALF, "「保存游戏」的显示值");
}

/**
 * ``random()`` 的**原始浮点**（``[0, 1)``）→ 原始随机整数。
 *
 * 即 ``int(value * 0x80000000)``。和 :func:`saveGameValue` 的关系只有一步：
 * 显示值 = 原始浮点 × ``SAVE_GAME_SCALE``，所以这里**少一次除法**，也少一次舍入 ——
 * 只要游戏那边能拿到原始浮点，就该走这条路而不是先乘再除回来。
 *
 * :throws SpecError: 不是数字，或者换算后超出 31 位（``0..0x7fffffff``）。
 */
export function randomIntFromValue(value: unknown): number {
  return randomIntOf(value, (v) => v * SAVE_GAME_HALF, "「原始浮点」");
}
