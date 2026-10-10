/**
 * ``web/src/data/consts.json`` 的类型化读取层 —— 常量**单真源**的 TS 一侧。
 *
 * 数据来源（权威定义在 ``src_forge/const/*.py``）::
 *
 *     .venv\Scripts\python.exe -m src_forge.const.export_json web/src/data/consts.json
 *     .venv\Scripts\python.exe -m src_forge.const.export_json --check web/src/data/consts.json
 *
 * ``consts.json`` **提交进仓库**（静态部署与 CI 不需要 Python 就能跑 vitest），
 * 所以「有没有过期」由两边各一条测试盯着：
 *
 * * Python 侧 ``src_forge/tests/test_export_json.py`` 跑 :func:`check_file`；
 * * TS 侧 ``tests/consts.test.ts`` 校验形状与若干基准值。
 *
 * 为什么用静态 ``import`` 而不是 ``fetch``：产物要能丢进任意静态目录、甚至
 * ``file://`` 直接打开，``fetch`` 会被协议/CORS 挡住；常量表本来就该确定性地进包。
 *
 * ⚠️ ``resolveJsonModule`` 推断出来的类型「所有键都可能缺失」，这里用 ``as`` 收紧。
 * 形状真伪由上面那条 TS 测试兜底 —— **改了导出结构，要同时改这里和那个测试**。
 */

import type { Pair } from "../core/ranges";
import rawConsts from "./consts.json";

/** 与 ``src_forge/const/export_json.py::SCHEMA_VERSION`` 必须一致（不一致就直接抛）。 */
export const CONSTS_SCHEMA_VERSION = 3;

/** ``(lo, hi)`` 闭区间；JSON 里只能是两个数的数组。 */
export type RangePair = Pair;

/** 装备表里一条属性的取值：``"品质": "优秀"`` / ``"回血": 2`` / ``"攻击": [10.0, 15.0]``。 */
export type EquipValue = string | number | RangePair;

/** 一件装备的属性字典（``"品质"`` / 各属性 / ``"五行"``）。 */
export interface EquipDict {
  readonly [attr: string]: EquipValue;
}

/** 一颗宝石：属性 → 可滚区间。 */
export interface GemDict {
  readonly [attr: string]: RangePair;
}

/** ``const/petInfo.py::data`` 的一条记录。 */
export interface PetInfoRecord {
  /** 资质范围（四围）—— 实测**没有** ``null``。 */
  readonly 资质范围: Readonly<Record<string, RangePair>>;
  /** 基础属性范围；``null`` = 基础属性固定。 */
  readonly 基础属性范围: Readonly<Record<string, RangePair>> | null;
  /** 基础属性是否吃随机数。 */
  readonly 基础属性随机: boolean;
  /** 普通葫芦的捕捉成功率。 */
  readonly 成功率: number;
}

/** ``const/resolution.py``：属性分解表的元信息。 */
export interface AttrsConst {
  /** 10 个可滚属性（``COMMON_ATTRS``）。 */
  readonly common: readonly string[];
  /** 属性 → 显示/输入的小数位数。 */
  readonly precision: Readonly<Record<string, number>>;
  /** **游戏的计算顺序**（``品质`` + ``common`` + ``五行``），不能改。 */
  readonly order: readonly string[];
  /** UI 下拉框用（第一个是 ``"无"``）。 */
  readonly with_none: readonly string[];
  readonly quality_attr: string;
  readonly wuxing_attr: string;
  /** 宝石槽里可放的宝石种类（``"无"`` + 宝石表键）。 */
  readonly gem_kinds: readonly string[];
}

/** ``const/quality.py``：品质。 */
export interface QualityConst {
  /** 7 个品质名（``order`` 的键集）。 */
  readonly names: readonly string[];
  /** 品质 → 游戏里的整数色（``0xTTBBGGRR``）。 */
  readonly colors: Readonly<Record<string, number>>;
  /** 品质 → 排序序号。 */
  readonly order: Readonly<Record<string, number>>;
  /** 未知品质的兜底色。 */
  readonly fallback_color: number;
  /** 品质 → UI 用的 ``#RRGGBB``。 */
  readonly ui_colors: Readonly<Record<string, string>>;
}

/** ``const/wuxing.py``：五行。 */
export interface WuxingConst {
  /** 5 个五行名。 */
  readonly names: readonly string[];
  /** 五行 → 位序（``金``=4 等）。 */
  readonly bits: Readonly<Record<string, number>>;
  /** 「必须含五行」位（= ``core/values.ts::WUXING_HAS``）。 */
  readonly has: number;
  /** 六位全给位。 */
  readonly all: number;
  /**
   * 双抽门限的**浮点**版本（``random() >= double_at`` 就抽两个五行）。
   *
   * ⚠️ 整数版本 ``WUXING_DOUBLE_AT`` 住在 ``core/values.ts``，两者在
   * ``v == 1954210119`` 这**一个**值上结论相反（概率 1/2³¹，见 ``v4.py`` 的「偏差③」）。
   */
  readonly double_at: number;
  /** 5×4 的「下一五行」表（``NEXT_WUXING``）。 */
  readonly next: readonly (readonly number[])[];
}

