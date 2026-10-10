/**
 * 文本区间 → ``(lo, hi)`` —— ``src_forge/const/resolution.py::parse_pair`` 的 1:1 翻译。
 *
 * 为什么单独成文件
 * ----------------
 * 「用户在一个文本框里敲的区间」这件事在三个地方出现，而它们**必须**逐字同解，
 * 否则同一个字符串在不同场景里会给出不同的搜索区间（那是「差 1」级别最难查的错）：
 *
 * =================  ===========================================  =================================
 * 场景               字段                                         语义
 * =================  ===========================================  =================================
 * ``capture``        ``qual_*`` / ``base_*``                      ``stripParenContent = true``（默认）
 * ``rechild``        ``extra_*`` / ``base_*``                     同上
 * 装备侧             ``target_*``                                 ``stripParenContent = false``
 * =================  ===========================================  =================================
 *
 * 两种模式的差别是**历史遗留**（数据表值会把 ``"16(16)"`` 的括号注释一起丢掉，
 * 用户输入只丢括号字符本身），Python 侧专门写了「不要合并」——
 * 这里照抄两个分支，别「顺手」统一成一个。
 *
 * ⚠️ 与 Python 的两处已知差异（都不影响现有表单，因为两组输入都是纯文本）
 * ---------------------------------------------------------------------
 * * Python ``float()`` 认下划线分隔（``float("1_000") == 1000.0``），
 *   这里走的 :func:`pyFloat` 基于 ``Number()``，不认 —— 得到 ``null``（= 解析失败）。
 *   用户在两格文本框里写 ``1_000`` 不现实，与其自造一套下划线规则，不如如实拒绝。
 * * 结构化分支里的 ``bool``：Python 的 ``isinstance(True, int)`` 为真、``float(True) == 1.0``；
 *   这里同样把 ``boolean`` 当 ``0 / 1`` 处理（`pyFloat` 之后的 ``Number(true)`` 本来就是这语义）。
 */

import { pyFloat } from "./fromValue";

/**
 * Python ``_RANGE_SPLIT``：把 ``"100~150"`` / ``"100-150"`` / ``"100,150"`` /
 * ``"100 150"`` 都切得开。
 *
 * ⚠️ 与 :data:`ranges.DELIMITERS_RE` 是**同一个字符类**但**不是同一个常量** ——
 * 那边属于 ``core/ranges.py``（``num_parser`` 的分隔符），这边属于
 * ``const/resolution.py``。两处目前内容一致，但它们的「真源」不同，所以各留一份。
 */
const RANGE_SPLIT_RE = /[,，|~·/、；;\s]+/u;

/** Python ``_PAREN_CONTENT``：``"16(16)"`` → ``"16"``（括号**连同内容**一起丢掉）。 */
const PAREN_CONTENT_RE = /\([^)]*\)|（[^）]*）/gu;

/** Python ``_PAREN_ONLY``：``"(100)"`` → ``"100"``（只丢括号字符）。 */
const PAREN_ONLY_RE = /[()（）]/gu;

/** :func:`parsePair` 的可选行为。 */
export interface ParsePairOptions {
  /**
   * ``true``（默认，**数据表值**）：``"16(16)"`` → ``16``。
   * ``false``（**用户输入**）：``"16(16)"`` → 解析失败（括号里那串还在）。
   */
  stripParenContent?: boolean;
}

/**
 * 把 ``"100~150"`` / ``"16(16)"`` / ``"0.5"`` / ``(100, 150)`` 拆成 ``(lo, hi)``。
 *
 * 单值 → ``(v, v)``；解析不了 → ``null``（Python 返回 ``None``）。
 *
 * :param text: 字符串、数字、或长度 >= 1 的数字数组。**保持 Python 的分支顺序**：
 *     结构化输入优先按数值解读（``(100.0, 150.0)`` 是数据表里的元组，如果当字符串
 *     处理会被 ``_PAREN_CONTENT`` 整个吃掉）。
 */
export function parsePair(
  text: unknown,
  options: ParsePairOptions = {},
): readonly [number, number] | null {
  const stripParenContent = options.stripParenContent ?? true;
  if (text === null || text === undefined) return null;
  if (typeof text === "number" || typeof text === "boolean") {
    const number = pyFloat(typeof text === "boolean" ? (text ? 1 : 0) : text);
    return number === null ? null : [number, number];
  }
  if (Array.isArray(text)) {
    // Python ``len(text) == 1`` → 单值；``>= 2`` → 前两个；``0`` → None。
    if (text.length === 0) return null;
    const first = pyFloat(text[0]);
    if (first === null) return null;
    if (text.length === 1) return [first, first];
    const second = pyFloat(text[1]);
    return second === null ? null : [first, second];
  }
  let raw = String(text).trim();
  raw = stripParenContent
    ? raw.replace(PAREN_CONTENT_RE, "").trim()
    : raw.replace(PAREN_ONLY_RE, "").trim();
  if (raw === "") return null;
  const parts = raw.split(RANGE_SPLIT_RE).filter((part) => part !== "");
  if (parts.length === 0) return null;
  const first = pyFloat(parts[0]);
  if (first === null) return null;
  if (parts.length === 1) return [first, first];
  const second = pyFloat(parts[1]);
  return second === null ? null : [first, second];
}

/**
 * ``(100.0, 150.0)`` → ``"100~150"``；``lo === hi`` → ``"100"``。
 *
 * = Python ``const/resolution.py::format_pair``。是 :func:`parsePair` 的逆（对能解析的
 * 输入成立），给 UI 回显用。
 */
export function formatPair(lo: number, hi: number, precision = 0): string {
  let textLo: string;
  let textHi: string;
  if (precision <= 0) {
    textLo = String(Math.round(lo));
    textHi = String(Math.round(hi));
  } else {
    textLo = trimZeros(lo.toFixed(precision));
    textHi = trimZeros(hi.toFixed(precision));
  }
  return textLo === textHi ? textLo : `${textLo}~${textHi}`;
}

/** 去掉小数末尾的 ``0`` 与落单的小数点（``"1.50"`` → ``"1.5"``，``"2.00"`` → ``"2"``）。 */
function trimZeros(text: string): string {
  return text.includes(".") ? text.replace(/0+$/u, "").replace(/\.$/u, "") : text;
}
