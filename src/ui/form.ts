/**
 * 表单模型（``notes/web-design.md`` §5.3）—— **没有 DOM，只有规则**。
 *
 * 对应的 Python 侧是 ``src_forge/app/ui/form.py``（渲染规则）+ ``src_forge/app/fields.py``
 * （取值规则）。这里把两者的**纯逻辑**搬到 TS，``.vue`` 只负责把它的输出画出来
 * —— 这么分有两个理由：
 *
 * 1. 这一层**不碰 DOM**，所以能在 ``node`` 里被 ``tests/ui_*.test.ts`` 毫秒级钉住
 *    —— 同样的断言放进 ``.vue`` 就得起 ``happy-dom``（§5.7），慢且脆；
 * 2. 这些规则都有具体数值（宽度 44、默认 12、``required`` 与 ``None`` 的先后……），
 *    放在纯 TS 里才能被 ``node`` 下的测试钉住。
 *
 * 控件与值的对应关系照抄 tkinter 版：界面持有的是**控件的原始值**
 * （``string`` / ``boolean``），提交时 :func:`collectInputs` 才转成场景输入值。
 * 所以「清空输入框 = 恢复默认值」这条（``fields.coerce``）是**提交时**生效的，
 * 与界面显示无关 —— 别在输入事件里做转换，否则用户永远敲不出 ``1.`` 这种中间态。
 */

import {
  InputSchema,
  Note,
  type FieldKind,
  type InputField,
} from "../scenarios/scenario";

/** 输入框的字符宽度上限（``form.py:49`` 的 ``MAX_ENTRY_WIDTH``）。 */
export const MAX_ENTRY_WIDTH = 44;

/** 动态展示值为空时的占位（``form.py:52`` 的 ``HINT_EMPTY``）。 */
export const HINT_EMPTY = "—";

/** 「起始种子」这一列的 key（``fields.py:48`` 的 ``START_KEY``）。 */
export const START_KEY = "start_seed";

/** :func:`truthy` 认的「真 / 假」写法 —— 与 ``scenario.getBool`` **逐条对齐**。 */
const TRUE_TEXT: readonly string[] = ["1", "true", "yes", "y", "on"];
const FALSE_TEXT: readonly string[] = ["", "0", "false", "no", "n", "off"];

/** 界面上一个控件的原始值。``bool`` 用 ``boolean``，其余一律 ``string``。 */
export type RawValue = string | boolean;
/** 整张表单的原始值。 */
export type RawForm = Record<string, RawValue>;

/** 一个字段的取值错误（``FieldError`` 的 TS 版）。 */
export class FieldProblem extends Error {
  constructor(
    /** 指回 :attr:`InputField.key`，界面据此标红与聚焦。 */
    readonly key: string,
    readonly label: string,
    /** 不含字段名的原因，例如「必须是整数，当前是「abc」」。 */
    readonly detail: string,
  ) {
    super(`「${label}」${detail}`);
    this.name = "FieldProblem";
  }
}

/** 输入框该有多宽（字符）。``width`` 缺省 12，再压到 :data:`MAX_ENTRY_WIDTH`。 */
export function entryWidth(field: InputField): number {
  const declared = Math.trunc(field.width || 12);
  const clamped = Math.min(declared > 0 ? declared : 12, MAX_ENTRY_WIDTH);
  return Math.max(1, clamped);
}

/** 一个分组在界面上的摆法。 */
export interface FormGroup {
  /** 原始分组名（``""`` 表示「没有分组」）。 */
  readonly group: string;
  /** 显示标题：空分组显示「参数」。 */
  readonly title: string;
  readonly fields: readonly InputField[];
  /** 表头（``schema.headers[group] ?? []``）。 */
  readonly header: readonly string[];
  /**
   * 要不要画成表格（``form.py:105`` 的判据）：
   * 组里**至少一个字段开了 ``inline``**，**且**表头长度 ``>= 3``。
   * 表格组的列序是「字段名 | 展示值 | 控件」—— 展示值夹在中间。
   */
  readonly table: boolean;
}