/** ``const/strength.py``：强化。 */
export interface StrengthConst {
  /** 每级成功率（``ALLPRO``，9 项）。 */
  readonly allpro: readonly number[];
  /** 宝石等级名（4 项）。 */
  readonly stone_grades: readonly string[];
  readonly max_level: number;
  readonly lead_fastnext: number;
  readonly tail_fastnext: number;
  readonly click_offset: number;
  readonly near_limit: number;
  readonly prob_max: number;
}

/** 七星预设 —— ``(模式, 最低值 n, 浮动 r, 随机位置, 步长 step)`` 的具名版本。 */
export interface StarsPresetConst {
  readonly name: string;
  readonly mode: string;
  readonly minimum: number;
  readonly span: number;
  readonly random_pos: number;
  readonly step: number;
}

/** ``const/stars.py``：七星。 */
export interface StarsConst {
  /** ⚠️ 有序**列表**（不是字典）：顺序就是 UI 下拉框的顺序。 */
  readonly presets: readonly StarsPresetConst[];
  readonly default_preset: string;
  readonly save_game_preset: string;
  /** 模式名 → 模式标识（``truncation`` 是 ``"t"``）。 */
  readonly modes: Readonly<Record<string, string>>;
  /** 可枚举的模式（``raw`` 不在内）。 */
  readonly enum_modes: readonly string[];
  /** 斗部群星 boss 表（按索引）。 */
  readonly boss_by_index: readonly string[];
  readonly max_constraints: number;
  /** 斗部群星掩码（= ``core/values.ts::BOSS_MASK``）。 */
  readonly fastcrack_imask: number;
  readonly dbqx_value_step: number;
  /** ``r < crack2_max_span`` 用 ``crack2``，否则 ``crack``。 */
  readonly crack2_max_span: number;
  readonly save_game_scale: number;
  readonly save_game_half: number;
  readonly distance_limit: number;
}

/** ``const/resolution.py`` 的「装备分解产出表」—— 仓库里**没有**这份数据，所以是空的。 */
export interface ResolutionConst {
  readonly ready: boolean;
  readonly table: Readonly<
    Record<
      string,
      {
        readonly equip: string;
        readonly quality: string;
        readonly outputs: Readonly<Record<string, number>>;
      }
    >
  >;
}

/** ``consts.json`` 的顶层结构。 */
export interface ConstsFile {
  readonly schema_version: number;
  readonly attrs: AttrsConst;
  readonly quality: QualityConst;
  readonly wuxing: WuxingConst;
  readonly strength: StrengthConst;
  readonly stars: StarsConst;
  readonly resolution: ResolutionConst;
  /** 分类 → 该分类下的装备名（**已排序**，方便 diff —— 不要拿它当顺序用）。 */
  readonly equipment_names: Readonly<Record<string, readonly string[]>>;
  /**
   * 分类 → 装备名列表，**保持数据文件顺序**。
   *
   * 这个顺序就是 UI 下拉框的顺序，也是 ``item_choices()[0]`` 那份默认值。
   */
  readonly equipment_name_order: Readonly<Record<string, readonly string[]>>;
  /**
   * 分类 → 装备名 → 属性名列表，**保持数据文件顺序**。
   *
   * ⚠️ 这是**搜索语义的一部分**，不是排版细节：``buildBaseRanges`` 按数据顺序
   * 建表，``permutationSpecs`` 按这个顺序拼出 ``baseRollAttrs``，于是
   * ``RollSpec.rollVals[i]`` 就配给了第 i 个属性（决定谁拿到哪个随机值）。
   * ``equipment`` 里的属性键被 ``dumps(sort_keys=True)`` 按码点重排过
   * （如 ``天残`` 源顺序 ``魔法, 攻击`` 会变成 ``攻击, 魔法``），所以必须另带一份。
   */
  readonly equipment_attr_order: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
  /** 分类 → 装备名 → 属性表。 */
  readonly equipment: Readonly<Record<string, Readonly<Record<string, EquipDict>>>>;
  /** 宝石名 → 属性区间表。 */
  readonly gems: Readonly<Record<string, GemDict>>;
  /** 宠物名 → 记录。 */
  readonly pets: Readonly<Record<string, PetInfoRecord>>;
}

/**
 * 导出数据（模块加载时校验一次 ``schema_version``）。
 *
 * 版本不匹配就直接抛错 —— 常量语义变了而 TS 还在按旧结构读，静默跑错比启动就炸糟得多。
 */
export const CONSTS: ConstsFile = (() => {
  const data = rawConsts as unknown as ConstsFile;
  if (data.schema_version !== CONSTS_SCHEMA_VERSION) {
    // 文案刻意不点名生成它的上游模块 —— 这条会随打包进入线上产物、在浏览器里对用户可见。
    throw new Error(
      `consts.json 的 schema_version=${String(data.schema_version)}，` +
        `本文件按 ${CONSTS_SCHEMA_VERSION} 写的：` +
        "请重新生成 web/src/data/consts.json 并同步本文件。",
    );
  }
  return data;
})();

/** 装备表里的值是不是「可滚区间」（区别于 ``"品质"`` 的字符串与固定值的数字）。 */
export function isRangePair(value: EquipValue): value is RangePair {
  return Array.isArray(value);
}
