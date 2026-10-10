/**
 * 扩展的规则模型（``web/extension/url-seed/src/rules.ts``）。
 *
 * 重点钉三组契约：
 *
 * 1. **五条内置规则对五条真实 URL 的判定**（含 ``over/entries`` 必须被忽略）；
 * 2. **顺序即优先级**、第一条命中生效；
 * 3. **「恢复默认」的语义** —— 内置就地还原、缺失的补回、用户规则一根汗毛都不动。
 *    这条是用户明确提的需求（「防止用户不懂原来规则而删掉」）。
 */

import { describe, expect, it } from "vitest";
import {
  BUILTIN_IDS,
  BUILTIN_RULES,
  DEFAULT_EXTRACT,
  DEFAULT_FASTNEXT,
  DEFAULT_FORMULA,
  MAX_FASTNEXT,
  RuleError,
  builtinRules,
  coerceFastnext,
  compileRule,
  fastnextOf,
  matchUrl,
  newRule,
  nextRuleId,
  normalizeRules,
  previewRule,
  restoreDefaults,
  validateRule,
  type Rule,
} from "../extension/url-seed/src/rules";
import { DEFAULT_FORMULA_SAVE_GAME } from "../extension/url-seed/src/formula";

/** 用户报的那条非游戏流量（必须挡掉）。 */
const URL_ENTRIES = "https://img.4399.com/over/entries?ran=86213.62410485744&gameid=11";
/** 用户报的真游戏流量。 */
const URL_TOKEN = "https://sx.4399.com/index.php?ac=get_token&ran=48363.584419712424";
const URL_CTRL = "https://sx.4399.com/flash_ctrl_version.xml?ran=86982.94968344271";
const URL_AD = "https://sx.4399.com/flash_ad_version.xml?ran=0.9268094981089234";
/** 授时 API：随机数直接当参数（没有 ``ran=``），是原始浮点。 */
const URL_TIME = "https://sx.4399.com/index.php?ac=get_time&0.31530938018113375";

describe("内置规则：对五条真实 URL 的判定", () => {
  const rules = builtinRules();

  it("over/entries 被忽略（不是游戏随机数）", () => {
    expect(matchUrl(URL_ENTRIES, rules)).toEqual({ kind: "ignore", rule: BUILTIN_RULES[0] });
  });

  it("ac=get_token → 1038600067", () => {
    const out = matchUrl(URL_TOKEN, rules);
    expect(out.kind).toBe("capture");
    if (out.kind !== "capture") return;
    expect(out.text).toBe("48363.584419712424");
    expect(out.value).toBe(1038600067);
  });

  it("flash_ctrl_version.xml → 1867944621（同「保存游戏」，不 ÷100000 就错）", () => {
    const out = matchUrl(URL_CTRL, rules);
    expect(out.kind).toBe("capture");
    if (out.kind !== "capture") return;
    expect(out.value).toBe(1867944621);
    expect(out.rule.formula).toBe(DEFAULT_FORMULA_SAVE_GAME);
  });

  it("flash_ad_version.xml → 1990308242（原始浮点，**不** ÷100000）", () => {
    const out = matchUrl(URL_AD, rules);
    expect(out.kind).toBe("capture");
    if (out.kind !== "capture") return;
    expect(out.value).toBe(1990308242);
  });

  it("ac=get_time → 677121738（授时 API，原始浮点，**不** ÷100000）", () => {
    const out = matchUrl(URL_TIME, rules);
    expect(out.kind).toBe("capture");
    if (out.kind !== "capture") return;
    expect(out.text).toBe("0.31530938018113375");
    expect(out.value).toBe(677121738);
  });

  it("两条 flash_*.xml 走的是不同公式（不能只配一个全局倍率）", () => {
    const ctrl = matchUrl(URL_CTRL, rules);
    const ad = matchUrl(URL_AD, rules);
    expect(ctrl.kind === "capture" && ad.kind === "capture").toBe(true);
    if (ctrl.kind !== "capture" || ad.kind !== "capture") return;
    expect(ctrl.rule.formula).not.toBe(ad.rule.formula);
  });

  it("不认识的 URL 一律 none（不猜倍率）", () => {
    expect(matchUrl("https://sx.4399.com/whatever?ran=1.5", rules)).toEqual({ kind: "none" });
  });
});

