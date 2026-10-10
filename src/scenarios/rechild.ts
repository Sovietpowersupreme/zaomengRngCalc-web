/**
 * 宠物还童场景 —— ``rechild``（丹药 / 药园初·中·高级）。
 *
 * 逐行对照 ``src_forge/gameInfo/rechild.py`` ↔ ``src/PetCalculator.py::calc_rechild``
 * → ``cracker.findRechild2``：规格就是一个 :class:`PoolSpec`。
 *
 * ==================  ==========================================================================
 * 池              总额外资质 ``totalPool`` 先扣**保底** ``guarantee(level)``，剩下的
 *                 ``randomTotal`` 由 3 次随机分配：每次 ``round(rand * 剩余)`` 并把结果
 *                 从剩余里扣掉，最后一次直接吃残羹 —— 这就是 ``PoolSpec`` 的前 3 个槽位
 * 槽位 1~3         主属性**随机部分** ``(max(0, 目标下限 - 保底), max(0, 目标上限 - 保底))``，
 *                 然后 ``ATTR_ORDER`` 里第一个、第二个非主轴
 * 槽位 4+         宠物「基础属性随机」时，再接 4 个基础属性的**偏移**约束（显示值 - 基础下限），
 *                 倍率由 ``roll_vals`` 给出
 * ``n``            搜索起点之前的游戏侧消耗（基类 :meth:`advanceCount` = ``n + 1``）
 * ==================  ==========================================================================
 *
 * ``n`` 与 ``findRechild`` 自己要吃的 3 次池分配**不是同一回事**：后者发生在命中种子上，
 * 已经算进 ``distance`` 里了，两者不矛盾。
 *
 * 关于丹药还童的 ``n = 0``
 * -----------------------
 * ``notes/test_pets.py`` 顶部注释写「丹药还童:1」，但**同一个文件里的代码值是 ``0``**，
 * ``src.PetCalculator.REBIRTH_CONFIG`` 也是 ``0`` —— 两处代码一致，只有那句注释是早期
 * 笔误。这里照抄 ``src``，并由 ``web/tests/rechild.test.ts`` 与 Python 侧
 * ``test_danyao_n_is_zero`` / ``test_rebirth_config_matches_src`` 双向固化这张表。
 *
 * 与 ``capture`` 的关系
 * ---------------------
 * ``hint`` / ``NO_HIT_PREVIEW`` / ``ATTR_ORDER`` / :func:`finalize` **以及**「搜索」那一组
 * （``PetScenario``）全部从 ``./capture`` import —— ``rechild.py`` 就是这么写的
 * （它 ``from .capture import ...``）。所以这里的「距离重算」「无命中哨兵」「宠物顺序」
 * 「搜索组与局部搜索」四件事**只有一份实现**，别在这里再抄一遍。
 */

import { pyRepr } from "../core/fromValue";
import { parsePair } from "../core/pair";
import type { Pair } from "../core/ranges";
import type { SearchResult } from "../core/search";
import { PoolSpec } from "../core/spec";
import type { PetInfoRecord } from "../data/consts";
import {
  ATTR_ORDER,
  NO_HIT_PREVIEW,
  PETS,
  PetScenario,
  defaultPet,
  finalize,
  petNames,
  pyRound,
} from "./capture";
import { register } from "./registry";
import {
  InputField,
  InputSchema,
  Note,
  Outcome,
  ScenarioError,
  getInt,
  getStr,
  type Runtime,
} from "./scenario";

// =========================================================================== 常量
/** 一种还童方式的参数（= ``src.PetCalculator.REBIRTH_CONFIG`` 的一项）。 */
export interface RebirthConfig {
  /** 总额外资质点数。 */
  readonly totalPool: number;
  /** 保底函数（等级 → 保底点数）。 */
  readonly guarantee: (level: number) => number;
  /** 搜索起点之前的游戏侧消耗。 */
  readonly n: number;
}

/**
 * 模式参数表。**逐项对应** ``src.PetCalculator.REBIRTH_CONFIG``。
 *
 * 键序 = 下拉框顺序（``Object.keys`` 对非数字键保留字面量顺序），
 * :data:`REBIRTH_MODES` 是它的冻结快照，两者必须一致（测试钉住）。
 */
export const REBIRTH_CONFIG: Readonly<Record<string, RebirthConfig>> = Object.freeze({
  丹药还童: Object.freeze({ totalPool: 100, guarantee: (): number => 0, n: 0 }),
  药园初级还童: Object.freeze({ totalPool: 100, guarantee: (level: number): number => level * 1, n: 3 }),
  药园中级还童: Object.freeze({ totalPool: 200, guarantee: (level: number): number => level * 2, n: 3 }),
  药园高级还童: Object.freeze({ totalPool: 250, guarantee: (level: number): number => level * 2, n: 3 }),
});

