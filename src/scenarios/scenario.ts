/**
 * ``src_forge/gameInfo/scenario.py`` 的 1:1 翻译 —— **游戏机制声明层**。
 *
 * 为什么要有这一层
 * ----------------
 * ``src/`` 里的四个计算器把「游戏机制」和「tkinter 界面」焊死在一起：
 * ``MakingCalculator.calc2`` 里既有 ``before_attr_randoms = 13`` 这种机制常数，
 * 也有 ``messagebox.showwarning``。搬到 Web 端时只能整段重写。
 *
 * ``Scenario`` 把机制抽成 5 个纯函数 + 1 份表单描述：
 *
 * ======================  ==========================================================
 * ``randomConsumption``   这个场景在「属性计算」之前要过掉几次随机数（旧的 ``n``/``ab_sum``）
 * ``buildSpec``           把用户输入翻译成 :class:`SeedSpec`
 * ``searchSeed``          把「起始种子」推进到「搜索起点」（C 的 ``_start``）
 * ``interpret``           把 :class:`SearchResult` 翻译成 :class:`Outcome`
 * ``preview``             用找到的种子回放一遍，生成可读的属性预览
 * ``validate``            输入合法性（返回 :class:`Note`，不弹窗、不打印）
 * ``schema``              表单契约（``InputSchema``，可导出 JSON 给 TS 与 tkinter 共用）
 * ======================  ==========================================================
 *
 * 契约约定
 * --------
 * * ``Scenario`` 实例**无状态**：可以全局共享、可以跨 Worker 传。运行期依赖
 *   （engine / searcher）通过 :class:`Runtime` 在 :meth:`Scenario.run` 里注入，
 *   绝不存在实例字段上。
 * * ``inputs`` 一律是 ``Record<string, unknown>``（JSON 可序列化），键名与
 *   ``InputField.key`` 对齐。**不要传 DOM / 控件对象**。
 * * 只用核心层的 ``SeedSpec`` 表达需求 —— 场景**不允许**直接摸 wasm 内存。
 *   这样同一份场景代码才可能和 Python 侧逐字对齐。
 *
 * 与并行的关系
 * ------------
 * 两条路都能并行，但**判据不一样**（各自与 Python 的同名函数逐字对齐）：
 *
 * * 枚举（``searchAll``）：既要 ``ctx.preferParallel``（表单上的「并行枚举」勾选框，
 *   由场景自己 override :meth:`Scenario.searchOptions` 从输入里取 —— **目前还没有
 *   任何场景返回它**，勾选框属于 M4 的 UI 工作，通道本身是通的），又要扫描宽度
 *   ``>= PARALLEL_MIN_STEPS``（= ``MAX_SEED_SEARCH``）—— 判据 =
 *   :func:`shouldParallelEnum`，对应 Python ``search_all`` 里那条 ``if``；
 * * 局部搜索（``searchNearest``）：``limit >= PARALLEL_MIN_STEPS`` 且**手上有池子**
 *   就直接派给 worker 池，**没有任何开关** —— 判据 = :func:`shouldParallelNear`，
 *   对应 Python ``search_nearest`` 里那条；
 * * 两条都要求 ``rt.pool !== null``；``pool === null`` 时全部同步跑在当前线程上。
 * * 想把候选「取最近」，用 :meth:`Scenario.nearestOf`。
 *
 * ⚠️ **Web 侧没有 C 的 OpenMP 并行**。wasm 构建不能加 ``-fopenmp``，所以
 * ``*_mp`` / ``*_ord_mp`` 都不导出：wasm 后端的 ``searchParallel`` 只是逐分片
 * 串行（把分片交给 worker 池才是 Web 的并行来源，见 ``worker/pool.ts``）。
 * ``preferParallel`` 因此不改变任何结果 —— 与 Python 侧「有序并行」的契约一致：
 * 并行只是加速。
 *
 * 池子是**注入**进来的（:attr:`Runtime.pool`），不是场景自己造的：
 *
 * * ``pool === null`` ⇒ 和以前完全一样，全部同步跑在当前线程上；
 * * ``pool !== null`` ⇒ 一步局部搜索的步数越过门槛后改走 ``pool.searchNearest``，
 *   它把步数按 :func:`nearChunks` 切开、每块在主线程算好起点种子后派给 worker，
 *   再按 :func:`nearResult` 收尾 —— 与一次扫完**逐位一致**（有测试锁着）；
 *   枚举则改走 ``pool.searchAll``（按 ``ctx.shards()`` 切片），同样逐位一致。
 *
 * 为什么是「注入」而不是「场景内部按 ``nearLimit`` 自己建池子」：建池子要起
 * Worker + 每个 Worker 各加载一份 wasm，是几十到上百毫秒的一次性成本，必须由
 * 上层（UI）持有生命周期才能 ``warmup()`` 一次、用很多次。Python 侧同一件事是
 * ``Capabilities.parallel``（wasm 后端为 ``False``，ctypes 为 ``True``）——
 * 「有没有并行能力」都是**后端/环境的属性**，不是场景的属性。
 *
 * Python 侧对应的是 C 的 ``*_ord_mp``（有序并行，结果与串行逐位相同）。
 *
 * 与 Python 的差异（有意为之，不是漏译）
 * --------------------------------------
 * * Python 的 ``@classmethod`` ``input_schema`` / ``describe`` 在这里是**实例方法**
 *   （``schema()`` / ``describe()``）—— TS 的静态侧拿不到子类的 ClassVar 默认值，
 *   而注册表本来就持有实例。
 * * Python 的 ``backend_name`` **没有翻译**：Web 侧只有 wasm 一个后端，
 *   ``Runtime.resolve`` 不接受后端名字符串。留个永远为 ``null`` 的字段只会误导。
 * * Python 的 ``Runtime.simulator`` **没有翻译**：属性回放（``simulate_equip``）
 *   在 TS 侧是纯计算模块，不是后端能力。
 */

