/**
 * ``web/tests/fixtures/specs.json`` 的回放测试 —— `SeedSpec` 契约的 Python/Web 对拍。
 *
 * 夹具由 ``web/tools/make_spec_fixtures.py`` 用**真 Python 实现**生成，四个区段：
 *
 * * `roundtrip`：`spec_from_dict(d)` → `to_dict()` 的规范化结果（含默认值填充、
 *   `step < 1` 回落、uint32 回绕）；
 * * `bounds`：`num` / `step` / `u32_bounds`（后端填 `uRange` 用的原始边界）；
 * * `errors`：**必须抛 `SpecError`** 的输入 + 一句特征子串；
 * * `steps`：`require_unit_step` 的判定。
 *
 * ⚠️ 对拍用 `JSON.stringify` 逐字比较，因此**键的顺序也是契约的一部分**
 * （Python `json.dumps` 保持插入顺序，本模块的 `toDict()` 也照抄同一顺序）。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SpecError } from "../src/core/errors";
import {
  GROWTH_MAX_TENTHS,
  GROWTH_MIN_TENTHS,
  GrowthWuxingSpec,
  IntervalConstraint,
  IntervalSpec,
  MaskConstraint,
  MaskSpec,
  NON_ENUMERABLE_KINDS,
  NON_STEPPED_KINDS,
  PoolSpec,
  RollSpec,
  SeedSpec,
  WuxingSpec,
  constraintFromDict,
  requireUnitStep,
  specFromDict,
  type SpecInput,
} from "../src/core/spec";
import { MAX_INPUT, M32, WUXING_HAS, type U32Pair } from "../src/core/values";

interface SpecFixture {
  readonly schema: number;
  readonly roundtrip: readonly { readonly in: SpecInput; readonly out: SpecInput }[];
  readonly bounds: readonly {
    readonly in: SpecInput;
    readonly kind: string;
    readonly num: number;
    readonly step: number;
    readonly u32_bounds: readonly (readonly number[])[];
  }[];
  readonly errors: readonly { readonly in: SpecInput; readonly match: string }[];
  readonly steps: readonly { readonly in: SpecInput; readonly match: string }[];
}

const FX = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/specs.json", import.meta.url)), "utf8"),
) as SpecFixture;

/** 逐字比较（含键序）—— 这就是序列化契约本身的断言方式。 */
function dict(spec: SeedSpec): string {
  return JSON.stringify(spec.toDict());
}

