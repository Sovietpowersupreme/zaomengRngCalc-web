/**
 * ``web/src/ui/form.ts`` 的守卫。
 *
 * 这里的每一条都对应 ``src_forge/app/ui/form.py`` / ``src_forge/app/fields.py`` 里的
 * **一个具体行为**，不是随手写的边界 —— 尤其是这三条：
 *
 * * **清空输入框 = 恢复默认值**（不是变成 ``0``，也不是报错）；
 * * **必填排在「``None`` = 没填 = 不检查」前面** —— ``default = None`` 的必填字段
 *   空着必须是错误，不能被那一句 ``continue`` 吞掉；
 * * **候选表里的值要回原文**（``choice`` 折合比较是为了认出来，不是为了改写值）。
 */

import { describe, expect, it } from "vitest";
import { InputField, InputSchema } from "../src/scenarios/scenario";
import type { InputFieldInit } from "../src/scenarios/scenario";
import {
  FieldProblem,
  MAX_ENTRY_WIDTH,
  START_KEY,
  coerce,
  collect,
  entryWidth,
  firstErrorField,
  formGroups,
  hasStart,
  helpOf,
  hintOf,
  initialForm,
  issues,
  kindLabel,
  matchChoice,
  mergeNotes,
  normalizeText,
  startSeedOf,
  textOf,
  truthy,
  writeForm,
} from "../src/ui/form";

function field(init: InputFieldInit & { key: string }): InputField {
  return new InputField(init);
}

/** 一张覆盖五种 ``kind`` 的表，外加一个「分组 / 表格」用的组。 */
function schema(): InputSchema {
  return new InputSchema({
    fields: [
      field({ key: "count", kind: "int", default: 1, min: 1, max: 500, group: "基础", width: 6 }),
      field({
        key: "ratio",
        kind: "float",
        default: 1.3,
        min: 1,
        max: 3,
        group: "基础",
      }),
      field({
        key: "mode",
        kind: "choice",
        default: "未满 2.5（重算成长）",
        choices: ["未满 2.5（重算成长）", "满 2.5（只重算一次）"],
        group: "基础",
      }),
      field({ key: "note", kind: "text", default: "", group: "其它" }),
      field({ key: "auto", kind: "bool", default: false, toolbar: true, group: "其它" }),
      field({ key: START_KEY, kind: "int", default: 0, required: true, group: "其它" }),
    ],
  });
}

describe("entryWidth", () => {
  it("没声明宽度就用 12", () => {
    expect(entryWidth(field({ key: "a" }))).toBe(12);
    expect(entryWidth(field({ key: "a", width: 0 }))).toBe(12);
  });

  it("声明了就用声明的（这就是「观测值那种长输入框靠 width 撑开」的机制）", () => {
    expect(entryWidth(field({ key: "a", width: 40 }))).toBe(40);
  });

  it("超过 44 压到 44", () => {
    expect(entryWidth(field({ key: "a", width: 80 }))).toBe(MAX_ENTRY_WIDTH);
    expect(MAX_ENTRY_WIDTH).toBe(44);
  });

  it("负数回落 12（不是压到 1 —— 写歪的宽度不该变成一根线）", () => {
    expect(entryWidth(field({ key: "a", width: -5 }))).toBe(12);
  });
});

