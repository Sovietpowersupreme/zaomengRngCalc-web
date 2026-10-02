/**
 * ``src_forge/gameInfo/seed_resolve.py`` 的 1:1 翻译 —— 种子反查场景（``seed-resolve``）。
 *
 * 游戏内部用的是 31 位的 ``RandomPureHasher(seed * 71) & 0x7FFFFFFF``，而玩家能拿到的
 * 只有 ``F12`` 里打出来的一个浮点。``random()`` 的真值是那个 ``[0, 1)`` 原始浮点，
 * 随机整数 = ``int(原始浮点 × 0x80000000)``；游戏把显示用的数乘了 **100000**，
 * 于是两种换算只差一步（见 :mod:`../core/fromValue`）::
 *
 *     原始浮点   → 随机整数 = int(v × 0x80000000)
 *     显示值     → 随机整数 = int(v ÷ 100000 × 0x80000000)
 *
 * 表单因此**只有两格**（「反查值」+「匹配值」），两格都按「反查值格式」换算：
 *
 * * **「反查值」——多态**（:func:`parseValue`）：
 *
 *   * **浮点**（``0.5625…``，带小数点）→ 随机值。按「反查值格式」换算成随机整数，
 *     再 ``recoverSeeds`` 反推出所有可能的种子。日常走的就是这一条 —— 真实场景里
 *     能拿到的只有 ``random()`` 的浮点，``randomGenerator`` 那个整形根本看不到。
 *   * **整数**（``1779036211``，没有小数点）→ **已有的种子**，也就是旧版计算器那个
 *     单独的「起始值」。玩家手里已经有答案了（比如上一轮算出来的），它就不再是
 *     「要反查的东西」，而是「从哪儿开始」那把尺子 —— 反查交给「匹配值」。
 *
 * * **「匹配值」——``src`` 的 ``arg2``**：那个（或那几个）**也读到的随机值**。
 *   同样可以写浮点，同样按「反查值格式」换算。写多个（空格 / 逗号分隔）表示
 *   「按顺序读到的几个数」，只有**最后一个**参与。
 *
 * 真正的不确定性只有一处 —— ``recoverSeeds`` 的**多解**：实测单随机数能得到唯一解的
 * 概率不到 50%，所以要靠第二格多给一条约束：
 *
 * 1. ``recoverSeeds(randomInt)`` 用纯代数反演解出**所有**能产出这个随机值的种子
 *    （不搜索，所以很快，一般几个到十几个）；
 * 2. 再按两种情形筛：
 *
 *    * **有种子**：「匹配值」提供 ``arg1``，保留「从起始值正向 ``fastNext`` 能走到」
 *      的候选（``seedDistance`` 非 0），然后取它的**前一个**种子 ``getPreSeed`` ——
 *      ``recoverSeeds`` 给的是「正要产出该随机值」的那一刻，而存档里记录的是它发生
 *      **之前**的状态。种子不要求紧邻；
 *    * **没有种子**：那个随机值本身就是 ``arg1``，再对每个候选做一次
 *      ``seedFindbyRange``（单点区间 = 「匹配值」，步长 1），能匹配上就把匹配结果当答案。
 *
 * 3. **只有唯一解才算解**：``src`` 的原话是
 *    ``return results[0] if len(results) == 1 else 0`` —— 多个候选、零个候选统一返回 0。
 *    这一条必须保留：多解时给出任何一个都是在骗用户。
 *
 * 与 Python 的差异（有意为之，不是漏译）
 * --------------------------------------
 * * ``ValueInput.__bool__`` **没有翻译**：Python 侧全仓库没有一处拿它做布尔判断，
 *   译过来就是死代码。空输入在 :func:`parseValue` 就被拒了。
 * * ``run()`` 在 Python 里是同步的，这里是 ``async`` —— 只为与基类
 *   :meth:`Scenario.run` 的签名一致（TS 不允许「异步基类 + 同步覆写」）。
 *   内部一次 ``await`` 都没有。
 */

import { SpecError } from "../core/errors";
import { randomIntFromValue, pyRepr, saveGameValue } from "../core/fromValue";
import { IntervalSpec } from "../core/spec";
import { KMAX } from "../core/values";
import { register } from "./registry";
import {
  InputField,
  InputSchema,
  Note,
  Outcome,
  Runtime,
  Scenario,
  getStr,
  type RunOptions,
} from "./scenario";

