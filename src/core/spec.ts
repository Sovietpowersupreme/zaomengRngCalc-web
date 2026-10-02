/**
 * ``src_forge/core/spec.py`` 的 1:1 翻译 —— 语言无关的「随机数需求」描述。
 *
 * 为什么要有这一层
 * ----------------
 * ``csrc`` 里有 5 个各不相同的匹配器 + 3 个通用扫描器，它们的入参形状、消耗顺序、
 * ``re.seed`` 的语义都不一样。如果让 UI / 场景层直接对着 C 函数写参数，那么
 * Python 前端与 Web 前端就会各自长出一套「参数整理」代码，然后慢慢漂移。
 * ``SeedSpec`` 把这些差异收成**一个 JSON 可序列化的值**：
 *
 * | spec | 对应 C 函数 | 匹配对象 |
 * |---|---|---|
 * | `IntervalSpec` | `crack` / `crack2` | 每次消耗的随机数落在区间内 |
 * | `MaskSpec` | `fastCrack` | `hash & imask` 等于给定值 |
 * | `RollSpec` | `findEquip` | 最终装备属性落在区间内 |
 * | `WuxingSpec` | `findFabao` | 原始随机数 + 五行 + 八卦成长 |
 * | `PoolSpec` | `findRechild` | 池分配 + 固定 roll |
 * | `GrowthWuxingSpec` | （C 侧没有） | 起点的第一次命中，**不可枚举** |
 *
 * 约定
 * ----
 * * `toDict()` / `specFromDict()` 是**唯一**的序列化通道，键名与 Python 的
 *   `to_dict()` 逐字相同（`snake_case`），golden / Worker RPC 都走这个结构。
 * * 所有 `constraints` 的顺序就是 C 端 `range.min[i]` / `range.max[i]` 的顺序，
 *   顺序改了结果就变了（`crack` 是短路判定，顺序影响耗时不影响结果；`fastCrack`
 *   是等值判定，顺序无关；`findEquip` 的顺序决定 `roll_vals` 落到哪个属性上 ——
 *   必须原样保留）。
 *
 * ⚠️ 与 Python 的两点实现差异（都是有意的）
 * -----------------------------------------
 * 1. Python 的 dataclass 是 `frozen=True`；这里只用 TS 的 `readonly`（**编译期**），
 *    **没有** `Object.freeze(this)` —— 基类构造器里冻结会让子类随后赋值直接抛
 *    `TypeError`（严格模式）。要运行期不可变请自己 `Object.freeze`，但注意
 *    `constraints` 里的对象本来就是只读的。
 * 2. JS 的位运算是 int32 语义，所以 Python 的 `x & M32` 一律写成 `x >>> 0`；
 *    见 `values.ts` 顶部说明。
 */

import { SpecError } from "./errors";
import {
  M32,
  MAX_INPUT,
  WUXING_HAS,
  checkEquip,
  checkRangeNum,
  checkRechild,
  coerceIntTuple,
  coerceU32Tuple,
  u32,
  type U32Pair,
} from "./values";

// --------------------------------------------------------------------------- 类型
/** `IntervalSpec` 的两个扫描器（结果集相同，只差「哪个槽位先被检查」与性能）。 */
export type ScannerKind = "crack" | "crack2";

/** 全部 spec 种类。 */
export type SpecKind = "interval" | "mask" | "roll" | "wuxing" | "pool" | "growth-wuxing";

/** `toDict()` 里的区间约束。 */
// ⚠️ 用 ``type`` 而不是 ``interface``：interface 不会获得隐式索引签名，
// 于是没法当 ``Record<string, unknown>`` 传给 ``specFromDict``（type alias 可以）。
export type IntervalConstraintDict = {
  readonly kind: "interval";
  readonly lo: number;
  readonly hi: number;
};

/** `toDict()` 里的掩码约束。 */
export type MaskConstraintDict = {
  readonly kind: "mask";
  readonly mask: number;
  readonly value: number;
};

/** `toDict()` 里的约束。 */
export type ConstraintDict = IntervalConstraintDict | MaskConstraintDict;

