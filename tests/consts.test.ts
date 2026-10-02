/**
 * ``web/src/data/consts.json`` 的形状与基准值校验。
 *
 * 这份 JSON 由 ``src_forge/const/*.py`` 生成（**不是**手写的），提交进仓库供 TS 侧
 * 静态 import。本测试是它的「类型断言是真的」那一半 —— ``consts.ts`` 里的
 * ``as ConstsFile`` 只是告诉编译器「相信我」，这里才真去逐条看：
 *
 * 1. 顶层键集与 ``schema_version``；
 * 2. 每张表的**结构不变式**（区间 ``lo <= hi``、属性名都属于 ``attrs.order``、
 *    ``equipment_names`` 与 ``equipment`` 的键集一致…）；
 * 3. 若干**基准值**（预设表顺序、掩码常量…）；
 * 4. 与手写常量 ``core/values.ts`` 的**交叉校验** —— 同一语义两个来源，必须对齐。
 *
 * 另一半守卫在 Python 侧 ``src_forge/tests/test_export_json.py``（逐字节比对，
 * 防止「改了 ``const/*.py`` 忘了重新导出」）。
 */

import { describe, expect, it } from "vitest";
import { CONSTS, CONSTS_SCHEMA_VERSION, isRangePair } from "../src/data/consts";
import { BOSS_MASK, WUXING_DOUBLE_AT, WUXING_HAS } from "../src/core/values";

describe("consts.json 顶层结构", () => {
  it("顶层键集固定（多一个少一个都要改这里和 consts.ts）", () => {
    expect(Object.keys(CONSTS).sort()).toEqual([
      "attrs",
      "equipment",
      "equipment_attr_order",
      "equipment_name_order",
      "equipment_names",
      "gems",
      "pets",
      "quality",
      "resolution",
      "schema_version",
      "stars",
      "strength",
      "wuxing",
    ]);
  });

  it("schema_version 与 TS 侧的守卫一致", () => {
    expect(CONSTS.schema_version).toBe(CONSTS_SCHEMA_VERSION);
    expect(CONSTS_SCHEMA_VERSION).toBe(3);
  });
});

describe("attrs（属性分解表的元信息）", () => {
  it("10 个可滚属性", () => {
    expect(CONSTS.attrs.common).toEqual([
      "生命",
      "魔法",
      "攻击",
      "防御",
      "暴击",
      "闪避",
      "回血",
      "回魔",
      "魔抗",
      "成长",
    ]);
  });

  it("order = 品质 + 10 属性 + 五行（游戏的计算顺序）", () => {
    expect(CONSTS.attrs.order).toEqual(["品质", ...CONSTS.attrs.common, "五行"]);
  });

  it("with_none = 无 + 10 属性（UI 下拉框用）", () => {
    expect(CONSTS.attrs.with_none).toEqual(["无", ...CONSTS.attrs.common]);
  });

  it("只有「成长」有 1 位小数，其余全整数", () => {
    expect(CONSTS.attrs.precision).toEqual({
      生命: 0,
      魔法: 0,
      攻击: 0,
      防御: 0,
      暴击: 0,
      闪避: 0,
      回血: 0,
      回魔: 0,
      魔抗: 0,
      成长: 1,
    });
  });

  it("品质 / 五行的属性名", () => {
    expect(CONSTS.attrs.quality_attr).toBe("品质");
    expect(CONSTS.attrs.wuxing_attr).toBe("五行");
  });

  it("宝石种类 = 无 + 宝石表的 4 个键", () => {
    expect(CONSTS.attrs.gem_kinds).toEqual(["无", "三级宝石", "二级宝石", "一级宝石", "灵珠"]);
    expect([...CONSTS.attrs.gem_kinds].slice(1).sort()).toEqual(
      Object.keys(CONSTS.gems).sort(),
    );
  });
});

