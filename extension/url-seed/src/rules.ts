/**
 * **规则模型** + 内置默认规则 + 「从 URL 取值」的判定。
 *
 * 问题背景
 * --------
 * 游戏（Flash）把随机数塞在各种 URL 里，形态**不统一**：
 *
 * ============================================  ==============================
 * 实际 URL（节选）                                ran 的含义
 * ============================================  ==============================
 * ``index.php?ac=get_token&ran=48363.584419712424``  显示值（原始浮点 × 100000）
 * ``flash_ctrl_version.xml?ran=86982.94968344271``   同上（没乘数 ⇒ 也是显示值）
 * ``flash_ad_version.xml?ran=0.9268094981089234``    **原始浮点**（没有 ×100000）
 * ``index.php?ac=get_time&0.31530938018113375``      **原始浮点**（数字直接当参数，无 ``ran=``）
 * ``over/entries?ran=86213.62410485744&gameid``      **不是游戏产生的**，必须忽略
 * ============================================  ==============================
 *
 * 所以「一个全局因子」是错的：倍率**逐 URL** 不同，而且有些 URL 压根不该采。模型
 * 因此是「一条 URL 一个规则」，每条规则自带：匹配正则 + 提取正则 + 换算公式。
 *
 * 规则字段
 * -------
 * * ``match``：正则**源码**，对**完整 URL**（含 query）做 ``test()``；
 * * ``extract``：可选，正则**源码**，取**第 1 个捕获组**当随机数原文；
 *   留空用 :data:`DEFAULT_EXTRACT`（通用的 ``ran=…``）；
 * * ``formula``：可选，用 :mod:`./formula` 的迷你语言写的换算公式，变量 ``n``；
 *   留空用 :data:`DEFAULT_FORMULA_SAVE_GAME`（``int(n / 100000 * 0x80000000)``）；
 * * ``fastnext``：可选，拿到种子后再**往后** ``FastNext()`` 几次（默认 ``0`` 不动）。
 *   恢复出的是「读出匹配值**之前**」的种子，游戏之后再推进了几步就用它补回来；
 * * ``kind === "ignore"``：只匹配、不取值，用来挡掉已知的非游戏 URL。
 *
 * 判定顺序
 * -------
 * 按数组顺序**逐条**判，**第一条匹配的规则说了算**（不是「所有规则都试一遍」）：
 * 拿到第一个 ``enabled`` 且 ``match`` 命中的规则就停。所以
 * 1. 内置的 ``over/entries`` 忽略规则排在**最前面**（它的 URL 里也有 ``ran=``，
 *    不先挡就会被后面某条通用规则吃掉）；
 * 2. 「恢复默认」把缺失的内置规则**插到最前面**，用户自建规则留在后面。
 */

import {
  DEFAULT_FORMULA_SAVE_GAME,
  FormulaError,
  evaluateFormula,
  parseRandomText,
  validateFormula,
} from "./formula";

/** 规则的两种行为。 */
export type RuleKind = "capture" | "ignore";

/** 一条规则（可存在 ``chrome.storage`` 里，所以字段都是纯数据）。 */
export interface Rule {
  /** 稳定 id。内置规则是 ``builtin:xxx``，用户自建的 ``user:N``。 */
  id: string;
  /** 展示用名字。 */
  name: string;
  kind: RuleKind;
  /** 关掉的规则完全不参与判定（但保留在列表里）。 */
  enabled: boolean;
  /** 匹配**完整 URL** 的正则源码。 */
  match: string;
  /** 取随机数原文的正则源码（第 1 个捕获组）；``kind === "capture"`` 时才用。 */
  extract?: string;
  /** 换算公式源码；``kind === "capture"`` 时才用。 */
  formula?: string;
  /**
   * 拿到种子后再**往后** ``FastNext()`` 几次（默认 ``0`` = 不动）。
   *
   * 恢复出的是「读出**匹配值之前**」的那个种子（匹配值本身是从它往后一步得到的）；
   * 而游戏多数是「读一个数就顺便推进种子」（``rand_next``），所以「保存完再看的种子」
   * 往往比恢复结果靠后若干步 —— 这个参数就是把那几步补回来。
   * 只对 ``kind === "capture"`` 有意义；范围 ``0 ~ :data:`MAX_FASTNEXT```
   * （上限是防手输巨值把内容脚本的主线程卡住）。
   */
  fastnext?: number;
  /** 内置标记（「恢复默认」只动内置规则）。 */
  builtin?: boolean;
  /** 给用户看的备注（内置规则用来解释倍率差异）。 */
  note?: string;
}