/** `toDict()` 里的 spec（额外字段随 kind 变化）。 */
export interface SpecDict {
  readonly kind: SpecKind;
  readonly step: number;
  readonly constraints: readonly ConstraintDict[];
  readonly [extra: string]: unknown;
}

/** `specFromDict()` 接受的输入（任意 JSON 对象）。 */
export type SpecInput = Record<string, unknown>;

/** 一条约束。 */
export type Constraint = IntervalConstraint | MaskConstraint;

/** 这些规格在 C 里**没有** `step` 参数（见 `csrc/cracker.h` 的 `findEquip*` /
 * `findFabao*` / `findRechild*` 签名）；`growth-wuxing` 更没有（C 侧压根没这功能）。 */
export const NON_STEPPED_KINDS: ReadonlySet<SpecKind> = new Set<SpecKind>([
  "roll",
  "wuxing",
  "pool",
  "growth-wuxing",
]);

/**
 * **不可枚举**的 kind —— 不是「种子空间里的一个子集」，而是「从起点沿 `FastNext`
 * 单向前扫，第一个满足条件的那个」。因此没有任何后端能扫它们（`SeedSearcher.supports`
 * 一律 `false`，`search_slice` / `search_near` 一律抛 `BackendUnavailable`），
 * 只能由场景自己实现搜索。目前只有 `GrowthWuxingSpec` 一个。
 */
export const NON_ENUMERABLE_KINDS: ReadonlySet<SpecKind> = new Set<SpecKind>(["growth-wuxing"]);

/** 法宝成长的下界 —— `AllEquipment.as::refreshSutraAttribute` 的 `0.8`（单位 0.1）。 */
export const GROWTH_MIN_TENTHS = 8;
/** 法宝成长的上界 —— 同上的 `2.5`（单位 0.1）。也是游戏 `refreshSutraAttribute`
 * 的分支门限：洗之前成长 ≥2.5 就不再重算成长。 */
export const GROWTH_MAX_TENTHS = 25;

// --------------------------------------------------------------------------- 约束
/** 闭区间 `[lo, hi]` —— 对应 `uRange.min[i]` / `uRange.max[i]`。 */
export class IntervalConstraint implements U32Pair {
  /** 判别标签（Python 里是 `ClassVar`，不参与相等/构造）。 */
  readonly kind = "interval" as const;
  readonly lo: number;
  readonly hi: number;

  constructor(lo: number, hi: number) {
    if (lo < 0 || hi > M32) throw new SpecError(`区间约束越出 uint32：[${lo}, ${hi}]`);
    if (lo > hi) throw new SpecError(`区间约束上下界反了：[${lo}, ${hi}]`);
    this.lo = lo;
    this.hi = hi;
  }

  contains(value: number): boolean {
    return this.lo <= value && value <= this.hi;
  }

  /** 喂给 C 端 `range.min[i]` 的值（区间约束直接用 `lo`）。 */
  toCMin(_imask: number = M32): number {
    return this.lo;
  }

  toDict(): IntervalConstraintDict {
    return { kind: "interval", lo: Math.trunc(this.lo), hi: Math.trunc(this.hi) };
  }
}

/**
 * 掩码等值约束：`(value & mask) === expected`。
 *
 * 对应 `fastCrack` 的 `buffer[idx] != range.min[offset]`，其中
 * `buffer[i] = RandomPureHasher(...) & imask`。因此写进 C 的 `range.min[i]` 必须是
 * `expected & mask` —— 高位被 `imask` 抹掉后再比较，如果直接填 `expected` 会让
 * 高位不等而永远匹配不上。
 */
export class MaskConstraint {
  readonly kind = "mask" as const;
  readonly mask: number;
  readonly value: number;

  constructor(mask: number, value: number) {
    for (const [name, v] of [
      ["mask", mask],
      ["value", value],
    ] as const) {
      if (!(v >= 0 && v <= M32)) throw new SpecError(`掩码约束的 ${name} 越出 uint32：${v}`);
    }
    this.mask = mask;
    this.value = value;
  }

