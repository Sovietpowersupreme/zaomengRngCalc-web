/**
 * 用户可编辑的**换算公式**（迷你表达式语言）—— 解析 + 求值，**不用 ``eval``**。
 *
 * 为什么手写解析器
 * --------------
 * MV3 的扩展页面 CSP（``script-src 'self'``）**禁止** ``eval`` / ``new Function``，
 * 而「让用户自己写公式」就不能把公式编译进代码。任何走动态求值的方案（``eval``、
 * ``Function``、``setTimeout("...")``、``import(dataUrl)``）在 MV3 里都会当场炸，
 * 所以只能自己写 tokenizer + 递归下降。
 *
 * 语言（有意做得极小，够用就好）
 * ----------------------------
 *
 * .. code-block:: text
 *
 *     expr    := term (("+" | "-") term)*          # 左结合
 *     term    := unary (("*" | "/" | "%") unary)*  # 左结合
 *     unary   := ("+" | "-") unary | primary
 *     primary := number | ident "(" expr ")" | ident | "(" expr ")"
 *     number  := 十进制（可带小数/指数）| 0x 十六进制
 *
 * * 唯一变量是 ``n``（提取出来的那个随机数原文换成的浮点）；
 * * 函数：``int`` / ``trunc``（向 0 截断）、``floor`` / ``ceil`` / ``round`` / ``abs``，
 *   都只吃一个参数；
 * * ``round`` 用 JS 的 ``Math.round``（``.5`` 一律向 **+∞**，负数是 ``-2.5 → -2``）——
 *   与 Python 的「四舍六入五取偶」**不同**，所以文档里写死，别让人猜。
 *
 * ⚠️ **优先级天然左结合**，这点是契约：``n / 100000 * 0x80000000`` 必须**先除后乘**
 * （见 ``web/src/core/fromValue.ts`` 的注释：换个结合顺序真的会差 1）。
 * 递归下降里 ``term`` 就是一个 ``while`` 循环，所以顺序天然正确 —— 别改成
 * 「先扫乘除再算」那种做法。
 *
 * ⚠️ **``0x80000000`` 必须保持 ``2147483648``**。JS 的位运算会把它变成
 * ``-2147483648``（ToInt32），本模块全程只用 ``Number`` / ``*`` / ``/``，
 * 一处位运算都不许出现。
 *
 * 结果约定
 * -------
 * 求值结果先 ``Math.trunc``（= Python ``int``）再校验落在 ``0..0x7FFFFFFF``，
 * 越界 / ``NaN`` / ``inf`` 一律抛 :class:`FormulaError`。另外附带一个
 * **无假阳性**的诊断：若截断前的 ``x - floor(x) > 1 - 1e-6``，说明进来的浮点比真值
 * 小了不到 1 个整数（合法精确输入恒有 ``frac == 0``）⇒ 极可能是十进制位数不够被截断，
 * 面板会提示「差 1」。
 */

import { pyFloat } from "../../../src/core/fromValue";

/** 公式里唯一可用的变量名。 */
export const FORMULA_VARIABLE = "n";

/** 31 位随机数的上限（``int(v × 0x80000000)`` 的值域就是 ``0..0x7FFFFFFF``）。 */
export const MAX_RANDOM_INT = 0x7fffffff;

/**
 * 内置规则的公式。
 *
 * * ``SAVE_GAME``：游戏「保存游戏」那串显示值 = 原始浮点 × 100000，所以要 ÷100000；
 * * ``RAW``：直接就是 ``random()`` 的原始浮点。
 *
 * ⚠️ 两个字符串是**内置定义**，是「恢复默认」要还原的目标，也是文档与单测里的基准。
 */
export const DEFAULT_FORMULA_SAVE_GAME = "int(n / 100000 * 0x80000000)";
export const DEFAULT_FORMULA_RAW = "int(n * 0x80000000)";

/** 公式/数字解析失败。文案直接给用户看，所以写中文、带位置。 */
export class FormulaError extends Error {
  constructor(message: string) {
    super(message);
    // ``instanceof`` 在 TS 里要显式设置原型（``target: ES2022`` 下其实已经对了，
    // 但被打包器降到更低目标时会断，留着更稳）。
    this.name = "FormulaError";
    Object.setPrototypeOf(this, FormulaError.prototype);
  }
}

/** 编译好的公式：``(n) => number``。 */
export type CompiledFormula = (n: number) => number;

/** 单参数函数表（键就是公式里能写的名字）。 */
const FUNCTIONS: Readonly<Record<string, (x: number) => number>> = Object.freeze({
  int: Math.trunc,
  trunc: Math.trunc,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  abs: Math.abs,
});

/** 公式里可用的函数名（报错文案与设置页提示用）。 */
export const FORMULA_FUNCTIONS: readonly string[] = Object.freeze(Object.keys(FUNCTIONS));

/**
 * 设置页「公式怎么写」的说明行。
 *
 * 放在这里而不是设置页里，是为了跟着实现走：函数表 :data:`FUNCTIONS`、
 * 两条内置公式都在同一个文件里，改漏文案的概率小得多。
 */