describe("formGroups", () => {
  it("按首次出现顺序分组，空组名显示成「参数」", () => {
    const groups = formGroups(
      new InputSchema({
        fields: [
          field({ key: "a", group: "乙" }),
          field({ key: "b", group: "" }),
          field({ key: "c", group: "甲" }),
          field({ key: "d", group: "乙" }),
        ],
      }),
    );
    expect(groups.map((g) => g.group)).toEqual(["乙", "", "甲"]);
    expect(groups.map((g) => g.title)).toEqual(["乙", "参数", "甲"]);
    expect(groups[0]!.fields.map((f) => f.key)).toEqual(["a", "d"]);
  });

  it("工具栏开关（inToolbar）走 onForm() 之后不在参数区里", () => {
    const full = schema();
    const form = full.onForm();
    expect(formGroups(form).some((g) => g.fields.some((f) => f.key === "auto"))).toBe(false);
    // 但全量 schema 里它还在 —— validate / defaults 照旧认这个键。
    expect(full.get("auto")).not.toBeNull();
  });

  it("有 inline 字段且表头 ≥ 3 栏才画表格", () => {
    const inline = field({ key: "v", kind: "text", inline: true, group: "属性" });
    const plain = field({ key: "w", kind: "text", group: "属性" });
    const table = formGroups(
      new InputSchema({
        fields: [inline, plain],
        headers: { 属性: ["字段", "展示值", "输入"] },
      }),
    );
    expect(table[0]!.table).toBe(true);
    expect(table[0]!.header).toEqual(["字段", "展示值", "输入"]);
  });

  it("表头只有 2 栏 → 退化成普通两栏（不画表头）", () => {
    const groups = formGroups(
      new InputSchema({
        fields: [field({ key: "v", kind: "text", inline: true, group: "属性" })],
        headers: { 属性: ["字段", "值"] },
      }),
    );
    expect(groups[0]!.table).toBe(false);
  });

  it("组里没有 inline 字段 → 不画表格（哪怕表头够长）", () => {
    const groups = formGroups(
      new InputSchema({
        fields: [field({ key: "v", kind: "text", group: "属性" })],
        headers: { 属性: ["字段", "展示值", "输入"] },
      }),
    );
    expect(groups[0]!.table).toBe(false);
  });
});

describe("hintOf", () => {
  it("拿不到 / 空串都显示占位", () => {
    expect(hintOf({}, "a")).toBe("—");
    expect(hintOf({ a: "" }, "a")).toBe("—");
    expect(hintOf({ a: "[1, 10]" }, "a")).toBe("[1, 10]");
  });
});

describe("truthy", () => {
  it("认清这些写法", () => {
    for (const text of ["1", "true", "TRUE", " yes ", "Y", "On"]) {
      expect(truthy(text)).toBe(true);
    }
    for (const text of ["", "0", "false", "NO", "n", "off", "  "]) {
      expect(truthy(text)).toBe(false);
    }
  });

  it("认不出来回落到 fallback，不抛错", () => {
    expect(truthy("随便什么")).toBe(false);
    expect(truthy("随便什么", true)).toBe(true);
    expect(truthy(null, true)).toBe(true);
  });

  it("已经是布尔 / 数字就直接用", () => {
    expect(truthy(true)).toBe(true);
    expect(truthy(false)).toBe(false);
    expect(truthy(0)).toBe(false);
    expect(truthy(2)).toBe(true);
  });
});

describe("normalizeText", () => {
  it("NFKC 折合 + 去两侧空白（全角数字也认）", () => {
    expect(normalizeText("  １２３ ")).toBe("123");
    expect(normalizeText(null)).toBe("");
    expect(normalizeText(7)).toBe("7");
  });
});

describe("matchChoice", () => {
  it("精确命中就返回原文", () => {
    expect(matchChoice(["甲", "乙"], "乙")).toBe("乙");
  });

  it("大小写 / 全角括号折合后命中，返回的是**候选表原文**", () => {
    const choices = ["未满 2.5（重算成长）", "满 2.5（只重算一次）"];
    expect(matchChoice(choices, "未满 2.5(重算成长)")).toBe("未满 2.5（重算成长）");
    expect(matchChoice(["Critical"], "critical")).toBe("Critical");
  });

  it("认不出来原样返回（让 issues() 去报错，不在这里悄悄改成默认值）", () => {
    const choices = ["未满 2.5（重算成长）"];
    expect(matchChoice(choices, "未满2.5(重算成长)")).toBe("未满2.5(重算成长)");
  });
});