  /** 比较时实际出现的值（高位于 `mask` 之外的部分已被抹掉）。 */
  get expected(): number {
    return (this.value & this.mask) >>> 0;
  }

  contains(value: number): boolean {
    return ((value & this.mask) >>> 0) === this.expected;
  }

  toCMin(imask: number = M32): number {
    return (this.value & imask) >>> 0;
  }

  toDict(): MaskConstraintDict {
    return { kind: "mask", mask: Math.trunc(this.mask), value: Math.trunc(this.value) };
  }
}

/** 从 `toDict()` 的结构还原一条约束。 */
export function constraintFromDict(data: Record<string, unknown>): Constraint {
  const kind = data["kind"];
  if (kind === "interval") {
    return new IntervalConstraint(Number(data["lo"]), Number(data["hi"]));
  }
  if (kind === "mask") {
    return new MaskConstraint(Number(data["mask"]), Number(data["value"]));
  }
  throw new SpecError(`未知的约束类型: ${JSON.stringify(kind)}`);
}

/** 校验一组约束（类型 + 数量）。 */
function normalizeConstraints(items: readonly Constraint[], skipRangeCheck = false): readonly Constraint[] {
  const out: Constraint[] = [];
  for (const item of items) {
    if (!(item instanceof IntervalConstraint) && !(item instanceof MaskConstraint)) {
      throw new SpecError(
        `约束必须是 IntervalConstraint 或 MaskConstraint，得到 ${(item as object)?.constructor?.name ?? typeof item}`,
      );
    }
    out.push(item);
  }
  if (!skipRangeCheck) checkRangeNum(out.length);
  return out;
}

/**
 * 确保 `NON_STEPPED_KINDS` 里的规格 `step` 是 `1`。
 *
 * C 的 `findEquip_core` / `findFabao_core` / `findRechild_core` 签名里根本没有
 * `step` —— 所以这几个规格上的 `step` 字段**没有任何实现会去读它**。与其静默按
 * `1` 算（用户会以为跳跃生效了），不如当场报错。
 */
export function requireUnitStep(spec: SeedSpec): void {
  const step = Math.trunc(Number((spec as { step?: unknown }).step ?? 1));
  if (NON_STEPPED_KINDS.has(spec.kind) && step !== 1) {
    throw new SpecError(
      `${spec.kind} 规格的 step 必须是 1：C 的 findEquip / findFabao / findRechild ` +
        `没有 step 参数，得到 ${step}；请不要假设它会被忽略`,
    );
  }
}

// --------------------------------------------------------------------------- spec
/**
 * 所有 spec 的公共母体：一串约束 + 步长。
 *
 * `constraints` 的长度就是 C 端的 `range.num`，顺序即槽位顺序。`step` 是相邻两次
 * 采样之间 `FastNext` 的次数（C 端 `step < 1` 会回落到 1，这里在构造期就规范化，
 * 免得后端各自处理）。
 */
export abstract class SeedSpec {
  /** 判别标签。 */
  abstract readonly kind: SpecKind;
  readonly constraints: readonly Constraint[];
  readonly step: number;

  protected constructor(constraints: readonly Constraint[], step = 1, skipRangeCheck = false) {
    this.constraints = normalizeConstraints(constraints, skipRangeCheck);
    this.step = Math.max(Math.trunc(step), 1);
  }

  /** 区间数量（C 端 `range.num`）。 */
  get num(): number {
    return this.constraints.length;
  }

  /**
   * `(min, max)` 形式的原始 uint 边界（供后端直接填 `uRange`）。
   *
   * 区间约束 → `(lo, hi)`；掩码约束 → `(value & mask, 0xFFFFFFFF)`
   * （`fastCrack` 只读 `min[]`，`max[]` 不参与比较）。
   */
  get u32Bounds(): readonly U32Pair[] {
    return this.constraints.map((c) =>
      c instanceof MaskConstraint
        ? { lo: c.toCMin(), hi: M32 }
        : { lo: Math.trunc(c.lo), hi: Math.trunc(c.hi) },
    );
  }