import { SpecError } from "../core/errors";
import {
  SearchContext,
  SearchResult,
  shouldParallelEnum,
  shouldParallelNear,
  type SearchContextInit,
  type SeedSearcher,
} from "../core/search";
import type { SeedSpec } from "../core/spec";
import type { WasmEngine } from "../wasm/engine";
import type { WasmRuntime } from "../wasm/runtime";
import type { SearchPool } from "../worker/pool";

/**
 * ``searchNearest`` 的默认步数上限 —— 照抄 Python ``scenario.DEFAULT_NEAR_LIMIT``
 * （``9_999_999``，与 ``src/PetCalculator`` 一致）。
 *
 * ⚠️ **不要**改用 ``core/search.ts`` 的 ``DEFAULT_NEAR_LIMIT``（那是 ``100_000``，
 * 是「核心层给的保守值」），场景层的默认值是它的一百倍 —— 两者不是一回事。
 */
export const SCENARIO_NEAR_LIMIT = 9_999_999;

export type NoteLevel = "info" | "warning" | "error";

/** 场景层错误（输入不合法、机制未实现、结果无法解释）。 */
export class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioError";
  }
}

// =========================================================================== 输入
export interface NoteInit {
  level: NoteLevel;
  message: string;
  field?: string;
}

export interface NoteDict {
  level: NoteLevel;
  message: string;
  field: string;
}

/** ``validate`` 的返回值 —— 不弹窗、不打印，让调用方决定怎么展示。 */
export class Note {
  readonly level: NoteLevel;
  readonly message: string;
  readonly field: string;

  constructor(init: NoteInit) {
    this.level = init.level;
    this.message = init.message;
    this.field = init.field ?? "";
  }

  get isError(): boolean {
    return this.level === "error";
  }

  toDict(): NoteDict {
    return { level: this.level, message: this.message, field: this.field };
  }

  static fromDict(data: NoteDict): Note {
    return new Note({ level: data.level, message: data.message, field: data.field });
  }
}

export type FieldKind = "int" | "float" | "text" | "choice" | "bool";

export interface InputFieldInit {
  key: string;
  label?: string;
  kind?: FieldKind;
  default?: unknown;
  min?: number | null;
  max?: number | null;
  choices?: readonly string[];
  help?: string;
  group?: string;
  width?: number;
  inline?: boolean;
  toolbar?: boolean;
  required?: boolean;
}

/**
 * 表单里的一个输入项。
 *
 * tkinter 的 ``app/ui`` 与 Web 的 ``src/ui`` 都按这份描述**自动生成**控件，
 * 所以它是两个前端之间唯一需要保持同步的东西。
 */
export class InputField {
  readonly key: string;
  readonly label: string;
  readonly kind: FieldKind;
  readonly default: unknown;
  readonly min: number | null;
  readonly max: number | null;
  readonly choices: readonly string[];
  readonly help: string;
  readonly group: string;
  readonly width: number;
  /**
   * 这个字段旁边要留一栏**动态展示值**（值由 :meth:`Scenario.fieldHints` 按当前
   * 输入算出来）。装备场景拿它把「这件装备该属性的上下限」摆在输入框旁边 ——
   * 静态的 ``help`` 只说「留空代表什么」，具体数字每次都不一样，塞不进提示条。
   * 同一个分组里只要有一个字段开了它，整组就按「字段名 | 展示值 | 控件」三栏画，
   * 展示值在控件**左边**（照抄旧版 ``src/MakingCalculator.py`` 的属性表列序）。
   */
  readonly inline: boolean;
  /**
   * 这个字段的控件属于**窗口工具栏**而不是表单（曾经的「枚举全部」「自动升档」）。
   * 它仍然算 schema 的一部分：``defaults()`` 照常给出默认值，窗口只是换个
   * 位置摆控件、再把值盖回去。用 :attr:`inToolbar` 判断「捡不捡得出来」。
   * ⚠️ **目前没有任何字段开着它** —— 勾选框摆回表单、和它管的那几个输入放一起
   * 才看得懂；机制留着是出于兼容（``toDict()`` 里仍然是契约的一部分）。
   */
  readonly toolbar: boolean;
  /**
   * 这块**必须填**：留空是错误，而不是悄悄回落到 ``default``。
   * 用的地方是「起始种子」这类**没有合理默认值**的输入 —— 0 不是合法种子
   * （``fastNext(0) === 0``，整条序列全是 0），与其让用户从一个假的 0 出发
   * 搜出一堆无意义的结果，不如一开始就把话说清楚。
   */
  readonly required: boolean;