/**
 * 分组（**首次出现顺序**），并决定每组画成表格还是普通两栏。
 *
 * 入参请传 ``schema.onForm()`` 的结果 —— ``inToolbar`` 的字段属于窗口工具栏，
 * 不该出现在参数区（``form.py`` 的 ``build`` 第一行就是这么做的）。
 */
export function formGroups(schema: InputSchema): FormGroup[] {
  const out: FormGroup[] = [];
  for (const [group, fields] of Object.entries(schema.groups())) {
    const header = schema.headers[group] ?? [];
    out.push({
      group,
      title: group || "参数",
      fields,
      header,
      table: fields.some((f) => f.inline) && header.length >= 3,
    });
  }
  return out;
}

/** 动态展示值：``fieldHints`` 里没有这个 key 就是 :data:`HINT_EMPTY`。 */
export function hintOf(
  hints: Readonly<Record<string, string>>,
  key: string,
): string {
  const text = hints[key];
  return text === undefined || text === "" ? HINT_EMPTY : text;
}

// =========================================================================== 取值
/** NFKC 归一 + ``strip``（``fields.normalize``）。全角数字、全角斜杠都折成半角。 */
export function normalizeText(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  const text = typeof raw === "string" ? raw : String(raw);
  return text.normalize("NFKC").trim();
}

/** 只做 NFKC（不 strip）—— 给「比较键」用。 */
function foldText(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/** 控件值 → ``bool``（``fields.truthy``）。认不出来的字符串回落到 ``default``。 */
export function truthy(raw: unknown, fallback = false): boolean {
  if (typeof raw === "boolean") return raw;
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === "number") return raw !== 0;
  const text = normalizeText(raw).toLowerCase();
  if (TRUE_TEXT.includes(text)) return true;
  if (FALSE_TEXT.includes(text)) return false;
  return fallback;
}

/** 把值对回候选表里的**规范写法**（``fields.match_choice``）。认不出就原样返回。 */
export function matchChoice(choices: readonly string[], raw: unknown): string {
  const text = (raw === null || raw === undefined ? "" : String(raw)).trim();
  if (!text || choices.length === 0) return text;
  if (choices.includes(text)) return text;
  const key = foldText(text);
  for (const candidate of choices) {
    if (foldText(candidate) === key) return candidate;
  }
  return text;
}

/**
 * 单个字段：控件值 → 场景输入值（``fields.coerce``）。
 *
 * 空值一律回落到 ``field.default``（**清空 = 恢复默认**，比「悄悄变成 0」可预测）；
 * ``bool`` 不走回落（勾选框只有真 / 假两态）；转不动就抛 :class:`FieldProblem`。
 */
export function coerce(field: InputField, raw: unknown): unknown {
  if (field.kind === "bool") return truthy(raw);

  if (field.kind === "choice") {
    // ⚠️ 这里**不能**用 normalizeText 的结果：NFKC 会把全角括号折成半角，而候选表
    // 里写的就是全角（例如「未满 2.5（重算成长）」），折完永远对不上。
    const text = matchChoice(field.choices, raw);
    return text || matchChoice(field.choices, field.default);
  }

  const text = normalizeText(raw);
  if (text === "") return field.default;
  if (field.kind === "int") {
    if (!/^[+-]?\d+$/.test(text)) {
      throw new FieldProblem(field.key, field.label, `必须是整数，当前是「${text}」`);
    }
    const value = Number(text);
    if (!Number.isSafeInteger(value)) {
      throw new FieldProblem(field.key, field.label, `整数超出可表示范围，当前是「${text}」`);
    }
    return value;
  }
  if (field.kind === "float") {
    const value = Number(text);
    if (!Number.isFinite(value)) {
      throw new FieldProblem(field.key, field.label, `必须是数字，当前是「${text}」`);
    }
    return value;
  }
  return text;
}

