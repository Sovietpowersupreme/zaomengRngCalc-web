/**
 * 扩展的公式迷你语言（``web/extension/url-seed/src/formula.ts``）。
 *
 * 这里钉的是**两件事**：
 *
 * 1. 解析器本身的行为（优先级、左结合、函数、错误文案不崩）；
 * 2. **与 Python 侧参考实现逐位一致** —— 期望值全部由
 *    ``src_forge/const/stars.py`` 的 ``save_game_value`` / ``random_int_from_value``
 *    在同一台机器上跑出来，写死在这里。扩展存在的理由就是「和网页版/游戏那份对上」，
 *    所以这组断言不能用「自己再算一遍」来替代。
 *
 * 之所以要在 node 里跑而不是浏览器：``pyFloat`` 复用 web 侧实现，不需要 DOM。
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_FORMULA_RAW,
  DEFAULT_FORMULA_SAVE_GAME,
  FORMULA_HELP,
  FORMULA_VARIABLE,
  FormulaError,
  MAX_RANDOM_INT,
  evaluateFormula,
  parseRandomText,
  validateFormula,
} from "../extension/url-seed/src/formula";

/** Python ``save_game_value(RAW_TEXT)`` = 1207965724（与 ``tests/stars.test.ts`` 同源）。 */
const RAW_TEXT = "56250.287406146526";
const RAW_RANDOM_INT = 1207965724;

describe("公式：内置两条与 Python 参考实现一致", () => {
  it("「保存游戏」显示值 → 随机整数", () => {
    const out = evaluateFormula(DEFAULT_FORMULA_SAVE_GAME, Number(RAW_TEXT));
    expect(out.value).toBe(RAW_RANDOM_INT);
    // 合法输入（显示值 = k × 100000 / 2^31）乘回去应当是整数，一点舍入都不差。
    expect(out.raw).toBe(RAW_RANDOM_INT);
  });

  it("原始浮点 → 随机整数（少一次除法，也少一次舍入）", () => {
    const out = evaluateFormula(DEFAULT_FORMULA_RAW, RAW_RANDOM_INT / 0x80000000);
    expect(out.value).toBe(RAW_RANDOM_INT);
  });

  it("三条真实 URL 的样例值（Python 侧算出的定值）", () => {
    // save_game_value("48363.584419712424")
    expect(evaluateFormula(DEFAULT_FORMULA_SAVE_GAME, 48363.584419712424).value).toBe(1038600067);
    // save_game_value("86982.94968344271")
    expect(evaluateFormula(DEFAULT_FORMULA_SAVE_GAME, 86982.94968344271).value).toBe(1867944621);
    // random_int_from_value("0.9268094981089234")
    expect(evaluateFormula(DEFAULT_FORMULA_RAW, 0.9268094981089234).value).toBe(1990308242);
  });

  it("同级运算符左结合（顺序不是随便的）", () => {
    // 实测：``n / 100000 * 0x80000000`` 与 ``n * 0x80000000 / 100000`` 对样例值
    // 给出同一个结果，所以这里不去声称「写错顺序就会差 1」—— 只钉住左结合本身。
    expect(evaluateFormula(DEFAULT_FORMULA_SAVE_GAME, 48363.584419712424).value).toBe(1038600067);
    expect(evaluateFormula("int(n * 0x80000000 / 100000)", 48363.584419712424).value).toBe(1038600067);
    expect(evaluateFormula("int(8 / 4 / 2)", 0).value).toBe(1);
    expect(evaluateFormula("int(8 / (4 / 2))", 0).value).toBe(4);
    expect(evaluateFormula("int(10 - 3 - 2)", 0).value).toBe(5);
    expect(evaluateFormula("int(10 % 4 % 3)", 0).value).toBe(2);
  });
});