  constructor(init: InputFieldInit) {
    this.key = init.key;
    this.label = init.label ?? init.key;
    this.kind = init.kind ?? "text";
    this.default = init.default ?? null;
    this.min = init.min ?? null;
    this.max = init.max ?? null;
    this.choices = Object.freeze([...(init.choices ?? [])]);
    this.help = init.help ?? "";
    this.group = init.group ?? "";
    this.width = init.width ?? 12;
    this.inline = init.inline ?? false;
    this.toolbar = init.toolbar ?? false;
    this.required = init.required ?? false;
  }

  /** 是否该做成工具栏上的勾选框 —— 只有 ``bool`` 才谈得上「工具栏开关」。 */
  get inToolbar(): boolean {
    return this.toolbar && this.kind === "bool";
  }

  toDict(): Record<string, unknown> {
    return {
      key: this.key,
      label: this.label,
      kind: this.kind,
      default: this.default,
      min: this.min,
      max: this.max,
      choices: [...this.choices],
      help: this.help,
      group: this.group,
      width: Math.trunc(this.width),
      inline: this.inline,
      toolbar: this.toolbar,
      required: this.required,
    };
  }

  static fromDict(data: Record<string, unknown>): InputField {
    const key = String(data["key"]);
    return new InputField({
      key,
      label: String(data["label"] ?? key),
      kind: (data["kind"] ?? "text") as FieldKind,
      default: data["default"] ?? null,
      min: (data["min"] ?? null) as number | null,
      max: (data["max"] ?? null) as number | null,
      choices: (data["choices"] ?? []) as readonly string[],
      help: String(data["help"] ?? ""),
      group: String(data["group"] ?? ""),
      width: num(data["width"]) ?? 12,
      inline: Boolean(data["inline"] ?? false),
      toolbar: Boolean(data["toolbar"] ?? false),
      required: Boolean(data["required"] ?? false),
    });
  }
}

export interface InputSchemaInit {
  fields?: readonly InputField[];
  title?: string;
  hint?: string;
  headers?: Readonly<Record<string, readonly string[]>>;
}

/** 一个场景的完整表单描述。``fields`` 的顺序就是 UI 里的显示顺序。 */
export class InputSchema {
  readonly fields: readonly InputField[];
  readonly title: string;
  readonly hint: string;
  /**
   * 分组表头：``{组名: [第一栏, 第二栏, ...]}``。**给了表头（且组里有 ``inline``
   * 字段）的组会被画成表格** —— 第一栏是 ``InputField.label``，中间那栏是
   * ``inline = true`` 字段的动态展示值，**最后一栏才是控件**。长度对不上
   * （少于 3 栏）就不画表头，退化成普通两栏。
   */
  readonly headers: Readonly<Record<string, readonly string[]>>;

  constructor(init: InputSchemaInit = {}) {
    this.fields = Object.freeze([...(init.fields ?? [])]);
    this.title = init.title ?? "";
    this.hint = init.hint ?? "";
    this.headers = Object.freeze({ ...(init.headers ?? {}) });
  }

  get(key: string): InputField | null {
    for (const f of this.fields) {
      if (f.key === key) return f;
    }
    return null;
  }

  get keys(): readonly string[] {
    return this.fields.map((f) => f.key);
  }

  defaults(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of this.fields) out[f.key] = f.default;
    return out;
  }

  /** 按 ``group`` 归组（保持首次出现顺序），供 UI 分栏。 */
  groups(): Record<string, InputField[]> {
    const out: Record<string, InputField[]> = {};
    for (const f of this.fields) {
      (out[f.group] ??= []).push(f);
    }
    return out;
  }

  /**
   * 只留摆在表单里的字段（``inToolbar`` 的挑出去给窗口工具栏）。
   *
   * 界面拿这份去生成控件，``validate`` / ``defaults`` 之流照旧用全量 schema ——
   * 「枚举全部」这类开关不该因为换了个位置就变成「场景不认识的一个键」。
   */
  onForm(): InputSchema {
    const kept = this.fields.filter((f) => !f.inToolbar);
    if (kept.length === this.fields.length) return this;
    return new InputSchema({ fields: kept, title: this.title, hint: this.hint, headers: this.headers });
  }

  toDict(): Record<string, unknown> {
    const headers: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(this.headers)) headers[k] = [...v];
    return {
      title: this.title,
      hint: this.hint,
      fields: this.fields.map((f) => f.toDict()),
      headers,
    };
  }

  static fromDict(data: Record<string, unknown>): InputSchema {
    const rawHeaders = (data["headers"] ?? {}) as Record<string, readonly string[]>;
    const headers: Record<string, readonly string[]> = {};
    for (const [k, v] of Object.entries(rawHeaders)) headers[String(k)] = [...v];
    return new InputSchema({
      fields: ((data["fields"] ?? []) as Record<string, unknown>[]).map((f) => InputField.fromDict(f)),
      title: String(data["title"] ?? ""),
      hint: String(data["hint"] ?? ""),
      headers,
    });
  }
}

