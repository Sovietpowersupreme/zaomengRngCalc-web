/**
 * ``web/src/ui/result.ts`` 的守卫（``notes/web-design.md`` §5.4）。
 *
 * 取数规则全部对应 ``src_forge/app/ui/result.py``，其中两条是**用户直接看得到**的
 * 硬格式，写歪了就是肉眼可见的错：
 *
 * * 种子序列 ``(11,22,33)`` —— 圆括号、逗号、**不加空格**；
 * * 属性预览只认那 12 个属性名（``PREVIEW_ORDER``），认不出就原样显示，
 *   **绝不**把别的场景的自由文本硬拆成属性表。
 */

import { describe, expect, it } from "vitest";
import { Note, Outcome } from "../src/scenarios/scenario";
import {
  INLINE_SEEDS,
  LEVEL_LABEL,
  NOTES_EMPTY,
  PREVIEW_EMPTY,
  PREVIEW_ORDER,
  ROWS,
  SEED_EMPTY,
  conclusionOf,
  detailJson,
  formatSeeds,
  noteLines,
  parseLiteralDict,
  previewLines,
  previewView,
  seedBarText,
  seedListLines,
  seedText,
  tableRows,
} from "../src/ui/result";

function outcome(init: ConstructorParameters<typeof Outcome>[0] = {}): Outcome {
  return new Outcome(init);
}

describe("formatSeeds / seedText", () => {
  it("圆括号 + 逗号，不加空格", () => {
    expect(formatSeeds([11, 22, 33])).toBe("(11,22,33)");
    expect(formatSeeds([])).toBe("()");
    expect(formatSeeds([7])).toBe("(7)");
  });

  it("内联只摆前 8 个 + 计数", () => {
    expect(INLINE_SEEDS).toBe(8);
    const [text, hidden] = seedText([1, 2, 3]);
    expect(text).toBe("(1,2,3)");
    expect(hidden).toBe(0);

    const many = Array.from({ length: 10 }, (_, i) => i + 1);
    const [short, hidden2] = seedText(many);
    expect(short).toBe("(1,2,3,4,5,6,7,8,…)");
    expect(hidden2).toBe(2);
  });

  it("limit 为 0 时只剩省略号", () => {
    expect(seedText([1, 2], 0)).toEqual(["(…)", 2]);
  });

  it("种子条：没有候选返回 null（界面显示 SEED_EMPTY）", () => {
    expect(seedBarText([])).toBeNull();
    expect(seedBarText([5])).toBe("(5)");
    expect(SEED_EMPTY).toContain("没有候选列表");
  });
});

describe("seedListLines（弹层里的全量列表）", () => {
  it("只在逗号处折行，拼回来等于原序列", () => {
    const seeds = Array.from({ length: 400 }, (_, i) => 1000000000 + i);
    const lines = seedListLines(seeds);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(0, -1)) {
      expect(line.length).toBeLessThanOrEqual(73);
      expect(line.endsWith(",")).toBe(true);
    }
    expect(lines[lines.length - 1]!.endsWith(",")).toBe(false);
    const flat = lines
      .join("")
      .split(",")
      .filter((s) => s !== "")
      .map(Number);
    expect(flat).toEqual(seeds);
  });

  it("空序列给空数组", () => {
    expect(seedListLines([])).toEqual([]);
  });
});

describe("parseLiteralDict（Python str(dict) 那种写法）", () => {
  it("单引号键 / 数字值", () => {
    expect(parseLiteralDict("{'暴击':7}")).toEqual({ 暴击: 7 });
  });

  it("混合类型与裸标识符键", () => {
    expect(parseLiteralDict("{五行: '金', 成长: 0.8, 满: True, 空: None}")).toEqual({
      五行: "金",
      成长: 0.8,
      满: true,
      空: null,
    });
  });

  it("嵌套结构不猜（返回 null，交给调用方原样显示）", () => {
    expect(parseLiteralDict("{'a':{'b':1}}")).toBeNull();
    expect(parseLiteralDict("{'a':[1,2]}")).toBeNull();
    expect(parseLiteralDict("不是字典")).toBeNull();
  });

  it("空字典", () => {
    expect(parseLiteralDict("{}")).toEqual({});
  });
});