export const FORMULA_HELP: readonly string[] = Object.freeze([
  `变量只有一个 n：从 URL 里提取到的那串数字，例 48363.584419712424。`,
  `运算符 + - * / % 与括号；数字可写十进制或十六进制（0x80000000）。`,
  `可用函数：${FORMULA_FUNCTIONS.join(" / ")}。`,
  `最外层建议套 int(...)：结果必须是 0 ~ ${MAX_RANDOM_INT} 的整数。`,
  `「保存游戏」那串是放大过的显示值，要 ÷100000：${DEFAULT_FORMULA_SAVE_GAME}`,
  `原始浮点（flash_ad_version.xml 那种）直接用：${DEFAULT_FORMULA_RAW}`,
]);

// =========================================================================== 词法
interface Token {
  /** ``"number"`` / ``"ident"`` / ``"op"`` / ``"eof"``。 */
  kind: "number" | "ident" | "op" | "eof";
  /** 字面量原文（``kind === "number"`` 时已转成数值存在 :attr:`value`）。 */
  text: string;
  /** 数字字面量的值。 */
  value: number;
  /** 在**去掉首尾空白后**的源串里的下标（0 起），报错用。 */
  at: number;
}

/** 运算符里「多字符优先」的一个都没有，所以单字符切分是安全的。 */
const OPERATORS = "+-*/%(),";

/** 标识符（变量 / 函数名）。 */
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/;

/** 十六进制整数（大小写均可）。 */
const HEX_RE = /0[xX][0-9a-fA-F]+/;

/** 十进制（可带小数与指数）。 */
const DECIMAL_RE = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;

/** 把源串切成 token；空白直接跳过。 */
function tokenize(source: string): Token[] {
  const text = source.trim();
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === ",") {
      tokens.push({ kind: "op", text: ch, value: 0, at: i });
      i += 1;
      continue;
    }
    if (OPERATORS.includes(ch)) {
      tokens.push({ kind: "op", text: ch, value: 0, at: i });
      i += 1;
      continue;
    }
    // 数字：``0x…`` 优先（否则 ``0x1`` 会被十进制规则吃成 ``0`` + 标识符 ``x1``）。
    const rest = text.slice(i);
    const hex = HEX_RE.exec(rest);
    if (hex !== null && hex.index === 0) {
      tokens.push({ kind: "number", text: hex[0], value: Number(hex[0]), at: i });
      i += hex[0].length;
      continue;
    }
    const dec = DECIMAL_RE.exec(rest);
    if (dec !== null && dec.index === 0) {
      tokens.push({ kind: "number", text: dec[0], value: Number(dec[0]), at: i });
      i += dec[0].length;
      continue;
    }
    const ident = IDENT_RE.exec(rest);
    if (ident !== null && ident.index === 0) {
      tokens.push({ kind: "ident", text: ident[0], value: 0, at: i });
      i += ident[0].length;
      continue;
    }
    throw new FormulaError(`第 ${i + 1} 个字符处的 "${ch}" 不认识（只能用数字、n、+ - * / % ( ) , 和函数名）`);
  }
  tokens.push({ kind: "eof", text: "", value: 0, at: text.length });
  return tokens;
}