export const KEY = "seed-resolve";

/** ``src`` 在 ``resolve_seed`` 里用的 ``seedDistance`` / ``seedFindbyRange`` 上限。 */
export const LIMIT = 9_999_999;

/**
 * 表单字段名 —— 就这两格（+ 一个格式下拉）。``VALUE_FIELD`` 那一格是**多态**的，
 * 起始值（``src`` 的 ``user_seed``）由它的**整数写法**兼任，不再单独开一格。
 */
export const VALUE_FIELD = "value";
export const MODE_FIELD = "value_mode";
export const TARGET_FIELD = "target";

/** 「反查值格式」的候选 —— 浮点该怎么换算成随机整数。默认第一个。 */
export const MODE_VALUE = "原始浮点";
export const MODE_SAVE_GAME = "保存游戏";
export const VALUE_MODES: readonly [string, string] = Object.freeze([MODE_VALUE, MODE_SAVE_GAME]);

/** 「匹配值」里几个数之间的分隔符。与 ``gameInfo.stars`` 的「观测值」一套写法。 */
export const VALUE_SPLIT_RE = /[，,、；;:：\s]+/;

/** 没有唯一解时的预览（``src`` 只写一句日志，这里保留一个占位）。 */
export const NO_HIT_PREVIEW = "种子: -";

/** 换算表：格式 → 浮点换算函数。键就是 :data:`VALUE_MODES` 里的文案。 */
const VALUE_CONVERTERS: Readonly<Record<string, (text: unknown) => number>> = {
  [MODE_VALUE]: randomIntFromValue,
  [MODE_SAVE_GAME]: saveGameValue,
};

/**
 * 按「反查值格式」取换算函数；不认识的格式直接报错。
 *
 * 「反查值」和「匹配值」**共用**这一张表 —— 选「保存游戏」时两格一起 ÷100000，
 * 不存在「一边按显示值算、另一边按原始浮点算」的中间状态。
 */
function converter(mode: string): (text: unknown) => number {
  const found = VALUE_CONVERTERS[mode];
  if (found === undefined) {
    throw new SpecError(
      `「反查值格式」不认识 ${pyRepr(mode)}，可选 [${VALUE_MODES.map((m) => `'${m}'`).join(", ")}]`,
    );
  }
  return found;
}

/**
 * Python ``int(text, 10)`` 的等价物（``null`` = 转不动）。
 *
 * 只认「可选符号 + 十进制数字」，与 ``scenario.ts`` 里那个私有的 ``pythonInt`` 同构。
 * ``Number(text)`` **不能**用：它认 ``0x`` 前缀、也认空串。
 */