describe("previewLines", () => {
  it("按 PREVIEW_ORDER 排序，成长保留一位小数", () => {
    const lines = previewLines({ 暴击: 7, 五行: "金", 成长: 0.8000000000000001 });
    expect(lines).toEqual(["五行：金", "成长：0.8", "暴击：7"]);
  });

  it("长得像 dict 的字符串也算", () => {
    expect(previewLines("{'暴击':7,'五行':'金'}")).toEqual(["五行：金", "暴击：7"]);
  });

  it("只要有一个键不在那 12 个里就整段放弃（返回 null）", () => {
    expect(previewLines({ 五行: "金", 不知道的属性: 1 })).toBeNull();
    expect(PREVIEW_ORDER).toHaveLength(12);
  });

  it("空字典 / 自由文本 / 数字都不算属性表", () => {
    expect(previewLines({})).toBeNull();
    expect(previewLines("连点器: -\n当前种子: -")).toBeNull();
    expect(previewLines("-340693954")).toBeNull();
    expect(previewLines("")).toBeNull();
  });
});

describe("conclusionOf", () => {
  it("三条结论文案（用户看的是一整句）", () => {
    expect(conclusionOf({ kind: "idle" }).text).toBe("还没有结果");
    expect(conclusionOf({ kind: "failed", message: "炸了" })).toEqual({
      text: "计算失败",
      danger: true,
    });
    const miss = conclusionOf({ kind: "done", outcome: outcome({}) });
    expect(miss).toEqual({ text: "没有找到种子", danger: true });

    const one = conclusionOf(
      { kind: "done", outcome: outcome({ seed: 123, needConsume: 45 }) },
    );
    expect(one.text).toBe("找到种子 123（需消耗 45）");
    expect(one.danger).toBe(false);

    const many = conclusionOf({
      kind: "done",
      outcome: outcome({ seed: 123, needConsume: 45, seeds: [9, 8, 7] }),
    });
    expect(many.text).toBe("找到 3 个种子（最近 123，需消耗 45）");
  });

  it("只有一个候选也算「找到种子」（不是「找到 1 个种子」）", () => {
    const one = conclusionOf({ kind: "done", outcome: outcome({ seed: 5, seeds: [5] }) });
    expect(one.text).toBe("找到种子 5（需消耗 0）");
  });

  it("「当前」口径（种子搜索器）报的是 seedAfter，不是命中种子", () => {
    const one = conclusionOf(
      { kind: "done", outcome: outcome({ seed: 111, seedAfter: 222, needConsume: 7 }) },
      "current",
    );
    expect(one).toEqual({ text: "当前种子 222", danger: false });

    const miss = conclusionOf({ kind: "done", outcome: outcome({}) }, "current");
    expect(miss).toEqual({ text: "没有找到种子", danger: true });
  });

  it("「当前」口径下多解：不冒充当前种子", () => {
    const many = conclusionOf(
      { kind: "done", outcome: outcome({ seed: 123, seedAfter: 222, seeds: [9, 8, 7] }) },
      "current",
    );
    expect(many).toEqual({
      text: "找到 3 个候选种子（不唯一，无法确定当前种子）",
      danger: false,
    });
  });

  it("「距离」口径（种子恢复）仍是旧文案", () => {
    const one = conclusionOf(
      { kind: "done", outcome: outcome({ seed: 228116770, distance: 0, needConsume: -1 }) },
      "distance",
    );
    expect(one).toEqual({ text: "找到种子 228116770（距离 0）", danger: false });

    const many = conclusionOf(
      { kind: "done", outcome: outcome({ seed: 123, distance: 0, seeds: [9, 8, 7] }) },
      "distance",
    );
    expect(many.text).toBe("找到 3 个种子（最近 123，距离 0）");
  });
});

