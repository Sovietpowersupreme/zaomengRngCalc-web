/**
 * ``RangeCodec`` 的跨语言对拍：回放 ``web/tests/fixtures/ranges.json``。
 *
 * 夹具由 ``web/tools/make_fixtures.py`` 用**Python 侧实现**（``src_forge.core.ranges``）
 * 采样生成 —— 也就是说这里的 350+ 条用例全部是「Python 算出来的权威答案」。
 * Web 侧一旦有位运算/取整/夹取上的偏差，这个测试会立刻炸。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { SpecError } from "../src/core/errors";
import * as R from "../src/core/ranges";

interface UintCase {
  mode: "truncate" | "round" | "ceil";
  shape: "scalar" | "list" | "str";
  n: number;
  r: number;
  seq: number | number[] | string;
  out: number[] | number[][];
}

interface Fixture {
  schema: number;
  seed: number;
  scale_factor: number;
  uint: UintCase[];
  uint_text: Omit<UintCase, "shape">[];
  constraints: { text: string; out: number[][] }[];
  float: { text: string; out: number[][] }[];
  errors: { mode: UintCase["mode"]; n: number; r: number; seq: number | string; why: string }[];
}

const fx = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/ranges.json", import.meta.url)), "utf8"),
) as Fixture;

const MODE_FN = {
  truncate: R.uintBeforeTruncation,
  round: R.uintBeforeRound,
  ceil: R.uintBeforeCeil,
} as const;

describe("RangeCodec 对拍（夹具来自 Python 实现）", () => {
  it("夹具本身是自洽的", () => {
    expect(fx.schema).toBe(1);
    expect(fx.scale_factor).toBe(R.SCALE_FACTOR);
    expect(fx.uint.length).toBeGreaterThan(200);
    expect(fx.uint_text.length).toBeGreaterThan(50);
    for (const c of fx.uint) {
      const isScalar = typeof c.seq === "number";
      expect(isScalar).toBe(c.shape === "scalar");
    }
  });

  it("标量 / 数组 / 分隔符串三种输入都与 Python 一致", () => {
    const bad: string[] = [];
    for (const [i, c] of fx.uint.entries()) {
      const got = MODE_FN[c.mode](c.seq, c.n, c.r);
      if (JSON.stringify(got) !== JSON.stringify(c.out)) {
        bad.push(
          `#${i} ${c.mode}(${JSON.stringify(c.seq)}, n=${c.n}, r=${c.r}) 得到 ${JSON.stringify(got)} 期望 ${JSON.stringify(c.out)}`,
        );
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it("分隔符串（含中文标点）与 Python 一致", () => {
    const bad: string[] = [];
    for (const [i, c] of fx.uint_text.entries()) {
      const got = MODE_FN[c.mode](c.seq, c.n, c.r);
      if (JSON.stringify(got) !== JSON.stringify(c.out)) {
        bad.push(
          `#${i} ${c.mode}(${JSON.stringify(c.seq)}, n=${c.n}, r=${c.r}) 得到 ${JSON.stringify(got)} 期望 ${JSON.stringify(c.out)}`,
        );
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it("convertToConstraints 的字符串分支可用（Python 原实现里从没工作过）", () => {
    for (const c of fx.constraints) {
      // ⚠️ 返回的是 ``IntervalConstraint`` 实例（与 Python 一致，才有上下界校验），
      // 所以这里只比区间端点，而不是整对象比较。
      const got = R.convertToConstraints(c.text).map((p) => [p.lo, p.hi]);
      expect({ text: c.text, got }).toEqual({ text: c.text, got: c.out });
    }
  });

  it("floatIntervals 与 Python 一致", () => {
    for (const c of fx.float) {
      const got = R.floatIntervals(c.text).map((iv) => [iv.lo, iv.hi]);
      expect({ text: c.text, got }).toEqual({ text: c.text, got: c.out });
    }
  });

  it("该拒绝的输入仍然拒绝", () => {
    for (const e of fx.errors) {
      expect(() => MODE_FN[e.mode](e.seq, e.n, e.r), e.why).toThrow(SpecError);
    }
    expect(() => R.convertToConstraints([])).toThrow(SpecError);
    expect(() => R.convertToConstraints("")).toThrow(SpecError);
  });

  it("cleanPairText 真的剥掉了括号与空白", () => {
    expect(R.cleanPairText("(1, 2)")).toBe("1,2");
    expect(R.cleanPairText(" [ 3 , 4 ] ")).toBe("3,4");
  });
});