/** 整张表单 → ``(输入值, 所有字段错误)``。坏字段**回落到默认值**，好让界面一次全标红。 */
export function collect(
  schema: InputSchema,
  raw: Readonly<Record<string, unknown>>,
): { inputs: Record<string, unknown>; errors: FieldProblem[] } {
  const inputs: Record<string, unknown> = {};
  const errors: FieldProblem[] = [];
  for (const field of schema.fields) {
    const value = field.key in raw ? raw[field.key] : field.default;
    try {
      inputs[field.key] = coerce(field, value);
    } catch (exc) {
      if (!(exc instanceof FieldProblem)) throw exc;
      errors.push(exc);
      inputs[field.key] = field.default;
    }
  }
  return { inputs, errors };
}

/**
 * 场景输入值 → 控件里该显示的文本（``fields.text_of``）。
 *
 * ``bool`` 例外：Python 那边回的是 ``"1"`` / ``"0"``（那些值是塞进 tkinter
 * ``StringVar`` 的），网页端复选框持有的是**真布尔**，所以这里直接给 ``boolean``。
 * ``null`` 两边都是「未勾选」（``""`` 与 ``false`` 在复选框上等价），界面状态一致。
 *
 * ``choice`` 也例外：只读下拉框不能为空，所以不在候选里的值（含 ``null``）一律折成
 * **第一个候选** —— schema 的默认值本来就该是合法候选，这条只防某个场景把默认值写歪。
 */
export function textOf(field: InputField, value: unknown): RawValue {
  if (field.kind === "bool") return truthy(value);
  if (field.kind === "choice") {
    if (value === null || value === undefined) return field.choices[0] ?? "";
    const text = matchChoice(field.choices, value);
    return field.choices.includes(text) ? text : (field.choices[0] ?? "");
  }
  return value === null || value === undefined ? "" : String(value);
}

// =========================================================================== 整表
/** 整张表单的初始控件值（= 各字段默认值）。 */
export function initialForm(schema: InputSchema): RawForm {
  const raw: RawForm = {};
  for (const field of schema.fields) raw[field.key] = textOf(field, field.default);
  return raw;
}

/**
 * 把一组场景输入值写进控件值（**返回新对象**，便于 Vue 直接替换 ref）。
 *
 * 不认识 / 没有对应字段的键**原样丢掉** —— 调用方（``advance()`` 回填、URL 解码）
 * 给的是「想改哪些字段」，不是「整张表单」。
 */
export function writeForm(
  schema: InputSchema,
  raw: Readonly<RawForm>,
  values: Readonly<Record<string, unknown>>,
): RawForm {
  const next: RawForm = { ...raw };
  for (const [key, value] of Object.entries(values)) {
    const field = schema.get(key);
    if (field === null) continue;
    next[key] = textOf(field, value);
  }
  return next;
}

/** 这张表单有没有「起始种子」这一列（``fields.has_start``）。 */
export function hasStart(schema: InputSchema): boolean {
  return schema.fields.some((f) => f.key === START_KEY);
}

/**
 * 取 ``run()`` 的起点（``fields.start_seed_of``）。
 *
 * ⚠️ 没有这一列 / 为空 ⇒ ``0``，而这个 0 是**哨兵**不是种子（``stars`` 的「没有起始值
 * = 全空间枚举」正是靠它）。合法种子的检查由 :func:`issues` + 场景自己的
 * ``validate`` 负责。
 */
export function startSeedOf(inputs: Readonly<Record<string, unknown>>): number {
  const value = inputs[START_KEY];
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "number" ? value : Number(normalizeText(value));
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n) >>> 0;
}