describe("coerce", () => {
  it("bool 只有两态，不走「空值回落默认值」", () => {
    const f = field({ key: "b", kind: "bool", default: true });
    expect(coerce(f, "")).toBe(false);
    expect(coerce(f, "on")).toBe(true);
  });

  it("choice 空值回落到默认值对应的候选", () => {
    const f = field({
      key: "m",
      kind: "choice",
      default: "乙",
      choices: ["甲", "乙"],
    });
    expect(coerce(f, "")).toBe("乙");
    expect(coerce(f, "甲")).toBe("甲");
  });

  it("其余类型：空值 = 默认值（清空输入框就是恢复默认）", () => {
    expect(coerce(field({ key: "n", kind: "int", default: 7 }), "")).toBe(7);
    expect(coerce(field({ key: "n", kind: "int", default: 7 }), "  ")).toBe(7);
    expect(coerce(field({ key: "t", kind: "text", default: "x" }), "")).toBe("x");
  });

  it("int 认全角数字，转不动就抛 FieldProblem（带「」的整句）", () => {
    const f = field({ key: "n", kind: "int", default: 1, label: "次数" });
    expect(coerce(f, " １２ ")).toBe(12);
    expect(coerce(f, "-3")).toBe(-3);
    let thrown: unknown = null;
    try {
      coerce(f, "abc");
    } catch (exc) {
      thrown = exc;
    }
    expect(thrown).toBeInstanceOf(FieldProblem);
    expect((thrown as FieldProblem).key).toBe("n");
    expect((thrown as FieldProblem).message).toBe("「次数」必须是整数，当前是「abc」");
  });

  it("int 超出安全整数范围要报错，不许悄悄变成浮点", () => {
    expect(() => coerce(field({ key: "n", kind: "int" }), "99999999999999999999")).toThrow(
      FieldProblem,
    );
  });

  it("float 允许 1.3 / .5 / 1e3，认不出就抛", () => {
    const f = field({ key: "r", kind: "float", default: 1 });
    expect(coerce(f, "1.3")).toBe(1.3);
    expect(coerce(f, ".5")).toBe(0.5);
    expect(coerce(f, "1e3")).toBe(1000);
    expect(() => coerce(f, "一")).toThrow(FieldProblem);
  });

  it("text 过 NFKC + strip", () => {
    expect(coerce(field({ key: "t", kind: "text" }), " ＡＢ ")).toBe("AB");
  });
});

describe("collect", () => {
  it("坏字段回落到默认值并全部记下来（好让界面一次标红）", () => {
    const s = schema();
    const { inputs, errors } = collect(s, {
      count: "abc",
      ratio: "2.5",
      mode: "满 2.5（只重算一次）",
      note: "hi",
      auto: true,
      [START_KEY]: "123",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.key).toBe("count");
    expect(inputs["count"]).toBe(1);
    expect(inputs["ratio"]).toBe(2.5);
    expect(inputs["auto"]).toBe(true);
  });

  it("表单里缺的键用字段默认值补齐", () => {
    const { inputs } = collect(schema(), {});
    expect(inputs["count"]).toBe(1);
    expect(inputs["mode"]).toBe("未满 2.5（重算成长）");
    expect(inputs["auto"]).toBe(false);
  });
});

describe("textOf / initialForm / writeForm", () => {
  it("choice 是只读下拉框，永远给得出一个合法候选", () => {
    const f = field({ key: "m", kind: "choice", default: "甲", choices: ["甲", "乙"] });
    expect(textOf(f, null)).toBe("甲");
    expect(textOf(f, "不存在")).toBe("甲");
    expect(textOf(f, "乙")).toBe("乙");
  });

  it("bool 回布尔（网页端复选框要真布尔），其余回字符串", () => {
    expect(textOf(field({ key: "b", kind: "bool", default: true }), null)).toBe(false);
    expect(textOf(field({ key: "b", kind: "bool", default: true }), true)).toBe(true);
    expect(textOf(field({ key: "b", kind: "bool" }), "on")).toBe(true);
    expect(textOf(field({ key: "n", kind: "int", default: 3 }), 3)).toBe("3");
    expect(textOf(field({ key: "n", kind: "int" }), null)).toBe("");
  });

  it("initialForm = 各字段默认值", () => {
    const raw = initialForm(schema());
    expect(raw["count"]).toBe("1");
    expect(raw["mode"]).toBe("未满 2.5（重算成长）");
    expect(raw["auto"]).toBe(false);
    expect(Object.keys(raw)).toHaveLength(6);
  });

  it("writeForm 只写认识的键，并且返回新对象", () => {
    const s = schema();
    const before = initialForm(s);
    const after = writeForm(s, before, { count: 30, 不存在: 1, ratio: 2 });
    expect(after["count"]).toBe("30");
    expect(after["ratio"]).toBe("2");
    expect("不存在" in after).toBe(false);
    expect(before["count"]).toBe("1");
    expect(after).not.toBe(before);
  });
});

describe("hasStart / startSeedOf", () => {
  it("有这一列才算有起点", () => {
    expect(hasStart(schema())).toBe(true);
    expect(hasStart(new InputSchema({ fields: [field({ key: "a" })] }))).toBe(false);
  });

  it("没有 / 空 ⇒ 0 这个哨兵（不是「种子 0」）", () => {
    expect(startSeedOf({})).toBe(0);
    expect(startSeedOf({ [START_KEY]: "" })).toBe(0);
    expect(startSeedOf({ [START_KEY]: null })).toBe(0);
    expect(startSeedOf({ [START_KEY]: "abc" })).toBe(0);
  });

  it("合法的按 32 位无符号取（回绕是特性，不是 bug）", () => {
    expect(startSeedOf({ [START_KEY]: "123456" })).toBe(123456);
    expect(startSeedOf({ [START_KEY]: 4294967295 })).toBe(4294967295);
    expect(startSeedOf({ [START_KEY]: "4294967296" })).toBe(0);
    expect(startSeedOf({ [START_KEY]: "-1" })).toBe(4294967295);
  });
});

describe("issues（schema 级机械约束）", () => {
  it("必填检查排在「None 就跳过」前面", () => {
    const s = new InputSchema({
      fields: [field({ key: "seed", kind: "int", default: null, required: true, label: "起始种子" })],
    });
    const notes = issues(s, { seed: null });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.level).toBe("error");
    expect(notes[0]!.field).toBe("seed");
    expect(notes[0]!.message).toBe("「起始种子」还没填 —— 请先填上再运行");
  });

  it("非必填的空值不报（这个场景就是没有这个字段）", () => {
    const s = new InputSchema({ fields: [field({ key: "a", kind: "int" })] });
    expect(issues(s, { a: null })).toHaveLength(0);
  });

  it("choice 不在候选里要报，并列出候选", () => {
    const s = schema();
    const notes = issues(s, { mode: "乱填的", [START_KEY]: 1 });
    expect(notes.map((n) => n.field)).toEqual(["mode"]);
    expect(notes[0]!.message).toContain("未满 2.5（重算成长）/满 2.5（只重算一次）");
  });

  it("上下限要报，且文案带当前值", () => {
    const s = schema();
    const low = issues(s, { count: 0, ratio: 1.3, mode: "未满 2.5（重算成长）", [START_KEY]: 1 });
    expect(low[0]!.message).toBe("「count」不能小于 1，当前是 0");
    const high = issues(s, { count: 1, ratio: 9, mode: "未满 2.5（重算成长）", [START_KEY]: 1 });
    expect(high[0]!.message).toBe("「ratio」不能大于 3，当前是 9");
  });

  it("不是数字的 int 也要报（比 min/max 更早拦住）", () => {
    const s = new InputSchema({ fields: [field({ key: "n", kind: "int", min: 1 })] });
    expect(issues(s, { n: "abc" })[0]!.message).toBe("「n」必须是数字，当前是「abc」");
  });
});

