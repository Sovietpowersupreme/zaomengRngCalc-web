/**
 * 强化场景 —— ``strength``（强化石强化）。
 *
 * 逐行对照 ``src/StrengthCalculator.py::Calculator.calculate``：
 *
 * ====  ==================================================================
 * 1     成功率 ``sumPro`` = clamp(Σ_{i<e} ``ALLPRO``[max(c-d+1, 0)], 0, 1)
 * 2     需求区间 = ``convert2Range([(0, sumPro * 0x80000000)])``
 * 3     搜索起点 = ``userSeed`` 走 **4** 次 ``FastNext``（「防止获得太靠近的种子」）
 * 4     ``seed = seedFindbyRange(搜索起点, ur, 9999)``（局部搜索，步数上限 9999）
 * 5     ``distance = seedDistance(userSeed, seed, 9999)`` —— **从用户种子量**
 * 6     ``click = distance - 3``（UI 上的「连点器F」）
 * 7     ``末种子 = FastNext^(b + 2)(seed)``（``b`` = 随机属性数，UI 上的「末种子G」）
 * ====  ==================================================================
 *
 * 第 2 步的两个细节都和 ``src`` 对齐：
 *
 * * **不 round**。``src`` 传进 ``convert2Range`` 的就是 ``sumPro * 0x80000000``
 *   这个浮点，由 ``num_parser`` 里的 ``int()`` 向 0 截断 —— 所以这里也用
 *   ``Math.trunc``，不要「顺手」改成 ``Math.round``（``capture`` 的成功率阈值是
 *   ``round``，两处**故意不一样**，因为 ``src`` 本身就不一样）；
 * * 概率为 1 时上界会算出 ``0x80000000``，超出 ``KMAX``。这不是 bug：随机数本身
 *   只有 31 位（``<= 0x7FFFFFFF``），所以「上界 2^31」等价于「不筛」，与 ``src``
 *   把 ``0x80000000`` 交给 C 比较的效果逐位一致。
 *
 * 一次强化吃几次随机（用户 2026-09 确认）
 * --------------------------------------
 * ``Game Scripts/extra_info.md`` 给的公式::
 *
 *     总 = 无关2 + 强化判断1 + 白板随机属性n + 无关2        # n = 输入框 B
 *
 * * 「强化判断」只有 **1 次**抽签：``Game Scripts/export.strength/Strength.as``
 *   的 ``afterReadStore`` 里只有一句 ``getRandom() < cobj.allpro``；
 * * ``n`` = **白板装备的随机词条数** —— 游戏的反作弊函数会新造一件同名白板装备
 *   再比对，所以固定吃这么多次随机。它就是输入框 B（``roll_count``），
 *   用 :func:`cycleLength` 换算成 ``5 + n``；
 * * **失败会回档**，回档不额外吃随机数 → 成败不影响消耗量；
 * * 所以 ``click = distance - 3`` 里的 3 就是「判断点在一次操作里的 1 基位置」
 *   （前 2 次无关 + 第 3 次判断）。
 *
 * ``consume`` 的取值
 * -----------------
 * ``CONSUME = CLICK_OFFSET - 1 = 2`` 只是让
 * ``Outcome.needConsume = distance - 1 - consume`` 恰好退化成 ``src`` 的
 * ``click = distance - 3`` 的**记账约定**，不是物理次数 —— 真实的单次消耗是
 * :attr:`StrengthPlan.cycle`（= :func:`cycleLength(rollCount)` = ``5 + n``）。
 * :meth:`StrengthScenario.advanceCount` 被**重写**成固定的 :data:`LEAD_FASTNEXT`
 * （= 4），与 ``consume`` 解耦 —— 搜索起点是 4 次 ``FastNext``，不是 ``consume + 1``。
 *
 * 与 ``src`` 的一处刻意差异
 * -----------------------
 * ``distance === 0``（超过 9999 步上限）时 ``src`` 会显示 ``连点器 = -3``；
 * 这里沿用 ``equipment``/``capture`` 的约定：``distance`` 记 0、``needConsume``
 * 记 0，并附一条 warning。实际触发不到（成功率最低的一档也要连抽 ~1 万次不中
 * 才会越过 9999 步），但不显示负数更合理。
 *
 * 关于「下标」的两种写法
 * --------------------
 * ``src`` 用 **1 基** 的强化石等级 ``d``：``index = c - d + 1``；
 * 这里的 :func:`proIndex` 用 **0 基**：``proIndex(level, "一") = level - 0``。
 * 两者等价（``test_index_matches_src`` 把这条钉住），不是「已知不一致」。
 */

