/**
 * URL 状态与分享链接（``notes/web-design.md`` §5.8）—— **只管输入，不管运行态**。
 *
 * 为什么值得单独成一个模块
 * ------------------------
 * 这段逻辑的三条规则都容易被写歪，而每一条都能悄悄毁掉用户手上的链接：
 *
 * 1. **只编码 ``inputs``**（``schema().fields`` 里的 key → 值），结果 / 进度 / 种子表
 *    都不进 URL —— 它们要么太大（999 个种子），要么下次打开就该重算。
 * 2. **缺省值不进 URL**（值 === ``field.default`` 就跳过），否则一条链接长得毫无意义。
 * 3. **绝不因为旧链接而抛错**：``v`` 对不上就只恢复 key 能对上的字段，其余忽略并给
 *    一条 ``warning``；未知 key / 越界值同样忽略 + 提醒。手改过的链接不该白屏。
 *
 * 打开链接 = **把表单填好，不自动开跑**（wasm 在大种子上要跑很久，自动跑是坏体验）
 * —— 这条不是本模块的职责，但决定了本模块**只导出输入**、不导出任何「该不该跑」的信号。
 *
 * 与 ``fields.py`` 的关系
 * ----------------------
 * 解码时的「字符串 → 场景输入值」用的是 :func:`coerceText`，语义对齐
 * ``src_forge/app/fields.py`` 的 ``coerce``，**但有一处刻意不同**：那里转换失败会
 * 抛 ``FieldError``（用户在界面上敲错了，要标红让他改），这里**失败就丢掉这一项**并
 * 记一条 ``Note``（URL 里的值没人能改，报错只会挡住他看别的字段）。
 */

import type { InputField } from "../scenarios/scenario";
import { Note, type NoteLevel } from "../scenarios/scenario";
import type { InputSchema } from "../scenarios/scenario";

/** ``v`` 那个查询参数的键名。带 ``_v`` 是为了避开字段 key 的命名空间。 */
export const VERSION_KEY = "_v";

/** 一条链接里最多回填多少条 ``warning``（手改坏了的链接可能每条都坏，别刷屏）。 */
const MAX_NOTES = 5;

/** 路由的两种形态：``#/key?…`` 与「没有路由」。 */
export interface RouteState {
  /** 场景 key（``""`` = 没写 / 写了空）。 */
  readonly key: string;
  /** 查询串（``URLSearchParams``，永远是**已解码**的值）。 */
  readonly params: URLSearchParams;
}

/**
 * ``location.hash`` → 路由状态。
 *
 * 容忍这几种写法（都是人手工敲出来的常见形态）：
 * ``#/making?a=1`` / ``#making?a=1`` / ``#/making`` / ``#making`` / ``""`` / ``"#"``。
 * 场景 key 里允许 ``-``（例如 ``seed-resolve`` / ``v4-reforge``），所以**不**按
 * 字母数字去校验，只按「遇到 ``?`` 或 ``/`` 为止」切。
 */
export function parseHash(hash: string): RouteState {
  let body = String(hash ?? "");
  if (body.startsWith("#")) body = body.slice(1);
  if (body.startsWith("/")) body = body.slice(1);
  const cut = body.search(/[?&]/);
  const path = cut >= 0 ? body.slice(0, cut) : body;
  const query = cut >= 0 ? body.slice(cut) : "";
  let params = new URLSearchParams();
  try {
    params = new URLSearchParams(query);
  } catch {
    // 畸形查询串（比如 ``%`` 后面跟了非十六进制）—— 当成「没有参数」，
    // 而不是把整个页面打成白屏。URLSearchParams 本身很宽容，这条只是兜底。
    params = new URLSearchParams();
  }
  return { key: path.trim(), params };
}

/** ``#/key?a=1``。参数为空时省掉 ``?``。 */
export function buildHash(key: string, query?: URLSearchParams | string | null): string {
  const body = String(key ?? "").trim();
  const text = query instanceof URLSearchParams ? query.toString() : String(query ?? "");
  const tail = text.startsWith("?") ? text.slice(1) : text;
  return tail ? `#/${body}?${tail}` : `#/${body}`;
}