/** schema 级校验（``fields.issues``）。这些是**机械约束**，场景的 ``validate`` 之外的兜底。 */
export function issues(
  schema: InputSchema,
  inputs: Readonly<Record<string, unknown>>,
): Note[] {
  const notes: Note[] = [];
  for (const field of schema.fields) {
    if (!(field.key in inputs)) continue;
    const value = inputs[field.key];
    // 必填要排在「None = 没填 = 不检查」**前面**：``default = null`` 的必填字段
    // 空着就是错的，不是「这个场景没有这个字段」。
    if (field.required && (value === null || value === undefined || value === "")) {
      notes.push(
        new Note({
          level: "error",
          message: `「${field.label}」还没填 —— 请先填上再运行`,
          field: field.key,
        }),
      );
      continue;
    }
    if (value === null || value === undefined) continue;
    if (field.kind === "choice") {
      if (field.choices.length > 0 && !field.choices.includes(String(value))) {
        notes.push(
          new Note({
            level: "error",
            message: `「${field.label}」只能是 ${field.choices.join("/")}，当前是「${value}」`,
            field: field.key,
          }),
        );
      }
      continue;
    }
    if (field.kind === "int" || field.kind === "float") {
      const n = typeof value === "number" ? value : Number(normalizeText(value));
      if (!Number.isFinite(n)) {
        notes.push(
          new Note({
            level: "error",
            message: `「${field.label}」必须是数字，当前是「${value}」`,
            field: field.key,
          }),
        );
        continue;
      }
      if (field.min !== null && n < field.min) {
        notes.push(
          new Note({
            level: "error",
            message: `「${field.label}」不能小于 ${field.min}，当前是 ${n}`,
            field: field.key,
          }),
        );
      }
      if (field.max !== null && n > field.max) {
        notes.push(
          new Note({
            level: "error",
            message: `「${field.label}」不能大于 ${field.max}，当前是 ${n}`,
            field: field.key,
          }),
        );
      }
    }
  }
  return notes;
}

/** 两条 ``Note`` 算不算重复（``field`` + 文案都一样）—— 合并去重时用。 */
export function sameNote(a: Note, b: Note): boolean {
  return a.field === b.field && a.message === b.message && a.level === b.level;
}

/**
 * 合并多组 ``Note`` 并按 ``(field, message, level)`` 去重，**保持首次出现的顺序**。
 *
 * 场景的 ``validate`` 与 :func:`issues` 检查的重叠面很大（都管 ``min``/``max``/
 * ``choices``），不去重的话同一个问题会在提示页里出现两遍。
 */
export function mergeNotes(...groups: ReadonlyArray<readonly Note[]>): Note[] {
  const out: Note[] = [];
  for (const group of groups) {
    for (const note of group) {
      if (out.some((existing) => sameNote(existing, note))) continue;
      out.push(note);
    }
  }
  return out;
}

/** 最靠上那个出错的字段 key（界面标红后要聚焦它；``null`` = 没有错）。 */
export function firstErrorField(
  schema: InputSchema,
  notes: ReadonlyArray<readonly Note[]>,
): string | null {
  const bad = new Set<string>();
  for (const group of notes) {
    for (const note of group) {
      if (note.isError && note.field) bad.add(note.field);
    }
  }
  if (bad.size === 0) return null;
  for (const field of schema.fields) {
    if (bad.has(field.key)) return field.key;
  }
  return null;
}

/** 字段类型的中文名（提示条里 ``field.help`` 为空时的兜底，对齐 ``form.py:172``）。 */
export function kindLabel(kind: FieldKind): string {
  switch (kind) {
    case "int":
      return "整数";
    case "float":
      return "数字";
    case "choice":
      return "选项";
    case "bool":
      return "开关";
    default:
      return "文本";
  }
}

/** 提示条里显示的那行字：``field.help``，为空则 ``「标签」（类型）``。 */
export function helpOf(field: InputField): string {
  return field.help || `${field.label}（${kindLabel(field.kind)}）`;
}
