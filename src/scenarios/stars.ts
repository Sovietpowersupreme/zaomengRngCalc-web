/**
 * 种子搜索器场景 —— ``stars``（原名「七星」，``src/SevenStars.py``）的 1:1 翻译。
 *
 * 这个 ``key`` 一直叫 ``stars``（常量侧 ``const/stars.py`` / ``consts.json::stars``
 * 也是），但界面上的 ``label`` 是「种子搜索器」—— 下拉框里真正被用的那件事是
 * 「反推种子」。「保存游戏」**不是**单独一项，它就是「预设」下拉框里的一个选项
 * （``raw`` 模式）。
 *
 * 逐项对照 ``src`` 的 ``run_custom_function`` / ``enum_31bit`` / ``resolve_seed``：
 *
 * ```
 * 1  解析输入：5 个预设各有各的解析方式（boss 简称 / 整数带上下限 / 显示值）
 * 2  有起始值 → seedFindbyRange(起始值, urange, 9999999, step)（局部搜索）
 *    没有起始值 → crack / crack2 / fastCrack 全空间枚举，**要求唯一解**
 * 3  命中种子推进 advance 次 FastNext 得到「结果整数」
 * 4  距离 = seedDistance(起始值, 结果整数, 9999999)（0 显示成 -）
 * ```
 *
 * 两条分支在同一个预设上**行为不同**，这不是笔误，是 ``src`` 的原样：
 *
 * ``斗部群星``
 *     * 没有起始值：``fastCrack`` 的**等值+掩码**匹配（``imask = 0x60000000``，
 *       四个 boss 只差第 29~30 位），步长 3；
 *     * 有起始值：``uintBeforeTruncation`` 把 boss 序号折成区间，
 *       再用 ``seedFindbyRange`` 正向找最近的 —— **不是**掩码匹配。
 *     * 有起始值时只取前 :data:`MAX_CONSTRAINTS`（31）个输入，没有时不受这个限制。
 *     * 一次操作 3 次随机，**第 3 次才是选中**（``randomPos = 3``），前 2 次无关；
 *       两条分支在 ``notes/test_seed.py`` 里都手算过：
 *       ``[(i, i)]`` 区间 ↔ ``i * 0x20000000`` 掩码等值。两者机制上等价
 *       （掩码保留的就是向下取整桶的最高 2 位），但区间每边宽 1，
 *       于是边界上有 9/2^31 个值两条路线都收 —— ``convertToRange`` 的粒度问题。
 *     * 输入是**手点**出来的：面板让玩家点 boss 名或 ``0~3``，掩码是**算完**再套的。
 *
 * ``还童丹 / 宠物铠甲``
 *     * 两种分支都用 ``uintBeforeRound``，``r < crack2_max_span(=20)`` 时枚举走
 *       ``crack2``（32 槽环形窗口），否则走 ``crack``。
 *
 * ``保存游戏``
 *     * **不搜索**，直接调 :func:`resolveCandidates`
 *       （``recoverSeeds`` 代数反演 + ``seedDistance`` / ``seedFindbyRange`` 筛选）。
 *       输入只有最后 1~2 个数参与（``values[-1 if userSeed else -2:]``）。
 *
 * ``advance`` 的公式也分两支（``src`` 的 ``task()``）：
 *
 * ```
 * 保存游戏: FastNext^(step - randomPos)
 * 其余:     FastNext^((len(seq) - 1) * step + (step - randomPos))
 * ```
 *
 * ``Outcome`` 字段的落点
 * ----------------------
 * * ``seed`` = 命中的种子（``src`` 的 ``normal_calc`` 返回值 / ``resolve_seed`` 返回值）；
 * * ``seedAfter`` = 「结果整数」—— ``src`` 界面上那个只读框，也是量距离的终点；
 * * ``distance`` = ``seedDistance(起始值, seedAfter)``，没有起始值时为 0（``src`` 显示 ``-``）；
 * * ``consume`` = ``advance``，于是 ``needConsume = distance - 1 - advance``
 *   = 「从起始值到**命中种子**要预先过的随机数 - 1」，与 ``Outcome`` 的通用语义一致。
 *   没有起始值时 ``needConsume`` 是负数（= 不适用）。
 */