/** 两个值算不算「同一个」（用于「等于默认值就不进 URL」）。 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  if (typeof a === "number" && typeof b === "string") return String(a) === b;
  if (typeof a === "string" && typeof b === "number") return a === String(b);
  return false;
}

/** ``bool`` → ``"1"`` / ``"0"``（其它类型照旧走 ``String``）。 */
function encodeValue(field: InputField, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (field.kind === "bool") return value ? "1" : "0";
  if (field.kind === "choice") return String(value);
  if (field.kind === "int" || field.kind === "float") {
    const n = Number(value);
    return Number.isFinite(n) ? String(n) : null;
  }
  const text = String(value);
  return text === "" ? null : text;
}

/**
 * ``inputs`` → 查询参数。
 *
 * 顺序 = ``schema.fields`` 顺序（**稳定**，同一个表单永远编出同一串，便于人眼比对与
 * 手改）；等于 ``field.default`` 的项直接跳过；空串 / ``null`` 也跳过。
 *
 * :param version: 写进 ``_v`` 的表单契约版本（见 :func:`formVersion`）。
 *   ``""`` / 省略 ⇒ 不写 ``_v``（测试与内部调用用得上）。
 */
export function encodeParams(
  schema: InputSchema,
  inputs: Readonly<Record<string, unknown>>,
  version = "",
): URLSearchParams {
  const params = new URLSearchParams();
  for (const field of schema.fields) {
    const value = inputs[field.key];
    if (sameValue(value, field.default)) continue;
    const text = encodeValue(field, value);
    if (text === null) continue;
    params.set(field.key, text);
  }
  if (version) params.set(VERSION_KEY, version);
  return params;
}

/** 一个字段的解码结果：拿到了值，或者「不认识这条」。 */
type Decoded = { ok: true; value: unknown } | { ok: false; why: string };

function coerceText(field: InputField, text: string): Decoded {
  const body = text.trim();
  if (field.kind === "bool") {
    const low = body.toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(low)) return { ok: true, value: true };
    if (["0", "false", "no", "n", "off", ""].includes(low)) return { ok: true, value: false };
    return { ok: false, why: `不是布尔值（${body}）` };
  }
  if (field.kind === "choice") {
    if (!body) return { ok: false, why: "空选项" };
    if (field.choices.includes(body)) return { ok: true, value: body };
    // 退一步做大小写/全半角无关的比较（手写链接时大小写很容易打歪），
    // 但**返回值永远是候选表原文** —— 与 ``fields.match_choice`` 同一口径。
    const folded = body.normalize("NFKC").toLowerCase();
    for (const candidate of field.choices) {
      if (candidate.normalize("NFKC").toLowerCase() === folded) {
        return { ok: true, value: candidate };
      }
    }
    return { ok: false, why: `不在候选里（${body}）` };
  }
  if (field.kind === "int") {
    if (!/^[+-]?\d+$/.test(body)) return { ok: false, why: `不是整数（${body || "空"}）` };
    const value = Number(body);
    if (!Number.isFinite(value)) return { ok: false, why: `数字太大（${body}）` };
    const bad = rangeProblem(field, value);
    return bad ? { ok: false, why: bad } : { ok: true, value };
  }
  if (field.kind === "float") {
    if (body === "") return { ok: false, why: "空值" };
    const value = Number(body);
    if (!Number.isFinite(value)) return { ok: false, why: `不是数字（${body}）` };
    const bad = rangeProblem(field, value);
    return bad ? { ok: false, why: bad } : { ok: true, value };
  }
  // text：原样收下；但候选表非空的 ``text`` 字段（装备名那类）也当选择用，
  // 否则一个手改的名字会一路带到 ``buildSpec`` 里才炸。
  if (field.choices.length > 0) {
    return field.choices.includes(body)
      ? { ok: true, value: body }
      : { ok: false, why: `不在候选里（${body}）` };
  }
  return { ok: true, value: body };
}