describe("内置规则：顺序与优先级", () => {
  it("第一条命中生效：over/entries 排在最前", () => {
    const rules = builtinRules();
    expect(rules.map((rule) => rule.id)).toEqual([
      "builtin:entries",
      "builtin:token",
      "builtin:flash-ctrl",
      "builtin:flash-ad",
      "builtin:get-time",
    ]);
  });

  it("同时含 over/entries 与 flash_ad 的 URL 仍被判忽略", () => {
    const rules = builtinRules();
    const both = "https://x.com/over/entries?ran=0.5&u=flash_ad_version.xml";
    const out = matchUrl(both, rules);
    expect(out.kind).toBe("ignore");
  });

  it("删掉 over/entries 规则后，它变成「没人认领」被静默忽略", () => {
    const rules = builtinRules().filter((rule) => rule.id !== "builtin:entries");
    expect(matchUrl(URL_ENTRIES, rules)).toEqual({ kind: "none" });
    // 而一旦手滑给它配一条「拿过来就用」的采集规则，就会算出 1.85e14 这种数：
    // 既不报错也不给种子 —— 这正是默认必须把它 ignore 掉的理由。
    const careless: Rule = {
      id: "user:1",
      name: "手滑",
      kind: "capture",
      enabled: true,
      match: "over/entries",
      extract: DEFAULT_EXTRACT,
      formula: "int(n * 0x80000000)",
    };
    const out = matchUrl(URL_ENTRIES, [careless]);
    expect(out.kind).toBe("error");
    if (out.kind !== "error") return;
    expect(out.message).toContain("超出 31 位随机数范围");
  });

  it("停用的规则被跳过", () => {
    const rules = builtinRules().map((rule) =>
      rule.id === "builtin:token" ? { ...rule, enabled: false } : rule,
    );
    expect(matchUrl(URL_TOKEN, rules)).toEqual({ kind: "none" });
  });
});

describe("规则校验与编译", () => {
  it("提取正则没有捕获组 → 编译就报错", () => {
    const rule: Rule = { ...newRule([]), extract: "ran=[0-9.]+" };
    expect(() => compileRule(rule)).toThrow(RuleError);
    expect(validateRule(rule).join()).toContain("捕获组");
  });

  it("具名捕获组也算数（它同样填 match[1]）", () => {
    const rule: Rule = { ...newRule([]), match: "ran=", extract: "ran=(?<v>[0-9.]+)" };
    expect(validateRule(rule)).toEqual([]);
    expect(matchUrl("https://x.com/a?ran=1.5", [rule]).kind).toBe("capture");
  });

  it("字符类里的小括号 / 转义的小括号都不算捕获组", () => {
    const inClass: Rule = { ...newRule([]), match: "ran=", extract: "ran=[(0-9.]+" };
    expect(validateRule(inClass).join()).toContain("捕获组");
    const escaped: Rule = { ...newRule([]), match: "ran=", extract: "ran=\\(([0-9.]+)\\)" };
    expect(validateRule(escaped)).toEqual([]);
  });

  it("非法正则给出带规则名的报错", () => {
    const rule: Rule = { ...newRule([], "", "坏正则"), match: "([", };
    const problems = validateRule(rule);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join()).toContain("坏正则");
  });

  it("空名字 / 空匹配正则被拦下", () => {
    const rule: Rule = { ...newRule([]), name: "  ", match: "" };
    expect(validateRule(rule)).toEqual(
      expect.arrayContaining(["名字不能为空", "匹配正则不能为空"]),
    );
  });

  it("ignore 类规则不要求公式", () => {
    const rule: Rule = { id: "user:9", name: "忽略", kind: "ignore", enabled: true, match: "x" };
    expect(validateRule(rule)).toEqual([]);
  });
});

describe("样例预览 previewRule", () => {
  it("命中采集规则时给出「原文 → 随机整数」", () => {
    const text = previewRule(builtinRules()[1] as Rule, URL_TOKEN);
    expect(text).toContain("48363.584419712424");
    expect(text).toContain("1038600067");
  });

  it("忽略规则给出「会被忽略」", () => {
    expect(previewRule(builtinRules()[0] as Rule, URL_ENTRIES)).toContain("忽略");
  });

  it("不匹配的 URL 明说没匹配上", () => {
    expect(previewRule(builtinRules()[1] as Rule, URL_AD)).toContain("不匹配");
  });
});