  /** 各子类把自己的额外字段塞进 `toDict()` 的钩子。 */
  protected extraToDict(): Record<string, unknown> {
    return {};
  }

  /** 唯一的序列化通道（键名与 Python `to_dict()` 逐字相同）。 */
  toDict(): SpecDict {
    return {
      kind: this.kind,
      step: this.step,
      constraints: this.constraints.map((c) => c.toDict()),
      ...this.extraToDict(),
    };
  }

  /** 从 `toDict()` 的输出（或同构 JSON）还原；类型由字典里的 `kind` 决定。 */
  static fromDict(data: SpecInput): SeedSpec {
    return specFromDict(data);
  }

  /**
   * 各子类实现自己的「额外字段 → 构造参数」映射。
   *
   * 基类这里只提供一个会抛错的默认实现 —— 存在的意义是让子类能写
   * `static override fromExtra`，从而在**编译期**保证签名一致（TS 不允许
   * `abstract static`）。
   */
  static fromExtra(_constraints: readonly Constraint[], _step: number, _data: SpecInput): SeedSpec {
    throw new SpecError("SeedSpec.fromExtra 没有实现（只有具体 spec 才可从字典构造）");
  }

  toString(): string {
    return `${this.constructor.name}(num=${this.num}, step=${this.step}, ${JSON.stringify(
      this.extraToDict(),
    )})`;
  }
}

/** 通用区间扫描 —— 对应 `crack` / `crack2` / `seedFindbyRange`。 */
export class IntervalSpec extends SeedSpec {
  readonly kind = "interval" as const;
  /**
   * `"crack"`（直连迭代，无缓冲）或 `"crack2"`（256 环形缓冲，窗口宽度 `MAX_INPUT`）。
   * 两者对同一输入的**结果集相同**，差别只在「多槽位时哪个先被检查」和性能；
   * 显式写出来是为了 golden 能分别固化。`seedFindbyRange`（局部搜索）不受它影响。
   */
  readonly scanner: ScannerKind;

  constructor(constraints: readonly Constraint[], step = 1, scanner: ScannerKind = "crack") {
    super(constraints, step);
    if (scanner !== "crack" && scanner !== "crack2") {
      throw new SpecError(`未知的 scanner: ${JSON.stringify(scanner)}`);
    }
    for (const c of this.constraints) {
      if (!(c instanceof IntervalConstraint)) throw new SpecError("IntervalSpec 只接受 IntervalConstraint");
    }
    this.scanner = scanner;
  }

  protected override extraToDict(): Record<string, unknown> {
    return { scanner: this.scanner };
  }

  static fromPairs(
    pairs: Iterable<readonly [number, number]>,
    step = 1,
    scanner: ScannerKind = "crack",
  ): IntervalSpec {
    return new IntervalSpec(
      Array.from(pairs, ([lo, hi]) => new IntervalConstraint(u32(lo), u32(hi))),
      step,
      scanner,
    );
  }

  static override fromExtra(constraints: readonly Constraint[], step: number, data: SpecInput): IntervalSpec {
    const scanner = (data["scanner"] ?? "crack") as ScannerKind;
    return new IntervalSpec(constraints, step, scanner);
  }
}

/** 掩码等值扫描 —— 对应 `fastCrack`（斗部群星专用）。 */
export class MaskSpec extends SeedSpec {
  readonly kind = "mask" as const;
  /**
   * C 端 `fastCrack` 的第三个参数；每个 `MaskConstraint` 的 `mask` 必须与它一致，
   * 否则「JS 侧算出的期望值」与「C 侧实际比较的值」不是同一把尺子。
   * 这一点在构造期就钉死。
   */
  readonly imask: number;

  constructor(constraints: readonly Constraint[], step = 1, imask: number = M32) {
    super(constraints, step);
    const mask = u32(imask);
    for (const c of this.constraints) {
      if (!(c instanceof MaskConstraint)) throw new SpecError("MaskSpec 只接受 MaskConstraint");
      if (c.mask !== mask) {
        throw new SpecError(
          `MaskConstraint.mask=${hex(c.mask)} 与 MaskSpec.imask=${hex(mask)} 不一致`,
        );
      }
    }
    this.imask = mask;
  }