describe("SeedSpec 契约对拍 specs.json", () => {
  it("夹具自身可用", () => {
    expect(FX.schema).toBe(1);
    expect(FX.roundtrip.length).toBeGreaterThanOrEqual(20);
    expect(FX.bounds.length).toBe(FX.roundtrip.length);
    expect(FX.errors.length).toBeGreaterThanOrEqual(20);
    expect(FX.steps.length).toBeGreaterThanOrEqual(5);
  });

  it.each(FX.roundtrip.map((c, i) => [i, c] as const))("roundtrip #%i", (_i, c) => {
    const spec = specFromDict(c.in);
    // 1. 规范化后的字典逐字相同（键序也是契约）
    expect(dict(spec)).toBe(JSON.stringify(c.out));
    // 2. `kind` 一致，且实例类型正确
    expect(spec.kind).toBe(c.out["kind"]);
    expect(spec.step).toBe(c.out["step"]);
    // 3. 幂等：再喂一遍规范化结果，输出不变
    expect(dict(specFromDict(spec.toDict()))).toBe(dict(spec));
    // 4. 基类的静态工厂与顶层函数同源
    expect(dict(SeedSpec.fromDict(c.in))).toBe(dict(spec));
  });

  it.each(FX.bounds.map((c, i) => [i, c] as const))("bounds #%i", (_i, c) => {
    const spec = specFromDict(c.in);
    expect(spec.kind).toBe(c.kind);
    expect(spec.num).toBe(c.num);
    expect(spec.step).toBe(c.step);
    expect(spec.u32Bounds.map((p) => [p.lo, p.hi])).toEqual(c.u32_bounds.map((p) => [...p]));
    // 每个槽位都必须是合法 uint32（`writeURange` 会 `u32()` 后再写内存）
    for (const p of spec.u32Bounds) {
      expect(Number.isInteger(p.lo)).toBe(true);
      expect(Number.isInteger(p.hi)).toBe(true);
      expect(p.lo).toBeGreaterThanOrEqual(0);
      expect(p.hi).toBeLessThanOrEqual(M32);
    }
  });

  it.each(FX.errors.map((c, i) => [i, c] as const))("error #%i", (_i, c) => {
    expect(() => specFromDict(c.in)).toThrowError(SpecError);
    // 消息只比特征子串：Python 用 ``{kind!r}``，这里用 ``JSON.stringify``，拼写必然不同
    try {
      specFromDict(c.in);
      expect.unreachable("本应抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(SpecError);
      expect((err as SpecError).message).toContain(c.match);
    }
  });

  it.each(FX.steps.map((c, i) => [i, c] as const))("requireUnitStep #%i", (_i, c) => {
    const spec = specFromDict(c.in);
    if (c.match === "") {
      expect(() => requireUnitStep(spec)).not.toThrow();
      return;
    }
    expect(() => requireUnitStep(spec)).toThrowError(SpecError);
    try {
      requireUnitStep(spec);
      expect.unreachable("本应抛错");
    } catch (err) {
      expect((err as SpecError).message).toContain(c.match);
    }
  });
});

describe("约束值对象（夹具覆盖不到的语义）", () => {
  it("IntervalConstraint 满足 U32Pair，可用于 writeURange", () => {
    const c = new IntervalConstraint(3, 9);
    const pair: U32Pair = c;
    expect([pair.lo, pair.hi]).toEqual([3, 9]);
    expect(c.contains(3)).toBe(true);
    expect(c.contains(9)).toBe(true);
    expect(c.contains(2)).toBe(false);
    expect(c.contains(10)).toBe(false);
    expect(c.toCMin()).toBe(3);
    expect(c.toCMin(0xff)).toBe(3);
    expect(c.kind).toBe("interval");
  });

  it("IntervalConstraint 拒绝越界与反序", () => {
    expect(() => new IntervalConstraint(-1, 5)).toThrowError(/越出 uint32/);
    expect(() => new IntervalConstraint(0, M32 + 1)).toThrowError(/越出 uint32/);
    expect(() => new IntervalConstraint(5, 4)).toThrowError(/上下界反了/);
    // 端点相等是合法区间（只匹配一个值）
    expect(new IntervalConstraint(7, 7).contains(7)).toBe(true);
  });

  it("MaskConstraint：expected 抹掉 mask 之外的高位", () => {
    const c = new MaskConstraint(0xffff, 0x12345678);
    expect(c.expected).toBe(0x5678);
    // ⚠️ ``to_c_min`` 的默认 ``imask`` 是 ``M32`` —— 那时返回的是**原值**
    // （Python 同样如此）。只有 ``MaskSpec.u32_bounds`` 才传自己的 ``imask``。
    expect(c.toCMin()).toBe(0x12345678);
    expect(c.toCMin(0xffff)).toBe(0x5678);
    expect(c.contains(0x12345678)).toBe(true);
    expect(c.contains(0x12345679)).toBe(false);
    expect(c.contains(0x5678)).toBe(true); // 高位本来就会被抹掉
  });

  it("MaskConstraint：``>>> 0`` 语义（不能退回 ``& M32``）", () => {
    // JS 里 ``0xffffffff & 0xffffffff`` 是 int32 的 -1；Python 是 4294967295。
    const c = new MaskConstraint(M32, M32);
    expect(c.expected).toBe(M32);
    expect(c.expected).toBeGreaterThan(0);
    expect(c.toCMin()).toBe(M32);
    expect(c.toCMin(M32)).toBe(M32);    // mask 之外的位被抹掉后，期望值是 0
    expect(new MaskConstraint(0xf0, 0x0f).expected).toBe(0);
  });

  it("MaskConstraint 拒绝越界（含负数）", () => {
    expect(() => new MaskConstraint(-1, 0)).toThrowError(/越出 uint32/);
    expect(() => new MaskConstraint(0, M32 + 1)).toThrowError(/越出 uint32/);
  });

  it("constraintFromDict 认两种 kind，其它一律 SpecError", () => {
    expect(constraintFromDict({ kind: "interval", lo: 1, hi: 2 })).toBeInstanceOf(IntervalConstraint);
    expect(constraintFromDict({ kind: "mask", mask: 1, value: 0 })).toBeInstanceOf(MaskConstraint);
    expect(() => constraintFromDict({ kind: "who" })).toThrowError(SpecError);
    expect(() => constraintFromDict({})).toThrowError(/未知的约束类型/);
  });
});

describe("构造器与工厂", () => {
  it("每种 kind 的实例类型", () => {
    expect(IntervalSpec.fromPairs([[0, 1]])).toBeInstanceOf(IntervalSpec);
    expect(MaskSpec.fromValues([1, 2], 0xff)).toBeInstanceOf(MaskSpec);
    expect(RollSpec.fromPairs([[0, 9]], [10])).toBeInstanceOf(RollSpec);
    expect(WuxingSpec.fromPairs([[0, 9]])).toBeInstanceOf(WuxingSpec);
    expect(PoolSpec.fromPairs([[0, 1], [0, 2], [0, 3]], 10)).toBeInstanceOf(PoolSpec);
    expect(GrowthWuxingSpec.fromParts(0)).toBeInstanceOf(GrowthWuxingSpec);
    // 每个具体类都继承 ``SeedSpec.fromDict``
    expect(IntervalSpec.fromDict({ kind: "mask", constraints: [{ kind: "mask", mask: M32, value: 1 }] })).toBeInstanceOf(
      MaskSpec,
    );
  });

  it("step 在构造期就被规范化（< 1 回落到 1，小数向 0 截断）", () => {
    expect(IntervalSpec.fromPairs([[0, 1]], 0).step).toBe(1);
    expect(IntervalSpec.fromPairs([[0, 1]], -7).step).toBe(1);
    expect(IntervalSpec.fromPairs([[0, 1]], 2.9).step).toBe(2);
  });

  it("IntervalSpec 的 scanner 白名单", () => {
    expect(IntervalSpec.fromPairs([[0, 1]], 1, "crack2").toDict()["scanner"]).toBe("crack2");
    expect(() => IntervalSpec.fromPairs([[0, 1]], 1, "nope" as "crack")).toThrowError(/未知的 scanner/);
  });

  it("MaskSpec 要求 imask 与每个约束的 mask 一致", () => {
    const spec = MaskSpec.fromValues([0x20000000, 0x40000000], 0x60000000);
    expect(spec.imask).toBe(0x60000000);
    expect(spec.u32Bounds).toEqual([
      { lo: 0x20000000, hi: M32 },
      { lo: 0x40000000, hi: M32 },
    ]);
    // 值和掩码不同尺子 → 构造期就拒
    expect(() => new MaskSpec([new MaskConstraint(0xff, 1)], 1, 0xffff)).toThrowError(/不一致/);
  });

  it("RollSpec / PoolSpec 的长度契约", () => {
    const roll = RollSpec.fromPairs([[0, 9], [0, 9], [0, 9]], [10, 20], [5], [2]);
    expect([roll.rollNum, roll.gemNum]).toEqual([2, 1]);
    expect(roll.gemIndex).toEqual([2]);
    // 负数 gem_index 要保留下来被 checkEquip 拒掉（`coerceIntTuple` 不回绕）
    expect(() => RollSpec.fromPairs([[0, 9], [0, 9]], [10], [5], [-1])).toThrowError(/越界/);
    const pool = PoolSpec.fromPairs([[0, 1], [0, 2], [0, 3], [0, 4]], 100, [7]);
    expect(pool.rollNum).toBe(1);
    expect(pool.total).toBe(100);
    expect(() => PoolSpec.fromPairs([[0, 1], [0, 2], [0, 3]], 100, [7])).toThrowError(/超过区间数量/);
  });

  it("WuxingSpec 的 bagua_growth 与 target_wx", () => {
    const spec = WuxingSpec.fromPairs([[0, 9]], 0b101, [5, 12]);
    expect(spec.targetWx).toBe(0b101);
    expect(spec.hasBaguaGrowth).toBe(true);
    expect(spec.baguaGrowth).toEqual([5, 12]);
    expect(WuxingSpec.fromPairs([[0, 9]], 0, [3, 0]).hasBaguaGrowth).toBe(false);
    expect(() => WuxingSpec.fromPairs([[0, 9]], 0, [1])).toThrowError(/长度为 2/);
  });

  it("GrowthWuxingSpec：不可枚举、step 恒 1、target_wx 必带 WUXING_HAS", () => {
    const spec = GrowthWuxingSpec.fromParts(0);
    expect(spec.num).toBe(0);
    expect(spec.step).toBe(1);
    expect(spec.targetWx).toBe(WUXING_HAS);
    expect(spec.wantsWuxing).toBe(false);
    expect(spec.grows).toBe(true);
    expect(spec.growth).toEqual([-0.3, 0.3]);
    expect(GrowthWuxingSpec.fromParts(0b101).wantsWuxing).toBe(true);
    // 传 2 也不给（候选必须是连续种子）
    expect(() => GrowthWuxingSpec.fromParts(0, [-0.3, 0.3], true, 2)).toThrowError(/step 恒为 1/);
    // 但字典里写 5 会被静默规范化成 1（与 Python 一致）
    expect(specFromDict({ kind: "growth-wuxing", step: 5, constraints: [] }).step).toBe(1);
    // 不接受任何区间约束
    expect(() => new GrowthWuxingSpec([new IntervalConstraint(0, 1)])).toThrowError(/不接受区间约束/);
  });

  it("常量与集合", () => {
    expect(MAX_INPUT).toBe(32);
    expect(WUXING_HAS).toBe(0b100000);
    expect([GROWTH_MIN_TENTHS, GROWTH_MAX_TENTHS]).toEqual([8, 25]);
    expect([...NON_STEPPED_KINDS].sort()).toEqual(["growth-wuxing", "pool", "roll", "wuxing"]);
    expect([...NON_ENUMERABLE_KINDS]).toEqual(["growth-wuxing"]);
    // 可枚举的这几个才能被后端扫
    for (const kind of ["interval", "mask", "roll", "wuxing", "pool"] as const) {
      expect(NON_ENUMERABLE_KINDS.has(kind)).toBe(false);
    }
  });

  it("toString 与 Python 的 __repr__ 同形", () => {
    const text = IntervalSpec.fromPairs([[0, 1]], 3, "crack2").toString();
    expect(text.startsWith("IntervalSpec(num=1, step=3, ")).toBe(true);
    expect(text).toContain('"scanner":"crack2"');
  });
});
