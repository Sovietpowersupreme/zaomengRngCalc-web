/**
 * ``web/src/scenarios/*`` 的对拍测试。
 *
 * 夹具 ``fixtures/scenarios.json`` 由 **Python 侧**生成
 * （``web/tools/make_scenario_fixtures.py``，数据源 = ``registry.describe_all()``），
 * 所以这里比的是「TS 场景的 ``describe()`` 是否与 Python 逐字段一致」——
 * 也就是**表单契约**的一致性（字段顺序、``label``、``help``、上下限、``inline``…）。
 *
 * 本文件分两层：
 *
 * 1. **夹具自身的结构与基准锚点** —— 与 TS 代码无关，今天就能跑，钉住
 *    「Python 给出来的到底是什么」；
 * 2. **TS 实现回放** —— 遍历注册表里**已落地**的场景，逐字段对拍。
 *    ``20b`` 是分步移植：还没落地的 key 在 :func:`missingKeys` 里，
 *    每落地一个场景，第 2 层就自动多覆盖一个（不需要改这个文件）。
 */

import { describe, expect, it } from "vitest";
import fixture from "./fixtures/scenarios.json";
// 副作用导入：只有 ``scenarios/index`` 里登记过的场景才算「已落地」。
import "../src/scenarios/index";
import { BUILTIN_ORDER, describeAll, getScenario, missingKeys, registeredKeys } from "../src/scenarios/registry";
import { ScenarioError } from "../src/scenarios/scenario";

interface FieldDict {
  key: string;
  label: string;
  kind: string;
  default: unknown;
  min: number | null;
  max: number | null;
  choices: string[];
  help: string;
  group: string;
  width: number;
  inline: boolean;
  toolbar: boolean;
  required: boolean;
}

interface SchemaDict {
  title: string;
  hint: string;
  fields: FieldDict[];
  headers: Record<string, string[]>;
}

interface Entry {
  key: string;
  label: string;
  version: string;
  hint: string;
  spec_kind: string;
  supports_near: boolean;
  near_limit: number;
  slice_bounds: number[] | null;
  schema: SchemaDict;
}

interface Fixture {
  schema: number;
  generator: string;
  order: string[];
  count: number;
  scenarios: Entry[];
}

const FIXTURE = fixture as unknown as Fixture;
const byKey = new Map(FIXTURE.scenarios.map((s) => [s.key, s]));

/** Python ``FieldKind`` 的 5 个取值。**注意 ``"float"`` 全程只出现在 ``fusion.bagua``**。 */
const FIELD_KINDS = ["int", "float", "text", "choice", "bool"];

/** ``"float"`` 在夹具里的全部出现处（强探针：变多说明机制变了）。 */
const FLOAT_FIELDS = ["fusion.bagua"];

/** Python 侧出现过的 ``spec.kind``（比 ``core/spec.ts`` 的 5 种多一个 ``growth-wuxing``）。 */
const SPEC_KINDS = ["interval", "mask", "roll", "wuxing", "pool", "growth-wuxing"];

const MAKING_KEYS = [
  "item",
  "gem1_kind",
  "gem1_attr",
  "gem2_kind",
  "gem2_attr",
  "gem3_kind",
  "gem3_attr",
  // 属性表：10 项，键名是中文属性名后缀（``target_生命`` … ``target_成长``）
  ...["生命", "魔法", "攻击", "防御", "暴击", "闪避", "回血", "回魔", "魔抗", "成长"].map((a) => `target_${a}`),
  "start_seed",
  "full_search",
  "limit",
];

const GEM_KINDS = ["无", "三级宝石", "二级宝石", "一级宝石", "灵珠"];
const GEM_ATTRS = ["无", "生命", "魔法", "攻击", "防御", "暴击", "闪避", "回血", "回魔", "魔抗", "成长"];

describe("夹具 scenarios.json 元信息", () => {
  it("schema / generator / count", () => {
    expect(FIXTURE.schema).toBe(1);
    expect(FIXTURE.generator).toBe("web/tools/make_scenario_fixtures.py");
    expect(FIXTURE.count).toBe(BUILTIN_ORDER.length);
    expect(FIXTURE.scenarios).toHaveLength(BUILTIN_ORDER.length);
  });

  it("order 就是 UI 标签页顺序（= registry.BUILTIN_ORDER）", () => {
    expect(FIXTURE.order).toEqual([...BUILTIN_ORDER]);
    expect(FIXTURE.scenarios.map((s) => s.key)).toEqual(FIXTURE.order);
    expect(byKey.size).toBe(BUILTIN_ORDER.length);
  });

  it("每个场景都有 label / hint / 版本号", () => {
    for (const entry of FIXTURE.scenarios) {
      expect(entry.label, entry.key).not.toBe("");
      expect(entry.hint, entry.key).not.toBe("");
      expect(entry.version, entry.key).toMatch(/^\d+\.\d+$/);
    }
  });
});

