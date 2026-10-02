/**
 * ``web/src/ui/url.ts`` 的守卫（``notes/web-design.md`` §5.8）。
 *
 * 三条规矩各有一组测试，因为它们都能**悄悄毁掉用户手上的链接**，而不是报个错：
 *
 * 1. 缺省值不进 URL（不然链接长得没法看，也没法手改）；
 * 2. 旧链接 / 手改坏的链接**只能降级**（丢掉认不出的项 + 一条 warning），绝不抛错；
 * 3. 回填的值必须过一遍和表单同一套的校验（越界不写进表单）。
 */

import { describe, expect, it } from "vitest";
import { InputField, InputSchema } from "../src/scenarios/scenario";
import type { InputFieldInit } from "../src/scenarios/scenario";
import { collect } from "../src/ui/form";
import {
  VERSION_KEY,
  buildHash,
  decodeParams,
  describeDecode,
  encodeParams,
  formVersion,
  parseHash,
  shareUrl,
} from "../src/ui/url";

function field(init: InputFieldInit & { key: string }): InputField {
  return new InputField(init);
}

function schema(): InputSchema {
  return new InputSchema({
    fields: [
      field({ key: "count", kind: "int", default: 1, min: 1, max: 500, label: "次数" }),
      field({ key: "ratio", kind: "float", default: 1.3, min: 1, max: 3 }),
      field({
        key: "mode",
        kind: "choice",
        default: "未满 2.5（重算成长）",
        choices: ["未满 2.5（重算成长）", "满 2.5（只重算一次）"],
      }),
      field({ key: "note", kind: "text", default: "" }),
      field({ key: "auto", kind: "bool", default: false }),
    ],
  });
}

describe("parseHash", () => {
  it("认 ``#/key?a=1`` / ``#key?a=1`` / 没有参数 / 空 hash", () => {
    const a = parseHash("#/making?a=1&b=2");
    expect(a.key).toBe("making");
    expect(a.params.get("a")).toBe("1");
    expect(a.params.get("b")).toBe("2");

    expect(parseHash("#making?a=1").key).toBe("making");
    expect(parseHash("#/seed-resolve").key).toBe("seed-resolve");
    expect(parseHash("#").key).toBe("");
    expect(parseHash("").key).toBe("");
  });

  it("带连字符的场景 key 不会被切坏", () => {
    const state = parseHash("#/v4-reforge?count=3");
    expect(state.key).toBe("v4-reforge");
    expect(state.params.get("count")).toBe("3");
  });

  it("参数值已经解码（百分号编码的中文直接可用）", () => {
    const state = parseHash("#/x?note=%E4%B8%AD%E6%96%87");
    expect(state.params.get("note")).toBe("中文");
  });

  it("畸形查询串当「没有参数」，不抛", () => {
    expect(() => parseHash("#/x?a=%")).not.toThrow();
  });
});

describe("buildHash", () => {
  it("参数为空时省掉 ``?``", () => {
    expect(buildHash("x", new URLSearchParams())).toBe("#/x");
    expect(buildHash("x", "")).toBe("#/x");
  });

  it("带前导 ``?`` 的字符串也认", () => {
    expect(buildHash("x", "?a=1")).toBe("#/x?a=1");
    expect(buildHash("x", "a=1")).toBe("#/x?a=1");
  });
});

describe("encodeParams", () => {
  const s = schema();

  it("等于默认值的项不写进 URL", () => {
    const params = encodeParams(s, collect(s, {}).inputs, "1.0");
    expect(params.get(VERSION_KEY)).toBe("1.0");
    expect([...params.keys()]).toEqual([VERSION_KEY]);
  });

  it("顺序 = schema.fields 顺序（同一个表单永远编出同一串）", () => {
    const inputs = collect(s, { count: 30, ratio: 2, mode: "满 2.5（只重算一次）", auto: true })
      .inputs;
    const params = encodeParams(s, inputs, "1.0");
    expect([...params.keys()]).toEqual(["count", "ratio", "mode", "auto", VERSION_KEY]);
    expect(params.get("count")).toBe("30");
    expect(params.get("auto")).toBe("1");
  });

  it("bool 编成 1/0，text 空串跳过，null 跳过", () => {
    expect(encodeParams(s, { auto: false }, "").has("auto")).toBe(false); // = 默认值
    expect(encodeParams(s, { auto: false }, "").get("auto")).toBeNull();
    const flipped = encodeParams(s, { auto: true }, "");
    expect(flipped.get("auto")).toBe("1");
    expect(encodeParams(s, { note: "" }, "").has("note")).toBe(false);
    expect(encodeParams(s, { count: null }, "").has("count")).toBe(false);
  });

  it("不写版本号就不带 ``_v``", () => {
    expect(encodeParams(s, { count: 30 }, "").has(VERSION_KEY)).toBe(false);
  });
});