describe("tableRows", () => {
  it("行顺序就是 ROWS，空值显示成 ——", () => {
    const rows = tableRows(outcome({ seed: 1, distance: 2, needConsume: 1, consume: 3, seedAfter: 4 }));
    expect(rows.map((r) => r.label)).toEqual([
      "命中种子",
      "'当前'种子",
      "距离",
      "需消耗",
      "游戏消耗",
      "结果数",
      "后端",
      "宝石排列",
    ]);
    expect(ROWS).toHaveLength(8);
    expect(rows[5]!.value).toBe("0"); // 结果数 = seeds.length，0 就显示 0
    expect(rows[6]!.value).toBe("—"); // backend 为空
    expect(rows[7]!.value).toBe("—"); // permutation 为空
  });

  it("showConsumption = false 藏掉距离/需消耗/游戏消耗三行", () => {
    const rows = tableRows(
      outcome({ seed: 1, distance: 2, needConsume: 1, consume: 3, seedAfter: 4 }),
      false,
    );
    expect(rows.map((r) => r.label)).toEqual([
      "命中种子",
      "'当前'种子",
      "结果数",
      "后端",
      "宝石排列",
    ]);
  });

  it("截断 / 并行无序各追加一行", () => {
    const rows = tableRows(outcome({ seed: 1, truncated: true, unordered: true }));
    expect(rows.slice(-2)).toEqual([
      { label: "结果", value: "已截断（只保留了一部分）" },
      { label: "顺序", value: "并行搜索，结果无序" },
    ]);
  });
});

describe("previewView", () => {
  it("有命中但不提供预览 → 灰字说明", () => {
    expect(previewView(outcome({ seed: 1 }))).toEqual({ kind: "empty" });
    expect(PREVIEW_EMPTY).toContain("不提供属性预览");
  });

  it("没有命中 → 空着", () => {
    expect(previewView(outcome({}))).toEqual({ kind: "blank" });
  });

  it("属性表拆成一行一个；自由文本原样等宽显示", () => {
    expect(previewView(outcome({ seed: 1, preview: "{'五行':'金'}" }))).toEqual({
      kind: "table",
      lines: ["五行：金"],
    });
    expect(previewView(outcome({ seed: 1, preview: "连点器: -\n当前种子: -" }))).toEqual({
      kind: "raw",
      text: "连点器: -\n当前种子: -",
    });
  });
});

describe("noteLines", () => {
  it("前缀是 [提示|警告|错误](字段) ", () => {
    expect(LEVEL_LABEL).toEqual({ info: "提示", warning: "警告", error: "错误" });
    const lines = noteLines([
      new Note({ level: "warning", message: "有点慢", field: "auto_upshift" }),
      new Note({ level: "error", message: "填错了" }),
    ]);
    expect(lines[0]).toEqual({
      prefix: "[警告](auto_upshift) ",
      message: "有点慢",
      level: "warning",
    });
    expect(lines[1]!.prefix).toBe("[错误] ");
    expect(NOTES_EMPTY).toContain("没有额外提示");
  });
});

describe("detailJson", () => {
  it("就是 outcome.toDict() 的缩进 JSON，能和对象对上", () => {
    const item = outcome({
      seed: 12,
      distance: 3,
      preview: "当前种子: 3",
      notes: [new Note({ level: "warning", message: "注意" })],
    });
    const parsed = JSON.parse(detailJson(item)) as Record<string, unknown>;
    expect(parsed["seed"]).toBe(12);
    expect(parsed["distance"]).toBe(3);
    expect(parsed["need_consume"]).toBe(0);
    expect(parsed["preview"]).toBe("当前种子: 3");
    expect(parsed["notes"]).toEqual([{ level: "warning", message: "注意", field: "" }]);
    expect(detailJson(item)).toContain("\n  ");
  });
});
