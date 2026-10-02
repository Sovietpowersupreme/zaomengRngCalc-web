/**
 * 掉落场景 —— ``drops``（掉落装备 / 含五行筛选）。
 *
 * ``drops`` 是最杂的一类：29 件里只有 12 件带五行字段。
 *
 * * **带五行**的走 ``findFabao2`` 那条路（``mytask`` 的五行分支）：一个规格，
 *   ``consume = 0``，五行位由 ``parse_wuxing`` 决定筛选掩码；
 * * **不带五行**的走普通 ``findEquip2`` 分支，``consume = 0``（``drops`` 不在
 *   硬编码表里，``ab_sum`` 也返回 ``(0, 0)``）。
 *
 * ``_calc_ab`` 只对 ``weapons`` / ``armors`` / ``accessories`` 生效，所以掉落
 * 装备没有宝石栏，也没有灵魂刷新的 ``A``/``B``。
 *
 * 与 ``v4-reforge`` 的分工
 * ------------------------
 * ``v4-reforge``（属性重置）**不在本模块**：它走的是 ``calc_v4`` →
 * ``findRefreshSutraAttribute``，是一段**独立的前向扫描**（成长增量 → 五行掩码
 * → ``seedDistance``），不是任何一个可枚举的 ``SeedSpec`` 能表达的 —— 见
 * ``web/src/scenarios/v4.ts``。本模块只负责 ``drops`` 那 29 件。
 *
 * ⚠️ 只有声明：机制全在 `./equipment` 的 `EquipScenario`。
 */

import { EquipScenario } from "./equipment";
import { register } from "./registry";

/** 掉落装备：含五行筛选。 */
export class DropsScenario extends EquipScenario {
  override readonly key = "drops";
  override readonly label = "掉落";
  override readonly hint =
    "掉落装备的搜索。带五行的掉落装备可以填五行做筛选：\n" +
    "留空或填「无」= 不筛五行；填 1 个字只出该五行；填 2 个字要求双五行。\n" +
    "掉落装备的随机数个数为 0（不吃宝石、不吃灵魂刷新）。";

  override readonly categories: readonly string[] = ["drops"];
  override readonly allowWuxing = true;
}

register(DropsScenario);