/** 规则/正则错误（文案直接给用户看）。 */
export class RuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleError";
    Object.setPrototypeOf(this, RuleError.prototype);
  }
}

/** 缺省提取正则：通用 ``ran=…``（``?``/``&``/串首 开头，到 ``&``/``#``/空白 结束）。 */
export const DEFAULT_EXTRACT = "(?:[?&]|^)ran=([^&#\\s]+)";

/** 缺省换算公式 = 「保存游戏」那套（显示值 ÷100000 再 ×2³¹）。 */
export const DEFAULT_FORMULA = DEFAULT_FORMULA_SAVE_GAME;

/**
 * 「后移次数」的上限。
 *
 * 不是算法限制（``fastNext`` 自己能跑任意次），纯粹是**保险丝**：这个值会被用户在
 * 设置页里手打，一个 10 亿会当场把内容脚本的主线程钉死（后移是同步跑的，且刻意
 * **不用**快速幂 —— N 本来就只有个位数）。正常用法连 10 都用不到。
 */
export const MAX_FASTNEXT = 1000;

/** 「后移次数」的缺省值。 */
export const DEFAULT_FASTNEXT = 0;

/**
 * 把 ``unknown`` 收成一个合法的「后移次数」。
 *
 * 容错优先（storage 里的数据可能是上一版扩展写的、也可能被用户手工改过）：
 * 数字、数字串都收；**留空 / 不是数 / NaN / 负数 / 超上限一律回落 0** ——
 * 回落成 0 而不是「保留坏值」，因为 0 是「什么都不做」，最坏也只是回到旧行为。
 */
export function coerceFastnext(value: unknown): number {
  let num: number;
  if (typeof value === "number") num = value;
  else if (typeof value === "string" && value.trim() !== "") num = Number(value);
  else return DEFAULT_FASTNEXT;
  if (!Number.isFinite(num)) return DEFAULT_FASTNEXT;
  const truncated = Math.trunc(num);
  if (truncated < 0 || truncated > MAX_FASTNEXT) return DEFAULT_FASTNEXT;
  return truncated;
}

/** 内置规则的 id 前缀。 */
export const BUILTIN_PREFIX = "builtin:";

/** 用户自建规则的 id 前缀。 */
export const USER_PREFIX = "user:";

/**
 * 内置规则（**顺序即优先级**）。
 *
 * id 与顺序都是契约：改 id 等于「老用户的这条规则变成孤儿」，改顺序等于改判定结果。
 */