describe("恢复默认：内置还原、用户规则不动", () => {
  it("删掉内置 → 按内置顺序补回最前面", () => {
    const stored: Rule[] = [{ ...newRule([]), id: "user:1", name: "我的规则", match: "mine" }];
    const restored = restoreDefaults(stored);
    expect(restored.map((rule) => rule.id)).toEqual([
      "builtin:entries",
      "builtin:token",
      "builtin:flash-ctrl",
      "builtin:flash-ad",
      "builtin:get-time",
      "user:1",
    ]);
  });

  it("改坏内置公式 → 就地还原，且**位置不变**", () => {
    const stored = builtinRules().map((rule) =>
      rule.id === "builtin:token" ? { ...rule, formula: "int(n * 999)", match: "坏掉了" } : rule,
    );
    // 用户把它拖到了最后
    const moved = [...stored.slice(1), stored[0] as Rule];
    const restored = restoreDefaults(moved);
    const token = restored.find((rule) => rule.id === "builtin:token");
    expect(token).toEqual(BUILTIN_RULES[1]);
    expect(restored[restored.length - 1]?.id).toBe("builtin:entries");
  });

  it("用户自建规则原样保留（连 id 都不换）", () => {
    const mine: Rule = {
      id: "user:7",
      name: "我的规则",
      kind: "capture",
      enabled: false,
      match: "custom",
      extract: DEFAULT_EXTRACT,
      formula: DEFAULT_FORMULA,
      note: "别动我",
    };
    const restored = restoreDefaults([mine]);
    const kept = restored.find((rule) => rule.id === "user:7");
    expect(kept).toEqual(mine);
  });

  it("反复调用是幂等的", () => {
    const once = restoreDefaults(builtinRules());
    expect(restoreDefaults(once)).toEqual(once);
  });

  it("内置定义本身是冻结的（外部改不动）", () => {
    expect(Object.isFrozen(BUILTIN_RULES)).toBe(true);
    expect(Object.isFrozen(BUILTIN_RULES[0])).toBe(true);
    expect(BUILTIN_IDS.has("builtin:entries")).toBe(true);
  });
});

describe("storage 数据容错", () => {
  it("坏条目丢弃、重复 id 只留第一条", () => {
    const raw = [
      { id: "user:1", match: "a", name: "A" },
      { id: "user:1", match: "b", name: "B" },
      { id: "", match: "c" },
      { id: "user:2", match: "   " },
      null,
      "字符串",
      { id: "user:3", match: "d", kind: "ignore" },
    ];
    const rules = normalizeRules(raw);
    expect(rules.map((rule) => rule.id)).toEqual(["user:1", "user:3"]);
    expect(rules[0]?.name).toBe("A");
  });

  it("采集类规则缺 extract/formula 时补默认值（空串也当没填）", () => {
    const rules = normalizeRules([{ id: "user:1", match: "a", extract: "  ", formula: "" }]);
    expect(rules[0]?.extract).toBe(DEFAULT_EXTRACT);
    expect(rules[0]?.formula).toBe(DEFAULT_FORMULA);
  });

  it("非数组 / 全坏 → 空列表（不抛）", () => {
    expect(normalizeRules(undefined)).toEqual([]);
    expect(normalizeRules({})).toEqual([]);
  });

  it("nextRuleId 取最大编号 + 1（不重号）", () => {
    const rules = normalizeRules([{ id: "user:4", match: "a" }, { id: "user:2", match: "b" }]);
    expect(nextRuleId(rules)).toBe("user:5");
    expect(nextRuleId([])).toBe("user:1");
  });
});

