/**
 * 宠物捕捉场景 —— ``capture``（普通葫芦 / 红葫芦）。
 *
 * 逐行对照 ``src_forge/gameInfo/capture.py`` ↔ ``src/PetCalculator.py::calc_capture``
 * → ``cracker.findFabao2``：**就是一个** :class:`WuxingSpec`，只不过
 * ``targetWx = 0``、``baguaGrowth = [0, 0]`` —— 五行与八卦两段分支都不参与。
 *
 * ==================  =========================================================
 * ``src`` 的 ``n``      属性计算前要过掉的随机次数：普通葫芦 **2**、红葫芦 **1**
 * 搜索起点             ``fastNext`` 走 ``n + 1`` 次（基类 :meth:`advanceCount`）
 * ``targets[0..1]``    普通葫芦独有的两个**原始随机数**区间（**不过** ``uintBeforeRound``）
 * 其余槽位             最终资质/基础属性**显示值** → 减下限归一化 → 反推原始随机区间
 * ``distance``         **另起一次** ``seedDistance(用户种子, 首个种子, 9999999)``
 * ==================  =========================================================
 *
 * 为什么距离不能直接用基类的 ``result.distance``
 * --------------------------------------------
 * 搜索起点是 ``fastNext^(n+1)``，``findFabao2`` 内部给出的距离量的是**到搜索起点**；
 * ``src`` 的 ``process_result`` 量的是**到用户起始种子**，两者差 ``n + 1``。
 * 所以 :func:`recomputeDistance` 必须重算 —— 见那里的注释。
 *
 * 刻意与 ``src`` 一致的两处
 * ------------------------
 * * 预览（``capture_preview``）里普通葫芦先空转 **2** 次 ``random()``、红葫芦 **0** 次，
 *   然后才读资质。这个不对称看起来怪，但它是 ``src`` 的既有行为，对拍逐位相等，
 *   所以照抄（:meth:`CaptureScenario.preview` 里**不要**改成 ``consume``）；
 * * ``preview`` 里基础属性段的 ``round`` 是 Python 内置 ``round``（**半值取偶**），
 *   不是 JS 的 ``Math.round``（半值向上）—— 见 :func:`pyRound`。
 *
 * 与 ``src`` 的两处刻意差异
 * ------------------------
 * * ``seedDistance`` 超过 :data:`DISTANCE_LIMIT` 时返回 0，``src`` 把它显示成
 *   「过于遥远」且不给实际消耗；这里记 ``needConsume = 0`` + 一条 warning
 *   （沿用 ``strength``/``equipment`` 对同类情况的约定）；
 * * 一个种子都没找到时 ``src`` 只显示「未找到」，这里用 ``seed = distance = 0``、
 *   ``needConsume = -1`` + 一条 warning 的哨兵 —— 见 :func:`finalize`。
 *
 * 关于 :func:`finalize` 里那个 ``-2``（``capture-red`` 的 golden 就是它）
 * -------------------------------------------------------------------
 * 「无命中」的判据是 ``!seed && !seeds`` —— **枚举**（``searchAll``）只要搜到一个种子
 * 就会带回 ``seeds``，于是走 ``elif rt !== null`` 那条路；而 :func:`recomputeDistance`
 * 的第一句 ``if (!outcome.seed) return outcome`` 会**原样返回**（那个 ``seed`` 是
 * 「首个/最近命中」，枚举时可能是 0）。结果就是 ``needConsume = 0 - 1 - consume``
 * = **−2**（红葫芦）、**−3**（普通葫芦），且**一条 note 都不加**。
 * Python 侧一模一样（``runs.json`` 的 ``capture-red`` 记的就是 ``need_consume = -2``、
 * ``notes = []``）。这不是 bug，是「枚举没给出单个种子时不该编造消耗量」的既定行为。
 */

import { pyRepr } from "../core/fromValue";
import { parsePair } from "../core/pair";
import { uintBeforeRound, type Pair } from "../core/ranges";
import type { SearchResult } from "../core/search";
import { WuxingSpec } from "../core/spec";
import { CONSTS, type PetInfoRecord } from "../data/consts";
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
  type RunOptions,
  type Runtime,
} from "./scenario";