describe("场景表单契约自洽（不依赖 TS 实现）", () => {
  it("spec_kind / supports_near / near_limit / slice_bounds", () => {
    for (const entry of FIXTURE.scenarios) {
      expect(SPEC_KINDS, entry.key).toContain(entry.spec_kind);
      expect(typeof entry.supports_near, entry.key).toBe("boolean");
      expect(entry.supports_near, entry.key).toBe(true);
      expect(entry.near_limit, entry.key).toBeGreaterThan(0);
      // 目前没有场景限制「枚举」的范围（``slice_bounds`` 全是 None）。
      expect(entry.slice_bounds, entry.key).toBeNull();
    }
  });

  it("字段：key 唯一、非空、kind 合法、choice 必有 choices", () => {
    const floatFields: string[] = [];
    const toolbarFields: string[] = [];
    for (const entry of FIXTURE.scenarios) {
      const { fields } = entry.schema;
      expect(fields.length, entry.key).toBeGreaterThan(0);
      const keys = fields.map((f) => f.key);
      expect(new Set(keys).size, entry.key).toBe(keys.length);
      for (const field of fields) {
        const where = `${entry.key}.${field.key}`;
        expect(field.key, where).not.toBe("");
        expect(FIELD_KINDS, where).toContain(field.kind);
        if (field.kind === "float") floatFields.push(where);
        if (field.toolbar && field.kind === "bool") toolbarFields.push(where);
        expect(field.label, where).not.toBe("");
        // ``group`` 只对**表单内**的字段有要求：``toolbar`` 的 bool 开关摆在窗口
        // 工具栏上（＝ ``InputField.inToolbar``），没有分组名，``group`` 就是空串。
        // 下面那条「一个都没有」说明这豁免**现在不作用于任何字段** ——
        // 留着是因为 ``toolbar`` 还是 schema 契约的一部分。
        if (!(field.toolbar && field.kind === "bool")) {
          expect(field.group, where).not.toBe("");
        }
        expect(field.width, where).toBeGreaterThanOrEqual(8);
        expect(field.help.length, where).toBeGreaterThanOrEqual(0);
        if (field.kind === "choice") {
          // ⚠️ 不能写成「至少两项」：task.item 只有 ``task-yanma/炎马`` 一项
          //（任务奖励装备只会是炎马），照样是合法的 choice。
          expect(field.choices.length, where).toBeGreaterThanOrEqual(1);
          expect(field.choices, where).toContain(field.default);
        } else {
          expect(field.choices, where).toEqual([]);
        }
      }
    }
    // ``equipment.py`` 里 ``kind="float"`` 受 ``cls.allow_bagua`` 保护，目前只有
    // ``fusion`` 打开它（＝太极八卦的「成长和」，决定成长范围）。**别处冒出 float
    // 就说明机制变了**，要同步 TS 的控件映射（``float`` 与 ``int``/``text`` 同用文本框）。
    expect(floatFields).toEqual(FLOAT_FIELDS);

    // 工具栏开关**一个都没有**：最后一个（``strength.auto_upshift``）和「枚举全部」一样
    // 搬回了参数栏 —— 勾选框和它管的东西摆在同一眼里才看得懂。冒出一个来就说明有人
    // 又往工具栏上摆东西了，同时上面那条 ``group`` 豁免会重新生效。
    expect(toolbarFields).toEqual([]);
  });

  it("字段：int 的上下限与默认值自洽", () => {
    for (const entry of FIXTURE.scenarios) {
      for (const field of entry.schema.fields) {
        if (field.kind !== "int") continue;
        const where = `${entry.key}.${field.key}`;
        for (const bound of [field.min, field.max]) {
          if (bound !== null) expect(Number.isInteger(bound), where).toBe(true);
        }
        if (field.min !== null && field.max !== null) {
          expect(field.min, where).toBeLessThanOrEqual(field.max);
        }
        if (field.default !== null) expect(Number.isInteger(field.default), where).toBe(true);
        if (field.required) expect(field.default, where).toBeNull();
      }
    }
  });

  it("字段：bool 的默认值必须是布尔", () => {
    for (const entry of FIXTURE.scenarios) {
      for (const field of entry.schema.fields) {
        if (field.kind !== "bool") continue;
        expect(typeof field.default, `${entry.key}.${field.key}`).toBe("boolean");
      }
    }
  });

  it("表头只挂在真实存在的分组上，且至少三栏", () => {
    for (const entry of FIXTURE.scenarios) {
      const groups = new Set(entry.schema.fields.map((f) => f.group));
      for (const [group, columns] of Object.entries(entry.schema.headers)) {
        expect(groups, `${entry.key}.${group}`).toContain(group);
        expect(columns.length, `${entry.key}.${group}`).toBeGreaterThanOrEqual(3);
        for (const column of columns) expect(column).not.toBe("");
      }
    }
  });

  it("title / hint 与场景级 label / hint 一致（默认实现）", () => {
    for (const entry of FIXTURE.scenarios) {
      expect(entry.schema.title, entry.key).toBe(entry.label);
      expect(entry.schema.hint, entry.key).toBe(entry.hint);
    }
  });
});