export const BUILTIN_RULES: readonly Rule[] = Object.freeze([
  Object.freeze({
    id: `${BUILTIN_PREFIX}entries`,
    name: "over/entries（非游戏流量，忽略）",
    kind: "ignore" as RuleKind,
    enabled: true,
    match: "(?:^|[/?&])over/entries\\b",
    builtin: true,
    note: "例：over/entries?ran=86213.62410485744&gameid —— 这里的 ran 不是游戏随机数，必须挡掉。",
  }),
  Object.freeze({
    id: `${BUILTIN_PREFIX}token`,
    name: "保存游戏 get_token",
    kind: "capture" as RuleKind,
    enabled: true,
    match: "[?&]ac=get_token\\b",
    extract: DEFAULT_EXTRACT,
    formula: DEFAULT_FORMULA_SAVE_GAME,
    fastnext: 0,
    builtin: true,
    note: "例：index.php?ac=get_token&ran=48363.584419712424 —— 显示值，要 ÷100000。",
  }),
  Object.freeze({
    id: `${BUILTIN_PREFIX}flash-ctrl`,
    name: "flash_ctrl_version.xml（同「保存游戏」）",
    kind: "capture" as RuleKind,
    enabled: true,
    match: "flash_ctrl_version\\.xml",
    extract: DEFAULT_EXTRACT,
    formula: DEFAULT_FORMULA_SAVE_GAME,
    fastnext: 0,
    builtin: true,
    note: "例：flash_ctrl_version.xml?ran=86982.94968344271 —— 同样没有乘数（也是显示值）。",
  }),
  Object.freeze({
    id: `${BUILTIN_PREFIX}flash-ad`,
    name: "flash_ad_version.xml（原始浮点）",
    kind: "capture" as RuleKind,
    enabled: true,
    match: "flash_ad_version\\.xml",
    extract: DEFAULT_EXTRACT,
    formula: "int(n * 0x80000000)",
    fastnext: 0,
    builtin: true,
    note: "例：flash_ad_version.xml?ran=0.9268094981089234 —— 这里就是原始浮点，不 ÷100000。",
  }),
  Object.freeze({
    id: `${BUILTIN_PREFIX}get-time`,
    name: "get_time（授时 API，原始浮点）",
    kind: "capture" as RuleKind,
    enabled: true,
    match: "[?&]ac=get_time\\b",
    extract: "[?&]([0-9][^&#\\s]*)",
    formula: "int(n * 0x80000000)",
    // 斗部群星那条流程里，get_time 端出随机数之后游戏还要再走 2 步 ⇒ 出厂就是 2，不是 0。
    // （`tests/ext_rules.test.ts` / `tests/ext_settings.test.ts` / `README.md` 里都钉了这个值。）
    fastnext: 2,
    builtin: true,
    note: "例：index.php?ac=get_time&0.31530938018113375 —— 随机数直接当参数（没有 ran=），是原始浮点，不 ÷100000。",
  }),
]);

/** 内置规则的 id 集合（判断「这条能不能被恢复默认」）。 */
export const BUILTIN_IDS: ReadonlySet<string> = new Set(BUILTIN_RULES.map((rule) => rule.id));

/** 复制一份规则（避免把冻结的内置定义写进 storage）。 */
export function cloneRule(rule: Rule): Rule {
  return { ...rule };
}

/** 内置规则的独立副本（外部改它不会污染 :data:`BUILTIN_RULES`）。 */
export function builtinRules(): Rule[] {
  return BUILTIN_RULES.map(cloneRule);
}

/** 造一个新 id（``user:N``，N = 现有 ``user:`` 里的最大编号 + 1）。 */
export function nextRuleId(existing: readonly Rule[]): string {
  let max = 0;
  for (const rule of existing) {
    if (!rule.id.startsWith(USER_PREFIX)) continue;
    const ordinal = Number(rule.id.slice(USER_PREFIX.length));
    if (Number.isInteger(ordinal) && ordinal > max) max = ordinal;
  }
  return `${USER_PREFIX}${max + 1}`;
}

/** 用户新建规则时的填空（默认给一条「保存游戏」形态的骨架，改一改就能用）。 */
export function newRule(existing: readonly Rule[], sampleMatch = "", name = ""): Rule {
  return {
    id: nextRuleId(existing),
    name: name === "" ? `新规则 ${existing.filter((r) => !r.builtin).length + 1}` : name,
    kind: "capture",
    enabled: true,
    match: sampleMatch,
    extract: DEFAULT_EXTRACT,
    formula: DEFAULT_FORMULA,
    fastnext: DEFAULT_FASTNEXT,
  };
}

/**
 * 把 storage / 用户输入里的 ``unknown`` 收成一条合法规则。
 *
 * 返回 ``null`` 表示**这条彻底不能用**（没有 id 或没有 match）—— 调用方直接丢掉。
 * 其余字段缺省即补，坏值就地降级：storage 里的数据是上一版扩展写的，
 * 也可能被用户手工改过，容错比重启后白屏强。
 */