/** ``Number`` 的「是数字才算」版本（``null`` 表示不是）。 */
function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Python ``int(str)`` 的等价物：只认可选符号 + 十进制数字（``null`` = 转不动）。 */
function pythonInt(text: string): number | null {
  const body = text.trim();
  if (!/^[+-]?\d+$/.test(body)) return null;
  const value = Number(body);
  return Number.isFinite(value) ? value : null;
}

/** 宽容地取整数：``null`` / ``""`` / 非法值 → ``default``。 */
export function getInt(inputs: Readonly<Record<string, unknown>>, key: string, fallback = 0): number {
  const raw = inputs[key] ?? fallback;
  if (raw === null || raw === undefined || raw === "") return Math.trunc(fallback);
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (typeof raw === "number") return Number.isFinite(raw) ? Math.trunc(raw) : Math.trunc(fallback);
  return pythonInt(String(raw)) ?? Math.trunc(fallback);
}

/** 宽容地取浮点：``null`` / ``""`` / 非法值 → ``default``。 */
export function getFloat(inputs: Readonly<Record<string, unknown>>, key: string, fallback = 0): number {
  const raw = inputs[key] ?? fallback;
  if (raw === null || raw === undefined || raw === "") return fallback;
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (typeof raw === "number") return raw;
  const text = String(raw).trim();
  // Python 的 float() 不认 0x/0b/0o 前缀，而 Number() 认 —— 挡掉，免得「十六进制当十进制」。
  if (/^[+-]?0[xXbBoO]/.test(text)) return fallback;
  const value = Number(text);
  return Number.isNaN(value) ? fallback : value;
}

export function getStr(inputs: Readonly<Record<string, unknown>>, key: string, fallback = ""): string {
  const raw = inputs[key] ?? fallback;
  return raw === null || raw === undefined ? fallback : String(raw);
}

export function getBool(inputs: Readonly<Record<string, unknown>>, key: string, fallback = false): boolean {
  const raw = inputs[key] ?? fallback;
  if (typeof raw === "boolean") return raw;
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === "number") return raw !== 0 && !Number.isNaN(raw);
  const text = String(raw).trim().toLowerCase();
  if (["", "0", "false", "no", "n", "off"].includes(text)) return false;
  if (["1", "true", "yes", "y", "on"].includes(text)) return true;
  return fallback;
}

// =========================================================================== 结果
export interface OutcomeInit {
  seed?: number;
  distance?: number;
  needConsume?: number;
  consume?: number;
  seedAfter?: number;
  preview?: string;
  permutation?: string;
  seeds?: readonly number[];
  truncated?: boolean;
  unordered?: boolean;
  backend?: string;
  notes?: readonly Note[];
  extra?: Readonly<Record<string, unknown>>;
}

export interface OutcomeDict {
  seed: number;
  distance: number;
  need_consume: number;
  consume: number;
  seed_after: number;
  preview: string;
  permutation: string;
  seeds: number[];
  truncated: boolean;
  unordered: boolean;
  backend: string;
  notes: NoteDict[];
  extra: Record<string, unknown>;
}

/**
 * 场景的统一输出。
 *
 * 字段名与 ``src`` 四个计算器里 ``HIJKLMN`` 七个展示框的对应关系：
 *
 * ======  ==========================  ==========================
 * 旧名    新字段                       含义
 * ======  ==========================  ==========================
 * H       （由 ``distance`` 推出）    「须提前过的随机数个数」
 * I       ``consume``                 属性计算前的随机次数
 * J       ``seed``                    匹配到的首个种子
 * K       ``distance``                种子距离
 * L       ``seedAfter``               末种子（强化/七星用）
 * M       ``preview``                 随机属性预览
 * N       ``permutation``             宝石顺序（装备侧用）
 * ======  ==========================  ==========================
 *
 * ``with()`` 就是 Python 的 ``dataclasses.replace``：所有字段 ``readonly``，
 * 改一个值要造新对象（Python 侧有 ~15 处 ``replace``，TS 侧一律用 ``with``）。
 */
export class Outcome {
  readonly seed: number;
  readonly distance: number;
  readonly needConsume: number;
  readonly consume: number;
  readonly seedAfter: number;
  readonly preview: string;
  readonly permutation: string;
  readonly seeds: readonly number[];
  readonly truncated: boolean;
  readonly unordered: boolean;
  readonly backend: string;
  readonly notes: readonly Note[];
  readonly extra: Readonly<Record<string, unknown>>;

  constructor(init: OutcomeInit = {}) {
    this.seed = Math.trunc(init.seed ?? 0);
    this.distance = Math.trunc(init.distance ?? 0);
    this.needConsume = Math.trunc(init.needConsume ?? 0);
    this.consume = Math.trunc(init.consume ?? 0);
    this.seedAfter = Math.trunc(init.seedAfter ?? 0);
    this.preview = init.preview ?? "";
    this.permutation = init.permutation ?? "";
    this.seeds = Object.freeze([...(init.seeds ?? [])]);
    this.truncated = init.truncated ?? false;
    this.unordered = init.unordered ?? false;
    this.backend = init.backend ?? "";
    this.notes = Object.freeze([...(init.notes ?? [])]);
    this.extra = Object.freeze({ ...(init.extra ?? {}) });
  }