/** 支持的模式。顺序 = UI 下拉框顺序（= Python ``tuple(REBIRTH_CONFIG)``）。 */
export const REBIRTH_MODES: readonly string[] = Object.freeze([
  "丹药还童",
  "药园初级还童",
  "药园中级还童",
  "药园高级还童",
]);

/** 默认模式（= Python ``DEFAULT_MODE``）。注意**不是** ``REBIRTH_MODES[0]``。 */
export const DEFAULT_MODE: string = "药园初级还童";

// =========================================================================== 计划
/** 一次还童搜索的全部中间量。 */
export class RechildPlan {
  readonly pet: string;
  readonly mode: string;
  readonly level: number;
  readonly mainAttr: string;
  readonly consume: number;
  readonly totalPool: number;
  readonly guarantee: number;
  readonly randomTotal: number;
  /** 额外资质目标（**最终显示值**，含保底），预览与展示用。 */
  readonly extraRanges: ReadonlyMap<string, Pair>;
  /** 基础属性范围；不随机时是空表。 */
  readonly attrRanges: ReadonlyMap<string, Pair>;
  /** ``PoolSpec`` 的 ``constraints``（前 3 个是池分配，其后是基础属性偏移）。 */
  readonly targets: readonly Pair[];
  /** ``PoolSpec`` 的 ``roll_vals``（基础属性倍率）。 */
  readonly baseRolls: readonly number[];
  readonly baseRandom: boolean;
  readonly notes: readonly Note[];

  constructor(init: {
    pet: string;
    mode: string;
    level: number;
    mainAttr: string;
    consume: number;
    totalPool: number;
    guarantee: number;
    randomTotal: number;
    extraRanges: ReadonlyMap<string, Pair>;
    attrRanges: ReadonlyMap<string, Pair>;
    targets: readonly Pair[];
    baseRolls: readonly number[];
    baseRandom: boolean;
    notes?: readonly Note[];
  }) {
    this.pet = init.pet;
    this.mode = init.mode;
    this.level = Math.trunc(init.level);
    this.mainAttr = init.mainAttr;
    this.consume = Math.trunc(init.consume);
    this.totalPool = Math.trunc(init.totalPool);
    this.guarantee = Math.trunc(init.guarantee);
    this.randomTotal = Math.trunc(init.randomTotal);
    this.extraRanges = init.extraRanges;
    this.attrRanges = init.attrRanges;
    this.targets = Object.freeze(init.targets.map((t) => Object.freeze([t[0], t[1]]) as Pair));
    this.baseRolls = Object.freeze([...init.baseRolls]);
    this.baseRandom = init.baseRandom;
    this.notes = Object.freeze([...(init.notes ?? [])]);
  }

  /** ``targets`` 的长度 = C 端 ``range.num``。 */
  get num(): number {
    return this.targets.length;
  }
}

/** 从表里取一条区间（缺了就是数据/编程错误，别让 ``?.`` 把它悄悄降级）。 */
function requirePair(table: ReadonlyMap<string, Pair>, attr: string): Pair {
  const pair = table.get(attr);
  if (pair === undefined) throw new ScenarioError(`缺少「${attr}」的范围`);
  return pair;
}

/** Python ``repr(list(ATTR_ORDER))`` 的等价物 —— 用来拼报错文案。 */
function attrOrderRepr(): string {
  return `[${ATTR_ORDER.map((a) => pyRepr(a)).join(", ")}]`;
}

/**
 * 读一个目标范围输入。
 *
 * ``strict = true``（基础属性）：越界退回 ``(lo, hi)`` 并记 error。
 *
 * ``strict = false``（额外资质）：只要求 ``0 <= min <= max`` —— ``src`` 对额外资质
 * **不做上界检查**（多填的靠池子自然筛掉），所以这里必须放开，否则会把 ``src``
 * 能跑的参数判成错误。
 *
 * 与 ``capture.ts`` 的同名函数有三处文案/分支差异（照抄 ``rechild.py``，
 * 别「顺手统一」）：多一个 ``kind`` 词、文案是「已按**默认**处理」、
 * 并且有 ``vmin < 0`` 这条独立分支（在越界检查**之前**）。
 */