describe("基准锚点：making（打造）", () => {
  const making = byKey.get("making") as Entry;

  it("字段清单与顺序", () => {
    expect(making.schema.fields.map((f) => f.key)).toEqual(MAKING_KEYS);
    expect(making.label).toBe("打造");
    expect(making.spec_kind).toBe("roll");
    // EquipScenario 把局部搜索上限抬到 8 个 9（不是 DEFAULT_NEAR_LIMIT 的 7 个 9）
    expect(making.near_limit).toBe(99_999_999);
  });

  it("装备选择框", () => {
    const item = making.schema.fields[0] as FieldDict;
    expect(item.kind).toBe("choice");
    expect(item.default).toBe("weapons/尾火棍");
    expect(item.width).toBe(22);
    expect(item.group).toBe("装备");
    // 分类前缀（weapons/armors/accessories）必须唯一区分重名装备
    for (const choice of item.choices) expect(choice).toMatch(/^[a-z0-9-]+\/.+$/);
    expect(new Set(item.choices).size).toBe(item.choices.length);
  });

  it("三组宝石：种类与属性下拉的候选值", () => {
    for (const n of [1, 2, 3]) {
      const kind = making.schema.fields.find((f) => f.key === `gem${n}_kind`) as FieldDict;
      const attr = making.schema.fields.find((f) => f.key === `gem${n}_attr`) as FieldDict;
      expect(kind.choices).toEqual(GEM_KINDS);
      expect(attr.choices).toEqual(GEM_ATTRS);
      expect(kind.default).toBe("无");
      expect(attr.default).toBe("无");
      expect([kind.width, attr.width]).toEqual([10, 10]);
    }
  });

  it("目标属性表：10 项、inline、宽度 12、默认空", () => {
    const targets = making.schema.fields.filter((f) => f.group === "目标属性");
    expect(targets).toHaveLength(10);
    for (const field of targets) {
      expect(field.kind).toBe("text");
      expect(field.inline).toBe(true);
      expect(field.toolbar).toBe(false);
      expect(field.width).toBe(12);
      expect(field.default).toBe("");
      expect(field.help).toContain("留空=用左边显示的装备上下限");
    }
    expect(making.schema.headers).toEqual({ 目标属性: ["属性名", "展示值", "目标上下限"] });
  });

  it("起始种子：必填、1 ~ 2147483647、默认空", () => {
    const seed = making.schema.fields.find((f) => f.key === "start_seed") as FieldDict;
    expect(seed.kind).toBe("int");
    expect(seed.required).toBe(true);
    expect(seed.default).toBeNull();
    expect(seed.min).toBe(1);
    expect(seed.max).toBe(2147483647);
    expect(seed.width).toBe(14);
    expect(seed.group).toBe("搜索");
  });

  it("「枚举全部」在搜索分组里、默认不勾、不是工具栏开关", () => {
    const field = making.schema.fields.find((f) => f.key === "full_search") as FieldDict;
    expect(field.kind).toBe("bool");
    expect(field.label).toBe("枚举全部");
    expect(field.default).toBe(false);
    expect(field.group).toBe("搜索");
    // ⚠️ 它一度是工具栏开关（toolbar=True），后来回到表单里紧挨着起始种子 ——
    // 所以这里的 ``toolbar`` 必须是 false，且 TS 侧不该有第二个开关。
    expect(field.toolbar).toBe(false);
    expect(field.inline).toBe(false);
  });

  it("步数上限的 help 文本逐字保留", () => {
    const limit = making.schema.fields.find((f) => f.key === "limit") as FieldDict;
    expect(limit.default).toBe(0);
    expect(limit.min).toBe(0);
    expect(limit.max).toBeNull();
    // ``help`` 是**原样照抄 Python** 的（含那句补充说明），一字不改；改这里等于改契约。
    expect(limit.help).toBe("0=用场景默认（见 search_limits）；勾上「枚举全部」时本项被忽略");
  });
});

