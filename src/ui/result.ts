/**
 * 结果面板模型（``notes/web-design.md`` §5.4）—— 一句结论 + 键值表 + 种子条 + 三个标签页。
 *
 * 对应 Python 侧 ``src_forge/app/ui/result.py``。搬过来的只有**取数规则**
 * （哪几格、什么顺序、``null`` 显示成什么、预览怎么拆行），画的部分在 ``.vue`` 里。
 *
 * ⚠️ 两条与性能有关的纪律（照抄 §5.6 的第 2、3 条）：
 *
 * * ``Outcome.seeds`` 最长 999 —— 内联只摆前 :data:`INLINE_SEEDS` 个 + ``…`` + 总数，
 *   全量走弹层（:func:`seedListLines` 分块折行）。别把整个数组塞进任何 ``v-for``；
 * * **详情页的 JSON 要按需序列化**（:func:`detailJson` 只在切到该页时调一次）——
 *   大结果序列化一次是毫秒级，但每帧都序列化就是肉眼可见的卡。
 */

import type { Note, NoteLevel, Outcome } from "../scenarios/scenario";

/** 种子条那一行最多摆几个（``result.py:79``）。多的用 ``…`` 收尾。 */
export const INLINE_SEEDS = 8;

/** 没有候选列表时种子条显示的话（局部搜索只给最近的那个种子）。 */
export const SEED_EMPTY = "（没有候选列表：局部搜索只给最近的种子）";

/** 弹层里每行最多多少字符（**在逗号处折行**，不会把一个种子掰成两半）。 */
export const SEED_LINE_CHARS = 72;

/** 弹层分块渲染的块大小 —— 剩下的交给下一帧，开窗那一刻不卡。 */
export const SEED_CHUNK = 400;

/** 属性预览页的宽度（等宽字符）。窄于这个数就不出横向滚动条。 */
export const PREVIEW_WIDTH = 48;

/** 有命中但场景不提供预览时显示的话。 */
export const PREVIEW_EMPTY = "（这个场景不提供属性预览）";

/** 没有提示时显示的话。 */
export const NOTES_EMPTY = "（没有额外提示）";

/** ``Note.level`` → 界面上那个方括号里的字。 */
export const LEVEL_LABEL: Readonly<Record<NoteLevel, string>> = Object.freeze({
  info: "提示",
  warning: "警告",
  error: "错误",
});

/** 键值表的行定义：``[标签, 取值方式]``。顺序就是界面上的顺序（两列排布）。
 *
 * 第二项是 :class:`Outcome` 上的属性名（``count`` 不是字段而是 getter，照样算）。
 */
export const ROWS: ReadonlyArray<readonly [string, string]> = [
  ["种子", "seed"],
  ["距离", "distance"],
  ["需消耗", "need_consume"],
  ["实际消耗", "consume"],
  ["用后种子", "seed_after"],
  ["结果数", "count"],
  ["后端", "backend"],
  ["宝石排列", "permutation"],
];

/**
 * 属性预览的**固定顺序**（用户定的）：五行、品质、成长、生命、魔法、攻击、防御…
 *
 * ⚠️ 这个表只管**界面怎么摆**，不是游戏的计算顺序（那个是
 * ``const/resolution.ATTR_ORDER``，明写了「不能改」）。两件事别混。
 */
export const PREVIEW_ORDER: readonly string[] = [
  "五行",
  "品质",
  "成长",
  "生命",
  "魔法",
  "攻击",
  "防御",
  "暴击",
  "闪避",
  "回血",
  "回魔",
  "魔抗",
];

/** 空格占位（``null`` / 空串都显示它）。 */
const DASH = "—";

/** 种子序列 → ``"(11,22,33)"``。圆括号 + 逗号、**不加空格**（用户定的格式）。 */
export function formatSeeds(seeds: Iterable<number>): string {
  return `(${[...seeds].map((v) => String(Math.trunc(v))).join(",")})`;
}

/**
 * 种子序列 → ``["(11,22,33,…)", 被省略的个数]``。
 *
 * 内联那一行的长度**是定死的**：再多候选也只摆 :data:`INLINE_SEEDS` 个 + 计数。
 */
export function seedText(seeds: Iterable<number>, limit = INLINE_SEEDS): [string, number] {
  const items = [...seeds].map((v) => String(Math.trunc(v)));
  const cap = Math.max(Math.trunc(limit), 0);
  const hidden = Math.max(0, items.length - cap);
  if (hidden === 0) return [`(${items.join(",")})`, 0];
  const head = items.slice(0, cap).join(",");
  return [head ? `(${head},…)` : "(…)", hidden];
}