// =========================================================================== 常量
/**
 * 宠物四条资质/基础属性的固定顺序（= ``src`` 的 ``ATTR_ORDER``）。
 *
 * 它同时是：① 表单里 ``qual_*`` / ``base_*`` 的生成顺序；② ``targets`` 里四个资质槽位
 * 的顺序；③ :meth:`CaptureScenario.preview` 的回放顺序。三处共用一个常量，
 * ``rechild`` 也 import 它（``rechild.py`` 就是这么做的）。
 */
export const ATTR_ORDER: readonly string[] = Object.freeze(["生命", "魔法", "攻击", "防御"]);

/** 支持的模式。顺序 = UI 下拉框顺序。 */
export const MODES: readonly string[] = Object.freeze(["普通葫芦捕捉", "红葫芦捕捉"]);

/** 默认模式（``MODES[0]``）。 */
export const NORMAL_MODE: string = MODES[0] as string;

/** 占位槽位 ``(0, 0x7fffffff)`` 的原始随机数区间 —— 等价于「不筛」。 */
export const WILDCARD: Pair = Object.freeze([0, 0x7fffffff] as const);

/**
 * ``src.PetCalculator.process_result`` 里 ``seedDistance`` 的硬编码上限。
 *
 * ⚠️ 与 :data:`SCENARIO_NEAR_LIMIT`（也是 9999999）**数值相同但语义不同**：
 * 那个是「局部搜索走多少步」，这个是「量距离时最多找多远」。两个常量各自独立，
 * 改一个不影响另一个 —— 所以这里各起一个名，不合并。
 */
export const DISTANCE_LIMIT = 9_999_999;

/** ``src.process_result`` 在「未找到」时显示的预览（没有任何距离/消耗信息）。 */
export const NO_HIT_PREVIEW = "属性预览: -        \n\n";

/**
 * 「枚举全部」时的搜索上限 —— C 的 ``0x7fffffff``。与
 * :data:`equipment.FULL_SEARCH_LIMIT` 是同一个哨兵，但宠物族本来就不依赖装备族，
 * 所以这里自己声明一份（``v4`` 的 ``SEARCH_LIMIT`` 同理）。
 */
export const FULL_SEARCH_LIMIT = 0x7fffffff;

/** 宠物记录表（= ``const/petInfo.py::data``，按名字取）。 */
export const PETS: Readonly<Record<string, PetInfoRecord>> = CONSTS.pets;

/**
 * 宠物名的顺序 —— **照抄 ``const/petInfo.py::data`` 的字面量顺序**。
 *
 * 为什么不能直接用 ``Object.keys(CONSTS.pets)``：``consts.json`` 是
 * ``export_json.dumps()`` 生成的，而它固定用 ``json.dumps(..., sort_keys=True)``
 * （见那份文件的「设计目标 1：确定性」），**字典键一律按码点重排**。于是
 * 「丑牛 / 子鼠 / 寅虎 …」这个顺序在导出时就丢了。
 *
 * 而顺序在这三处都是**语义**，不是排版：
 *
 * 1. ``next(iter(PETS))`` = 默认宠物（月兔），也是表单 ``pet`` 字段的初值；
 * 2. ``choices = tuple(PETS)`` = 下拉框顺序；
 * 3. ``web/tests/fixtures/scenarios.json`` 的 ``describe()`` 快照 ——
 *    它由 ``web/tools/make_scenario_fixtures.py`` 从 Python 注册表生成，
 *    照抄的就是 Python 的插入顺序。
 *
 * 漂移由两层测试钉住（**两个方向都盖到了**，见 ``web/tests/capture.test.ts``）：
 * ``Object.keys(CONSTS.pets)`` 的**集合**必须与这里相等（挡「Python 加了新宠物」），
 * ``describe()`` 与 fixture 的快照相等（挡「顺序变了」）。
 *
 * ⚠️ 上游的正解是让 ``export_json`` 把顺序带出来（``stars.presets`` 就是这么干的
 * —— 它导出成**列表**而不是字典，理由一模一样，写在那份文件的注释里）。
 * 那属于 ``consts.json`` 的 schema 变更，这次先不动，用常量表 + 测试钉住。
 */
export const PET_ORDER: readonly string[] = Object.freeze([
  "月兔",
  "子鼠",
  "丑牛",
  "寅虎",
  "年兽",
  "虎丸",
  "龟布",
  "雀蛋",
  "龙仔",
  "火丸",
  "雪球",
  "灵猴",
  "雪马",
  "小飞",
]);