export function normalizeRule(raw: unknown): Rule | null {
  if (raw === null || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const id = typeof source["id"] === "string" ? source["id"].trim() : "";
  if (id === "") return null;
  const match = typeof source["match"] === "string" ? source["match"] : "";
  if (match.trim() === "") return null;
  const kind: RuleKind = source["kind"] === "ignore" ? "ignore" : "capture";
  const rule: Rule = {
    id,
    name: typeof source["name"] === "string" && source["name"].trim() !== "" ? source["name"] : id,
    kind,
    enabled: source["enabled"] !== false,
    match,
  };
  if (kind === "capture") {
    // ⚠️ 空串要当成「没填」而不是「用空正则」—— 空正则对任何串都匹配，
    // 会把「第 1 个捕获组」变成 undefined，症状是「明明匹配了却取不到数」。
    const extract = typeof source["extract"] === "string" ? source["extract"] : "";
    const formula = typeof source["formula"] === "string" ? source["formula"] : "";
    rule.extract = extract.trim() === "" ? DEFAULT_EXTRACT : extract;
    rule.formula = formula.trim() === "" ? DEFAULT_FORMULA : formula;
    // 缺字段（老数据没有这一项）、空串、负数、NaN 全部回落 0 —— 见 ``coerceFastnext``。
    rule.fastnext = coerceFastnext(source["fastnext"]);
  }
  if (source["builtin"] === true) rule.builtin = true;
  if (typeof source["note"] === "string") rule.note = source["note"];
  return rule;
}

/** 数组 → 规则列表（逐条 :func:`normalizeRule`，坏条目丢弃、重复 id 只留第一条）。 */
export function normalizeRules(raw: unknown): Rule[] {
  if (!Array.isArray(raw)) return [];
  const rules: Rule[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const rule = normalizeRule(item);
    if (rule === null || seen.has(rule.id)) continue;
    seen.add(rule.id);
    rules.push(rule);
  }
  return rules;
}

/**
 * 「恢复默认」。
 *
 * 语义（用户明确要求）：**把内置规则还原成出厂定义，用户自建的规则原地不动**。
 *
 * 1. 列表里已存在的内置 id ⇒ **就地重置**成 :data:`BUILTIN_RULES` 的副本
 *    （位置保留，用户把它拖到哪就留在哪）；
 * 2. 缺失的内置 id ⇒ 按内置顺序**插到最前面**（`over/entries` 必须先判）；
 * 3. 用户自建规则（``builtin`` 不是 ``true`` 且 id 不是内置 id）⇒ 原样保留。
 *
 * 所以「不小心删掉了内置规则」「手抖把公式改坏了」都能一键回来，而不会连带
 * 清掉用户自己攒的规则。
 */
export function restoreDefaults(stored: readonly Rule[]): Rule[] {
  const byId = new Map(stored.map((rule) => [rule.id, rule]));
  const resolved = stored.map((rule) => {
    const definition = BUILTIN_RULES.find((builtin) => builtin.id === rule.id);
    return definition === undefined ? rule : cloneRule(definition);
  });
  const missing = BUILTIN_RULES.filter((builtin) => !byId.has(builtin.id)).map(cloneRule);
  return [...missing, ...resolved];
}

// =========================================================================== 编译 / 判定
/** 编译好的规则：正则只编译一次。 */
export interface CompiledRule {
  readonly rule: Rule;
  /** 匹配完整 URL（无 flag —— 带 ``g`` 的话 ``test`` 会有 ``lastIndex`` 状态）。 */
  test(url: string): boolean;
  /** 提取随机数原文；没命中返回 ``null``。 */
  extract(url: string): string | null;
  /** 换算公式（``kind === "capture"`` 才有）。 */
  formula(n: number): ReturnType<typeof evaluateFormula>;
}

const COMPILED = new Map<string, CompiledRule>();

/** 编译缓存键：规则里真正影响行为的那几个字段。 */
function compileKey(rule: Rule): string {
  return `${rule.kind}\u0000${rule.match}\u0000${rule.extract ?? ""}\u0000${rule.formula ?? ""}`;
}

/**
 * 正则源码里有没有**捕获组**（第 1 组会当随机数原文）。
 *
 * JS 不暴露「组数」这个信息，只能扫源码。要跳过的：转义字符、字符类 ``[…]``、
 * 非捕获/断言组 ``(?:`` ``(?=`` ``(?!`` ``(?<=`` ``(?<!``。``(?<name>…)`` 是**具名捕获组**，
 * 算数（它同样填 ``match[1]``）。
 */
function hasCaptureGroup(source: string): boolean {
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "[") {
      i += 1;
      while (i < source.length && source[i] !== "]") {
        if (source[i] === "\\") i += 1;
        i += 1;
      }
      continue;
    }
    if (ch !== "(") continue;
    if (source[i + 1] !== "?") return true;
    if (source[i + 2] === "<" && source[i + 3] !== "=" && source[i + 3] !== "!") return true;
  }
  return false;
}