/** 越界返回原因，没越界返回 ``null``。 */
function rangeProblem(field: InputField, value: number): string | null {
  if (field.min !== null && value < field.min) return `小于下限 ${field.min}（${value}）`;
  if (field.max !== null && value > field.max) return `大于上限 ${field.max}（${value}）`;
  return null;
}

/** 解码结果：只回填**URL 里真的写了**的键。 */
export interface DecodedInputs {
  readonly inputs: Record<string, unknown>;
  readonly notes: readonly Note[];
  /** 被认出来的字段数（等于 ``Object.keys(inputs).length``）。 */
  readonly restored: number;
}

/**
 * 查询参数 → 输入覆盖项。
 *
 * :param expectedVersion: :func:`formVersion` 的当前值。参数里没有 ``_v`` ⇒ 不校验
 *   （老链接 / 手写链接），有且对不上 ⇒ 仍然逐字段恢复 + 一条 ``warning``。
 */
export function decodeParams(
  schema: InputSchema,
  params: URLSearchParams,
  expectedVersion = "",
): DecodedInputs {
  const inputs: Record<string, unknown> = {};
  const notes: Note[] = [];
  let restored = 0;
  const rejected: string[] = [];
  const unknown: string[] = [];

  let version = "";
  try {
    version = params.get(VERSION_KEY) ?? "";
  } catch {
    version = "";
  }
  const mismatch = Boolean(version) && Boolean(expectedVersion) && version !== expectedVersion;

  for (const [rawKey, rawValue] of params.entries()) {
    if (rawKey === VERSION_KEY) continue;
    const field = schema.get(rawKey);
    if (field === null) {
      unknown.push(rawKey);
      continue;
    }
    const decoded = coerceText(field, rawValue);
    if (decoded.ok) {
      inputs[field.key] = decoded.value;
      restored += 1;
    } else {
      rejected.push(`${field.label}：${decoded.why}`);
    }
  }

  if (notes.length < MAX_NOTES && unknown.length > 0) {
    notes.push(
      new Note({
        level: "warning",
        message: `链接里有 ${unknown.length} 个当前场景不认识的字段，已忽略：${unknown.join("、")}`,
      }),
    );
  }
  for (const text of rejected) {
    if (notes.length >= MAX_NOTES) break;
    notes.push(new Note({ level: "warning", message: `链接里的「${text}」，已忽略` }));
  }
  if (mismatch && notes.length < MAX_NOTES) {
    notes.push(
      new Note({
        level: "warning",
        message: `链接是为表单版本 ${version} 生成的，当前是 ${expectedVersion}；只恢复了能对上的字段`,
      }),
    );
  }
  return { inputs, notes, restored };
}

/**
 * 场景的表单契约版本号（写进 ``_v``）。
 *
 * 取 :attr:`Scenario.version`（机制版本）：URL 是**按场景**分享的，所以按场景的版本
 * 比一个全局版本号更精细 —— 改随机消耗顺序、增删字段时都会 +1。
 *
 * ⚠️ 它是「提示级」的判据，不是安全边界：对不上只降级恢复 + 一条警告，**永远不拒绝**。
 */
export function formVersion(scenario: { readonly version: string }): string {
  return scenario.version || "1.0";
}

/**
 * 拼分享链接。
 *
 * :param href: 当前 ``location.href``（或测试里的任意绝对 URL）—— 只取它的
 *   ``origin + pathname + search``，hash 整段换掉，所以 ``base: "./"`` 部署在子路径
 *   下也照样对（不需要知道 ``base``）。
 */
export function shareUrl(
  href: string,
  key: string,
  schema: InputSchema,
  inputs: Readonly<Record<string, unknown>>,
  version = "",
): string {
  const url = new URL(href);
  url.hash = buildHash(key, encodeParams(schema, inputs, version));
  return url.toString();
}

/** 给测试与「显示在界面上」用的一行摘要。 */
export function describeDecode(result: DecodedInputs): string {
  const levels = new Map<NoteLevel, number>();
  for (const note of result.notes) levels.set(note.level, (levels.get(note.level) ?? 0) + 1);
  const parts = [`恢复 ${result.restored} 项`];
  for (const [level, count] of levels) parts.push(`${level} ${count}`);
  return parts.join("，");
}