import { saveGameValue, pyRepr } from "../core/fromValue";
import { SpecError } from "../core/errors";
import { uintBeforeRound, uintBeforeTruncation, type Pair } from "../core/ranges";
import { IntervalSpec, MaskSpec, type ScannerKind, type SeedSpec } from "../core/spec";
import type { SearchResult } from "../core/search";
import { KMAX, MAX_INPUT } from "../core/values";
import { CONSTS, type StarsPresetConst } from "../data/consts";
import { register } from "./registry";
import { resolveCandidates } from "./seed_resolve";
import {
  InputField,
  InputSchema,
  Note,
  Outcome,
  Runtime,
  Scenario,
  ScenarioError,
  getBool,
  getInt,
  getStr,
} from "./scenario";
import type { RunOptions } from "./scenario";
import type { WasmRuntime } from "../wasm/runtime";

// =========================================================================== 名字
export const KEY = "stars";

export const START_FIELD = "start_seed";
export const PRESET_FIELD = "preset";
export const SEQUENCE_FIELD = "sequence";
export const PARALLEL_FIELD = "parallel";

/** ``src`` 用的切分符（比 ``core/ranges.ts::delimiters`` 多 ``:`` ``：``、少 ``|~·/``）。 */
const SEQUENCE_SPLIT_RE = /[，,、；;:：\s]+/;

/** 「输入太少，未找到唯一种子」—— ``src`` 的原话。 */
export const TOO_FEW = "输入太少, 未找到唯一种子，请增加输入";

export const NO_HIT_PREVIEW = "距离: -\n结果: -";
export const TOO_FEW_PREVIEW = `距离: -\n结果: -（${TOO_FEW}）`;

// =========================================================================== 常量
//
// 全部走 ``consts.json``（导出自 ``const/stars.py``），不再抄一份字面量 ——
// 抄两份就会有「Python 改了、TS 没改」的静默漂移。

/** 预设表（**有序**列表：顺序就是 UI 下拉框的顺序，``src`` 拿第一项当默认值）。 */
export const PRESETS: readonly StarsPresetConst[] = CONSTS.stars.presets;

export const PRESET_NAMES: readonly string[] = Object.freeze(
  CONSTS.stars.presets.map((p) => p.name),
);

/** 默认预设（``src`` 里「未勾选用户输入」或下拉框停在第一项时强制用它）。 */
export const DEFAULT_PRESET: string = CONSTS.stars.default_preset;

/** 「保存游戏」预设的名字（``stars`` 预设下拉框里的一项，``raw`` 模式）。 */
export const SAVE_GAME_PRESET: string = CONSTS.stars.save_game_preset;

/**
 * 模式标识（``const/stars.py`` 的 ``DBQX_MODE`` 一族）。
 *
 * ``modes`` 在 ``consts.ts`` 里是索引签名（``Record<string, string>``），
 * 而 ``noUncheckedIndexedAccess`` 会让取值带上 ``undefined``。缺表时**在模块加载期
 * 就抛** —— 悄悄回落成字面量会让 ``consts.json`` 的漂移变成静默的 bug。
 */
function modeOf(name: string): string {
  const value = CONSTS.stars.modes[name];
  if (value === undefined) throw new Error(`consts.json 的 stars.modes 缺少 ${name}`);
  return value;
}

export const DBQX_MODE: string = modeOf("dbqx");
export const ROUND_MODE: string = modeOf("round");
export const TRUNCATION_MODE: string = modeOf("truncation");
export const RAW_MODE: string = modeOf("raw");

/** 走 ``enum_31bit`` 的模式（``raw`` 走 ``resolve_seed``）。 */
export const ENUM_MODES: ReadonlySet<string> = new Set(CONSTS.stars.enum_modes);

/** 斗部群星的 4 个 boss —— 下标即值，简称即输入。 */
export const BOSS_BY_INDEX: readonly string[] = CONSTS.stars.boss_by_index;

const BOSS_BY_NAME: ReadonlyMap<string, number> = new Map(
  BOSS_BY_INDEX.map((name, index) => [name, index] as const),
);

/** ``enum_31bit`` 的局部搜索只取前 31 个区间（``min(len(lst), 31)``）。 */
export const MAX_CONSTRAINTS: number = CONSTS.stars.max_constraints;

/**
 * ``fastCrack`` 的默认 ``imask`` —— 只保留哈希的**第 29~30 位**。
 *
 * 目前**只有斗部群星**能用 ``fastCrack``（它的观测值正好 4 选 1，而其它预设的
 * ``r + 1`` 不是 2 的幂，留不出干净的掩码）。与 ``core/values.ts::BOSS_MASK`` 同值。
 */
export const FASTCRACK_IMASK: number = CONSTS.stars.fastcrack_imask;

/** 斗部群星每个 boss 对应的等值目标（``i * 0x20000000``）。 */
export const DBQX_VALUE_STEP: number = CONSTS.stars.dbqx_value_step;