/**
 * 编译一条规则。
 *
 * @throws RuleError 正则源码非法（两条正则各自报错，附上规则名便于定位）。
 */
export function compileRule(rule: Rule): CompiledRule {
  const key = compileKey(rule);
  const cached = COMPILED.get(key);
  if (cached !== undefined) return cached;

  let matchRe: RegExp;
  try {
    matchRe = new RegExp(rule.match);
  } catch (err) {
    throw new RuleError(`规则「${rule.name}」的匹配正则非法：${err instanceof Error ? err.message : String(err)}`);
  }

  let extractRe: RegExp | null = null;
  if (rule.kind === "capture") {
    const source = rule.extract ?? DEFAULT_EXTRACT;
    try {
      extractRe = new RegExp(source);
    } catch (err) {
      throw new RuleError(`规则「${rule.name}」的提取正则非法：${err instanceof Error ? err.message : String(err)}`);
    }
    // ⚠️ 没有捕获组就永远取不到数 —— 提前报出来，比「匹配了但没值」好查得多。
    if (!hasCaptureGroup(extractRe.source)) {
      throw new RuleError(`规则「${rule.name}」的提取正则没有捕获组（要写 (…) 把数字括起来）`);
    }
  }
  // 收成 ``const``：闭包里对 ``let`` 的收窄不如 ``const`` 稳。
  const extractor = extractRe;

  const formulaSource = rule.formula ?? DEFAULT_FORMULA;
  if (rule.kind === "capture") {
    const problem = validateFormula(formulaSource);
    if (problem !== null) throw new RuleError(`规则「${rule.name}」的公式非法：${problem}`);
  }

  const compiled: CompiledRule = {
    rule,
    test: (url) => matchRe.test(url),
    extract: (url) => {
      if (extractor === null) return null;
      const found = extractor.exec(url);
      const group = found?.[1];
      return group === undefined ? null : group;
    },
    formula: (n) => evaluateFormula(formulaSource, n),
  };
  if (COMPILED.size > 512) COMPILED.clear();
  COMPILED.set(key, compiled);
  return compiled;
}

/** :func:`matchUrl` 的判定结果。 */
export type RuleOutcome =
  /** 没有任何规则匹配（URL 被忽略）。 */
  | { readonly kind: "none" }
  /** 命中了忽略规则。 */
  | { readonly kind: "ignore"; readonly rule: Rule }
  /** 命中采集规则且换算成功。 */
  | {
      readonly kind: "capture";
      readonly rule: Rule;
      /** 提取到的原文（``"48363.584419712424"``）。 */
      readonly text: string;
      /** 换算出的 31 位随机整数。 */
      readonly value: number;
    }
  /** 规则匹配了但提取/换算失败（配置问题，要显示给用户）。 */
  | { readonly kind: "error"; readonly rule: Rule; readonly message: string };

/**
 * 用规则列表判一条 URL：**第一条命中的规则说了算**。
 *
 * 不匹配 ⇒ :data:`"none"`（一律忽略，不做任何兜底猜测 —— 猜错倍率比不采更糟）。
 */