/** 宠物名顺序（= Python ``PETS`` 的迭代顺序）。 */
export function petNames(): readonly string[] {
  return PET_ORDER;
}

/**
 * 默认宠物（= Python ``next(iter(PETS))``）。
 *
 * 表为空时 Python 会抛 ``StopIteration``，这里返回 ``""`` —— 随后 ``planOf`` 会把它
 * 变成一条正常的 :class:`ScenarioError`（「未知的宠物：''」），比抛出裸异常友好。
 * 表为空本身意味着常量导出坏了，那条错误信息足够定位。
 */
export function defaultPet(): string {
  return PET_ORDER[0] ?? "";
}

// =========================================================================== 纯函数
/**
 * Python 内置 ``round(float)`` 的等价物 —— **半值取偶**。
 *
 * 不能写成 ``Math.floor(v + 0.5)`` / ``Math.round(v)``：那两者在**恰好 .5** 时向上取整
 * （``round(0.5) = 1``），Python 取偶（``round(0.5) = 0``、``round(2.5) = 2``）。
 *
 * 这里用 ``v - Math.floor(v)`` 取小数部分：对 ``|v|`` 在此量级（``<= 2^31``）的输入，
 * 两个相近 double 相减是**精确**的（Sterbenz 引理），所以 ``frac === 0.5`` 能可靠地
 * 判定「正好一半」。这与 ``v4.ts`` 里 :func:`pyRound1` 走 BigInt 精确有理数那套
 * 是同一个目标，只是这里只需要整数位、不需要保留小数，所以能用更短的路。
 *
 * :param value: 待取整的浮点。
 * :returns: Python ``round(value)`` 的整数值（``NaN`` / ``±Inf`` 原样返回）。
 */