describe("后移次数 fastnext", () => {
  it("五条内置里三条是 0；只有 get_time 出厂就带 2 次后移", () => {
    const capture = BUILTIN_RULES.filter((rule) => rule.kind === "capture");
    expect(capture).toHaveLength(4);
    expect(capture.map((rule) => rule.id)).toEqual([
      "builtin:token",
      "builtin:flash-ctrl",
      "builtin:flash-ad",
      "builtin:get-time",
    ]);
    // 斗部群星那条流程里，get_time 端出随机数之后游戏还要再走 2 步。
    expect(capture.map((rule) => rule.fastnext)).toEqual([0, 0, 0, 2]);
    // ignore 那条不产出匹配值，所以压根不带这个字段。
    expect(BUILTIN_RULES[0]?.kind).toBe("ignore");
    expect(BUILTIN_RULES[0]?.fastnext).toBeUndefined();
  });

  it("新建规则默认 0", () => {
    expect(newRule([]).fastnext).toBe(0);
    expect(newRule([], "match", "名字").fastnext).toBe(DEFAULT_FASTNEXT);
  });

  it("normalizeRules：缺字段 / 空串 / 坏值一律回落 0", () => {
    const read = (fastnext: unknown): number | undefined =>
      normalizeRules([{ id: "user:1", match: "a", fastnext }])[0]?.fastnext;
    expect(read(undefined)).toBe(0); // 老数据没有这一项
    expect(read("")).toBe(0);
    expect(read("   ")).toBe(0);
    expect(read("abc")).toBe(0);
    expect(read(Number.NaN)).toBe(0);
    expect(read(Number.POSITIVE_INFINITY)).toBe(0);
    expect(read(-1)).toBe(0); // 负数不合法 ⇒ 回落，而不是留在库里
    expect(read(MAX_FASTNEXT + 1)).toBe(0);
    expect(read({})).toBe(0);
  });

  it("normalizeRules：数字串与小数照收（截断到整数）", () => {
    const read = (fastnext: unknown): number | undefined =>
      normalizeRules([{ id: "user:1", match: "a", fastnext }])[0]?.fastnext;
    expect(read("3")).toBe(3);
    expect(read(" 7 ")).toBe(7);
    expect(read(2.9)).toBe(2);
    expect(read(0)).toBe(0);
    expect(read(MAX_FASTNEXT)).toBe(MAX_FASTNEXT);
  });

  it("normalizeRules：ignore 类不认这个字段", () => {
    const rules = normalizeRules([{ id: "user:1", match: "a", kind: "ignore", fastnext: 5 }]);
    expect(rules[0]?.kind).toBe("ignore");
    expect(rules[0]?.fastnext).toBeUndefined();
  });

  it("coerceFastnext 是上面那套规则的单一实现", () => {
    expect(coerceFastnext("12")).toBe(12);
    expect(coerceFastnext(-3)).toBe(0);
    expect(coerceFastnext(3.7)).toBe(3);
    expect(coerceFastnext(null)).toBe(0);
    expect(coerceFastnext(true)).toBe(0);
    expect(coerceFastnext(undefined)).toBe(0);
  });

  it("validateRule：负数 / 超上限 / 小数都报错，0 与上限本身放行", () => {
    const withFastnext = (fastnext: number): Rule => ({
      ...newRule([]),
      name: "测试",
      match: "x",
      fastnext,
    });
    expect(validateRule(withFastnext(0))).toEqual([]);
    expect(validateRule(withFastnext(3))).toEqual([]);
    expect(validateRule(withFastnext(MAX_FASTNEXT))).toEqual([]);
    expect(validateRule(withFastnext(-1)).join()).toContain("负数");
    expect(validateRule(withFastnext(MAX_FASTNEXT + 1)).join()).toContain("最多");
    expect(validateRule({ ...withFastnext(0), fastnext: 1.5 }).join()).toContain("整数");
    // 没填（undefined）等价于 0，不算错。
    expect(validateRule({ ...withFastnext(0), fastnext: undefined })).toEqual([]);
  });

  it("restoreDefaults 会把内置的后移次数也还原成出厂值", () => {
    const tampered = builtinRules().map((rule) =>
      rule.id === "builtin:token" || rule.id === "builtin:get-time"
        ? { ...rule, fastnext: 5 }
        : rule,
    );
    expect(tampered[1]?.fastnext).toBe(5);
    expect(tampered[4]?.fastnext).toBe(5);
    expect(restoreDefaults(tampered)[1]?.fastnext).toBe(0);
    // get_time 的出厂值是 2，不是 0 —— 还原要还原成「出厂那个值」。
    expect(restoreDefaults(tampered)[4]?.fastnext).toBe(2);
  });

  it("fastnextOf：找不到 / 不是采集类 ⇒ 0，找得到就取它的值", () => {
    const rules: Rule[] = [
      { id: "builtin:entries", name: "忽略", kind: "ignore", enabled: true, match: "e" },
      { ...newRule([]), id: "user:1", name: "A", fastnext: 4 },
    ];
    expect(fastnextOf(rules, "user:1")).toBe(4);
    expect(fastnextOf(rules, "user:不存在")).toBe(0);
    expect(fastnextOf(rules, "builtin:entries")).toBe(0); // ignore 不产出匹配值
    expect(fastnextOf([], "user:1")).toBe(0);
    // 手搓的规则可能没这个字段（老数据 / 直接构造的字面量）。
    expect(fastnextOf([{ id: "user:2", name: "B", kind: "capture", enabled: true, match: "b" }], "user:2")).toBe(0);
  });

  it("fastnextOf 不看 enabled —— N 是「这条规则的含义」，不是「它开没开」", () => {
    const rules: Rule[] = [{ ...newRule([]), id: "user:1", name: "A", enabled: false, fastnext: 2 }];
    expect(fastnextOf(rules, "user:1")).toBe(2);
  });

  it("previewRule：0 不吭声，非 0 说明还要往后走几步", () => {
    const token = builtinRules()[1] as Rule;
    const plain = previewRule(token, URL_TOKEN);
    expect(plain).toContain("1038600067");
    expect(plain).not.toContain("FastNext");

    const shifted = previewRule({ ...token, fastnext: 3 }, URL_TOKEN);
    expect(shifted).toContain("1038600067");
    expect(shifted).toContain("FastNext 3 次");
  });
});