import { SpecError } from "../core/errors";
import { IntervalSpec } from "../core/spec";
import type { SearchResult } from "../core/search";
import { register } from "./registry";
import {
  InputField,
  InputSchema,
  Note,
  Outcome,
  Scenario,
  ScenarioError,
  getBool,
  getInt,
  getStr,
  withBackend,
  type RunOptions,
  type Runtime,
} from "./scenario";

// =========================================================================== 表与纯函数
// 逐行对照 ``src_forge/const/strength.py``。只有本场景用它，所以直接放这里；
// 表本身在 ``consts.json`` 里也有（给 UI 用），``strength.test.ts``
// 会把两边对钉 —— 两边是**同一份数据的两个副本**，漂了要立刻发现。

/** 单颗强化石的成功概率表（下标 = ``等级 - 强化石等级``，负数取 0）。 */
export const ALLPRO: readonly number[] = Object.freeze([
  1, 0.375, 0.09, 0.02, 0.0058, 0, 0, 0, 0,
]);

/** 强化石等级的中文名（``一``/``二``/``三``/``四``）。 */
export const STONE_GRADES: readonly string[] = Object.freeze(["一", "二", "三", "四"]);

/**
 * ``STONE_GRADES[0]``。
 *
 * 单独起个名是因为 ``noUncheckedIndexedAccess`` 下 ``STONE_GRADES[0]`` 的类型是
 * ``string | undefined`` —— 而「默认强化石等级」必须是个确定的字符串。
 */
export const DEFAULT_STONE_GRADE: string = STONE_GRADES[0] as string;

/** 装备可强化到的最高等级。 */
export const MAX_LEVEL = 7;

/** 搜索前先跳过的 ``FastNext`` 次数（「防止获得太靠近的种子」）。 */
export const LEAD_FASTNEXT = 4;

/** 找到种子之后再跳过的 ``FastNext`` 次数（得到「末种子」）。 */
export const TAIL_FASTNEXT = 2;

/** 一次强化里「判断之前」的无关随机次数（见模块 docstring 的公式）。 */
export const NOISE_HEAD = 2;

/** 「强化判断」本身只抽 1 次（``getRandom() < allpro``）。 */
export const CHECK_RANDOMS = 1;

/** 一次强化里「判断之后」的无关随机次数。 */
export const NOISE_TAIL = 2;

/** 与白板随机属性数无关的固定消耗 = ``2 + 1 + 2``。 */
export const CYCLE_FIXED = NOISE_HEAD + CHECK_RANDOMS + NOISE_TAIL;

/**
 * ``click = distance - CLICK_OFFSET``；这个 3 正好是「判断随机数」在一次操作里的
 * **1 基位置**（``NOISE_HEAD + CHECK_RANDOMS``），不是随手取的。
 */
export const CLICK_OFFSET = 3;

/** ``seedFindbyRange`` / ``seedDistance`` 的步数上限。 */
export const NEAR_LIMIT = 9999;

/** 成功概率的上下界。 */
export const PROB_MAX = 1.0;

/**
 * 一次强化消耗的随机数 = ``5 + rollCount``（``rollCount`` = 白板随机属性数）。
 *
 * 用户确认的公式是 ``无关2 + 强化判断1 + 白板随机属性n + 无关2``；这里把它写成
 * 函数，方便 UI 直接显示「点一次 = 吃几次随机」。
 */
export function cycleLength(rollCount = 0): number {
  return CYCLE_FIXED + Math.trunc(rollCount);
}

/**
 * ``"三"`` → ``2``；同时也接受 ``1..4``（1 基）与 ``0..3``（0 基）的写法。
 *
 * 不合法时抛 :class:`SpecError`（Python 抛 ``ValueError``，由 ``planOf`` 转成
 * :class:`ScenarioError`）。报错文案里的等级用**原样**的那个值，别用 ``trim()``
 * 之后的 —— Python 写的是 ``{grade!r}``，拿的就是函数参数本身。
 */
export function stoneGradeIndex(grade: unknown): number {
  const text = String(grade).trim();
  const index = STONE_GRADES.indexOf(text);
  if (index >= 0) return index;
  if (/^[0-9]+$/.test(text)) {
    const value = Number(text);
    if (value >= 1 && value <= 4) return value - 1;
    if (value === 0) return 0;
  }
  throw new SpecError(`强化石等级只能是 一/二/三/四 或 1..4，得到 ${pyRepr(grade)}`);
}