export function pyRound(value: number): number {
  if (!Number.isFinite(value)) return value;
  const floor = Math.floor(value);
  const frac = value - floor;
  if (frac > 0.5) return floor + 1;
  if (frac < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** 属性计算前要过掉的随机数个数（``src`` 的 ``n``）。 */
export function modeConsume(mode: string): number {
  return mode === NORMAL_MODE ? 2 : 1;
}

/**
 * 普通葫芦的成功率阈值：``round(成功率 * 2^31)``。
 *
 * ⚠️ 是 ``round`` 不是 ``trunc`` —— ``strength.ts`` 那边**故意**用 ``Math.trunc``，
 * 因为 ``src`` 本身两处写法就不一样（``convert2Range`` 走 ``int()`` 截断，
 * 这里走 Python 的 ``round``）。别顺手统一。
 */
export function successMax(pet: PetInfoRecord): number {
  return pyRound(Number(pet.成功率) * 0x80000000);
}

/** Python ``"成功率" in pet`` 的运行时等价物（类型上说它必在，但数据是 JSON 读进来的）。 */
export function hasSuccessRate(pet: PetInfoRecord): boolean {
  return typeof pet.成功率 === "number" && Number.isFinite(pet.成功率);
}

/** 单值 → ``uintBeforeRound`` 的标量结果（传数字时走标量分支，必然是一个区间）。 */
function uintRound1(value: number, n: number, r: number): Pair {
  const out = uintBeforeRound(value, n, r);
  // ``Pair`` **本身就是数组**，所以这里只能做「反向判定」：``out[0]`` 还是数组就说明
  // ``out`` 成了一串区间，即调用点传进去的不是标量。``core/ranges.ts`` 的 ``isPair``
  // 是模块私有的（它也要靠同一个反向判据），所以本地写一份足够的那一半。
  if (Array.isArray(out) && Array.isArray(out[0])) {
    throw new ScenarioError(`uintBeforeRound 的标量调用返回了区间表：${String(value)}`);
  }
  return out as Pair;
}

/**
 * 「显示值区间」→「原始随机数区间」。
 *
 * ⚠️ ``src`` 的写法是**两次标量调用**：下界取 ``[0]``、上界取 ``[1]``。
 * 不能把 ``(min, max)`` 当成一个 tuple 传进 ``uintBeforeRound`` ——
 * ``parseSequence`` 会把 ``(5, 10)`` 看成**两个槽位** ``[5, 10]``，直接得出一串区间。
 *
 * :param roll: 变化范围 ``hi - lo``（**不是** ``hi``）。
 * :throws ScenarioError: ``roll <= 0``（该属性四条资质上下限相同，无法构造搜索）。
 */
export function rawPair(
  vmin: number,
  vmax: number,
  lo: number,
  roll: number,
  attr: string,
): Pair {
  if (roll <= 0) {
    throw new ScenarioError(`${attr} 没有变化范围（min == max），无法构造搜索`);
  }
  const low = uintRound1(vmin - lo, 0, roll);
  const high = uintRound1(vmax - lo, 0, roll);
  return [low[0], high[1]];
}

/**
 * 把 ``distance`` / ``needConsume`` 换成 ``src`` 的算法。
 *
 * ``seedDistance`` 超出上限返回 0，``src`` 把它显示成「过于遥远」且**不**显示实际消耗
 * —— 这里改成 ``needConsume = 0`` + 一条 warning。
 *
 * ⚠️ 第一句 ``if (!outcome.seed) return outcome`` 是**行为**不是防御：枚举没给出
 * 单个种子时它原样返回，于是 ``needConsume`` 保持基类算的 ``distance - 1 - consume``。
 * 见模块 docstring 里关于 ``-2`` 的那一段。
 */
export function recomputeDistance(outcome: Outcome, startSeed: number, rt: Runtime): Outcome {
  if (!outcome.seed) return outcome;
  const distance = Math.trunc(
    rt.engine.seedDistance(Math.trunc(startSeed), Math.trunc(outcome.seed), DISTANCE_LIMIT),
  );
  if (!distance) {
    const notes = [
      ...outcome.notes,
      new Note({
        level: "warning",
        message: `种子距离超过 ${DISTANCE_LIMIT}（「过于遥远」）`,
        field: "seed",
      }),
    ];
    return outcome.with({ distance: 0, needConsume: 0, notes });
  }
  return outcome.with({
    distance,
    needConsume: distance - 1 - Math.trunc(outcome.consume),
  });
}

/**
 * ``capture`` / ``rechild`` 共用的收尾（``rechild.ts`` 会 import 它）。
 *
 * 1. **无命中** —— ``seed`` 与 ``seeds`` 都空 ⇒ 哨兵 ``seed = distance = 0``、
 *    ``needConsume = -1`` + 一条 warning，预览换成 :data:`NO_HIT_PREVIEW`；
 * 2. **有命中** —— 必须是 :func:`recomputeDistance` 的结果；
 * 3. 合并场景特有的 ``extra``（**合并**不是覆盖：基类可能已经塞过东西）。
 */
export function finalize(
  outcome: Outcome,
  startSeed: number,
  rt: Runtime | null,
  extra: Readonly<Record<string, unknown>>,
): Outcome {
  if (!outcome.seed && outcome.seeds.length === 0) {
    const notes = [
      ...outcome.notes,
      new Note({ level: "warning", message: "在给定上限内没有找到任何种子", field: "pet" }),
    ];
    outcome = outcome.with({
      seed: 0,
      distance: 0,
      needConsume: -1,
      preview: NO_HIT_PREVIEW,
      notes,
    });
  } else if (rt !== null) {
    outcome = recomputeDistance(outcome, startSeed, rt);
  }
  return withExtra(outcome, extra);
}

/** ``extra`` 合并且造新 ``Outcome``（``rechild.ts`` 也用）。 */
export function withExtra(
  outcome: Outcome,
  extra: Readonly<Record<string, unknown>>,
): Outcome {
  return outcome.with({ extra: { ...outcome.extra, ...extra } });
}

// =========================================================================== 计划
/** 一次捕捉搜索的全部中间量。 */
export class CapturePlan {
  readonly pet: string;
  readonly mode: string;
  readonly consume: number;
  /** 资质范围（**显示值**），预览用。 */
  readonly potential: ReadonlyMap<string, Pair>;
  /** 基础属性范围（**显示值**）；``基础属性随机`` 为假时是空表。 */
  readonly attrRanges: ReadonlyMap<string, Pair>;
  /** 原始随机数区间序列，顺序与 C 端 ``range.min[]`` 一致。 */
  readonly targets: readonly Pair[];
  readonly baseRandom: boolean;
  readonly notes: readonly Note[];

  constructor(init: {
    pet: string;
    mode: string;
    consume: number;
    potential: ReadonlyMap<string, Pair>;
    attrRanges: ReadonlyMap<string, Pair>;
    targets: readonly Pair[];
    baseRandom: boolean;
    notes?: readonly Note[];
  }) {
    this.pet = init.pet;
    this.mode = init.mode;
    this.consume = Math.trunc(init.consume);
    this.potential = init.potential;
    this.attrRanges = init.attrRanges;
    this.targets = Object.freeze(init.targets.map((t) => Object.freeze([t[0], t[1]]) as Pair));
    this.baseRandom = init.baseRandom;
    this.notes = Object.freeze([...(init.notes ?? [])]);
  }

  /** ``targets`` 的长度 = C 端 ``range.num``。 */
  get num(): number {
    return this.targets.length;
  }
}

/** 四条资质的显示值范围（``资质范围`` 表读出来的 ``(lo, hi)``）。 */
function potentialOf(pet: PetInfoRecord): ReadonlyMap<string, Pair> {
  const out = new Map<string, Pair>();
  for (const attr of ATTR_ORDER) {
    const pair = pet.资质范围[attr];
    if (pair === undefined) {
      // 数据里 14 只宠物四围俱全；缺一个就是导出坏了，当场说清楚而不是给 undefined。
      throw new ScenarioError(`宠物数据类型里缺少「${attr}」的资质范围`);
    }
    out.set(attr, pair);
  }
  return out;
}

/** 四条基础属性的显示值范围；``基础属性随机`` 为假时返回空表。 */
function baseRangesOf(pet: PetInfoRecord): ReadonlyMap<string, Pair> {
  const out = new Map<string, Pair>();
  const source = pet.基础属性范围;
  if (source === null) {
    throw new ScenarioError("宠物标记了「基础属性随机」但没有基础属性范围");
  }
  for (const attr of ATTR_ORDER) {
    const pair = source[attr];
    if (pair === undefined) {
      throw new ScenarioError(`宠物数据类型里缺少「${attr}」的基础属性范围`);
    }
    out.set(attr, pair);
  }
  return out;
}

/** 读一个目标范围输入；空 = 全范围。越界/解析失败记 note 并退回全范围。 */
function readTarget(
  inputs: Readonly<Record<string, unknown>>,
  key: string,
  attr: string,
  lo: number,
  hi: number,
  notes: Note[],
): Pair {
  const raw = String(inputs[key] ?? "").trim();
  if (raw === "") return [lo, hi];
  const pair = parsePair(raw);
  // Python 在这里是 ``int(pair[0])`` —— 遇到 ``nan`` / ``inf`` 会抛未捕获的
  // ``ValueError`` / ``OverflowError``。这里当成「解析不了」记 note：
  // 对任何**合法**输入结论完全一致，只在 Python 会崩的那些输入上给出可读的报错。
  if (pair === null || !Number.isFinite(pair[0]) || !Number.isFinite(pair[1])) {
    notes.push(
      new Note({
        level: "error",
        message: `${attr} 目标范围无法解析（${pyRepr(raw)}），已按全范围处理`,
        field: key,
      }),
    );
    return [lo, hi];
  }
  let vmin = Math.trunc(pair[0]);
  let vmax = Math.trunc(pair[1]);
  if (vmin > vmax) [vmin, vmax] = [vmax, vmin];
  if (vmin < lo || vmax > hi) {
    notes.push(
      new Note({
        level: "error",
        message: `${attr} 目标范围 ${vmin}~${vmax} 超出 ${lo}~${hi}，已按全范围处理`,
        field: key,
      }),
    );
    return [lo, hi];
  }
  return [vmin, vmax];
}

// ===================================================================== 宠物族
/**
 * 宠物族（`capture` / `rechild`）的公共部分：「搜索」那一组 + 局部搜索。
 *
 * ### 为什么必须要有用户给的起始种子
 *
 * 旧版 `src/PetCalculator.py` 的窗口顶部**一直**有这一格（`:102`
 * `ttk.Label(main, text="初始种子:")`，捕捉与还童共用），后面才是
 * `:475` `for _ in range(n + 1): start = cracker.fastNext(start)` 与
 * `:629` `seedDistance(input_seed, 首个种子, 9999999)` —— 也就是
 * `Scenario.searchSeed` 与 `recomputeDistance`。没有这一格时 `run()` 的起点会被
 * 兜底成 `0`，而 `FastNext(0) == 0` 是个固定点：搜索起点恒为 0，宠物捕捉
 * **永远**报「在给定上限内没有找到任何种子」、宠还童则静默给出「种子 0、距离 1、
 * 还差 -3 次」这种没有意义的结果。所以这一格是必填的，默认**留空**而不是 0。
 *
 * ### 为什么只有局部搜索
 *
 * 旧版这里只有一条路（`findFabao2` / `findRechild2`，都是「从当前种子往前找最近
 * 的命中」），全空间枚举既对不上游戏里的那个问题，也跑不完。表单里的「枚举全部」
 * 与装备族的同名选项语义相同 —— **把搜索上限抬到无上限**，不是切到枚举：
 *
 * ```python
 * search_limit = 0x7fffffff if self.is_full_search.get() else 9999999
 * ```
 *
 * （`src/PetCalculator.py:342`，逐字相同。）
 *
 * ### 并行是自动的
 *
 * 搜索统一走 `Scenario.search` → `rt.searcher.searchNearest`，所以只要**步数**
 * 越过 `PARALLEL_MIN_STEPS`（`99999999`）后方就会自己改用 C 的有序并行
 * `*2_ord_mp` —— 和装备族共用同一道门槛，宠物族没有额外的开关。注意宠物族的默认
 * 上限（`SCENARIO_NEAR_LIMIT` = `9999999`，与旧版一致）**低于**那道门槛，所以默认
 * 是串行、只有勾「枚举全部」或把「步数上限」填到 `99999999` 以上才会自动切并行；
 * 两者结果逐位相同，只是快慢。
 */
export abstract class PetScenario extends Scenario {
  override readonly supportsNear = true;

  /**
   * 「搜索」组的三个字段 —— 与 `equipment.ts` 同款同序。
   *
   * 组名、字段 key、`required` / 范围都刻意保持一致，这样界面按组名排版的行为、
   * `startSeedOf` 的读取、以及各种「必填校验」用例都不必为宠物族开分支。
   */
  searchFields(): InputField[] {
    return [
      new InputField({
        key: "start_seed",
        label: "起始种子",
        kind: "int",
        // 默认**留空**、且必填：0 不是合法种子（`FastNext(0) == 0`，整条序列全是 0），
        // 所以这里不给「0」这个假默认值 —— 与其让用户从一个假的 0 出发搜出一堆
        // 无意义的结果，不如让他填。
        default: null,
        min: 1,
        max: 0x7fffffff,
        required: true,
        group: "搜索",
        help: "游戏里当前的那个种子（1 ~ 2147483647）；留空会直接报错",
        width: 14,
      }),
      new InputField({
        key: "full_search",
        label: "枚举全部",
        kind: "bool",
        default: false,
        group: "搜索",
        help:
          "不勾=局部搜索（默认，步数上限 9999999）；" +
          "勾上=把搜索上限抬到无上限（慢很多，且会忽略下面的「步数上限」）",
      }),
      new InputField({
        key: "limit",
        label: "步数上限",
        kind: "int",
        default: 0,
        min: 0,
        group: "搜索",
        help: "0=用场景默认（9999999）；勾上「枚举全部」时本项被忽略",
        width: 12,
      }),
    ];
  }

  /**
   * 算这次局部搜索的上限，返回 `[搜索上限, 被作废的表单步数]`。
   *
   * 优先级与装备族一致：**「枚举全部」压过「步数上限」** —— 否则顺手填一个步数
   * 就把「抬到无上限」这个语义覆盖掉了。第二个值只用于写一条提示，没勾「枚举全部」
   * 时恒为 `0`。
   */
  searchLimitOf(
    inputs: Readonly<Record<string, unknown>>,
    limit: number | null,
  ): readonly [number, number] {
    const full = getBool(inputs, "full_search", false);
    let searchLimit = full ? FULL_SEARCH_LIMIT : Math.trunc(this.nearLimit);
    let asked = 0;
    let effective = limit;
    if (effective === null) {
      // 表单里的「步数上限」（0 = 用场景默认）。调用方**显式**传 `limit` 时以它为准
      // （那是程序化调用的低层覆盖）。
      asked = getInt(inputs, "limit", 0);
      effective = (full ? 0 : asked) || null;
    }
    if (effective) searchLimit = Math.trunc(effective);
    return [searchLimit, full ? asked : 0];
  }

  /** 宠物族只做局部搜索（`near=false` 直接抛，与装备/强化一致）。 */
  override async run(
    inputs: Readonly<Record<string, unknown>>,
    startSeed: number,
    options: RunOptions = {},
  ): Promise<Outcome> {
    if (options.near === false) {
      throw new ScenarioError(`${this.key} 只支持局部搜索（near=True）`);
    }
    const [limit, ignored] = this.searchLimitOf(inputs, options.limit ?? null);
    const outcome = await super.run(inputs, startSeed, { ...options, near: true, limit });
    if (ignored === 0) return outcome;
    return outcome.with({
      notes: [
        new Note({
          level: "info",
          message:
            `已勾「枚举全部」：表单里的步数上限 ${String(ignored)} 被忽略` +
            `（搜索上限抬到无上限 ${String(limit)}）`,
          field: "limit",
        }),
        ...outcome.notes,
      ],
    });
  }
}

// =========================================================================== 场景
/** 宠物捕捉：普通葫芦 / 红葫芦。 */
export class CaptureScenario extends PetScenario {
  override readonly key = "capture";
  override readonly label = "宠物捕捉";
  override readonly version = "1.0";
  override readonly specKind = "wuxing";

  override readonly hint =
    "用葫芦捕捉宠物。选宠物 → 选葫芦 → 填想要的资质范围 → 填起始种子。\n" +
    "普通葫芦要额外过 2 次随机（成功率判定 + 一次无关随机），红葫芦只过 1 次。\n" +
    "资质目标留空 = 该资质全范围（等于不筛）。\n" +
    "";

  // ------------------------------------------------------------------ 表单
  override schema(): InputSchema {
    const fields: InputField[] = [
      new InputField({
        key: "pet",
        label: "宠物",
        kind: "choice",
        default: defaultPet(),
        choices: petNames(),
        group: "宠物",
        width: 12,
      }),
      new InputField({
        key: "mode",
        label: "葫芦",
        kind: "choice",
        default: NORMAL_MODE,
        choices: MODES,
        group: "宠物",
        help: "普通葫芦需要宠物数据里有「成功率」",
        width: 14,
      }),
    ];
    for (const attr of ATTR_ORDER) {
      fields.push(
        new InputField({
          key: `qual_${attr}`,
          label: `${attr}资质`,
          kind: "text",
          default: "",
          group: "资质目标",
          help: "留空=全范围；支持「900~1000」「900-1000」「900」",
          width: 12,
        }),
      );
    }
    for (const attr of ATTR_ORDER) {
      fields.push(
        new InputField({
          key: `base_${attr}`,
          label: `${attr}基础`,
          kind: "text",
          default: "",
          group: "基础属性目标",
          help: "只有「基础属性随机」的宠物才需要填",
          width: 12,
        }),
      );
    }
    fields.push(...this.searchFields());
    return new InputSchema({ fields, title: this.label, hint: this.hint });
  }

  // ------------------------------------------------------------------ 解析
  /** 纯函数：表单 → :class:`CapturePlan`。 */
  planOf(inputs: Readonly<Record<string, unknown>>): CapturePlan {
    const name = getStr(inputs, "pet", "") || defaultPet();
    const pet = PETS[name];
    if (pet === undefined) throw new ScenarioError(`未知的宠物：${pyRepr(name)}`);
    const mode = getStr(inputs, "mode", NORMAL_MODE) || NORMAL_MODE;
    if (!MODES.includes(mode)) {
      throw new ScenarioError(`${this.label} 不支持的模式：${pyRepr(mode)}`);
    }
    if (mode === NORMAL_MODE && !hasSuccessRate(pet)) {
      throw new ScenarioError(`${name} 没有设置成功率，不能用普通葫芦捕捉`);
    }

    const consume = modeConsume(mode);
    const potential = potentialOf(pet);
    const baseRandom = pet.基础属性随机;
    const attrRanges: ReadonlyMap<string, Pair> = baseRandom ? baseRangesOf(pet) : new Map();

    const notes: Note[] = [];
    const targets: Pair[] = [];
    if (mode === NORMAL_MODE) {
      targets.push([0, successMax(pet)]);
      targets.push(WILDCARD);
    }

    // 资质：显示值 → 归一化（- 下限）→ 反推原始随机区间
    for (const attr of ATTR_ORDER) {
      const [lo, hi] = requirePair(potential, attr);
      const [vmin, vmax] = readTarget(inputs, `qual_${attr}`, attr, lo, hi, notes);
      targets.push(rawPair(vmin, vmax, lo, hi - lo, attr));
    }

    // 基础属性
    if (baseRandom) {
      for (const attr of ATTR_ORDER) {
        const [lo, hi] = requirePair(attrRanges, attr);
        const [vmin, vmax] = readTarget(inputs, `base_${attr}`, attr, lo, hi, notes);
        targets.push(rawPair(vmin, vmax, lo, hi - lo, attr));
      }
    }

    return new CapturePlan({
      pet: name,
      mode,
      consume,
      potential,
      attrRanges,
      targets,
      baseRandom,
      notes,
    });
  }

  // ------------------------------------------------------------------ 校验
  override validate(inputs: Readonly<Record<string, unknown>>): readonly Note[] {
    try {
      return this.planOf(inputs).notes;
    } catch (exc) {
      if (exc instanceof ScenarioError) return [new Note({ level: "error", message: exc.message })];
      throw exc;
    }
  }

  // ------------------------------------------------------------------ 契约
  override randomConsumption(inputs: Readonly<Record<string, unknown>>): number {
    return this.planOf(inputs).consume;
  }

  /** 捕捉 = 一个没有五行筛选、没有八卦成长的 ``WuxingSpec``。 */
  override buildSpec(inputs: Readonly<Record<string, unknown>>, _startSeed: number): WuxingSpec {
    const plan = this.planOf(inputs);
    return WuxingSpec.fromPairs(plan.targets, 0, [0, 0]);
  }

  // ------------------------------------------------------------------ 执行
  override interpret(
    result: SearchResult,
    inputs: Readonly<Record<string, unknown>>,
    startSeed: number,
    rt: Runtime | null = null,
  ): Outcome {
    const plan = this.planOf(inputs);
    const outcome = super.interpret(result, inputs, startSeed, rt);
    return finalize(outcome, startSeed, rt, {
      pet: plan.pet,
      mode: plan.mode,
      num: plan.num,
      targets: plan.targets.map((t) => [t[0], t[1]]),
    });
  }

  // ------------------------------------------------------------------ 预览
  /** 回放命中种子能抽到的资质 / 基础属性（``src`` 的 ``capture_preview``）。 */
  override preview(seed: number, inputs: Readonly<Record<string, unknown>>, rt: Runtime): string {
    if (!seed) return NO_HIT_PREVIEW;
    const plan = this.planOf(inputs);
    let state = Math.trunc(seed);
    // ⚠️ 普通葫芦空转 2 次、红葫芦 0 次 —— 照抄 ``src``，别「顺手」改成 consume。
    if (plan.mode === NORMAL_MODE) {
      for (let i = 0; i < 2; i += 1) state = rt.engine.randomAdvance(state)[1];
    }

    let text = NO_HIT_PREVIEW;
    for (const attr of ATTR_ORDER) {
      const [lo, hi] = requirePair(plan.potential, attr);
      const [value, next] = rt.engine.randomValue(state);
      state = next;
      text += `${attr}资质: ${lo + pyRound(value * (hi - lo))}    \n`;
    }
    text += "\n";
    for (const attr of ATTR_ORDER) {
      const range = plan.attrRanges.get(attr);
      if (range === undefined) continue;
      const [lo, hi] = range;
      const [value, next] = rt.engine.randomValue(state);
      state = next;
      text += `${attr}: ${lo + pyRound(value * (hi - lo))}    \n`;
    }
    return text;
  }
}

/** 从表里取一条区间（缺了就是数据/编程错误，别让 ``?.`` 把它悄悄降级成全范围）。 */
function requirePair(table: ReadonlyMap<string, Pair>, attr: string): Pair {
  const pair = table.get(attr);
  if (pair === undefined) throw new ScenarioError(`缺少「${attr}」的范围`);
  return pair;
}

register(CaptureScenario);