function readTarget(
  inputs: Readonly<Record<string, unknown>>,
  key: string,
  attr: string,
  lo: number,
  hi: number,
  kind: string,
  notes: Note[],
  strict = true,
): Pair {
  const raw = String(inputs[key] ?? "").trim();
  if (raw === "") return [lo, hi];
  const pair = parsePair(raw);
  // Python 是 ``int(pair[0])``，遇到 nan/inf 会抛未捕获异常；这里当成解析失败记 note。
  if (pair === null || !Number.isFinite(pair[0]) || !Number.isFinite(pair[1])) {
    notes.push(
      new Note({
        level: "error",
        message: `${attr} ${kind}范围无法解析（${pyRepr(raw)}），已按默认处理`,
        field: key,
      }),
    );
    return [lo, hi];
  }
  let vmin = Math.trunc(pair[0]);
  let vmax = Math.trunc(pair[1]);
  if (vmin > vmax) [vmin, vmax] = [vmax, vmin];
  if (vmin < 0) {
    notes.push(
      new Note({
        level: "error",
        message: `${attr} ${kind}不能为负数，已按默认处理`,
        field: key,
      }),
    );
    return [lo, hi];
  }
  if (strict && (vmin < lo || vmax > hi)) {
    notes.push(
      new Note({
        level: "error",
        message: `${attr} ${kind} ${vmin}~${vmax} 超出 ${lo}~${hi}，已按默认处理`,
        field: key,
      }),
    );
    return [lo, hi];
  }
  return [vmin, vmax];
}

// =========================================================================== 场景
/**
 * 宠物还童：丹药 / 药园初中高级。
 *
 * 「搜索」那一组（起始种子 / 枚举全部 / 步数上限）与局部搜索的执行都直接继承
 * `PetScenario` —— 旧版 `src/PetCalculator.py` 里捕捉与还童本来就是**同一个窗口**
 * 共用那一格起始种子（`:131` 的 6 个模式、`:102` 那一个 `ttk.Entry`）。
 */
export class RechildScenario extends PetScenario {
  override readonly key = "rechild";
  override readonly label = "宠物还童";
  override readonly version = "1.0";
  override readonly specKind = "pool";