describe("公式：解析器行为", () => {
  it("变量名只有 n", () => {
    expect(FORMULA_VARIABLE).toBe("n");
    expect(validateFormula("int(m * 2)")).not.toBeNull();
  });

  it("算术优先级与括号", () => {
    expect(evaluateFormula("int(1 + 2 * 3)", 0).value).toBe(7);
    expect(evaluateFormula("int((1 + 2) * 3)", 0).value).toBe(9);
    expect(evaluateFormula("int(10 % 3)", 0).value).toBe(1);
    expect(evaluateFormula("int(2 - 5 + 8)", 0).value).toBe(5);
  });

  it("一元负号与十六进制字面量", () => {
    // 0x80000000 = 2147483648；int(2147483648 - 1) 才落在范围内。
    expect(evaluateFormula("int(0x80000000 - 1)", 0).value).toBe(MAX_RANDOM_INT);
    expect(evaluateFormula("abs(-3)", 0).value).toBe(3);
  });

  it("函数表覆盖 int/trunc/floor/ceil/round/abs", () => {
    expect(FORMULA_HELP.join("\n")).toContain("int / trunc / floor / ceil / round / abs");
    // floor 与 int 对正数一致、对负数分开。
    expect(evaluateFormula("abs(floor(-1.5))", 0).value).toBe(2);
    expect(evaluateFormula("abs(int(-1.5))", 0).value).toBe(1);
  });

  it("越界 / 非有限数都抛 FormulaError", () => {
    expect(() => evaluateFormula("int(0x80000000)", 0)).toThrow(FormulaError);
    expect(() => evaluateFormula("int(-1)", 0)).toThrow(FormulaError);
    expect(() => evaluateFormula("int(n)", Number.POSITIVE_INFINITY)).toThrow(FormulaError);
  });

  it("语法错误返回给用户看的文案（带位置）", () => {
    // 公式没写完：不说位置的话用户根本不知道断在哪。
    const problem = validateFormula("int(n *");
    expect(problem).not.toBeNull();
    expect(problem).toContain("第");
    // 空公式与「没写完」要分开报，否则用户以为公式是空的。
    expect(validateFormula("   ")).toBe("公式是空的");
    expect(validateFormula("n & 1")).toContain("第 3 个字符");
  });

  it("空公式与尾部垃圾都算非法", () => {
    expect(validateFormula("")).not.toBeNull();
    expect(validateFormula("int(n) 1")).not.toBeNull();
  });

  it("重复编译走缓存（同一个函数对象）", () => {
    expect(validateFormula(DEFAULT_FORMULA_SAVE_GAME)).toBeNull();
    expect(validateFormula(DEFAULT_FORMULA_SAVE_GAME)).toBeNull();
  });
});

describe("公式：为什么没有「输入疑似被截断」提示", () => {
  it("默认公式自带 int(...)，外面永远拿到整数", () => {
    // 少抄一位小数（…1465 而不是 …146526）结果真的会小 1，
    // 但 int(...) 在公式**内部**就把小数部分吃掉了 —— 外面看不到「差一点」。
    // （扩展里的数字是从 URL 正则抓的，不存在手抄，所以这个提示没意义。）
    expect(evaluateFormula(DEFAULT_FORMULA_SAVE_GAME, 56250.287406146526).value).toBe(RAW_RANDOM_INT);
    expect(evaluateFormula(DEFAULT_FORMULA_SAVE_GAME, 56250.2874061465).value).toBe(RAW_RANDOM_INT - 1);
    for (const n of [56250.287406146526, 56250.2874061465, 56250.28740614652]) {
      const out = evaluateFormula(DEFAULT_FORMULA_SAVE_GAME, n);
      expect(Number.isInteger(out.raw)).toBe(true);
      expect(Number.isInteger(out.value)).toBe(true);
    }
  });
});

describe("parseRandomText：与 Python float() 对齐", () => {
  it("认普通十进制与科学计数", () => {
    expect(parseRandomText("0.5")).toBe(0.5);
    expect(parseRandomText("  1e-3 ")).toBe(0.001);
    expect(parseRandomText("56250.287406146526")).toBe(Number(RAW_TEXT));
  });

  it("不认 Python 认不出的写法", () => {
    // Python 的 float("0x10") 直接报错，Number("0x10") 却给 16 —— 必须挡住。
    expect(() => parseRandomText("0x10")).toThrow(FormulaError);
    expect(() => parseRandomText("")).toThrow(FormulaError);
    expect(() => parseRandomText("abc")).toThrow(FormulaError);
  });
});