/** ``ALLPRO`` 的下标 = ``max(level - gradeIndex, 0)``。 */
export function proIndex(level: number, grade: unknown): number {
  const index = Math.trunc(level) - stoneGradeIndex(grade);
  return index >= 0 ? index : 0;
}

/** 总成功概率（``count`` 颗同等级强化石），已 clamp 到 ``[0, 1]``。 */
export function successPro(level: number, grade: unknown, count = 1): number {
  const index = proIndex(level, grade);
  const base = ALLPRO[index];
  if (base === undefined) {
    // Python 在这里会 ``IndexError``。`level` 已经被 `planOf` 限死在 1~MAX_LEVEL，
    // 所以这是纯防御：与其把 NaN 悄悄带进区间上界，不如当场说清楚。
    throw new SpecError(`成功概率表没有下标 ${index}（等级 ${level} 超出表长）`);
  }
  const total = base * Math.trunc(count);
  if (total < 0) return 0;
  return total > PROB_MAX ? PROB_MAX : total;
}

/** 成功概率的搜索区间（含 0 下界），单位是 ``float``。 */
export function successInterval(
  level: number,
  grade: unknown,
  count = 1,
): readonly [number, number] {
  return [0, successPro(level, grade, count)];
}

/**
 * 升到 ``level`` 最省的那档强化石在 :data:`STONE_GRADES` 里的下标。
 *
 * 旧版 ``src/StrengthCalculator.py::Calculator.upshift`` 里写的是
 * ``max(等级 - 4, 0)``。这个式子原本是「该穿几件白板装备」的公式，被**借来**
 * 当强化石下标用了 —— 但它给的确实是「最省」那档：``ALLPRO`` 从下标 3 起就是
 * 0.02，7 级用「一」成功率是 0，必须跟着升档才搜得到种子。
 *
 * 这里只用来选强化石，**不要**顺手拿它填「随机属性数B」——那是装备自己的属性。
 */
export function cheapStoneIndex(level: number): number {
  return Math.max(Math.trunc(level) - STONE_GRADES.length, 0);
}

/** 升到 ``level`` 最省的强化石等级（见 :func:`cheapStoneIndex`）。 */
export function cheapStone(level: number): string {
  const index = Math.min(cheapStoneIndex(level), STONE_GRADES.length - 1);
  return STONE_GRADES[index] as string;
}

/**
 * 搜索上界 ``Math.trunc(sumPro * 0x80000000)``（向 0 截断，**不 round**）。
 *
 * :param grade: ``"一"``~``"四"``（也接受 1~4 的整数，见 :func:`stoneGradeIndex`）。
 */
export function successMax(level: number, grade: unknown, count = 1): number {
  return Math.trunc(successPro(level, grade, count) * 0x80000000);
}

/** ``repr()`` 的近似（只用来拼报错文案）。 */
function pyRepr(value: unknown): string {
  if (typeof value === "string") return `'${value}'`;
  if (value === null || value === undefined) return "None";
  return String(value);
}

// =========================================================================== plan
/** 一次最多用几颗强化石（``src`` 的下拉框 E 是 1~3）。 */
export const MAX_STONE_COUNT = 3;

/** 见模块 docstring：让 ``needConsume = distance - 1 - consume`` 退化成 ``click = distance - 3``。 */
export const CONSUME = CLICK_OFFSET - 1;

/** 强化只有一个「成功判定」区间。 */
export const SPEC_NUM = 1;

/** 没找到种子时的占位预览。 */
export const NO_HIT_PREVIEW = "连点器: -\n末种子: -";

export interface StrengthPlanInit {
  level: number;
  stone: string;
  stoneCount: number;
  rollCount: number;
  index: number;
  prob: number;
  successMax: number;
  notes?: readonly Note[];
}

/** 强化一次（用 ``count`` 颗同等级强化石）的搜索需求。 */
export class StrengthPlan {
  readonly level: number;
  readonly stone: string;
  readonly stoneCount: number;
  readonly rollCount: number;
  readonly index: number;
  readonly prob: number;
  readonly successMax: number;
  readonly notes: readonly Note[];