describe("quality（品质）", () => {
  it("names / order / colors 的键集一致；ui_colors 多一个旧 UI 的死配置「粗糙」", () => {
    const named = CONSTS.quality.names.slice().sort();
    expect(named).toHaveLength(7);
    expect(Object.keys(CONSTS.quality.order).sort()).toEqual(named);
    expect(Object.keys(CONSTS.quality.colors).sort()).toEqual(named);
    // UI_QUALITY_COLORS 是**旧 tkinter** 自己硬编码的一份，含游戏里根本不存在的「粗糙」。
    expect(Object.keys(CONSTS.quality.ui_colors).sort()).toEqual([...named, "粗糙"].sort());
  });

  it("order 是 0..6 的一个排列", () => {
    expect(Object.values(CONSTS.quality.order).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("游戏色是整数、UI 色是 #RRGGBB（旧配置里的「邪灵」写的是 CSS 名 red）", () => {
    for (const value of Object.values(CONSTS.quality.colors)) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    for (const [name, value] of Object.entries(CONSTS.quality.ui_colors)) {
      if (value === "red") {
        expect(name).toBe("邪灵");
        continue;
      }
      expect(value, name).toMatch(/^#[0-9A-F]{6}$/);
    }
    expect(CONSTS.quality.fallback_color).toBe(0xffffff);
  });
});

describe("wuxing（五行）与 core/values.ts 交叉校验", () => {
  it("5 个五行，位序是 0..4 的一个排列", () => {
    expect(CONSTS.wuxing.names).toHaveLength(5);
    expect(Object.keys(CONSTS.wuxing.bits).sort()).toEqual(CONSTS.wuxing.names.slice().sort());
    expect(Object.values(CONSTS.wuxing.bits).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it("has / all 与 values.ts 对齐", () => {
    expect(CONSTS.wuxing.has).toBe(WUXING_HAS);
    expect(CONSTS.wuxing.has).toBe(0b100000);
    expect(CONSTS.wuxing.all).toBe(0b111111);
  });

  it("NEXT_WUXING 是 5×4：每行 = 其余四个下标、升序", () => {
    expect(CONSTS.wuxing.next).toHaveLength(5);
    CONSTS.wuxing.next.forEach((row, i) => {
      expect(row).toHaveLength(4);
      expect(row).not.toContain(i);
      expect(row.slice().sort((a, b) => a - b)).toEqual(row);
      expect(row.slice().sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4].filter((v) => v !== i));
    });
  });

  it("浮点门限 = 0.91，整数门限 = floor(0.91 × 2³¹)", () => {
    expect(CONSTS.wuxing.double_at).toBe(0.91);
    expect(WUXING_DOUBLE_AT).toBe(Math.floor(CONSTS.wuxing.double_at * 2 ** 31));
  });
});

describe("strength（强化）", () => {
  it("基准值", () => {
    expect(CONSTS.strength).toEqual({
      allpro: [1, 0.375, 0.09, 0.02, 0.0058, 0, 0, 0, 0],
      click_offset: 3,
      lead_fastnext: 4,
      max_level: 7,
      near_limit: 9999,
      prob_max: 1,
      stone_grades: ["一", "二", "三", "四"],
      tail_fastnext: 2,
    });
  });
});

describe("stars（七星）", () => {
  it("预设表是**有序列表**，顺序就是 UI 下拉框的顺序", () => {
    expect(CONSTS.stars.presets).toEqual([
      { name: "斗部群星", mode: "dbqx", minimum: 0, span: 3, random_pos: 3, step: 3 },
      { name: "还童丹-四围固定", mode: "round", minimum: 0, span: 100, random_pos: 1, step: 5 },
      { name: "还童丹-四围浮动", mode: "round", minimum: 0, span: 100, random_pos: 1, step: 9 },
      { name: "宠物铠甲强化", mode: "round", minimum: 1, span: 4, random_pos: 1, step: 6 },
      { name: "保存游戏", mode: "raw", minimum: 0, span: 0x7fffffff, random_pos: 2, step: 2 },
    ]);
  });

  it("默认预设 = 第一个；「保存游戏」= 最后一个", () => {
    expect(CONSTS.stars.default_preset).toBe(CONSTS.stars.presets[0]?.name);
    expect(CONSTS.stars.default_preset).toBe("斗部群星");
    expect(CONSTS.stars.save_game_preset).toBe("保存游戏");
    expect(CONSTS.stars.presets.at(-1)?.name).toBe(CONSTS.stars.save_game_preset);
  });

  it("模式名与可枚举模式", () => {
    expect(CONSTS.stars.modes).toEqual({
      dbqx: "dbqx",
      round: "round",
      truncation: "t",
      raw: "raw",
    });
    expect(CONSTS.stars.enum_modes).toEqual(["dbqx", "round", "t"]);
    // raw（保存游戏）不能枚举 —— 空间是 2³¹。
    expect(CONSTS.stars.enum_modes).not.toContain(CONSTS.stars.modes["raw"]);
  });

  it("斗部群星 boss 表", () => {
    expect(CONSTS.stars.boss_by_index).toEqual(["翁", "猿", "车", "官"]);
  });

  it("掩码 / 步长 / 换算常量（与 values.ts 交叉校验）", () => {
    expect(CONSTS.stars.fastcrack_imask).toBe(0x60000000);
    expect(CONSTS.stars.fastcrack_imask).toBe(BOSS_MASK);
    expect(CONSTS.stars.dbqx_value_step).toBe(0x20000000);
    expect(CONSTS.stars.max_constraints).toBe(31);
    expect(CONSTS.stars.crack2_max_span).toBe(20);
    expect(CONSTS.stars.save_game_scale).toBe(100_000);
    expect(CONSTS.stars.save_game_half).toBe(0x80000000);
    expect(CONSTS.stars.distance_limit).toBe(9_999_999);
  });
});

describe("resolution（装备分解产出表）", () => {
  it("仓库里没有数据，所以是空表且 ready=false", () => {
    expect(CONSTS.resolution.ready).toBe(false);
    expect(CONSTS.resolution.table).toEqual({});
  });
});

describe("equipment（装备表）", () => {
  const CATEGORIES = [
    "accessories",
    "armors",
    "drops",
    "fusion-A",
    "fusion-B",
    "fusion-C",
    "fusion-tjbg",
    "task-yanma",
    "unsupported",
    "v4-reforge",
    "weapons",
  ];

  it("分类集固定，装备总数 83", () => {
    expect(Object.keys(CONSTS.equipment_names).sort()).toEqual(CATEGORIES);
    expect(Object.keys(CONSTS.equipment).sort()).toEqual(CATEGORIES);
    const total = Object.values(CONSTS.equipment_names).reduce((sum, names) => sum + names.length, 0);
    expect(total).toBe(83);
  });

  it("每个分类的名字都非空（除 unsupported）且已排序、无重复", () => {
    for (const [category, names] of Object.entries(CONSTS.equipment_names)) {
      expect(names.slice().sort(), category).toEqual(names);
      expect(new Set(names).size, category).toBe(names.length);
      if (category !== "unsupported") expect(names.length, category).toBeGreaterThan(0);
    }
    expect(CONSTS.equipment_names["weapons"]).toHaveLength(20);
    expect(CONSTS.equipment_names["armors"]).toHaveLength(14);
    expect(CONSTS.equipment_names["drops"]).toHaveLength(29);
    expect(CONSTS.equipment_names["unsupported"]).toHaveLength(0);
  });

  it("equipment 与 equipment_names 的键集逐分类一致", () => {
    for (const [category, names] of Object.entries(CONSTS.equipment_names)) {
      expect(Object.keys(CONSTS.equipment[category] ?? {}).sort(), category).toEqual(names.slice().sort());
    }
  });

  it("equipment_name_order 是无重复的全集，且**不**等于排序后的样子", () => {
    expect(Object.keys(CONSTS.equipment_name_order).sort()).toEqual(CATEGORIES);
    let sourceSorted = 0;
    for (const [category, names] of Object.entries(CONSTS.equipment_name_order)) {
      expect(new Set(names).size, category).toBe(names.length);
      expect(names.slice().sort(), category).toEqual(CONSTS.equipment_names[category]?.slice().sort());
      // unsupported 是空的，不参与「顺序不同于排序」的比较
      if (names.length > 1 && names.join("\u0000") === names.slice().sort().join("\u0000")) {
        sourceSorted += 1;
      }
    }
    // 这条是「源顺序不是排序顺序」的**哨兵**：真出现「恰好全已排序」说明
    // 生成器退化了（例如改回了 sorted()），那时装备属性顺序也会一起丢。
    expect(sourceSorted).toBeLessThan(Object.keys(CONSTS.equipment_name_order).length - 1);
    // 基准值：weapons 的源顺序第一件就是 schema 默认值 ``weapons/尾火棍``
    expect(CONSTS.equipment_name_order["weapons"]?.[0]).toBe("尾火棍");
    expect(CONSTS.equipment_name_order["weapons"]).not.toEqual(
      CONSTS.equipment_names["weapons"],
    );
  });

  it("equipment_attr_order 逐物品覆盖，且**保持源顺序**（天残 = 品质/魔法/攻击）", () => {
    expect(Object.keys(CONSTS.equipment_attr_order).sort()).toEqual(CATEGORIES);
    for (const [category, names] of Object.entries(CONSTS.equipment_name_order)) {
      const table = CONSTS.equipment_attr_order[category] ?? {};
      expect(Object.keys(table).sort(), category).toEqual(names.slice().sort());
      for (const name of names) {
        const order = table[name];
        expect(order, `${category}/${name}`).toBeDefined();
        expect(new Set(order).size, `${category}/${name}`).toBe(order?.length);
        // 与 equipment 的键集一致（只是顺序不同）
        expect(
          (order ?? []).slice().sort(),
          `${category}/${name}`,
        ).toEqual(Object.keys(CONSTS.equipment[category]?.[name] ?? {}).sort());
      }
    }
    // 天残：源顺序「品质, 魔法, 攻击」；按码点排会变成「攻击, 魔法」
    expect(CONSTS.equipment_attr_order["weapons"]?.["天残"]).toEqual(["品质", "魔法", "攻击"]);
    expect(CONSTS.equipment_attr_order["weapons"]?.["尾火棍"]).toEqual(["品质", "攻击"]);
    expect(CONSTS.equipment_attr_order["weapons"]?.["银弹金弓"]).toEqual([
      "品质",
      "攻击",
      "暴击",
      "回魔",
    ]);
  });

  it("属性名都在 attrs.order 里；区间 lo <= hi；字符串值都是合法品质", () => {
    const allowed = new Set(CONSTS.attrs.order);
    const qualities = new Set(CONSTS.quality.names);
    const missingQuality: string[] = [];
    let values = 0;
    for (const [category, items] of Object.entries(CONSTS.equipment)) {
      for (const [name, attrs] of Object.entries(items)) {
        const where = `${category}/${name}`;
        // 「品质」**允许缺失** —— 游戏脚本里有 4 件装备没写（2 个 drops、1 个 fusion-B、1 个 v4-reforge）。
        const quality = attrs["品质"];
        if (quality === undefined) {
          missingQuality.push(where);
        } else {
          expect(typeof quality, where).toBe("string");
          expect(qualities.has(String(quality)), where).toBe(true);
        }
        for (const [attr, value] of Object.entries(attrs)) {
          values += 1;
          expect(allowed.has(attr), `${where} 的属性 ${attr}`).toBe(true);
          if (isRangePair(value)) {
            expect(value, `${where}/${attr}`).toHaveLength(2);
            expect(value[0]).toBeTypeOf("number");
            expect(value[1]).toBeTypeOf("number");
            expect(value[0], `${where}/${attr}`).toBeLessThanOrEqual(value[1]);
          } else if (typeof value === "string") {
            expect(qualities.has(value), `${where}/${attr}=${value}`).toBe(true);
          } else {
            expect(Number.isFinite(value), `${where}/${attr}`).toBe(true);
          }
        }
      }
    }
    expect(values).toBe(307);
    expect(missingQuality).toHaveLength(4);
  });
});

describe("gems（宝石）", () => {
  it("4 种宝石，属性都在 10 个可滚属性里，区间合法", () => {
    expect(Object.keys(CONSTS.gems).sort()).toEqual(["一级宝石", "三级宝石", "二级宝石", "灵珠"]);
    const common = new Set(CONSTS.attrs.common);
    for (const [gem, table] of Object.entries(CONSTS.gems)) {
      expect(Object.keys(table).length, gem).toBeGreaterThan(0);
      for (const [attr, pair] of Object.entries(table)) {
        expect(common.has(attr), `${gem}/${attr}`).toBe(true);
        expect(pair, `${gem}/${attr}`).toHaveLength(2);
        expect(pair[0], `${gem}/${attr}`).toBeLessThanOrEqual(pair[1]);
        expect(pair[1], `${gem}/${attr}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("pets（宠物）", () => {
  it("14 条记录，字段集固定", () => {
    expect(Object.keys(CONSTS.pets)).toHaveLength(14);
    for (const [name, record] of Object.entries(CONSTS.pets)) {
      expect(Object.keys(record).sort(), name).toEqual(
        ["资质范围", "基础属性范围", "基础属性随机", "成功率"].sort(),
      );
      expect(typeof record.基础属性随机, name).toBe("boolean");
      expect(typeof record.成功率, name).toBe("number");
      expect(record.成功率, name).toBeGreaterThan(0);
      expect(record.成功率, name).toBeLessThanOrEqual(1);
    }
  });

  it("资质范围非空且只含「生命/魔法/攻击/防御」，区间合法", () => {
    const common = new Set(CONSTS.attrs.common);
    for (const [name, record] of Object.entries(CONSTS.pets)) {
      const ranges = record.资质范围;
      expect(Object.keys(ranges).length, name).toBeGreaterThan(0);
      for (const [attr, pair] of Object.entries(ranges)) {
        expect(common.has(attr), `${name}/${attr}`).toBe(true);
        expect(pair, `${name}/${attr}`).toHaveLength(2);
        expect(pair[0], `${name}/${attr}`).toBeLessThanOrEqual(pair[1]);
      }
      if (record.基础属性范围 !== null) {
        for (const [attr, pair] of Object.entries(record.基础属性范围)) {
          expect(common.has(attr), `${name}/基础/${attr}`).toBe(true);
          expect(pair[0], `${name}/基础/${attr}`).toBeLessThanOrEqual(pair[1]);
        }
      }
    }
  });
});