/** ``r < crack2_max_span`` 用 ``crack2``（窗口 32），否则用 ``crack``（``src`` 的「大概的数」）。 */
export const CRACK2_MAX_SPAN: number = CONSTS.stars.crack2_max_span;

/** ``seedDistance`` 的上限（``src`` 里全是 ``9999999``）。 */
export const DISTANCE_LIMIT: number = CONSTS.stars.distance_limit;

// =========================================================================== 纯函数
/** Python ``str(list[str])`` 的近似物 —— 只用来拼报错文案。 */
function pyStrList(items: readonly string[]): string {
  return `[${items.map((item) => `'${item}'`).join(", ")}]`;
}

/**
 * Python ``int(text, 10)`` 的等价物（``null`` = 转不动）。
 *
 * 只认「可选符号 + 十进制数字」，与 ``scenario.ts`` 里那个私有的 ``pythonInt``、
 * ``seed_resolve.ts`` 里那个 ``pyInt`` 同构。``Number(text)`` **不能**用：它认
 * ``0x`` 前缀、也认空串。
 */
function pyInt(text: string): number | null {
  if (!/^[+-]?\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** 按名字取预设。:throws SpecError: 未知预设。 */
export function presetOf(name: string): StarsPresetConst {
  const preset = CONSTS.stars.presets.find((p) => p.name === String(name));
  if (preset === undefined) {
    throw new SpecError(`未知的七星预设：${pyRepr(name)}，可选 ${pyStrList(PRESET_NAMES)}`);
  }
  return preset;
}

/**
 * ``"翁"`` / ``"0"`` / ``0`` → ``0``（``src`` 的 ``num_boss`` + ``dic`` 两张表）。
 *
 * :throws SpecError: 既不是 0~3 的序号，也不是四个 boss 简称之一。
 */
export function bossIndex(value: unknown): number {
  const text = String(value).trim();
  const byName = BOSS_BY_NAME.get(text);
  if (byName !== undefined) return byName;
  const index = pyInt(text);
  if (index === null || !(index >= 0 && index < BOSS_BY_INDEX.length)) {
    throw new SpecError(`斗部群星只接受 ${pyStrList(BOSS_BY_INDEX)} 或 0~3，得到 ${pyRepr(value)}`);
  }
  return index;
}

/**
 * boss 序号序列 → ``fastCrack`` 的等值目标 ``(i * 0x20000000, ...)``。
 *
 * 等价的常规路线是 ``[(i, i) for i in sequence]`` 交给 ``crack`` / ``crack2``
 * （``src`` 的局部搜索分支就是这么干的，见模块 docstring）。
 */
export function dbqxEqualityValues(sequence: readonly number[]): readonly number[] {
  return sequence.map((index) => Math.trunc(index) * DBQX_VALUE_STEP);
}

/**
 * ``src`` 的 ``seq = values[-1 if userSeed else -2:]``。
 *
 * 有起始种子时只需**最后 1 个**数（``recoverSeeds`` 反推候选，再用 ``seedDistance``
 * 挑），没有时用**最后 2 个**（``seedDistance`` 那一路不可用，只能靠
 * ``seedFindbyRange`` 匹配，多一个约束能收敛）。
 */
export function rawSequence(values: readonly number[], userSeed: number): readonly number[] {
  return userSeed ? values.slice(-1) : values.slice(-2);
}

/**
 * 命中种子 → ``src`` 展示的那个整数，要过几次 ``FastNext``。
 *
 * ``src`` 的两支：
 *
 * ```
 * if mode == 'raw': range(step - randomPos)
 * else:            range((len(seq) - 1) * step + (step - randomPos))
 * ```
 *
 * ``raw`` 只有 1~2 个输入、且 ``随机位置 = 2``，所以没有「跳过一个完整操作」的那一项。
 */
export function advanceAfterMatch(
  mode: string,
  length: number,
  randomPos: number,
  step: number,
): number {
  const tail = Math.trunc(step) - Math.trunc(randomPos);
  if (mode === RAW_MODE) return tail;
  return Math.max(0, Math.trunc(length) - 1) * Math.trunc(step) + tail;
}

/** ``r < 20`` 用 ``crack2``，否则用 ``crack``（``src`` 的经验值）。 */
export function scannerFor(span: number): ScannerKind {
  return Math.trunc(span) < CRACK2_MAX_SPAN ? "crack2" : "crack";
}

// =========================================================================== 计划
export interface StarsPlanInit {
  presetName: string;
  preset: StarsPresetConst;
  userSeed: number;
  /** 归一化后的输入：boss 序号（斗部群星）/ 整数 / 换算后的原始随机整数（保存游戏）。 */
  sequence: readonly number[];
  /** 区间约束（``raw`` 模式是那个单点区间；斗部群星的枚举分支用不上它）。 */
  pairs: readonly Pair[];
  /** 命中种子 → 「结果整数」要推进的次数。 */
  advance: number;
  notes?: readonly Note[];
}

/** 一次七星计算的完整「意图」（纯数据，不碰后端）。 */
export class StarsPlan {
  readonly presetName: string;
  readonly preset: StarsPresetConst;
  readonly userSeed: number;
  readonly sequence: readonly number[];
  readonly pairs: readonly Pair[];
  readonly advance: number;
  readonly notes: readonly Note[];

  constructor(init: StarsPlanInit) {
    this.presetName = init.presetName;
    this.preset = init.preset;
    this.userSeed = Math.trunc(init.userSeed);
    this.sequence = Object.freeze(init.sequence.map((v) => Math.trunc(v)));
    this.pairs = Object.freeze(init.pairs.map(([lo, hi]) => [lo, hi] as const));
    this.advance = Math.trunc(init.advance);
    this.notes = Object.freeze([...(init.notes ?? [])]);
  }

  // ---------------------------------------------------------------- 预设
  get mode(): string {
    return this.preset.mode;
  }

  get minimum(): number {
    return this.preset.minimum;
  }

  get span(): number {
    return this.preset.span;
  }

  get randomPos(): number {
    return this.preset.random_pos;
  }

  get step(): number {
    return this.preset.step;
  }

  get length(): number {
    return this.sequence.length;
  }

  // ---------------------------------------------------------------- 分支
  /** 有起始值 → 局部搜索（``seedFindbyRange``）。 */
  get local(): boolean {
    return this.userSeed !== 0;
  }

  /** 没有起始值且不是 ``保存游戏`` → 全空间枚举。 */
  get enumerating(): boolean {
    return !this.local && ENUM_MODES.has(this.mode);
  }

  get raw(): boolean {
    return this.mode === RAW_MODE;
  }

  /** ``uintBeforeTruncation`` 还是 ``uintBeforeRound``。 */
  get truncating(): boolean {
    if (this.local) return this.mode !== ROUND_MODE; // src: dbqx 走 t 分支
    return this.mode === TRUNCATION_MODE;
  }

  /** 枚举分支用 ``crack2`` 还是 ``crack``（``r < 20``）。 */
  get scanner(): ScannerKind {
    return scannerFor(this.span);
  }

  /** ``fastCrack`` 的等值目标（只有斗部群星的枚举分支用）。 */
  get equalityValues(): readonly number[] {
    return dbqxEqualityValues(this.sequence);
  }

  /** ``Outcome.consume`` = ``advance``（见模块 docstring）。 */
  get consume(): number {
    return this.advance;
  }

  // ---------------------------------------------------------------- raw
  /** ``resolveSeed`` 的 ``arg1``（``seq[0]``）。 */
  get randomInt(): number {
    return this.sequence.length > 0 ? (this.sequence[0] as number) : 0;
  }

  /** ``resolveSeed`` 的 ``arg2``（``seq[1]``，只有 1 个数时是 0）。 */
  get target(): number {
    return this.sequence.length > 1 ? (this.sequence[1] as number) : 0;
  }
}

// =========================================================================== 解析
function clampSeed(value: number): number {
  const v = Math.trunc(value);
  return v < 0 ? 0 : v > KMAX ? KMAX : v;
}

function splitSequence(text: string): string[] {
  return String(text)
    .trim()
    .split(SEQUENCE_SPLIT_RE)
    .filter((part) => part !== "");
}

function parseRaw(text: string, notes: Note[]): number[] {
  const values: number[] = [];
  for (const part of splitSequence(text)) {
    try {
      values.push(saveGameValue(part));
    } catch (exc) {
      if (!(exc instanceof SpecError)) throw exc;
      notes.push(new Note({ level: "error", message: exc.message, field: SEQUENCE_FIELD }));
    }
  }
  return values;
}

/** ``src`` 预设 1~3 的解析：``int()`` + ``n-r <= i <= n+r`` 上下限检查。 */
function parseInts(text: string, preset: StarsPresetConst, notes: Note[]): number[] {
  const values: number[] = [];
  const low = preset.minimum - preset.span;
  const high = preset.minimum + preset.span;
  for (const part of splitSequence(text)) {
    const value = pyInt(part);
    if (value === null) {
      notes.push(new Note({ level: "error", message: `「${part}」不是整数`, field: SEQUENCE_FIELD }));
      continue;
    }
    if (value < low || value > high) {
      notes.push(
        new Note({
          level: "error",
          message: `「${value}」超出 ${preset.minimum}±${preset.span}（${low}~${high}）`,
          field: SEQUENCE_FIELD,
        }),
      );
      continue;
    }
    values.push(value);
  }
  return values;
}

function parseBoss(text: string, notes: Note[]): number[] {
  const values: number[] = [];
  for (const part of splitSequence(text)) {
    try {
      values.push(bossIndex(part));
    } catch (exc) {
      if (!(exc instanceof SpecError)) throw exc;
      notes.push(new Note({ level: "error", message: exc.message, field: SEQUENCE_FIELD }));
    }
  }
  return values;
}

/** 显示值 → uint32 区间。``src`` 只做截断/减半两种还原，不做别的。 */
function intervalPairs(
  sequence: readonly number[],
  preset: StarsPresetConst,
  truncating: boolean,
): readonly Pair[] {
  if (sequence.length === 0) return [];
  const convert = truncating ? uintBeforeTruncation : uintBeforeRound;
  const out = convert([...sequence], preset.minimum, preset.span);
  if (!Array.isArray(out)) {
    throw new ScenarioError("内部错误：uintBeforeTruncation/uintBeforeRound 没有返回区间表");
  }
  return out.map(([lo, hi]) => [lo, hi] as const);
}

// =========================================================================== 场景
/** 种子搜索器 —— 斗部群星 / 还童丹 / 宠物铠甲 / 保存游戏（原名「七星」）。 */
export class StarsScenario extends Scenario {
  override readonly key = KEY;
  /**
   * 原来叫「七星」，但下拉框里最常被拿来用的其实是「反推种子」这件事，
   * 叫「种子搜索器」更直白。
   */
  override readonly label = "种子搜索器";
  override readonly version = "1.0";
  override readonly hint =
    "观测一串显示值，反推种子（斗部群星那一档是掩码匹配）。" +
    "只想拿「保存游戏」的随机数反推种子的话，把预设选成「保存游戏」，" +
    "再把游戏里 F12 看到的显示值抄进「观测值」（填一或两个都行）。";
  override readonly specKind = "mask";
  override readonly nearLimit = DISTANCE_LIMIT;
  override readonly supportsNear = true;

  /**
   * 子类把某一个预设**定死**：表单里不再出现「预设」下拉框，:meth:`planOf` 也一律
   * 用这个值。空字符串 = 正常模式。
   *
   * ⚠️ 现在没有子类用它（``save-game`` 那一项已被删掉），机制留着备用。
   */
  readonly presetLocked: string = "";

  // ------------------------------------------------------------------ 计划
  /**
   * 把表单输入翻译成 :class:`StarsPlan`。**只返回 Note，不抛异常。**
   *
   * :param startSeed: 给了就用它当「起始值」（``run`` 的参数优先于表单字段，
   *     两者不一致时以参数为准）。
   */
  planOf(inputs: Readonly<Record<string, unknown>>, startSeed: number | null = null): StarsPlan {
    const notes: Note[] = [];
    const userSeed = clampSeed(
      startSeed === null ? getInt(inputs, START_FIELD, 0) : startSeed,
    );

    const name =
      this.presetLocked ||
      (getStr(inputs, PRESET_FIELD, DEFAULT_PRESET).trim() || DEFAULT_PRESET);
    let preset: StarsPresetConst;
    let presetName = name;
    try {
      preset = presetOf(name);
    } catch (exc) {
      if (!(exc instanceof SpecError)) throw exc;
      notes.push(new Note({ level: "error", message: exc.message, field: PRESET_FIELD }));
      preset = presetOf(DEFAULT_PRESET);
      presetName = DEFAULT_PRESET;
    }

    const text = getStr(inputs, SEQUENCE_FIELD, "");
    let sequence: readonly number[];
    let pairs: readonly Pair[];
    if (preset.mode === RAW_MODE) {
      const parsed = parseRaw(text, notes);
      sequence = parsed.length > 0 ? rawSequence(parsed, userSeed) : [];
      if (parsed.length === 0) {
        notes.push(
          new Note({
            level: "error",
            message: "「保存游戏」至少要填一个显示值（观测值那一格；填两个更保险）",
            field: SEQUENCE_FIELD,
          }),
        );
      }
      const target = sequence.length > 1 ? (sequence[1] as number) : 0;
      pairs = [[target, target]];
    } else {
      const parsed =
        preset.mode === DBQX_MODE ? parseBoss(text, notes) : parseInts(text, preset, notes);
      sequence = parsed;
      if (parsed.length === 0) {
        notes.push(new Note({ level: "error", message: "至少要有一个观测值", field: SEQUENCE_FIELD }));
      }
      if (userSeed) {
        let list = intervalPairs(sequence, preset, preset.mode !== ROUND_MODE);
        if (list.length > MAX_CONSTRAINTS) {
          notes.push(
            new Note({
              level: "info",
              message: `有起始值时只取前 ${MAX_CONSTRAINTS} 个观测值（src 的 31 位上限）`,
              field: SEQUENCE_FIELD,
            }),
          );
          list = list.slice(0, MAX_CONSTRAINTS);
        }
        pairs = list;
      } else {
        const list = intervalPairs(sequence, preset, preset.mode === TRUNCATION_MODE);
        pairs = list;
        // C 的契约是 num <= 32，超了直接返回空集；这里在契约层拦住。
        if (preset.mode !== DBQX_MODE && list.length > MAX_INPUT) {
          notes.push(
            new Note({
              level: "error",
              message: `观测值最多 ${MAX_INPUT} 个（C 的 max_input）`,
              field: SEQUENCE_FIELD,
            }),
          );
        }
      }
    }

    const advance = advanceAfterMatch(preset.mode, sequence.length, preset.random_pos, preset.step);
    return new StarsPlan({
      presetName,
      preset,
      userSeed,
      sequence,
      pairs,
      advance,
      notes,
    });
  }

  override validate(inputs: Readonly<Record<string, unknown>>): readonly Note[] {
    return this.planOf(inputs).notes;
  }

  // ------------------------------------------------------------------ 机制
  override randomConsumption(inputs: Readonly<Record<string, unknown>>): number {
    return this.planOf(inputs).consume;
  }

  /**
   * 搜索起点就是起始值本身 —— ``seedFindbyRange`` 自己会先退 ``step`` 步。
   *
   * （局部搜索的「热点附近找不到种子」由 C 里的 ``getPreSeed`` 循环负责，与
   * ``equipment`` 的 ``consume + 1`` 不是一回事，所以这里要覆盖。）
   */
  override advanceCount(_inputs: Readonly<Record<string, unknown>>): number {
    return 0;
  }

  override searchSeed(
    startSeed: number,
    _inputs: Readonly<Record<string, unknown>>,
    _rt: Runtime,
  ): number {
    return Math.trunc(startSeed);
  }

  override buildSpec(inputs: Readonly<Record<string, unknown>>, startSeed: number): SeedSpec {
    const plan = this.planOf(inputs, startSeed);
    if (plan.raw) {
      // ``resolveCandidates`` 内部那个单点区间；``step`` 固定 1
      // （``src`` 调 ``seedFindbyRange`` 时没传，用默认值）。
      return IntervalSpec.fromPairs(plan.pairs, 1);
    }
    if (plan.local) {
      // 有起始值：一律区间 + ``seedFindbyRange``（斗部群星也是，见模块 docstring）。
      return IntervalSpec.fromPairs(plan.pairs, plan.step, "crack");
    }
    if (plan.mode === DBQX_MODE) {
      return MaskSpec.fromValues(plan.equalityValues, FASTCRACK_IMASK, plan.step);
    }
    return IntervalSpec.fromPairs(plan.pairs, plan.step, plan.scanner);
  }

  // ------------------------------------------------------------------ 解释
  /** 从搜索结果里取种子；枚举分支**要求唯一解**（``src`` 的 ``arr.len > 1``）。 */
  private seedOf(result: SearchResult, plan: StarsPlan): [number, readonly Note[]] {
    if (plan.local) {
      const nearest = result.nearest !== null ? Math.trunc(result.nearest) : 0;
      if (nearest) return [nearest, []];
      // ``src`` 在 ``seedFindbyRange`` 返回 0 时也会 log「未找到种子」。
      return [0, [new Note({ level: "warning", message: "没有搜到任何种子", field: START_FIELD })]];
    }
    const seeds = result.seeds.map((s) => Math.trunc(s));
    if (seeds.length === 1) return [seeds[0] as number, []];
    if (seeds.length > 1) {
      return [
        0,
        [
          new Note({ level: "warning", message: TOO_FEW, field: SEQUENCE_FIELD }),
          new Note({
            level: "warning",
            message: `共 ${seeds.length} 个候选种子已随结果返回`,
            field: SEQUENCE_FIELD,
          }),
        ],
      ];
    }
    return [0, [new Note({ level: "warning", message: "没有搜到任何种子", field: START_FIELD })]];
  }

  /** 命中种子 → 结果整数 → 距离 → :class:`Outcome`（两条分支共用）。 */
  private finish(
    seed: number,
    plan: StarsPlan,
    rt: Runtime,
    init: { notes?: readonly Note[]; result?: SearchResult | null; backend?: string } = {},
  ): Outcome {
    const notes = init.notes ?? [];
    const result = init.result ?? null;
    const extra: Record<string, unknown> = {
      preset: plan.presetName,
      mode: plan.mode,
      sequence: plan.sequence.map((v) => Math.trunc(v)),
      user_seed: Math.trunc(plan.userSeed),
      step: Math.trunc(plan.step),
      random_pos: Math.trunc(plan.randomPos),
      advance: Math.trunc(plan.advance),
    };
    const seeds = result !== null ? result.seeds.map((s) => Math.trunc(s)) : [];
    const truncated = result !== null ? result.truncated : false;
    const unordered = result !== null ? result.unordered : false;
    const backend = init.backend || (result !== null ? result.backend : "") || rt.backend.name;

    if (!seed) {
      return new Outcome({
        seed: 0,
        distance: 0,
        needConsume: -1,
        consume: plan.consume,
        preview: notes.some((n) => n.message === TOO_FEW) ? TOO_FEW_PREVIEW : NO_HIT_PREVIEW,
        seeds,
        truncated,
        unordered,
        backend,
        notes,
        extra,
      });
    }

    const engine = rt.engine;
    const resultInt = Math.trunc(engine.fastNextK(Math.trunc(seed), plan.advance));
    // 没有起始值时不测距（``src`` 显示 ``-``）；也避开从 0 出发的 1e7 次空转。
    const distance = plan.userSeed
      ? Math.trunc(engine.seedDistance(plan.userSeed, resultInt, DISTANCE_LIMIT))
      : 0;
    extra["result_int"] = resultInt;
    return new Outcome({
      seed: Math.trunc(seed),
      distance,
      needConsume: distance - 1 - plan.consume,
      consume: plan.consume,
      seedAfter: resultInt,
      preview: `距离: ${distance || "-"}\n结果: ${resultInt}`,
      seeds,
      truncated,
      unordered,
      backend,
      notes,
      extra,
    });
  }

  override interpret(
    result: SearchResult,
    inputs: Readonly<Record<string, unknown>>,
    startSeed: number,
    rt: Runtime | null = null,
  ): Outcome {
    const plan = this.planOf(inputs, startSeed);
    const [seed, extraNotes] = this.seedOf(result, plan);
    const notes = [...plan.notes, ...extraNotes];
    if (rt === null) {
      return new Outcome({
        seed,
        distance: 0,
        needConsume: -1,
        consume: plan.consume,
        preview: "",
        seeds: result.seeds,
        backend: result.backend,
        notes,
        extra: { preset: plan.presetName, mode: plan.mode },
      });
    }
    return this.finish(seed, plan, rt, { notes, result });
  }

  override preview(seed: number, inputs: Readonly<Record<string, unknown>>, rt: Runtime): string {
    const plan = this.planOf(inputs);
    if (!seed) return NO_HIT_PREVIEW;
    const resultInt = Math.trunc(rt.engine.fastNextK(Math.trunc(seed), plan.advance));
    const distance = plan.userSeed
      ? Math.trunc(rt.engine.seedDistance(plan.userSeed, resultInt, DISTANCE_LIMIT))
      : 0;
    return `距离: ${distance || "-"}\n结果: ${resultInt}`;
  }

  // ------------------------------------------------------------------ 执行
  /**
   * 把「并行枚举」勾选框翻译成 :class:`SearchContext` 覆盖项。
   *
   * 这个开关只影响**枚举**（没有起始值那一路）：它给的是 ``preferParallel``，
   * 后端在步数过 ``PARALLEL_MIN_STEPS`` 时才会真的走 ``*_ord_mp``，结果与串行
   * **逐位相同**。
   *
   * 局部搜索不需要开关 —— ``limit >= PARALLEL_MIN_STEPS`` 时后端自己会
   * 上 ``*2_ord_mp``。stars 的 ``nearLimit`` 是 ``DISTANCE_LIMIT``（1e7 减去 1），
   * 过不了门槛，所以这里永远走串行。
   */
  override searchOptions(
    inputs: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> {
    return getBool(inputs, PARALLEL_FIELD, false) ? { preferParallel: true } : {};
  }

  /** ``near`` 默认由「有没有起始值」决定（``src`` 就是这么分的）。 */
  override async run(
    inputs: Readonly<Record<string, unknown>>,
    startSeed: number,
    options: RunOptions = {},
  ): Promise<Outcome> {
    const plan = this.planOf(inputs, startSeed);
    if (plan.raw) {
      return this.runRaw(inputs, plan, options.backend ?? null);
    }
    const askedNear = options.near ?? null;
    let local: boolean;
    if (askedNear === null) {
      local = plan.local;
    } else {
      local = Boolean(askedNear);
      if (local !== plan.local) {
        // 两条分支的 spec 互不通用（掩码 vs 区间、单点 vs 邻域），强行换过去只会
        // 得到「搜不到」或「搜到一坨」，不如直接说不支持。
        throw new ScenarioError(
          `${this.key} 预设「${plan.presetName}」` +
            (plan.local
              ? "有起始值时只做局部搜索（near=True）"
              : "没有起始值时只能全空间枚举（near=False）"),
        );
      }
    }
    const ctx = options.ctx ?? this.searchContext(this.searchOptions(inputs));
    return super.run(inputs, startSeed, { ...options, near: local, ctx });
  }

  /**
   * 「保存游戏」分支：不搜索，走 ``recoverSeeds`` 反查。
   *
   * ``src`` 这一支压根不调 ``enum_31bit`` —— 有起始值时用 ``seedDistance`` 筛候选、
   * 没有时用单点 ``seedFindbyRange``，两者都不是「搜索」。
   *
   * ⚠️ Python 侧 ``Runtime.resolve`` 会去探测 ctypes → wasm → pure_py；Web 侧只有一份
   * wasm 产物，「没传后端」是调用方的 bug（由 :func:`Runtime.resolve` 抛）。
   */
  runRaw(
    inputs: Readonly<Record<string, unknown>>,
    plan: StarsPlan,
    backend: WasmRuntime | null = null,
  ): Outcome {
    const rt = Runtime.resolve(backend, null);
    const prepared = this.prepare(inputs, plan.userSeed);
    const resolved = resolveCandidates(plan.userSeed, plan.randomInt, plan.target, {
      rt,
      notes: prepared.notes,
    });
    const notes = [...resolved.notes];
    if (resolved.candidates.length > 1) {
      notes.push(new Note({ level: "warning", message: TOO_FEW, field: SEQUENCE_FIELD }));
    }
    return this.finish(resolved.seed, plan, rt, { notes, backend: rt.backend.name });
  }

  // ------------------------------------------------------------------ 表单
  override schema(): InputSchema {
    const fields: InputField[] = [
      new InputField({
        key: START_FIELD,
        label: "起始值A",
        kind: "int",
        // 默认**留空**而不是 0：0 落在种子迭代循环外（``fastNext(0) === 0``），
        // 在这里只是个「没有起始值」的哨兵值 —— 摆一个 0 在框里会让人以为
        // 「从 0 开始搜」是有效输入。要「没有起始值」就把框留空。
        default: null,
        min: 1,
        max: KMAX,
        help: "留空 = 没有起始值：斗部群星/还童丹走全空间枚举（要唯一解）",
        group: "输入",
        width: 16,
      }),
      // 紧跟在起始值后面：按需求「并行开关放在枚举全部旁边」。
      // 枚举全部在这里就是「起始值留空」，所以两者挨着。
      new InputField({
        key: PARALLEL_FIELD,
        label: "并行枚举",
        kind: "bool",
        default: true,
        help: "并行枚举：结果与串行逐位相同，只是更快",
        group: "输入",
      }),
    ];
    if (!this.presetLocked) {
      fields.push(
        new InputField({
          key: PRESET_FIELD,
          label: "预设",
          kind: "choice",
          default: DEFAULT_PRESET,
          choices: PRESET_NAMES,
          help: "决定解析方式、上下限与步长",
          group: "输入",
          width: 16,
        }),
      );
    }
    fields.push(
      new InputField({
        key: SEQUENCE_FIELD,
        label: "观测值",
        kind: "text",
        default: "",
        // 这个是**唯一**要留宽的输入框：斗部群星一次要贴 8~30 个 boss 简称。
        help:
          "斗部群星：" +
          BOSS_BY_INDEX.join("/") +
          " 或 0~3（按顺序手点，一次 3 随机、第 3 次才算）；" +
          "还童丹/宠物铠甲：整数；保存游戏：显示值（可带小数）",
        group: "输入",
        width: 40,
      }),
    );
    return new InputSchema({ title: this.label, hint: this.hint, fields });
  }
}

register(StarsScenario);