  get found(): boolean {
    return this.seed !== 0 || this.seeds.length > 0;
  }

  get count(): number {
    return this.seeds.length;
  }

  /** ``dataclasses.replace`` 的等价物。 */
  with(patch: OutcomeInit): Outcome {
    return new Outcome({
      seed: patch.seed ?? this.seed,
      distance: patch.distance ?? this.distance,
      needConsume: patch.needConsume ?? this.needConsume,
      consume: patch.consume ?? this.consume,
      seedAfter: patch.seedAfter ?? this.seedAfter,
      preview: patch.preview ?? this.preview,
      permutation: patch.permutation ?? this.permutation,
      seeds: patch.seeds ?? this.seeds,
      truncated: patch.truncated ?? this.truncated,
      unordered: patch.unordered ?? this.unordered,
      backend: patch.backend ?? this.backend,
      notes: patch.notes ?? this.notes,
      extra: patch.extra ?? this.extra,
    });
  }

  toDict(): OutcomeDict {
    return {
      seed: this.seed,
      distance: this.distance,
      need_consume: this.needConsume,
      consume: this.consume,
      seed_after: this.seedAfter,
      preview: this.preview,
      permutation: this.permutation,
      seeds: this.seeds.map((s) => Math.trunc(s)),
      truncated: this.truncated,
      unordered: this.unordered,
      backend: this.backend,
      notes: this.notes.map((n) => n.toDict()),
      extra: { ...this.extra },
    };
  }
}

export interface PreparedInit {
  spec: SeedSpec;
  consume: number;
  notes?: readonly Note[];
  extra?: Readonly<Record<string, unknown>>;
}

/** ``prepare`` 的产物：一次运行的「找什么」+「过几次随机」。 */
export class Prepared {
  readonly spec: SeedSpec;
  readonly consume: number;
  readonly notes: readonly Note[];
  readonly extra: Readonly<Record<string, unknown>>;

  constructor(init: PreparedInit) {
    this.spec = init.spec;
    this.consume = Math.trunc(init.consume);
    this.notes = Object.freeze([...(init.notes ?? [])]);
    this.extra = Object.freeze({ ...(init.extra ?? {}) });
  }

  get errors(): readonly Note[] {
    return this.notes.filter((n) => n.isError);
  }
}

// =========================================================================== 运行期
/**
 * 场景执行时需要的后端资源（由 :meth:`Scenario.run` 负责构造/注入）。
 *
 * 场景**不允许**缓存 ``Runtime``；它是每次调用临时组装的。Web 侧只有 wasm 一个
 * 后端，所以 ``backend`` 就是 ``WasmRuntime``。
 */
export class Runtime {
  readonly backend: WasmRuntime;
  /**
   * worker 池（可选）。``null`` = 没有并行能力，一切同步跑在当前线程。
   *
   * 由调用方持有并复用（见 ``worker/pool.ts`` 的 ``warmup`` / ``terminate``）。
   * 场景用它跑两类活，各自有自己的判据（见 :meth:`Scenario.search`）：
   * 局部搜索（只看步数门槛）和枚举（``ctx.preferParallel`` + 步数门槛）。
   */
  readonly pool: SearchPool | null;

  constructor(backend: WasmRuntime, pool: SearchPool | null = null) {
    this.backend = backend;
    this.pool = pool;
  }

  get engine(): WasmEngine {
    return this.backend.engine;
  }

  get searcher(): SeedSearcher {
    return this.backend.searcher;
  }

  /** ``pool === null`` 时 :meth:`Scenario.search` 会全部同步跑。 */
  get canParallelNear(): boolean {
    return this.pool !== null;
  }

  /**
   * ``backend`` 为 ``null`` / ``undefined`` 时抛 ``BackendUnavailable``。
   *
   * Python 侧 ``Runtime.resolve(None)`` 会去探测 ctypes → wasm → pure_py；
   * Web 侧没有可探测的东西（只有 wasm 一份产物），所以「没传后端」是**调用方的
   * bug**，由上层（UI / Worker）在启动时一次性 ``createRuntime()`` 解决。
   */
  static resolve(backend: WasmRuntime | null | undefined, pool: SearchPool | null = null): Runtime {
    if (!backend) {
      throw new ScenarioError("没有可用的后端：请先 createRuntime() 再把 WasmRuntime 传进来");
    }
    return new Runtime(backend, pool);
  }
}