describe("基准锚点：v4-reforge（法宝洗练）", () => {
  const v4 = byKey.get("v4-reforge") as Entry;

  it("字段清单与顺序", () => {
    expect(v4.schema.fields.map((f) => f.key)).toEqual([
      "item",
      "growth_state",
      "growth",
      "wuxing",
      "start_seed",
    ]);
    expect(v4.label).toBe("法宝洗练");
    expect(v4.spec_kind).toBe("growth-wuxing");
    expect(v4.near_limit).toBe(999_999);
    expect(v4.schema.headers).toEqual({});
  });

  it("法宝下拉只有一个动作", () => {
    // 游戏里只有「属性重置」一个按钮；成长 2.5 是**这件装备的状态**，
    // 由下面的 growth_state 表达，不是第二个物品。
    const item = v4.schema.fields[0] as FieldDict;
    expect(item.choices).toEqual(["v4-reforge/属性重置"]);
    expect(item.default).toBe("v4-reforge/属性重置");
    expect(item.group).toBe("法宝");
  });

  it("成长状态是「未满 / 已满 2.5」二选一", () => {
    const state = v4.schema.fields[1] as FieldDict;
    expect(state.choices).toEqual(["未满 2.5（重算成长）", "已满 2.5（只洗五行）"]);
    expect(state.default).toBe("未满 2.5（重算成长）");
  });

  it("成长变化量 / 五行都是文本输入，help 写明 0 不可达", () => {
    const growth = v4.schema.fields[2] as FieldDict;
    const wuxing = v4.schema.fields[3] as FieldDict;
    expect([growth.kind, wuxing.kind]).toEqual(["text", "text"]);
    expect(growth.help).toContain("0 不可达");
    expect(wuxing.help).toContain("最多 2 个字");
  });
});

describe("注册表", () => {
  it("missingKeys + registeredKeys 正好是清单（两者不重叠）", () => {
    const missing = [...missingKeys()];
    const registered = [...registeredKeys()];
    expect([...missing, ...registered].sort()).toEqual([...BUILTIN_ORDER].sort());
    expect(missing.filter((k) => registered.includes(k))).toEqual([]);
  });

  it("registeredKeys 按清单顺序（其余 key 排在后面）", () => {
    const registered = [...registeredKeys()];
    expect(registered).toEqual(BUILTIN_ORDER.filter((k) => registered.includes(k)));
    for (const key of registered) expect(FIXTURE.order).toContain(key);
  });

  it("未知 key 抛 ScenarioError", () => {
    expect(() => getScenario("no-such-scenario")).toThrow(ScenarioError);
    expect(() => getScenario("no-such-scenario")).toThrow(/未知场景/);
  });

  it("describeAll 与注册表一一对应", () => {
    const described = describeAll();
    expect(described.map((d) => d.key)).toEqual([...registeredKeys()]);
  });
});

describe("TS 场景与夹具逐字段对拍（20b 分步移植：每落地一个就多覆盖一个）", () => {
  const pending = BUILTIN_ORDER.filter((key) => !missingKeys().includes(key));

  // vitest 不允许空 suite：一个场景都还没落地时得有条占位用例。
  if (pending.length === 0) {
    it("目前 0 / 10 个场景已移植，逐字段对拍暂无对象", () => {
      expect(missingKeys().length).toBe(BUILTIN_ORDER.length);
    });
  }

  for (const key of pending) {
    const entry = byKey.get(key) as Entry;

    it(`${key} 的 describe() 与 Python 完全一致`, () => {
      const { near_limit, slice_bounds, ...expected } = entry;
      const scenario = getScenario(key);
      expect(scenario.describe()).toEqual(expected);
      expect(scenario.nearLimit).toBe(near_limit);
      expect(scenario.sliceBounds === null ? null : [...scenario.sliceBounds]).toEqual(slice_bounds);
    });
  }
});