describe("mergeNotes / firstErrorField", () => {
  it("合并去重、保持首次出现顺序", () => {
    const s = new InputSchema({ fields: [field({ key: "n", kind: "int", min: 5, label: "次数" })] });
    const fromSchema = issues(s, { n: 1 });
    const merged = mergeNotes(fromSchema, fromSchema, issues(s, { n: 2 }));
    expect(merged).toHaveLength(2);
    expect(merged[0]!.message).toContain("不能小于 5");
    expect(merged[1]!.message).toContain("当前是 2");
  });

  it("标红聚焦最靠上那个出错的字段", () => {
    const s = schema();
    const notes = [
      issues(s, { count: 0, ratio: 9, mode: "乱填的", [START_KEY]: 1 }),
    ];
    expect(firstErrorField(s, notes)).toBe("count");
    expect(firstErrorField(s, [[]])).toBeNull();
  });

  it("不是 error 的提示不参与聚焦", () => {
    const s = schema();
    const warning = issues(s, { count: 1, ratio: 1.3, mode: "未满 2.5（重算成长）", [START_KEY]: 1 });
    expect(firstErrorField(s, [warning])).toBeNull();
  });
});

describe("提示文案", () => {
  it("kindLabel / helpOf", () => {
    expect(kindLabel("int")).toBe("整数");
    expect(kindLabel("bool")).toBe("开关");
    expect(helpOf(field({ key: "a", label: "次数", kind: "int" }))).toBe("次数（整数）");
    expect(helpOf(field({ key: "a", label: "次数", help: "1~500" }))).toBe("1~500");
  });
});