// =========================================================================== 语法
/** 递归下降解析器（一次用完即弃，所以做成闭包而不是类）。 */
function parseTokens(source: string): CompiledFormula {
  const tokens = tokenize(source);
  let pos = 0;

  const peek = (): Token => tokens[pos] as Token;
  const next = (): Token => {
    const token = tokens[pos] as Token;
    pos += 1;
    return token;
  };
  const expectOp = (op: string): void => {
    const token = peek();
    if (token.kind !== "op" || token.text !== op) {
      throw new FormulaError(`第 ${token.at + 1} 个字符处缺少 "${op}"`);
    }
    pos += 1;
  };

  /** ``expr := term (("+" | "-") term)*`` —— 左结合。 */
  const parseExpr = (): CompiledFormula => {
    let left = parseTerm();
    for (;;) {
      const token = peek();
      if (token.kind !== "op" || (token.text !== "+" && token.text !== "-")) break;
      pos += 1;
      const right = parseTerm();
      const l = left;
      const op = token.text;
      left = op === "+" ? (n) => l(n) + right(n) : (n) => l(n) - right(n);
    }
    return left;
  };

  /** ``term := unary (("*" | "/" | "%") unary)*`` —— 左结合（这是精度契约）。 */
  const parseTerm = (): CompiledFormula => {
    let left = parseUnary();
    for (;;) {
      const token = peek();
      if (token.kind !== "op") break;
      const op = token.text;
      if (op !== "*" && op !== "/" && op !== "%") break;
      pos += 1;
      const right = parseUnary();
      const l = left;
      if (op === "*") left = (n) => l(n) * right(n);
      else if (op === "/") left = (n) => l(n) / right(n);
      // ``%`` 与 JS 一致（余数符号跟被除数）。
      else left = (n) => l(n) % right(n);
    }
    return left;
  };

  /** ``unary := ("+" | "-") unary | primary``。 */
  const parseUnary = (): CompiledFormula => {
    const token = peek();
    if (token.kind === "op" && (token.text === "+" || token.text === "-")) {
      pos += 1;
      const operand = parseUnary();
      return token.text === "-" ? (n) => -operand(n) : operand;
    }
    return parsePrimary();
  };

  /** ``primary := number | ident "(" expr ")" | ident | "(" expr ")"``。 */
  const parsePrimary = (): CompiledFormula => {
    const token = next();
    if (token.kind === "number") {
      const value = token.value;
      return () => value;
    }
    if (token.kind === "ident") {
      const isCall = peek().kind === "op" && peek().text === "(";
      if (!isCall) {
        if (token.text !== FORMULA_VARIABLE) {
          throw new FormulaError(`第 ${token.at + 1} 个字符处的 "${token.text}" 不是变量（只有 "${FORMULA_VARIABLE}" 可用，函数名后面要跟括号）`);
        }
        return (n) => n;
      }
      const fn = FUNCTIONS[token.text];
      if (fn === undefined) {
        throw new FormulaError(`第 ${token.at + 1} 个字符处的函数 "${token.text}" 不存在（可用：${FORMULA_FUNCTIONS.join(" / ")}）`);
      }
      expectOp("(");
      const arg = parseExpr();
      if (peek().kind === "op" && peek().text === ",") {
        throw new FormulaError(`"${token.text}" 只吃一个参数，不接受逗号`);
      }
      expectOp(")");
      return (n) => fn(arg(n));
    }
    if (token.kind === "op" && token.text === "(") {
      const inner = parseExpr();
      expectOp(")");
      return inner;
    }
    if (token.kind === "eof") {
      // 空公式和「公式没写完」（例如 ``int(n *``）都会走到这里，分开报更好懂。
      throw new FormulaError(
        source.trim() === ""
          ? "公式是空的"
          : `公式到第 ${token.at} 个字符就断了：末尾少了一个数或变量`,
      );
    }
    throw new FormulaError(`第 ${token.at + 1} 个字符处的 "${token.text}" 不能作为表达式开头`);
  };

  const compiled = parseExpr();
  const tail = peek();
  if (tail.kind !== "eof") {
    throw new FormulaError(`第 ${tail.at + 1} 个字符起多出了 "${tail.text}"（公式应当到那里结束）`);
  }
  return compiled;
}

/** 编译缓存：设置页每敲一个键都会校验一遍，别每次重解析。 */
const CACHE = new Map<string, CompiledFormula>();

/**
 * 编译公式（带缓存）。
 *
 * @throws FormulaError 语法错误。
 */
export function compileFormula(source: string): CompiledFormula {
  const cached = CACHE.get(source);
  if (cached !== undefined) return cached;
  const compiled = parseTokens(source);
  // 缓存上限只是防「用户狂敲」把内存撑爆；到顶就整体清空，简单且够用。
  if (CACHE.size > 256) CACHE.clear();
  CACHE.set(source, compiled);
  return compiled;
}

/** 校验公式：``null`` = 通过，否则是给用户看的错误文案。 */
export function validateFormula(source: string): string | null {
  try {
    compileFormula(source);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * 求值结果（:func:`evaluateFormula` 的返回）。
 *
 * 这里**不做**「输入疑似被截断、值可能小了 1」这类猜测：默认公式自带 ``int(...)``，
 * 截断发生在公式内部，外面拿到的永远是整数 —— 改用「小数部分接近 1」当判据只会永远为假。
 * 真要查这类问题，去看面板上的「最近请求」日志比对原文。
 */
export interface FormulaOutcome {
  /** ``Math.trunc`` 后的 31 位随机整数（已校验在 ``0..0x7FFFFFFF``）。 */
  readonly value: number;
  /** 截断前的原始结果（诊断/日志用）。 */
  readonly raw: number;
}

/**
 * 把公式作用在 ``n`` 上，并做 31 位范围校验。
 *
 * @throws FormulaError 语法错误 / 结果不是有限数 / 越界。
 */
export function evaluateFormula(source: string, n: number): FormulaOutcome {
  const raw = compileFormula(source)(n);
  if (!Number.isFinite(raw)) {
    throw new FormulaError(`公式算出 ${String(raw)}，不是有限数（检查一下是不是溢出了）`);
  }
  const value = Math.trunc(raw);
  if (value < 0 || value > MAX_RANDOM_INT) {
    throw new FormulaError(`公式算出 ${value}，超出 31 位随机数范围 0..${MAX_RANDOM_INT}`);
  }
  return { value, raw };
}

/**
 * 把提取到的文本换成浮点 —— 与 Python ``float()`` 对齐（复用 web 侧的 ``pyFloat``）。
 *
 * ``pyFloat`` 挡掉了 ``Number("0x10")``、``Number("")`` 这些 Python 不认的写法，
 * 保证扩展与 `web/` 计算器对同一串文字得到**同一个 double**。
 *
 * @throws FormulaError 不是数字。
 */
export function parseRandomText(text: string): number {
  const value = pyFloat(text);
  if (value === null) {
    throw new FormulaError(`"${text}" 不是数字（Python float() 认不出来）`);
  }
  return value;
}