// =========================================================================== 场景
export interface RunOptions {
  /** ``true`` 时走局部搜索（``searchNearest``），``false`` 时走枚举（``searchAll``）。 */
  near?: boolean;
  /** 局部搜索步数上限；``null`` / 省略 = :attr:`Scenario.nearLimit`。 */
  limit?: number | null;
  backend?: WasmRuntime | null;
  ctx?: SearchContext | null;
  /**
   * worker 池；省略 = 全同步。
   *
   * 传了它**也不代表一定并行** —— 局部搜索要看步数是否越过
   * :data:`PARALLEL_MIN_STEPS`（= Python 的 ``MAX_SEED_SEARCH``），
   * 枚举还要额外看 ``ctx.preferParallel``（「并行枚举」勾选框，默认 ``false``
   * ⇒ 不勾就串行，与 Python ``search_all`` 一致）。两条判据各写一份、只在
   * :meth:`Scenario.search` 里调。
   */
  pool?: SearchPool | null;
}

export interface NearestOptions {
  limit?: number | null;
  backend?: WasmRuntime | null;
  ctx?: SearchContext | null;
  pool?: SearchPool | null;
}

export interface ScenarioDescribe {
  key: string;
  label: string;
  version: string;
  hint: string;
  spec_kind: string;
  supports_near: boolean;
  schema: Record<string, unknown>;
}

/** ``prepare`` / ``run`` 共同用到的搜索选项（``searchOptions`` 的返回值）。 */
export type SearchOptions = SearchContextInit;

/**
 * 游戏机制声明的基类。子类只需要覆写真正不同的部分。
 *
 * 类常量（Python 的 ``ClassVar``）在这里是 ``readonly`` 实例字段：TS 没有
 * 「子类静态字段 + 基类静态方法读 ``this``」以外的好办法，而注册表本来就存实例。
 */
export abstract class Scenario {
  /** 稳定的机器标识（注册表键、Web 路由名）。**不要改**。 */
  abstract readonly key: string;
  /** 展示名。 */
  readonly label: string = "";
  /** 机制版本（改了随机消耗顺序就要 +1，方便对齐 golden）。 */
  readonly version: string = "1.0";
  /** 一句话说明，给 UI 用。 */
  readonly hint: string = "";
  /** 预期的 ``spec.kind``（``interval`` / ``mask`` / ``roll`` / ``wuxing`` / ``pool``）。只用于自检与 UI 展示。 */
  readonly specKind: string = "";
  /** 「枚举」默认的搜索范围（``null`` = 全空间 ``(0, KMAX)``）。 */
  readonly sliceBounds: readonly [number, number] | null = null;
  /** ``searchNearest`` 的默认步数上限。 */
  readonly nearLimit: number = SCENARIO_NEAR_LIMIT;
  /** 是否支持「局部搜索」（从已知种子出发找最近）。 */
  readonly supportsNear: boolean = true;

  // ------------------------------------------------------------------ 机制
  /**
   * 属性计算之前被过掉的随机数个数（旧代码里的 ``n`` / ``before_attr_randoms``）。
   *
   * :meth:`advanceCount` 默认在此基础上 ``+1`` —— 因为 ``src`` 里所有场景都是
   * ``for (i = 0; i <= n; i++) seed = fastNext(seed)``，那次额外的 ``+1`` 是
   * 「匹配器自身的起点偏移」。
   */
  randomConsumption(_inputs: Readonly<Record<string, unknown>>): number {
    return 0;
  }

  /** 把「起始种子」推进到「搜索起点」要调多少次 ``fastNext``。 */
  advanceCount(inputs: Readonly<Record<string, unknown>>): number {
    return this.randomConsumption(inputs) + 1;
  }