  /** `fastCrack` 只读 `min[]`；`max[]` 完全不参与比较。 */
  override get u32Bounds(): readonly U32Pair[] {
    return this.constraints.map((c) => ({ lo: c.toCMin(this.imask), hi: M32 }));
  }

  protected override extraToDict(): Record<string, unknown> {
    return { imask: Math.trunc(this.imask) };
  }

  static fromValues(values: Iterable<number>, imask: number = M32, step = 1): MaskSpec {
    const consts = Array.from(values, (v) => new MaskConstraint(imask, u32(v)));
    return new MaskSpec(consts, step, imask);
  }

  static override fromExtra(constraints: readonly Constraint[], step: number, data: SpecInput): MaskSpec {
    return new MaskSpec(constraints, step, Number(data["imask"] ?? M32));
  }
}

/** 装备合成 —— 对应 `findEquip`。 */
export class RollSpec extends SeedSpec {
  readonly kind = "roll" as const;
  readonly rollVals: readonly number[];
  readonly gemVals: readonly number[];
  readonly gemIndex: readonly number[];

  /**
   * `constraints` 约束的是**最终装备属性**（不是原始随机数）：
   * `equip[i] = round(rand * roll_vals[i])`，第 `gem_index[j]` 个槽位再加
   * `round(rand * gem_vals[j])`。
   *
   * 消耗顺序（与 C 的 `findEquip_core` 逐字对应）：
   *
   * 1. `roll_num` 次 `RandomGenerator` → 基础属性；
   * 2. `1` 次 `FastNext`（游戏里「过掉一个无关随机」）；
   * 3. `gem_num` 次 `RandomGenerator` → 宝石加成。
   */
  constructor(
    constraints: readonly Constraint[],
    step = 1,
    rollVals: Iterable<number> = [],
    gemVals: Iterable<number> = [],
    gemIndex: Iterable<number> = [],
  ) {
    super(constraints, step);
    const rolls = coerceU32Tuple(rollVals);
    const gems = coerceU32Tuple(gemVals);
    const index = coerceIntTuple(gemIndex);
    if (gems.length !== index.length) {
      throw new SpecError(`gem_vals 长度 ${gems.length} != gem_index 长度 ${index.length}`);
    }
    for (const c of this.constraints) {
      if (!(c instanceof IntervalConstraint)) {
        throw new SpecError("RollSpec 只接受 IntervalConstraint（比较的是属性值区间）");
      }
    }
    // C 的契约是 roll_num <= num（白板可变属性数 ≤ 装备属性总数），不是相等。
    checkEquip(this.num, rolls.length, index);
    this.rollVals = rolls;
    this.gemVals = gems;
    this.gemIndex = index;
  }

  get rollNum(): number {
    return this.rollVals.length;
  }

  get gemNum(): number {
    return this.gemVals.length;
  }

  protected override extraToDict(): Record<string, unknown> {
    return {
      roll_vals: this.rollVals.map((v) => Math.trunc(v)),
      gem_vals: this.gemVals.map((v) => Math.trunc(v)),
      gem_index: this.gemIndex.map((v) => Math.trunc(v)),
    };
  }

  static fromPairs(
    pairs: Iterable<readonly [number, number]>,
    rollVals: Iterable<number>,
    gemVals: Iterable<number> = [],
    gemIndex: Iterable<number> = [],
    step = 1,
  ): RollSpec {
    return new RollSpec(
      Array.from(pairs, ([lo, hi]) => new IntervalConstraint(u32(lo), u32(hi))),
      step,
      rollVals,
      gemVals,
      gemIndex,
    );
  }

  static override fromExtra(constraints: readonly Constraint[], step: number, data: SpecInput): RollSpec {
    const list = (v: unknown): Iterable<number> => (v as Iterable<number>) ?? [];
    return new RollSpec(
      constraints,
      step,
      list(data["roll_vals"]),
      list(data["gem_vals"]),
      list(data["gem_index"]),
    );
  }
}