/**
 * 全量种子 → 折好行的文本（弹层用）。
 *
 * 折行**只在逗号处**发生 —— 一个种子被拦腰截断成两行的话，用户框选复制出去就是
 * 一个错的数字，而这段文本的唯一用途就是复制进游戏。
 */
export function seedListLines(seeds: Iterable<number>, width = SEED_LINE_CHARS): string[] {
  const items = [...seeds].map((v) => String(Math.trunc(v)));
  if (items.length === 0) return [];
  const lines: string[] = [];
  let current = "";
  for (const item of items) {
    const next = current === "" ? item : `${current},${item}`;
    if (next.length > width && current !== "") {
      lines.push(`${current},`);
      current = item;
    } else {
      current = next;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

/**
 * ``"{'暴击':7}"`` 这类 **Python ``str(dict)``** 形态 → 键值对。
 *
 * 为什么不能直接 ``JSON.parse``：Python 的 ``repr`` 用**单引号**、``None``、
 * ``True`` 这些 JSON 里没有的字面量。只解析**一层扁平字典**（键是引号字符串或裸
 * 标识符、值是数字/字符串/``None``/``True``/``False``）；只要出现嵌套括号就返回
 * ``null``，交给调用方原样显示 —— 猜错格式比不猜更糟。
 */
export function parseLiteralDict(text: string): Record<string, unknown> | null {
  const body = text.trim();
  if (!body.startsWith("{") || !body.endsWith("}")) return null;
  const inner = body.slice(1, -1).trim();
  if (inner === "") return {};
  const pairs = splitTopLevel(inner);
  if (pairs === null) return null;
  const table: Record<string, unknown> = {};
  for (const pair of pairs) {
    const at = pair.indexOf(":");
    if (at < 0) return null;
    const key = unquote(pair.slice(0, at).trim());
    const value = literalValue(pair.slice(at + 1).trim());
    if (key === null || value === undefined) return null;
    table[key] = value;
  }
  return table;
}

/** 按顶层逗号切分；遇到任何括号嵌套就放弃（返回 ``null``）。 */
function splitTopLevel(text: string): string[] | null {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quote !== "") {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth += 1;
    else if (ch === "}" || ch === "]" || ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
    if (depth !== 0) return null;
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter((s) => s !== "");
}

/** 去掉一层引号；裸标识符原样返回。 */
function unquote(text: string): string | null {
  if (text.length >= 2) {
    const head = text[0];
    if ((head === "'" || head === '"') && text.endsWith(head)) return text.slice(1, -1);
  }
  if (text === "") return null;
  return text;
}

/** 字面量 → 值；认不出来返回 ``undefined``（哨兵：调用方据此放弃整段解析）。 */
function literalValue(text: string): unknown {
  if (text === "None") return null;
  if (text === "True") return true;
  if (text === "False") return false;
  if (text.length >= 2 && (text.startsWith("'") || text.startsWith('"'))) {
    const head = text.charAt(0);
    if (text.endsWith(head)) return text.slice(1, -1);
    return undefined;
  }
  if (/^[+-]?\d+$/.test(text)) return Number(text);
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(text)) return Number(text);
  return undefined;
}

/**
 * 属性预览 → 一行一个属性的 ``["五行：金", "成长：0.8"]``。
 *
 * 只在**确定**这是一张属性表时才返回列表：
 *
 * * ``preview`` 已经是 ``Record``，或者是长得像 ``"{'暴击':7}"`` 的字符串；
 * * 而且**每一个**键都在 :data:`PREVIEW_ORDER` 里；且**非空**。
 *
 * 否则返回 ``null``，由调用方原样显示 —— 别的场景给的是自由文本
 * （``连点器: -\n末种子: -``、``距离: 12\n结果: 3``、宝石排列的 `` | `` 拼接），
 * 硬拆会看不懂。
 */
export function previewLines(preview: unknown): string[] | null {
  let table: Record<string, unknown>;
  if (preview !== null && typeof preview === "object" && !Array.isArray(preview)) {
    table = { ...(preview as Record<string, unknown>) };
  } else if (typeof preview === "string" && preview.trim().startsWith("{")) {
    const parsed = parseLiteralDict(preview);
    if (parsed === null) return null;
    table = parsed;
  } else {
    return null;
  }
  const keys = Object.keys(table);
  if (keys.length === 0) return null;
  if (keys.some((key) => !PREVIEW_ORDER.includes(key))) return null;
  const rank = new Map(PREVIEW_ORDER.map((name, index) => [name, index]));
  const sorted = [...keys].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
  return sorted.map((key) => {
    const value = table[key];
    // 成长是唯一要格式化的一位小数（``0.8`` 而不是 ``0.8000000000000001``）。
    if (key === "成长" && typeof value === "number" && Number.isFinite(value)) {
      return `${key}：${value.toFixed(1)}`;
    }
    return `${key}：${value === null || value === undefined ? "" : String(value)}`;
  });
}

/** 面板状态：还没跑 / 整体失败 / 有结果。 */
export type PanelState =
  | { readonly kind: "idle" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "done"; readonly outcome: Outcome };

/** 一句结论（``result.py:617``）。``danger = true`` 时用危险色。 */
export function conclusionOf(state: PanelState): { text: string; danger: boolean } {
  if (state.kind === "idle") return { text: "还没有结果", danger: false };
  if (state.kind === "failed") return { text: "计算失败", danger: true };
  const outcome = state.outcome;
  if (!outcome.found) return { text: "没有找到种子", danger: true };
  if (outcome.count > 1) {
    return {
      text: `找到 ${outcome.count} 个种子（最近 ${outcome.seed}，距离 ${outcome.distance}）`,
      danger: false,
    };
  }
  return { text: `找到种子 ${outcome.seed}（距离 ${outcome.distance}）`, danger: false };
}

/** 键值表里的一行。 */
export interface ResultRow {
  readonly label: string;
  readonly value: string;
}

/** 键值表（``result.py:_fill_table``）。``null`` / ``""`` 显示成 :data:`DASH`。 */
export function tableRows(outcome: Outcome): ResultRow[] {
  const values: Record<string, unknown> = {
    seed: outcome.seed,
    distance: outcome.distance,
    need_consume: outcome.needConsume,
    consume: outcome.consume,
    seed_after: outcome.seedAfter,
    count: outcome.count,
    backend: outcome.backend,
    permutation: outcome.permutation,
  };
  const rows: ResultRow[] = ROWS.map(([label, attr]) => {
    const value = values[attr];
    return {
      label,
      value: value === null || value === undefined || value === "" ? DASH : String(value),
    };
  });
  if (outcome.truncated) rows.push({ label: "结果", value: "已截断（只保留了一部分）" });
  if (outcome.unordered) rows.push({ label: "顺序", value: "并行搜索，结果无序" });
  return rows;
}

/** 属性预览页该画什么。 */
export type PreviewView =
  | { readonly kind: "table"; readonly lines: readonly string[] }
  | { readonly kind: "raw"; readonly text: string }
  | { readonly kind: "empty" }
  | { readonly kind: "blank" };

/** 有命中但没预览 → ``empty``（灰字说明）；没命中 → ``blank``（什么都不显示）。 */
export function previewView(outcome: Outcome): PreviewView {
  if (!outcome.preview) return outcome.found ? { kind: "empty" } : { kind: "blank" };
  const lines = previewLines(outcome.preview);
  if (lines === null) return { kind: "raw", text: outcome.preview };
  return { kind: "table", lines };
}

/** 提示页的一行。 */
export interface NoteLine {
  /** ``[警告](字段名) `` 这一截；没有字段名时只有 ``[警告] ``。 */
  readonly prefix: string;
  readonly message: string;
  readonly level: NoteLevel;
}

/** ``Note`` 列表 → 提示行（``result.py:_fill_notes``）。空列表由调用方显示 :data:`NOTES_EMPTY`。 */
export function noteLines(notes: readonly Note[]): NoteLine[] {
  return notes.map((note) => ({
    prefix: `[${LEVEL_LABEL[note.level] ?? note.level}]${note.field ? `(${note.field})` : ""} `,
    message: note.message,
    level: note.level,
  }));
}

/** 种子条那一行的文本（``null`` 表示没有候选：显示 :data:`SEED_EMPTY`）。 */
export function seedBarText(seeds: readonly number[]): string | null {
  if (seeds.length === 0) return null;
  const [text] = seedText(seeds);
  return text;
}

/**
 * 详情页的 JSON。**只在切到详情页时调**（见文件头第 2 条纪律）。
 *
 * 序列化失败不抛给调用方 —— 详情页炸掉不该把整个界面带走。
 */
export function detailJson(outcome: Outcome): string {
  try {
    return JSON.stringify(outcome.toDict(), null, 2);
  } catch (exc) {
    return `无法序列化结果：${exc instanceof Error ? exc.message : String(exc)}`;
  }
}

/** 后端名 → 界面上显示的那串（``wasm`` 显示成 ``wasm（WebAssembly）``）。 */
export function backendLabel(name: string): string {
  if (!name) return DASH;
  return name === "wasm" ? "wasm（WebAssembly）" : name;
}