  /**
   * 「算完自动准备下一轮」：返回要**回填的表单值**，``null`` = 什么都不动。
   *
   * 默认什么也不做 —— 目前只有 ``strength`` 重写它（「自动升档」：起始值换末
   * 种子、等级 +1、强化石降到最省的一档、数量回到 1，对照旧版
   * ``src/StrengthCalculator.py``）。界面只对**自己声明了**它的场景生效，所以这个
   * 契约放在基类里只是为了把语义写清楚，不是给所有场景一个默认行为
   * —— ``test_other_scenarios_opt_out_by_default`` 那一测就是钉这一条。
   *
   * :param outcome: 刚算完的那一轮结果（``seedAfter`` 是回填的主要来源）。
   * :param inputs: 这一轮用的输入（判断开关、算下一档参数都要用）。
   */
  advance(
    _outcome: Outcome,
    _inputs: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> | null {
    return null;
  }

  /**
   * 把用户输入翻译成 :class:`SeedSpec`。
   *
   * 纯函数：不读文件、不摸 backend、不依赖 :attr:`key` 之外的类属性。
   */
  abstract buildSpec(inputs: Readonly<Record<string, unknown>>, startSeed: number): SeedSpec;

  /** 输入合法性检查。**只返回 Note，不弹窗、不抛异常。** */
  validate(_inputs: Readonly<Record<string, unknown>>): readonly Note[] {
    return [];
  }

  /** 搜索起点（C 里的 ``_start``）。默认 = 起始种子推进 :meth:`advanceCount` 次。 */
  searchSeed(startSeed: number, inputs: Readonly<Record<string, unknown>>, rt: Runtime): number {
    return rt.engine.fastNextK(startSeed, this.advanceCount(inputs));
  }

  /**
   * 把搜索结果翻译成 :class:`Outcome`。
   *
   * 默认实现覆盖「``distance`` 从 ``startSeed`` 起算」的绝大多数场景：
   * ``needConsume = distance - 1 - consume``（``src`` 的 ``H``）。
   */
  interpret(
    result: SearchResult,
    inputs: Readonly<Record<string, unknown>>,
    startSeed: number,
    rt: Runtime | null = null,
  ): Outcome {
    const consume = this.randomConsumption(inputs);
    const notes = [...this.validate(inputs)];
    const seed = result.nearest !== null ? result.nearest : result.head;
    let distance = result.distance ?? 0;
    if (distance === 0 && seed !== 0) {
      distance = rt ? rt.engine.seedDistance(startSeed, seed, this.nearLimit) : 0;
    }
    return new Outcome({
      seed,
      distance,
      needConsume: distance - 1 - consume,
      consume,
      seeds: result.seeds,
      truncated: result.truncated,
      unordered: result.unordered,
      backend: result.backend,
      notes,
    });
  }

  /** 用 ``seed`` 回放一遍，生成可读预览。默认不预览。 */
  preview(_seed: number, _inputs: Readonly<Record<string, unknown>>, _rt: Runtime): string {
    return "";
  }

  // ------------------------------------------------------------------ 表单
  schema(): InputSchema {
    return new InputSchema({ title: this.label || this.key, hint: this.hint });
  }

  /**
   * 字段右边那一栏**动态说明**：``{字段 key: 一行短文字}``。
   *
   * 与 ``InputField.help`` 的分工：``help`` 是静态说明（鼠标划过字段，在底部提示条
   * 里显示一行），这里跟着**当前输入**变 —— 装备场景用它把「这件装备（含已选宝石）
   * 该属性的上下限」直接摆在输入框旁边，用户不用再去猜「留空」到底代表哪个范围。
   *
   * 两条硬要求：
   *
   * 1. **纯函数**、够快 —— 用户每敲一个键都会重算一次；
   * 2. **永不抛异常** —— 输入还不完整的时候返回 ``{}`` 就行，提示算不出来最多是
   *    没提示，不能打断录入。
   */
  fieldHints(_inputs: Readonly<Record<string, unknown>>): Readonly<Record<string, string>> {
    return {};
  }

  /** 给 UI 用的自描述（可 JSON 序列化）。**键名与 Python ``describe()`` 逐字对齐。** */
  describe(): ScenarioDescribe {
    return {
      key: this.key,
      label: this.label,
      version: this.version,
      hint: this.hint,
      spec_kind: this.specKind,
      supports_near: this.supportsNear,
      schema: this.schema().toDict(),
    };
  }

  // ------------------------------------------------------------------ 执行
  /** 校验 + 组 spec。校验有 ``error`` 就抛 :class:`ScenarioError`。 */
  prepare(inputs: Readonly<Record<string, unknown>>, startSeed: number): Prepared {
    const notes = [...this.validate(inputs)];
    const errors = notes.filter((n) => n.isError);
    if (errors.length > 0) {
      throw new ScenarioError(errors.map((n) => n.message).join("；"));
    }
    let spec: SeedSpec;
    try {
      spec = this.buildSpec(inputs, startSeed);
    } catch (exc) {
      if (exc instanceof SpecError) throw exc;
      if (exc instanceof Error) {
        throw new ScenarioError(`无法根据输入构造 ${this.key} 的搜索需求：${exc.message}`);
      }
      throw exc;
    }
    return new Prepared({ spec, consume: this.randomConsumption(inputs), notes });
  }

  searchContext(overrides: SearchOptions = {}): SearchContext {
    const ctx = new SearchContext({ sliceBounds: this.sliceBounds ?? null });
    for (const [name, value] of Object.entries(overrides)) {
      if (value === null || value === undefined) continue;
      if (!CONTEXT_KEYS.has(name)) continue;
      (ctx as unknown as Record<string, unknown>)[name] = value;
    }
    return ctx;
  }

  /**
   * 从**输入**里推出的 ``SearchContext`` 覆盖项。默认空。
   *
   * 存在的意义：有些场景的输入里有「怎么搜」的开关（``stars`` 的「并行枚举」
   * 勾选框），而前端**不该知道**哪个字段管这个。前端只要
   *
   * .. code-block:: ts
   *
   *     const ctx = scenario.searchContext(scenario.searchOptions(inputs));
   *     ctx.cancelToken = token;
   *     ctx.progressCb = onProgress;
   *
   * 就能把「取消/进度」和「场景自己的搜索选项」都照顾到，同时不必给每个场景写分支。
   */
  searchOptions(_inputs: Readonly<Record<string, unknown>>): SearchOptions {
    return {};
  }

  /**
   * 执行搜索。默认交给 ``rt.searcher``。
   *
   * 不可枚举的 spec（``growth-wuxing``：从起点**单向前扫**，不是种子空间的子集）
   * 没有后端能原生加速，由场景自己重写本方法。
   *
   * **``async``**：局部搜索可能被派给 ``rt.pool``（worker 池），而跨 Worker 的
   * 派活天生是异步的。池子为 ``null`` 时内部一次 ``await`` 都不会挂起 ——
   * 结果与同步路径逐位一致（有测试锁着）。
   */
  async search(
    prepared: Prepared,
    searchSeed: number,
    options: { near: boolean; limit: number | null; rt: Runtime; ctx: SearchContext },
  ): Promise<SearchResult> {
    const { near, limit, rt, ctx } = options;
    // 门槛 + 能力：判据只此一份（core/search.ts），两边各用自己的那条。
    const pool = rt.pool;
    if (near) {
      if (!this.supportsNear) throw new ScenarioError(`${this.key} 不支持局部搜索`);
      const steps = Math.trunc(limit !== null ? limit : this.nearLimit);
      // 局部搜索：**只看步数门槛，没有开关**（= Python 的 search_nearest）。
      if (pool !== null && shouldParallelNear(rt.searcher, prepared.spec, steps, ctx)) {
        return pool.searchNearest(searchSeed, prepared.spec, steps, ctx);
      }
      return rt.searcher.searchNearest(searchSeed, prepared.spec, steps, ctx);
    }
    // 枚举：**开关（ctx.preferParallel）+ 步数门槛**（= Python 的 search_all）。
    // 没开关时，即使全空间也跑在当前线程上 —— 与 Python 逐字一致。
    if (pool !== null && shouldParallelEnum(rt.searcher, ctx)) {
      return pool.searchAll(prepared.spec, ctx);
    }
    return rt.searcher.searchAll(prepared.spec, ctx);
  }

  /** 一步到位：``prepare`` → ``search`` → ``interpret``（+ ``preview``）。 */
  async run(
    inputs: Readonly<Record<string, unknown>>,
    startSeed: number,
    options: RunOptions = {},
  ): Promise<Outcome> {
    const rt = Runtime.resolve(options.backend ?? null, options.pool ?? null);
    const prepared = this.prepare(inputs, startSeed);
    const ctx = options.ctx ?? this.searchContext();
    const searchSeed = this.searchSeed(startSeed, inputs, rt);
    const result = await this.search(prepared, searchSeed, {
      near: options.near ?? false,
      limit: options.limit ?? null,
      rt,
      ctx,
    });
    let outcome = this.interpret(result, inputs, startSeed, rt);
    if (outcome.notes.length === 0) {
      outcome = outcome.with({ notes: prepared.notes });
    }
    const seed = outcome.seed !== 0 ? outcome.seed : outcome.seeds.length > 0 ? (outcome.seeds[0] as number) : 0;
    if (seed !== 0 && !outcome.preview) {
      const text = this.preview(seed, inputs, rt);
      if (text) outcome = outcome.with({ preview: text });
    }
    return withBackend(outcome, rt);
  }

  /**
   * 从候选集里取最近的那个。
   *
   * ``searchAll`` 的结果是**有序**的，所以候选顺序不影响 ``best``；对每个候选再
   * 做一次局部搜索（C 的 ``findFabao2`` 一族）—— 走的是 :meth:`Scenario.search`，
   * 所以步数越门槛时每个候选都会自动用上 worker 池。
   */
  async nearestOf(
    inputs: Readonly<Record<string, unknown>>,
    candidates: readonly number[],
    options: NearestOptions = {},
  ): Promise<Outcome> {
    const rt = Runtime.resolve(options.backend ?? null, options.pool ?? null);
    const prepared = this.prepare(inputs, 0);
    const ctx = options.ctx ?? this.searchContext();
    const limit = options.limit ?? null;
    let best: SearchResult | null = null;
    for (const candidate of candidates) {
      const probeSeed = rt.engine.getPreSeed(Math.trunc(candidate));
      const found = await this.search(prepared, probeSeed, { near: true, limit, rt, ctx });
      if (found.nearest === null) continue;
      if (best === null || (found.distance ?? 0) < (best.distance ?? 0)) best = found;
    }
    if (best === null) {
      return withBackend(this.interpret(new SearchResult({ backend: rt.backend.name }), inputs, 0, rt), rt);
    }
    return withBackend(this.interpret(best, inputs, 0, rt), rt);
  }
}

/** ``searchContext`` 允许被覆盖的字段名（对应 Python 里 ``setattr(ctx, name, value)`` 的白名单）。 */
const CONTEXT_KEYS: ReadonlySet<string> = new Set([
  "cancelToken",
  "progressCb",
  "sliceBounds",
  "maxResults",
  "preferParallel",
  "nearParallel",
  "shardSize",
  "throttleInterval",
]);

/**
 * 把运行时真正用的后端名填进 ``Outcome``（只在它是空的时候）。
 *
 * 场景自己造的「没找到」结果很容易漏掉 ``backend``，而结果面板要显示这一格，
 * 空着就成了一条横杠。在这里统一补 —— ``rt`` 就是这次真正跑的那个后端。
 */
export function withBackend(outcome: Outcome, rt: Runtime | null): Outcome {
  if (rt === null || outcome.backend) return outcome;
  return outcome.with({ backend: rt.backend.name });
}