  constructor(init: StrengthPlanInit) {
    this.level = Math.trunc(init.level);
    this.stone = init.stone;
    this.stoneCount = Math.trunc(init.stoneCount);
    this.rollCount = Math.trunc(init.rollCount);
    this.index = Math.trunc(init.index);
    this.prob = init.prob;
    this.successMax = Math.trunc(init.successMax);
    this.notes = Object.freeze([...init.notes ?? []]);
  }

  /** 区间数量（C 端 ``range.num``）。 */
  get num(): number {
    return SPEC_NUM;
  }

  /** ``needConsume`` 的记账参数 —— 见模块 docstring「``consume`` 的取值」。 */
  get consume(): number {
    return CONSUME;
  }

  /** 一次强化真实吃掉几次随机 = :func:`cycleLength(rollCount)` = ``5 + n``。 */
  get cycle(): number {
    return cycleLength(this.rollCount);
  }
}

// =========================================================================== 场景
/** 强化石强化：给定当前种子与强化参数，算出「连点器几次」与「末种子」。 */
export class StrengthScenario extends Scenario {
  override readonly key = "strength";
  override readonly label = "强化";
  override readonly version = "1.0";
  override readonly hint =
    "强化石强化的种子推演。\n" +
    "成功率 = 强化石表按「目标等级 - 强化石等级 + 1」查，用几颗就累加几次（上限 1）。\n" +
    "结果里「连点器」= 种子距离 - 3，「末种子」= 命中种子再走 随机属性数 + 2 次。";
  override readonly specKind = "interval";
  override readonly nearLimit = NEAR_LIMIT;
  override readonly supportsNear = true;

  // ------------------------------------------------------------------ 解析
  /** 纯函数：表单 → :class:`StrengthPlan`。 */
  planOf(inputs: Readonly<Record<string, unknown>>): StrengthPlan {
    const level = getInt(inputs, "level", 1);
    if (!(level >= 1 && level <= MAX_LEVEL)) {
      throw new ScenarioError(`目标等级必须是 1~${MAX_LEVEL} 的整数，得到 ${level}`);
    }
    const stone =
      getStr(inputs, "stone", DEFAULT_STONE_GRADE) || DEFAULT_STONE_GRADE;
    try {
      stoneGradeIndex(stone);
    } catch (exc) {
      if (exc instanceof SpecError) throw new ScenarioError(exc.message);
      throw exc;
    }
    const count = getInt(inputs, "stone_count", 1);
    if (!(count >= 1 && count <= MAX_STONE_COUNT)) {
      throw new ScenarioError(`强化石数量必须是 1~${MAX_STONE_COUNT} 的整数，得到 ${count}`);
    }
    const rollCount = getInt(inputs, "roll_count", 0);
    if (rollCount < 0) {
      throw new ScenarioError("随机属性数不能为负");
    }

    const index = proIndex(level, stone);
    const prob = successPro(level, stone, count);
    const notes: Note[] = [];
    if (prob <= 0) {
      notes.push(
        new Note({
          level: "warning",
          message:
            `${level} 级用「${stone}」级强化石的成功率为 0，` +
            "区间退化成 (0, 0)，实际上搜不到任何种子",
          field: "level",
        }),
      );
    }
    return new StrengthPlan({
      level,
      stone,
      stoneCount: count,
      rollCount,
      index,
      prob,
      successMax: successMax(level, stone, count),
      notes,
    });
  }

  // ------------------------------------------------------------------ 校验
  /** 输入合法性检查。**只返回 Note，不弹窗、不抛异常。** */
  override validate(inputs: Readonly<Record<string, unknown>>): readonly Note[] {
    let plan: StrengthPlan;
    try {
      plan = this.planOf(inputs);
    } catch (exc) {
      // ``planOf`` 把「等级/强化石/数量/随机属性数」四类问题都归到一句话里，
      // 所以这里不挂 ``field`` —— 一次只可能有一条，挂哪一格都是误导。
      if (exc instanceof ScenarioError) {
        return [new Note({ level: "error", message: exc.message })];
      }
      throw exc;
    }
    return plan.notes;
  }

  // ------------------------------------------------------------------ 契约
  override randomConsumption(inputs: Readonly<Record<string, unknown>>): number {
    return this.planOf(inputs).consume;
  }

  /** 搜索起点 = 起始种子走 :data:`LEAD_FASTNEXT` 次。 */
  override advanceCount(_inputs: Readonly<Record<string, unknown>>): number {
    return LEAD_FASTNEXT;
  }