  override readonly hint =
    "用丹药或药园还童宠物。选宠物 → 选还童方式 → 填等级与主资质 → 填起始种子。\n" +
    "总额外资质先扣保底（等级决定），剩下的随机分给 3 个属性，最后一个吃残羹。\n" +
    "额外资质留空 = 用默认范围（主属性 [保底, 总额]，其余 [0, 可随机部分]）。\n" +
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
        label: "还童方式",
        kind: "choice",
        default: DEFAULT_MODE,
        choices: REBIRTH_MODES,
        group: "宠物",
        width: 14,
      }),
      new InputField({
        key: "level",
        label: "等级",
        kind: "int",
        default: 1,
        min: 1,
        group: "宠物",
        help: "等级决定保底额外资质",
        width: 8,
      }),
      new InputField({
        key: "main_attr",
        label: "主资质",
        kind: "choice",
        default: ATTR_ORDER[0] ?? "",
        choices: ATTR_ORDER,
        group: "宠物",
        width: 12,
      }),
    ];
    for (const attr of ATTR_ORDER) {
      fields.push(
        new InputField({
          key: `extra_${attr}`,
          label: `${attr}额外`,
          kind: "text",
          default: "",
          group: "额外资质目标",
          help: "留空=默认范围；支持「10~20」「10-20」「10」",
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
  /** 纯函数：表单 → :class:`RechildPlan`。 */
  planOf(inputs: Readonly<Record<string, unknown>>): RechildPlan {
    const name = getStr(inputs, "pet", "") || defaultPet();
    const pet: PetInfoRecord | undefined = PETS[name];
    if (pet === undefined) throw new ScenarioError(`未知的宠物：${pyRepr(name)}`);
    const mode = getStr(inputs, "mode", DEFAULT_MODE) || DEFAULT_MODE;
    const cfg = REBIRTH_CONFIG[mode];
    if (cfg === undefined) throw new ScenarioError(`${this.label} 不支持的模式：${pyRepr(mode)}`);
    const level = getInt(inputs, "level", 1);
    if (level < 1) throw new ScenarioError("宠物等级必须为正整数");
    const mainAttr = getStr(inputs, "main_attr", ATTR_ORDER[0] ?? "") || (ATTR_ORDER[0] ?? "");
    if (!ATTR_ORDER.includes(mainAttr)) {
      throw new ScenarioError(`主资质必须是 ${attrOrderRepr()} 之一，得到 ${pyRepr(mainAttr)}`);
    }

    const guarantee = Math.trunc(cfg.guarantee(level));
    const randomTotal = cfg.totalPool - guarantee;
    if (randomTotal < 0) throw new ScenarioError("保底值超过总额外资质，等级太高了");

    const notes: Note[] = [];

    // ---- 额外资质目标（最终显示值）
    const extraRanges = new Map<string, Pair>();
    for (const attr of ATTR_ORDER) {
      const [lo, hi] = attr === mainAttr ? [guarantee, cfg.totalPool] : [0, randomTotal];
      const [vmin, vmax] = readTarget(
        inputs,
        `extra_${attr}`,
        attr,
        lo,
        hi,
        "额外资质",
        notes,
        false,
      );
      extraRanges.set(attr, [vmin, vmax]);
    }

    // ---- 槽位 1~3：池分配
    const [mainMin, mainMax] = requirePair(extraRanges, mainAttr);
    const r1Min = Math.max(0, mainMin - guarantee);
    const r1Max = Math.max(0, mainMax - guarantee);
    if (r1Min > r1Max) throw new ScenarioError("主资质额外值范围与保底冲突");
    const others = ATTR_ORDER.filter((a) => a !== mainAttr);
    const other0 = others[0];
    const other1 = others[1];
    if (other0 === undefined || other1 === undefined) {
      throw new ScenarioError(`主资质之外的属性不足两个：${attrOrderRepr()}`);
    }
    const targets: Pair[] = [
      [r1Min, r1Max],
      requirePair(extraRanges, other0),
      requirePair(extraRanges, other1),
    ];

    // ---- 槽位 4+：基础属性偏移
    const baseRandom = pet.基础属性随机;
    const attrRanges = new Map<string, Pair>();
    const baseRolls: number[] = [];
    if (baseRandom) {
      const source = pet.基础属性范围;
      if (source === null) throw new ScenarioError("宠物标记了「基础属性随机」但没有基础属性范围");
      for (const attr of ATTR_ORDER) {
        const range = source[attr];
        if (range === undefined) {
          throw new ScenarioError(`宠物数据类型里缺少「${attr}」的基础属性范围`);
        }
        const lo = range[0];
        const hi = range[1];
        attrRanges.set(attr, [lo, hi]);
        const [vmin, vmax] = readTarget(inputs, `base_${attr}`, attr, lo, hi, "基础属性", notes);
        targets.push([vmin - lo, vmax - lo]);
        baseRolls.push(hi - lo);
      }
    }

    return new RechildPlan({
      pet: name,
      mode,
      level,
      mainAttr,
      consume: cfg.n,
      totalPool: cfg.totalPool,
      guarantee,
      randomTotal,
      extraRanges,
      attrRanges,
      targets,
      baseRolls,
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

  /** 还童 = ``PoolSpec``（``total`` 是**扣掉保底之后**的剩余点数）。 */
  override buildSpec(inputs: Readonly<Record<string, unknown>>, _startSeed: number): PoolSpec {
    const plan = this.planOf(inputs);
    return PoolSpec.fromPairs(plan.targets, plan.randomTotal, plan.baseRolls);
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
      level: plan.level,
      main_attr: plan.mainAttr,
      guarantee: plan.guarantee,
      random_total: plan.randomTotal,
    });
  }

  // ------------------------------------------------------------------ 预览
  /** 回放命中种子能抽到的额外资质 / 基础属性（``src`` 的 ``rechild_preview``）。 */
  override preview(seed: number, inputs: Readonly<Record<string, unknown>>, rt: Runtime): string {
    if (!seed) return NO_HIT_PREVIEW;
    const plan = this.planOf(inputs);
    let state = Math.trunc(seed);
    let rest = plan.randomTotal;

    // 抽取顺序 = 主属性 + 其余按 ``ATTR_ORDER``；**最后一个不吃随机**，它拿残羹。
    const order = [plan.mainAttr, ...ATTR_ORDER.filter((a) => a !== plan.mainAttr)];
    const last = order.pop();
    if (last === undefined) throw new ScenarioError("属性表不足 3 条，无法回放分配");
    const got = new Map<string, number>();
    for (const attr of order) {
      const [value, next] = rt.engine.randomValue(state);
      state = next;
      let loc = pyRound(value * rest);
      rest -= loc;
      if (attr === plan.mainAttr) loc += plan.guarantee;
      got.set(attr, loc);
    }
    got.set(last, rest);

    let text = NO_HIT_PREVIEW;
    for (const attr of ATTR_ORDER) {
      const value = got.get(attr);
      if (value === undefined) throw new ScenarioError(`回放缺少「${attr}」的分配结果`);
      text += `${attr}资质: ${value}    \n`;
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

register(RechildScenario);