/** 掉落（带五行分支）/ 宠物捕捉 —— 对应 `findFabao`。 */
export class WuxingSpec extends SeedSpec {
  readonly kind = "wuxing" as const;
  readonly targetWx: number;
  readonly baguaGrowth: readonly number[];

  /**
   * `constraints` 约束的是**原始随机整数**（不是最终显示值）。
   *
   * 五行判定（`target_wx !== 0` 时）：
   *
   * * 先抽一次：`< WUXING_DOUBLE_AT`（约 91%）→ 单抽 `round(rand * 4)`；
   * * 否则双抽：`round(rand * 4)` 与 `round(rand * 3)` 查 `next_wuxing` 表；
   * * 结果 `wuxing` 必须**包含** `target_wx` 的每一位（`(wuxing & target_wx) === target_wx`）；
   * * 之后必定 `FastNext` 一次（「跳 1 个无关随机」）。
   *
   * `bagua_growth[1] !== 0` 时再抽一次八卦额外成长，要求落在
   * `[bagua_growth[0], bagua_growth[1]]`。
   */
  constructor(
    constraints: readonly Constraint[],
    step = 1,
    targetWx = 0,
    baguaGrowth: Iterable<number> = [0, 0],
  ) {
    super(constraints, step);
    for (const c of this.constraints) {
      if (!(c instanceof IntervalConstraint)) throw new SpecError("WuxingSpec 只接受 IntervalConstraint");
    }
    const growth = coerceU32Tuple(baguaGrowth);
    if (growth.length !== 2) throw new SpecError("bagua_growth 必须是长度为 2 的序列");
    this.targetWx = u32(targetWx);
    this.baguaGrowth = growth;
  }

  get hasBaguaGrowth(): boolean {
    return Boolean(this.baguaGrowth[1]);
  }

  protected override extraToDict(): Record<string, unknown> {
    return {
      target_wx: Math.trunc(this.targetWx),
      bagua_growth: this.baguaGrowth.map((v) => Math.trunc(v)),
    };
  }

  static fromPairs(
    pairs: Iterable<readonly [number, number]>,
    targetWx = 0,
    baguaGrowth: Iterable<number> = [0, 0],
    step = 1,
  ): WuxingSpec {
    return new WuxingSpec(
      Array.from(pairs, ([lo, hi]) => new IntervalConstraint(u32(lo), u32(hi))),
      step,
      targetWx,
      baguaGrowth,
    );
  }

  static override fromExtra(constraints: readonly Constraint[], step: number, data: SpecInput): WuxingSpec {
    return new WuxingSpec(
      constraints,
      step,
      Number(data["target_wx"] ?? 0),
      (data["bagua_growth"] as Iterable<number>) ?? [0, 0],
    );
  }
}

/** 还童（洗孩子）—— 对应 `findRechild`。 */
export class PoolSpec extends SeedSpec {
  readonly kind = "pool" as const;
  readonly total: number;
  readonly rollVals: readonly number[];

  /**
   * 消耗顺序：前 3 次用**递减的剩余总点数** `rest` 作倍率
   * （`round(rand * rest)`，并把结果从 `rest` 里扣掉），之后 `roll_num` 次
   * 用固定的 `roll_vals[i-3]` 作倍率。
   *
   * `constraints` 的长度必须 `>= 3 + roll_vals.length` —— 前 3 个槽位约束池分配，
   * 其后是固定 roll 的约束。
   */
  constructor(constraints: readonly Constraint[], step = 1, total = 0, rollVals: Iterable<number> = []) {
    super(constraints, step);
    for (const c of this.constraints) {
      if (!(c instanceof IntervalConstraint)) throw new SpecError("PoolSpec 只接受 IntervalConstraint");
    }
    const rolls = coerceU32Tuple(rollVals);
    checkRechild(this.num, rolls.length);
    this.total = u32(total);
    this.rollVals = rolls;
  }

  get rollNum(): number {
    return this.rollVals.length;
  }