function pyInt(text: string): number | null {
  if (!/^[+-]?\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * 整数字面量（没有小数点/指数）→ ``int``；不是整数写法就返回 ``null``。
 *
 * ``"1e3"`` / ``"nan"`` / ``"inf"`` 都算浮点写法 —— 它们该走浮点那条路，然后再被
 * 范围检查挡下来，而不是在这里变成种子。
 */
function integerOf(text: string): number | null {
  if (/[.eE]/.test(text)) return null;
  return pyInt(text);
}

export interface ValueInputInit {
  mode?: string;
  randomInt?: number;
  seed?: number;
  isSeed?: boolean;
  text?: string;
}

/** 「反查值」一格输入解析出来的两种意思（见 :func:`parseValue`）。 */
export class ValueInput {
  /** 生效的「反查值格式」。（整数输入用不到它，但保留下来便于日志/测试核对。） */
  readonly mode: string;
  /** 浮点输入：按 :attr:`mode` 换算好的随机整数，交给 ``recoverSeeds``。 */
  readonly randomInt: number;
  /** 整数输入：输入本身就是种子（``src`` 的 ``user_seed``，也就是起始值）。 */
  readonly seed: number;
  /** 输入是不是「种子」那一条路 —— 是的话它当起始值，反查交给「匹配值」。 */
  readonly isSeed: boolean;
  /** 去掉首尾空白后的原文（报错文案与 UI 回显用）。 */
  readonly text: string;

  constructor(init: ValueInputInit = {}) {
    this.mode = init.mode ?? MODE_VALUE;
    this.randomInt = Math.trunc(init.randomInt ?? 0);
    this.seed = Math.trunc(init.seed ?? 0);
    this.isSeed = init.isSeed ?? false;
    this.text = init.text ?? "";
  }
}

/**
 * 解析「反查值」——**浮点 = 随机值，整数 = 种子（= 起始值）**。
 *
 * 整数这一条是有意为之：``randomGenerator`` 返回的整形在游戏里看不到，**但**
 * 「上一轮算出来的种子」是玩家确实会有的东西。填进来时它就是 ``src`` 的
 * ``user_seed``，反查的对象则换成「匹配值」。
 *
 * ⚠️ 先查 ``mode`` 再判整数（照抄 Python 的调用顺序）：格式写错时，哪怕输入是合法
 * 整数也照样报格式错，而不是默默按默认格式算。
 *
 * :throws SpecError: 空、不是数字、超出 31 位、或者 ``mode`` 不认识。
 */
export function parseValue(raw: unknown, mode: string = MODE_VALUE): ValueInput {
  const text = (raw === null || raw === undefined ? "" : String(raw)).trim();
  if (!text) {
    throw new SpecError("「反查值」还没填 —— 浮点（random() 的值）或整数（已有的种子）都行");
  }
  const convert = converter(mode);
  const seed = integerOf(text);
  if (seed !== null) {
    if (!(0 < seed && seed <= KMAX)) {
      throw new SpecError(`「反查值」当种子用时必须落在 1..${KMAX}，得到 ${pyRepr(text)}`);
    }
    return new ValueInput({ mode, seed, isSeed: true, text });
  }
  return new ValueInput({ mode, randomInt: convert(text), text });
}

/**
 * 解析「匹配值」→ ``src`` 的 ``arg2``（随机整数），空 = ``0``。
 *
 * 和「反查值」走**同一张换算表**，允许写多个（空格 / 逗号分隔），只有**最后一个**参与。
 *
 * 整数写法按**随机整数**理解（不是种子）：「匹配值」的位置永远是 ``arg2``。
 *
 * ⚠️ 这里先判整数再查 ``mode``（与 :func:`parseValue` **相反**，照抄 Python）：
 * 整数写法根本用不到换算表，所以格式写错也不该在这里报错。
 *
 * :throws SpecError: 最后一个既不是数字、又超出 ``0..KMAX``（或格式不认识）。
 */
export function parseTarget(raw: unknown, mode: string = MODE_VALUE): number {
  const parts = (raw === null || raw === undefined ? "" : String(raw))
    .split(VALUE_SPLIT_RE)
    .filter((part) => part !== "");
  const text = parts.at(-1);
  if (text === undefined) return 0;
  const seed = integerOf(text);
  if (seed !== null) {
    if (!(0 <= seed && seed <= KMAX)) {
      throw new SpecError(`「匹配值」当随机整数用时不能超出 0..${KMAX}，得到 ${pyRepr(text)}`);
    }
    return seed;
  }
  return converter(mode)(text);
}

export interface ResolveResultInit {
  seed?: number;
  candidates?: readonly number[];
  matched?: readonly number[];
  notes?: readonly Note[];
}

/** ``resolveSeed`` 的完整结果（``seed`` 才是 ``src`` 的返回值）。 */
export class ResolveResult {
  /** 唯一解；``0`` 表示「零个候选或多个候选」（两者在 ``src`` 里都是 0）。 */
  readonly seed: number;
  /** 全部通过筛选的最终答案（含被 ``seed`` 取走的那个）。 */
  readonly candidates: readonly number[];
  /** 中间态：有起始值时是 ``getPreSeed`` **之前**的那个种子（``seedDistance`` 量它）。 */
  readonly matched: readonly number[];
  readonly notes: readonly Note[];

  constructor(init: ResolveResultInit = {}) {
    this.seed = Math.trunc(init.seed ?? 0);
    this.candidates = Object.freeze([...(init.candidates ?? [])]);
    this.matched = Object.freeze([...(init.matched ?? [])]);
    this.notes = Object.freeze([...(init.notes ?? [])]);
  }

  get found(): boolean {
    return this.seed !== 0;
  }
}

export interface ResolveOptions {
  rt: Runtime;
  notes?: readonly Note[];
}

/**
 * ``src`` 的 ``resolve_seed(user_seed, arg1, arg2=0)``，但把中间结果也带出来。
 *
 * :param userSeed: 起始值，``0`` 表示不用（走 ``target`` 单点匹配）—— 「反查值」
 *     填整数时它就是那个整数。
 * :param randomInt: 反查值换算出来的随机整数（``arg1``）—— ``seed`` 的
 *     ``staticRandomGenerator``。「反查值」填整数时，上游把**「匹配值」**换算好放在
 *     这里。注意上游那两格都已经过 :func:`parseValue` / :func:`parseTarget`，
 *     这里收到的不是玩家填的那串字。
 * :param target: 匹配值（``arg2``），只在 ``userSeed === 0`` 时用。
 */
export function resolveCandidates(
  userSeed: number,
  randomInt: number,
  target: number = 0,
  options: ResolveOptions,
): ResolveResult {
  const { rt } = options;
  const engine = rt.engine;
  const collected: Note[] = [...(options.notes ?? [])];
  const recovered = engine.recoverSeeds(Math.trunc(randomInt)).map((s) => Math.trunc(s));
  if (recovered.length === 0) {
    collected.push(new Note({ level: "warning", message: "反查不到任何候选种子", field: VALUE_FIELD }));
    return new ResolveResult({ notes: collected });
  }

  const matched: number[] = [];
  let answers: number[];
  if (userSeed) {
    for (const seed of recovered) {
      if (engine.seedDistance(Math.trunc(userSeed), seed, LIMIT)) matched.push(seed);
    }
    answers = matched.map((seed) => Math.trunc(engine.getPreSeed(seed)));
  } else {
    const spec = IntervalSpec.fromPairs([[Math.trunc(target), Math.trunc(target)]]);
    for (const seed of recovered) {
      const found = rt.searcher.searchNearest(Math.trunc(seed), spec, LIMIT);
      if (found.nearest !== null && Math.trunc(found.nearest)) {
        matched.push(Math.trunc(found.nearest));
      }
    }
    answers = [...matched];
  }

  if (answers.length === 0) {
    collected.push(
      new Note({ level: "warning", message: "候选种子都被筛选条件排除了", field: VALUE_FIELD }),
    );
  } else if (answers.length > 1) {
    collected.push(
      new Note({
        level: "warning",
        message: `有 ${answers.length} 个候选种子，无法唯一确定`,
        field: VALUE_FIELD,
      }),
    );
  }
  return new ResolveResult({
    seed: answers.length === 1 ? (answers[0] as number) : 0,
    candidates: answers,
    matched,
    notes: collected,
  });
}

/** ``src`` 的返回值：唯一解，否则 ``0``。 */
export function resolveSeed(
  userSeed: number,
  randomInt: number,
  target: number = 0,
  options: ResolveOptions,
): number {
  return resolveCandidates(userSeed, randomInt, target, options).seed;
}

/** 种子反查 —— 输入随机值（或种子 + 随机值），反推出唯一的种子。 */
export class SeedResolveScenario extends Scenario {
  override readonly key = KEY;
  override readonly label = "种子反查";
  override readonly version = "1.2";
  override readonly hint =
    "「反查值」填浮点（random() 打出来的随机值）就反推种子，" +
    "填整数（手里已有的种子）就当旧版的「起始值」用 —— 那就得靠" +
    "「匹配值」（那次读到的随机值）来反查。唯一解才算解。";
  override readonly specKind = "interval";
  override readonly nearLimit = LIMIT;
  override readonly supportsNear = true;

  // ------------------------------------------------------------------ 机制
  /** 没有「属性计算」阶段，也没有连点器。 */
  override randomConsumption(_inputs: Readonly<Record<string, unknown>>): number {
    return 0;
  }

  /**
   * ``resolveCandidates`` 内部那个单点区间 —— 抽出来是为了可测、可复用。
   *
   * 注意 ``step`` 固定为 1：``src`` 调用 ``seedFindbyRange`` 时没传 ``step``，
   * 用的是默认值 1。起始值那一支压根不做搜索（走 ``seedDistance``），这里返回的
   * spec 只是为了让基类 :meth:`Scenario.prepare` 有东西可返回。
   */
  override buildSpec(inputs: Readonly<Record<string, unknown>>, _startSeed: number): IntervalSpec {
    const target = SeedResolveScenario.target(inputs);
    return IntervalSpec.fromPairs([[target, target]]);
  }

  override validate(inputs: Readonly<Record<string, unknown>>): readonly Note[] {
    const notes: Note[] = [];
    const mode = SeedResolveScenario.mode(inputs);
    let parsed: ValueInput;
    try {
      parsed = parseValue(inputs[VALUE_FIELD], mode);
    } catch (exc) {
      // 空 / 不是数字 / 越界 / 格式不认识，都由 ``parseValue`` 一句话讲清。
      // 「反查值」都读不出来，再讨论「怎么把多解压成一个」就是废话 ——
      // 刚切进场景（值还是空的）时也只留这一条错误。
      if (exc instanceof SpecError) {
        return [new Note({ level: "error", message: exc.message, field: VALUE_FIELD })];
      }
      throw exc;
    }
    let target: number;
    try {
      target = SeedResolveScenario.target(inputs);
    } catch (exc) {
      if (exc instanceof SpecError) {
        return [...notes, new Note({ level: "error", message: exc.message, field: TARGET_FIELD })];
      }
      throw exc;
    }

    if (parsed.isSeed) {
      // 整数 = 起始值：反查的对象换成了「匹配值」，没有它就没东西可查。
      notes.push(
        new Note({
          level: "info",
          message:
            `「反查值」是整数 → 当作起始值（种子 ${parsed.seed}），` +
            "要反查的随机值由「匹配值」提供",
          field: VALUE_FIELD,
        }),
      );
      if (!target) {
        notes.push(
          new Note({
            level: "error",
            message:
              "「反查值」当起始值用时「匹配值」不能空 —— " +
              "那里要填那一次读到的随机值，否则没东西可反查",
            field: TARGET_FIELD,
          }),
        );
      }
      return notes;
    }

    // 浮点 = 随机值，本身就够反查了；「匹配值」只是 ``src`` 的第二条筛法，
    // 用来把多解压成一个 —— 填不填都能跑，所以只提醒、不拦。
    if (target) {
      notes.push(
        new Note({
          level: "info",
          message:
            "「匹配值」用来筛候选：手里还有上次算出的种子的话，" +
            "把它填进「反查值」（整数写法）比只靠「匹配值」更稳",
          field: TARGET_FIELD,
        }),
      );
    } else {
      notes.push(
        new Note({
          level: "warning",
          message:
            "「匹配值」空着 → 只靠一个随机值反查，多半对应多个候选种子，" +
            "拿不到唯一解时本场景会拒绝给答案",
          field: TARGET_FIELD,
        }),
      );
    }
    return notes;
  }

  override preview(seed: number, _inputs: Readonly<Record<string, unknown>>, _rt: Runtime): string {
    return seed ? `种子: ${Math.trunc(seed)}` : NO_HIT_PREVIEW;
  }

  // ------------------------------------------------------------------ 执行
  /**
   * 直接做反查（**不做搜索**）。
   *
   * ``near`` / ``limit`` / ``ctx`` 只为与基类 :meth:`Scenario.run` 的签名兼容而存在，
   * 一律忽略 —— 反查本身很快，没有「步数门槛」可谈。
   */
  override async run(
    inputs: Readonly<Record<string, unknown>>,
    startSeed: number,
    options: RunOptions = {},
  ): Promise<Outcome> {
    const rt = Runtime.resolve(options.backend ?? null, options.pool ?? null);
    const prepared = this.prepare(inputs, startSeed);
    // ``prepare`` 已经跑过 ``validate``，那里面解析过一次且没抛错，
    // 所以这里再来一次一定成功（就是为了拿那个 :class:`ValueInput`）。
    const parsed = SeedResolveScenario.valueInput(inputs);
    const target = SeedResolveScenario.target(inputs);
    const userSeed = SeedResolveScenario.startSeed(parsed, startSeed);
    // 有种子时：「匹配值」才是那一次读到的随机值（``arg1``），「反查值」是尺子；
    // 没有种子时：「反查值」自己就是 ``arg1``，「匹配值」只管筛。
    const randomInt = parsed.isSeed ? target : parsed.randomInt;
    const resolved = resolveCandidates(userSeed, randomInt, target, {
      rt,
      notes: prepared.notes,
    });
    return this.outcomeOf(resolved, parsed, startSeed, rt);
  }

  /** 把 :class:`ResolveResult` 翻译成 :class:`Outcome`。 */
  outcomeOf(
    resolved: ResolveResult,
    parsed: ValueInput,
    startSeed: number,
    rt: Runtime,
  ): Outcome {
    const userSeed = SeedResolveScenario.startSeed(parsed, startSeed);
    const extra: Record<string, unknown> = {
      // ``src`` 的 ``user_seed``：整数「反查值」，或者 API 传进来的起点。
      user_seed: Math.trunc(userSeed),
      // 那一格填的是整数 → 它是种子，不是随机值。
      value_is_seed: parsed.isSeed,
      candidates: resolved.candidates.map((s) => Math.trunc(s)),
      matched: resolved.matched.map((s) => Math.trunc(s)),
    };
    if (!resolved.seed) {
      return new Outcome({
        seed: 0,
        distance: 0,
        needConsume: -1,
        consume: 0,
        preview: NO_HIT_PREVIEW,
        seeds: resolved.candidates,
        notes: resolved.notes,
        backend: rt.backend.name,
        extra,
      });
    }
    // 量到**返回的那个种子**（有起始值的那一支是 ``getPreSeed`` 之后），
    // 也就是 ``src`` 界面上 ``show_custom_result`` 写的那个整数 —— 两边一致。
    const distance = userSeed
      ? Math.trunc(rt.engine.seedDistance(Math.trunc(userSeed), Math.trunc(resolved.seed), LIMIT))
      : 0;
    return new Outcome({
      seed: resolved.seed,
      distance,
      needConsume: distance - 1,
      consume: 0,
      preview: `种子: ${Math.trunc(resolved.seed)}`,
      seeds: resolved.candidates,
      notes: resolved.notes,
      backend: rt.backend.name,
      extra,
    });
  }

  // ------------------------------------------------------------------ 表单
  override schema(): InputSchema {
    return new InputSchema({
      title: this.label,
      hint: this.hint,
      fields: [
        new InputField({
          key: VALUE_FIELD,
          label: "反查值",
          // 多态：浮点 = 随机值，整数 = 种子（= 起始值）。用 text 而不是 ``float`` ——
          // ``float`` 那种控件/解析会把 ``1779036211`` 也变成浮点，存不存在小数点
          // 这个信息就丢了。
          kind: "text",
          default: "",
          help: "浮点 = random() 的随机值（如 0.5625…）；整数 = 已有的种子，当起始值用",
          group: "输入",
          width: 22,
        }),
        new InputField({
          key: MODE_FIELD,
          label: "反查值格式",
          kind: "choice",
          default: MODE_VALUE,
          choices: VALUE_MODES,
          help: "两个格子共用：「原始浮点」v × 0x80000000；「保存游戏」v ÷ 100000 × 0x80000000",
          group: "输入",
          width: 16,
        }),
        new InputField({
          key: TARGET_FIELD,
          label: "匹配值",
          // 和「反查值」一样是 text：能写浮点，也能一次抄几个读数。
          kind: "text",
          default: "",
          help: "也读到的随机值（src 的 arg2）；可写多个，只有最后一个参与",
          group: "输入",
          width: 22,
        }),
      ],
    });
  }

  // ------------------------------------------------------------------ 内部
  /** 生效的「反查值格式」—— choice 一定在候选项里，``getStr`` 只是兜底。 */
  private static mode(inputs: Readonly<Record<string, unknown>>): string {
    return getStr(inputs, MODE_FIELD, MODE_VALUE);
  }

  /** 「反查值」那格 → :class:`ValueInput`（``prepare`` 之后一定成功）。 */
  private static valueInput(inputs: Readonly<Record<string, unknown>>): ValueInput {
    return parseValue(inputs[VALUE_FIELD], SeedResolveScenario.mode(inputs));
  }

  /** 「匹配值」那格 → ``src`` 的 ``arg2``（随机整数，空 = 0）。 */
  private static target(inputs: Readonly<Record<string, unknown>>): number {
    return parseTarget(inputs[TARGET_FIELD], SeedResolveScenario.mode(inputs));
  }

  /**
   * ``src`` 的 ``user_seed``：整数「反查值」优先，其次 ``run()`` 的入参。
   *
   * 整数「反查值」**就是**旧版那个单独的「起始值」；浮点那一支没有种子可言，
   * ``startSeed`` 是留给 ``scenario.run(inputs, startSeed)`` 这种程序化调用的后门
   * （UI 里没有对应的格子，永远是 0）。
   */
  static startSeed(parsed: ValueInput, startSeed: number = 0): number {
    const value = parsed.isSeed ? Math.trunc(parsed.seed) : Math.trunc(startSeed || 0);
    return 0 < value && value <= KMAX ? value : 0;
  }
}

register(SeedResolveScenario);