export function matchUrl(url: string, rules: readonly Rule[]): RuleOutcome {
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const compiled = compileRule(rule);
    if (!compiled.test(url)) continue;
    if (rule.kind === "ignore") return { kind: "ignore", rule };
    const text = compiled.extract(url);
    if (text === null) {
      return {
        kind: "error",
        rule,
        message: `匹配上了但提取不到随机数（检查提取正则的捕获组，或 URL 里确实没有 ran=）`,
      };
    }
    try {
      const outcome = compiled.formula(parseRandomText(text));
      return { kind: "capture", rule, text, value: outcome.value };
    } catch (err) {
      const message = err instanceof FormulaError ? err.message : String(err);
      return { kind: "error", rule, message: `换算失败：${message}（原文 "${text}"）` };
    }
  }
  return { kind: "none" };
}

/**
 * 「这条规则要求把种子往后推几次」—— 找不到规则 / 规则不是采集类 ⇒ ``0``。
 *
 * 存在的意义是把「用哪条规则的 N」这个决策收在**一处**（面板里也解释了为什么是
 * 「更晚那个读数」的规则）：恢复出的种子是「读到**匹配值**那一刻」的状态，
 * 所以决定「之后又抽了几次」的自然是**产出匹配值的那条规则**。
 *
 * 用**当前**规则表查而不是在采集时把 N 存进缓冲：这样用户改完设置立刻生效，
 * 不用重新抓值。代价是「把那条规则删了 ⇒ 回落 0」，可以接受（删规则本来就不常见）。
 */
export function fastnextOf(rules: readonly Rule[], ruleId: string): number {
  for (const rule of rules) {
    if (rule.id !== ruleId) continue;
    if (rule.kind !== "capture") return DEFAULT_FASTNEXT;
    return coerceFastnext(rule.fastnext);
  }
  return DEFAULT_FASTNEXT;
}

// =========================================================================== 设置页辅助
/** 校验一条规则：返回所有问题（空数组 = 没问题）。 */
export function validateRule(rule: Rule): string[] {
  const problems: string[] = [];
  if (rule.name.trim() === "") problems.push("名字不能为空");
  if (rule.match.trim() === "") problems.push("匹配正则不能为空");
  if (rule.kind === "capture" && (rule.extract ?? "").trim() === "") {
    problems.push("提取正则不能为空（要有一个 (…) 捕获组）");
  }
  if (rule.kind === "capture" && (rule.formula ?? "").trim() === "") {
    problems.push("换算公式不能为空");
  }
  if (rule.kind === "capture") {
    const fastnext = rule.fastnext ?? DEFAULT_FASTNEXT;
    if (!Number.isFinite(fastnext) || Math.trunc(fastnext) !== fastnext) {
      problems.push("后移次数必须是整数");
    } else if (fastnext < 0) {
      problems.push("后移次数不能为负数（只会往后推，不会往前）");
    } else if (fastnext > MAX_FASTNEXT) {
      problems.push(`后移次数最多 ${MAX_FASTNEXT}（正常用法个位数就够）`);
    }
  }
  try {
    compileRule(rule);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }
  return problems;
}

/**
 * 设置页的「样例预览」：拿一条 URL 试规则，返回给用户看的一句话。
 *
 * 刻意**不**复用 :func:`matchUrl` —— 预览要看到「规则匹配了但公式报错」的细节，
 * 而 ``matchUrl`` 会把第一条命中的结果直接返回。
 */
export function previewRule(rule: Rule, url: string): string {
  const problems = validateRule(rule);
  if (problems.length > 0) return `✗ ${problems[0]}`;
  const compiled = compileRule(rule);
  if (!compiled.test(url)) return "… 这条 URL 不匹配当前规则";
  if (rule.kind === "ignore") return "✓ 匹配：该 URL 会被忽略";
  const text = compiled.extract(url);
  if (text === null) return "✗ 匹配了，但没提取到数字（检查捕获组）";
  try {
    const outcome = compiled.formula(parseRandomText(text));
    const fastnext = rule.fastnext ?? DEFAULT_FASTNEXT;
    const suffix = fastnext > 0 ? `（拿到种子后还会往后 FastNext ${fastnext} 次）` : "";
    return `✓ 取到 "${text}" → 随机整数 ${outcome.value}${suffix}`;
  } catch (err) {
    return `✗ 取到 "${text}"，但换算失败：${err instanceof Error ? err.message : String(err)}`;
  }
}