  protected override extraToDict(): Record<string, unknown> {
    return {
      total: Math.trunc(this.total),
      roll_vals: this.rollVals.map((v) => Math.trunc(v)),
    };
  }

  static fromPairs(
    pairs: Iterable<readonly [number, number]>,
    total: number,
    rollVals: Iterable<number> = [],
    step = 1,
  ): PoolSpec {
    return new PoolSpec(
      Array.from(pairs, ([lo, hi]) => new IntervalConstraint(u32(lo), u32(hi))),
      step,
      total,
      rollVals,
    );
  }

  static override fromExtra(constraints: readonly Constraint[], step: number, data: SpecInput): PoolSpec {
    return new PoolSpec(
      constraints,
      step,
      Number(data["total"] ?? 0),
      (data["roll_vals"] as Iterable<number>) ?? [],
    );
  }
}

/**
 * 法宝「属性重置」—— `AllEquipment.as::refreshSutraAttribute`。
 *
 * **这是唯一一个不可枚举的 spec。** 别的 spec 描述的是「种子空间里的一个子集」，
 * 后端能直接扫；这一个描述的是「从某个起点沿 `FastNext` 单向前扫，第一个满足条件
 * 的那个种子」，所以没有任何后端能原生加速它，只能由场景自己实现搜索。
 * `constraints` 恒为空 —— 构造期传非空会抛 `SpecError`。
 *
 * 一次候选吃掉的随机数（`RandomEngine.randomValue`，注意**顺序即语义**）：
 *
 * ```text
 * // —— 成长：只有 ``grows`` 为真才抽，固定 2 次 ——
 * r1 → k = ceil(r1 * 3)                    // 变化量：0/1/2/3 个 0.1
 * r2 → if r2 <= 0.5: k = -k                // 第二次决定正负
 * delta = k / 10                           // 与 ``growth`` 区间比较
 * // —— 五行：必定抽，2 次或 3 次 ——
 * r3 → r3 < 0.91 ? wx = HAS | 1 << round(r4 * 4)
 *                : wx = HAS | 1 << w1 | 1 << NEXT_WUXING[w1][w2]
 * ```
 *
 * 两处**与 `src` 不同**的地方（`src/making_calc/simulation.py` 的
 * `findRefreshSutraAttribute` 是「当时的猜测」，以游戏脚本为准）：
 *
 * 1. 成长那 2 次随机数只由 `grows` 决定。`src` 把「成长 = 0」翻译成 `eup = ()`
 *    从而一次都不抽 —— 多抽一次就整体错位，属于 bug。
 * 2. 游戏显示前会把成长夹到 `[0.8, 2.5]`（`GROWTH_MIN_TENTHS` /
 *    `GROWTH_MAX_TENTHS`），但**夹钳不参与匹配** —— 它只影响最终显示值，
 *    而且 `src` 只建了 2.5 那一侧。
 *
 * `targetWx` 的掩码布局与 `WuxingSpec` 相同，但**语义不同**：这里的
 * `WUXING_HAS` 位必然置位（游戏每次都调 `initRondomPro()`），传 `0` 表示
 * 「不筛五行」，构造期会被规范化成 `WUXING_HAS`。
 *
 * @param targetWx 必须包含的五行位；构造期一律 `| WUXING_HAS`。
 * @param growth 目标**变化量**区间（单位「成长」，含端点）。可达的变化量只有
 *   `{0, ±0.1, ±0.2, ±0.3}`；`makingObject` 里 `属性重置` 的默认值 `(-0.3, 0.3)`
 *   就等于「不筛」。
 * @param grows 当前成长是否还没满 —— `false` 表示这次洗练**不抽**成长那 2 次
 *   （游戏里只有一个「属性重置」按钮，这正是它对「成长已满」法宝走的分支）。
 */
export class GrowthWuxingSpec extends SeedSpec {
  readonly kind = "growth-wuxing" as const;
  readonly targetWx: number;
  readonly growth: readonly [number, number];
  readonly grows: boolean;