describe("decodeParams", () => {
  const s = schema();

  it("编出来再解回来，值不变（只有非默认值的项）", () => {
    const inputs = collect(s, {
      count: 30,
      ratio: 2,
      mode: "满 2.5（只重算一次）",
      note: "hi there",
      auto: true,
    }).inputs;
    const params = encodeParams(s, inputs, "1.0");
    const back = decodeParams(s, params, "1.0");
    expect(back.notes).toHaveLength(0);
    expect(back.restored).toBe(5);
    expect(back.inputs).toEqual(inputs);
  });

  it("解出来的是**覆盖项**，没写的键不出现（调用方按默认值合并）", () => {
    const params = encodeParams(s, { count: 30 }, "1.0");
    const back = decodeParams(s, params, "1.0");
    expect(Object.keys(back.inputs)).toEqual(["count"]);
    expect(back.inputs).not.toHaveProperty("ratio");
  });

  it("不认识字段 → 忽略 + 一条 warning，其余照常恢复", () => {
    const params = new URLSearchParams("count=30&没有这个字段=1");
    const back = decodeParams(s, params, "");
    expect(back.inputs).toEqual({ count: 30 });
    expect(back.notes).toHaveLength(1);
    expect(back.notes[0]!.level).toBe("warning");
    expect(back.notes[0]!.message).toContain("不认识的字段");
    expect(back.notes[0]!.message).toContain("没有这个字段");
  });

  it("越界值 → 不进表单 + 一条 warning", () => {
    const back = decodeParams(s, new URLSearchParams("count=9999"), "");
    expect(back.inputs).toEqual({});
    expect(back.restored).toBe(0);
    expect(back.notes[0]!.message).toContain("大于上限 500");
  });

  it("选项大小写 / 全角括号折合后仍然恢复成候选表原文", () => {
    const back = decodeParams(s, new URLSearchParams("mode=未满 2.5(重算成长)"), "");
    expect(back.inputs["mode"]).toBe("未满 2.5（重算成长）");
  });

  it("认不出的选项 → 不进表单 + warning", () => {
    const back = decodeParams(s, new URLSearchParams("mode=乱填"), "");
    expect(back.inputs).toEqual({});
    expect(back.notes[0]!.message).toContain("不在候选里");
  });

  it("bool 认 1/0/true/on；乱写就不恢复", () => {
    expect(decodeParams(s, new URLSearchParams("auto=1"), "").inputs["auto"]).toBe(true);
    expect(decodeParams(s, new URLSearchParams("auto=0"), "").inputs["auto"]).toBe(false);
    expect(decodeParams(s, new URLSearchParams("auto=on"), "").inputs["auto"]).toBe(true);
    const bad = decodeParams(s, new URLSearchParams("auto=也许"), "");
    expect(bad.inputs).toEqual({});
    expect(bad.notes[0]!.message).toContain("不是布尔值");
  });

  it("没有 ``_v`` 就不校验版本（手写的链接照样能用）", () => {
    const back = decodeParams(s, new URLSearchParams("count=30"), "1.0");
    expect(back.inputs).toEqual({ count: 30 });
    expect(back.notes).toHaveLength(0);
  });

  it("``_v`` 对不上：仍然恢复能对上的字段，只多一条 warning —— 绝不抛错", () => {
    const back = decodeParams(s, new URLSearchParams("count=30&_v=0.9"), "1.0");
    expect(back.inputs).toEqual({ count: 30 });
    expect(back.notes).toHaveLength(1);
    expect(back.notes[0]!.message).toContain("表单版本 0.9");
    expect(back.notes[0]!.message).toContain("只恢复了能对上的字段");
  });

  it("提示条数封顶（手改坏的链接不该刷屏）", () => {
    const query = new URLSearchParams();
    for (let i = 0; i < 20; i += 1) query.set(`坏字段${i}`, "1");
    expect(decodeParams(s, query, "").notes.length).toBeLessThanOrEqual(5);
  });
});

describe("formVersion", () => {
  it("用场景自己的版本；空串回落 1.0", () => {
    expect(formVersion({ version: "2.1" })).toBe("2.1");
    expect(formVersion({ version: "" })).toBe("1.0");
  });
});

describe("shareUrl", () => {
  const s = schema();

  it("整段换掉 hash，其它部分（含子路径部署）原样保留", () => {
    const url = shareUrl(
      "https://example.test/rngCalc/index.html#/old?x=1",
      "strength",
      s,
      collect(s, { count: 30 }).inputs,
      "1.0",
    );
    expect(url.startsWith("https://example.test/rngCalc/index.html#/strength?")).toBe(true);
    expect(url).toContain("count=30");
    expect(url).toContain(`${VERSION_KEY}=1.0`);
    expect(url).not.toContain("/old");
  });

  it("全是默认值 ⇒ 只剩 ``_v``", () => {
    const url = shareUrl("https://example.test/a.html", "v4-reforge", s, collect(s, {}).inputs, "1.0");
    expect(url).toBe(`https://example.test/a.html#/v4-reforge?${VERSION_KEY}=1.0`);
  });
});

describe("describeDecode", () => {
  it("给界面一行摘要", () => {
    const s = schema();
    const back = decodeParams(s, new URLSearchParams("count=30&乱=1"), "");
    expect(describeDecode(back)).toContain("恢复 1 项");
    expect(describeDecode(back)).toContain("warning 1");
  });
});