  override searchSeed(
    startSeed: number,
    _inputs: Readonly<Record<string, unknown>>,
    rt: Runtime,
  ): number {
    return rt.engine.fastNextK(Math.trunc(startSeed), LEAD_FASTNEXT);
  }

  /** 强化 = 一个单区间 ``seedFindbyRange``（「随机数小于成功率即成功」）。 */
  override buildSpec(
    inputs: Readonly<Record<string, unknown>>,
    _startSeed: number,
  ): IntervalSpec {
    const plan = this.planOf(inputs);
    return IntervalSpec.fromPairs([[0, plan.successMax]], 1);
  }

  // ------------------------------------------------------------------ 自动升档
  /**
   * 「自动升档」：这一轮算完，下一轮的参数该填什么（``null`` = 什么都不动）。
   *
   * 逐条对应旧版 ``src/StrengthCalculator.py``：
   *
   * * ``set_a_from_g()`` —— 「起始值A」← **末种子G**（就是 ``seedAfter``）；
   * * ``upshift()`` —— 「目标等级C」+1、「强化石等级D」降到最省的一档、
   *   「强化石数量E」回到 1；
   * * ``upshift()`` 做到 7 级就 ``return``，这里也一样：**已经到 7 级就整块跳过**
   *   （连「A ← 末种子」也不做），否则下一次点「运行」算的是同一个 7 级、
   *   却拿着上一轮的末种子，两边对不上。
   *
   * 刻意**不碰**「随机属性数B」：那是白板装备自己的属性（反作弊会照着重造一件），
   * 不属于「升档」该改的东西。旧版也没碰过它。
   */
  override advance(
    outcome: Outcome,
    inputs: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> | null {
    if (!getBool(inputs, "auto_upshift", false)) return null;
    const seedAfter = Math.trunc(outcome.seedAfter || 0);
    if (seedAfter <= 0) return null; // 没命中（或末种子不可用）：别把 A 清成 0
    const plan = this.planOf(inputs);
    if (plan.level >= MAX_LEVEL) return null;
    const level = plan.level + 1;
    return {
      start_seed: seedAfter,
      level,
      stone: cheapStone(level),
      stone_count: 1,
    };
  }

  // ------------------------------------------------------------------ 执行
  /** 把搜索结果翻译成 :class:`Outcome`。 */
  override interpret(
    result: SearchResult,
    inputs: Readonly<Record<string, unknown>>,
    startSeed: number,
    rt: Runtime | null = null,
  ): Outcome {
    const plan = this.planOf(inputs);
    const engine = rt === null ? null : rt.engine;
    const seeds = result.seeds.map((s) => Math.trunc(s));
    // ``result.nearest or result.head or seeds[0]``：Python 的 ``or`` 把 0 当假值，
    // 所以这里不能写 ``??``（``nearest === 0`` 时 ``??`` 会把它当成有效值）。
    const first = seeds.length > 0 ? (seeds[0] as number) : 0;
    const seed = Math.trunc((result.nearest ?? 0) || result.head || first);
    const notes: Note[] = [...plan.notes];
    const extra: Record<string, unknown> = {
      level: plan.level,
      stone: plan.stone,
      stone_count: plan.stoneCount,
      roll_count: plan.rollCount,
      index: plan.index,
      success_pro: plan.prob,
      success_max: plan.successMax,
      cycle_randoms: plan.cycle,
    };
    if (!seed) {
      notes.push(
        new Note({ level: "warning", message: "在给定上限内没有找到任何种子", field: "start_seed" }),
      );
      return withBackend(
        this.withExtra(
          new Outcome({
            seed: 0,
            distance: 0,
            needConsume: -1,
            consume: CONSUME,
            preview: NO_HIT_PREVIEW,
            notes,
          }),
          extra,
        ),
        rt,
      );
    }

    // ``distance`` 必须**从用户种子**量（``src`` 的 ``seedDistance(user_seed, ...)``），
    // 搜索结果里的距离是从搜索起点（``fastNext^4``）量的，不能直接用。
    let distance = Math.trunc(result.distance ?? 0);
    if (engine !== null) {
      distance = Math.trunc(engine.seedDistance(Math.trunc(startSeed), seed, NEAR_LIMIT));
    }
    let click: number;
    if (distance === 0) {
      notes.push(
        new Note({
          level: "warning",
          message: `种子距离超过 ${NEAR_LIMIT} 步上限（「过于遥远」）`,
          field: "start_seed",
        }),
      );
      click = 0;
    } else {
      click = distance - CLICK_OFFSET;
    }
    const seedAfter =
      engine === null ? 0 : Math.trunc(engine.fastNextK(seed, plan.rollCount + TAIL_FASTNEXT));
    return this.withExtra(
      new Outcome({
        seed,
        distance,
        needConsume: click,
        consume: CONSUME,
        seedAfter,
        preview: `连点器: ${click}\n末种子: ${seedAfter}`,
        seeds,
        truncated: result.truncated,
        backend: result.backend,
        notes,
      }),
      extra,
    );
  }

  /** 单独回放末种子（完整预览由 :meth:`interpret` 写进 ``Outcome``）。 */
  override preview(seed: number, inputs: Readonly<Record<string, unknown>>, rt: Runtime): string {
    if (!seed) return NO_HIT_PREVIEW;
    const plan = this.planOf(inputs);
    const end = rt.engine.fastNextK(Math.trunc(seed), plan.rollCount + TAIL_FASTNEXT);
    return `末种子: ${Math.trunc(end)}`;
  }

  // ------------------------------------------------------------------ 入口
  /** 强化只做局部搜索 —— 全空间枚举既无意义也跑不完。 */
  override async run(
    inputs: Readonly<Record<string, unknown>>,
    startSeed: number,
    options: RunOptions = {},
  ): Promise<Outcome> {
    if (options.near === false) {
      throw new ScenarioError(`${this.key} 只支持局部搜索（near=True）`);
    }
    return super.run(inputs, startSeed, { ...options, near: true });
  }

  // ------------------------------------------------------------------ 内部
  /**
   * ``dataclasses.replace(outcome, extra=merged)`` —— 合并而不是覆盖。
   *
   * Python 侧是模块级函数 ``_with_extra``；放成私有方法只是为了少导一个名字。
   */
  private withExtra(
    outcome: Outcome,
    extra: Readonly<Record<string, unknown>>,
  ): Outcome {
    return outcome.with({ extra: { ...outcome.extra, ...extra } });
  }

  // ------------------------------------------------------------------ 表单
  override schema(): InputSchema {
    return new InputSchema({
      title: this.label,
      hint: this.hint,
      fields: [
        new InputField({
          key: "start_seed",
          label: "起始值A",
          kind: "int",
          // 默认留空 + 必填：0 不是合法种子（``fastNext(0) === 0``），
          // 从一个假的 0 出发算出来的「连点器次数」没有任何意义。
          default: null,
          min: 1,
          max: 0x7fffffff,
          required: true,
          group: "输入",
          help: "游戏里的当前种子（1 ~ 2147483647）；留空会直接报错",
          width: 14,
        }),
        new InputField({
          key: "roll_count",
          label: "随机属性数B",
          kind: "int",
          default: 0,
          min: 0,
          group: "输入",
          help: "白板装备的随机词条数（不含宝石）；反作弊会重造一件同名白板装备，固定吃完这些随机",
          width: 8,
        }),
        new InputField({
          key: "level",
          label: "目标等级C",
          kind: "int",
          default: 1,
          min: 1,
          max: MAX_LEVEL,
          group: "强化",
          help: `要强到几级（1~${MAX_LEVEL}）`,
          width: 8,
        }),
        new InputField({
          key: "stone",
          label: "强化石等级D",
          kind: "choice",
          default: DEFAULT_STONE_GRADE,
          choices: STONE_GRADES,
          group: "强化",
          width: 10,
        }),
        new InputField({
          key: "stone_count",
          label: "强化石数量E",
          kind: "int",
          default: 1,
          min: 1,
          max: MAX_STONE_COUNT,
          group: "强化",
          help: "一次用几颗（成功率按颗累加）",
          width: 8,
        }),
        new InputField({
          key: "auto_upshift",
          label: "自动升档",
          kind: "bool",
          // 默认开着 = 旧版行为（``src`` 的 ``self.auto_upshift = True``）。
          default: true,
          // 它不是一个「参数」，而是「算完要不要改参数」；但它改的正是上面这三项
          // （等级 / 强化石 / 数量），所以摆在同一个分组里紧挨着它们。
          // 它一度是**工具栏开关**（``toolbar: true``）；和「枚举全部」一样搬回表单后，
          // 勾选框和它管的东西终于在同一眼看得见的范围里。
          group: "强化",
          help: "算完自动把起始值A 换成末种子、目标等级 +1、强化石降到最省的一档、数量回到 1",
        }),
      ],
    });
  }
}

register(StrengthScenario);