  constructor(
    constraints: readonly Constraint[] = [],
    _step = 1,
    targetWx: number = WUXING_HAS,
    growth: readonly [number, number] = [-0.3, 0.3],
    grows = true,
  ) {
    // 故意**不**走母体的 `normalizeConstraints`：母体用 `checkRangeNum` 钉住
    // `num >= 1`（那是 C 端 `uRange` 的前提），而本 spec 恰恰一个区间都没有 ——
    // 它描述的根本不是种子空间的子集。所以这里手工清空 + 校验。
    if (constraints.length > 0) {
      throw new SpecError("GrowthWuxingSpec 不接受区间约束（它不是可枚举的子集）");
    }
    super([], 1, true);
    const lo = Number(growth[0]);
    const hi = Number(growth[1]);
    if (!(-1.0 <= lo && lo <= hi && hi <= 1.0)) {
      throw new SpecError(`growth 必须满足 -1.0 <= lo <= hi <= 1.0，得到 (${lo}, ${hi})`);
    }
    this.targetWx = u32(targetWx) | WUXING_HAS;
    this.growth = [lo, hi];
    this.grows = Boolean(grows);
  }

  /** 是否对五行有额外要求（`WUXING_HAS` 之外的位）。 */
  get wantsWuxing(): boolean {
    return Boolean(this.targetWx & ~WUXING_HAS);
  }

  static fromParts(
    targetWx: number,
    growth: readonly [number, number] = [-0.3, 0.3],
    grows = true,
    step = 1,
  ): GrowthWuxingSpec {
    if (Math.trunc(step) !== 1) throw new SpecError("GrowthWuxingSpec 的 step 恒为 1（候选是连续种子）");
    return new GrowthWuxingSpec([], 1, targetWx, growth, grows);
  }

  protected override extraToDict(): Record<string, unknown> {
    return { target_wx: this.targetWx, growth: [this.growth[0], this.growth[1]], grows: this.grows };
  }

  static override fromExtra(constraints: readonly Constraint[], step: number, data: SpecInput): GrowthWuxingSpec {
    const growth = (data["growth"] ?? [-0.3, 0.3]) as readonly [number, number];
    return new GrowthWuxingSpec(
      constraints,
      step,
      Number(data["target_wx"] ?? WUXING_HAS),
      [Number(growth[0]), Number(growth[1])],
      Boolean(data["grows"] ?? true),
    );
  }
}

/** 把 `int` 值打印成 `0x...`（Python 用 `{:#x}`）。 */
function hex(v: number): string {
  return `0x${(v >>> 0).toString(16)}`;
}

// --------------------------------------------------------------------- 工厂表
interface SpecExtraFactory {
  fromExtra(constraints: readonly Constraint[], step: number, data: SpecInput): SeedSpec;
}

const SPEC_KINDS: Readonly<Record<SpecKind, SpecExtraFactory>> = {
  interval: IntervalSpec,
  mask: MaskSpec,
  roll: RollSpec,
  wuxing: WuxingSpec,
  pool: PoolSpec,
  "growth-wuxing": GrowthWuxingSpec,
};

/** 从 `toDict()` 的输出（或 Web 侧同构 JSON）还原。 */
export function specFromDict(data: SpecInput): SeedSpec {
  const kind = data["kind"];
  if (kind === undefined) {
    throw new SpecError(`spec 字典缺少 'kind' 字段：${JSON.stringify(Object.keys(data).sort())}`);
  }
  const target = SPEC_KINDS[kind as SpecKind] as SpecExtraFactory | undefined;
  if (!target) {
    throw new SpecError(
      `未知的 spec kind: ${JSON.stringify(kind)}（可用: ${JSON.stringify(Object.keys(SPEC_KINDS).sort())}）`,
    );
  }
  const raw = (data["constraints"] ?? []) as readonly ConstraintDict[];
  const constraints = raw.map((c) => constraintFromDict(c));
  return target.fromExtra(constraints, Math.trunc(Number(data["step"] ?? 1)), data);
}

/** `MAX_INPUT` 的转发导出，方便 UI 层只 import 这一个模块。 */
export { MAX_INPUT };
