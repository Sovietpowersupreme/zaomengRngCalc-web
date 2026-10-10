/**
 * 合成场景 —— ``fusion-tjbg`` / ``fusion-A`` / ``fusion-B`` / ``fusion-C``。
 *
 * 这四类都不吃宝石（``_calc_ab`` 对非 ``weapons/armors/accessories`` 直接返回
 * ``(0, 0)``），随机数个数是硬编码表：
 *
 * ===============  ==============  ===========================================
 * 分类              随机数个数       说明
 * ===============  ==============  ===========================================
 * ``fusion-tjbg``  11              太极八卦：带「成长和」→ 额外成长
 * ``fusion-A``     7               流邪 / 枯叶灵 / 宣花葫芦 …
 * ``fusion-B``     3               沙邪 / 渊邪 / 救世星宿(史诗)
 * ``fusion-C``     8               玉净瓶
 * ===============  ==============  ===========================================
 *
 * 其中 ``fusion-A`` / ``fusion-B`` / ``fusion-C`` 带五行字段，会走 ``mytask``
 * 的**五行分支**（一个规格、不枚举排列）；
 * ``fusion-tjbg`` 的「成长」由成长和推出，范围是
 * ``(g/3, g/3 + 0.8)``，并额外用一次随机数决定加成。
 *
 * ⚠️ 只有声明：机制全在 `./equipment` 的 `EquipScenario`。
 */

import { EquipScenario } from "./equipment";
import { register } from "./registry";

/** 合成：太极八卦 / 流邪一族 / 沙邪一族 / 玉净瓶。 */
export class FusionScenario extends EquipScenario {
  override readonly key = "fusion";
  override readonly label = "合成";
  override readonly hint =
    "太极八卦、流邪、沙邪、玉净瓶的合成。\n" +
    "这些装备不吃宝石、也不吃灵魂刷新，随机数个数是游戏里定死的。\n" +
    // ⚠️ 提示文本必须与 Python **逐字**一致（夹具 scenarios.json 会逐字符比），
    //    别顺手「润色」这里的措辞。
    "太极八卦请把「成长和」填上（游戏里八卦面板的数值），程序据此推出成长范围。";

  override readonly categories: readonly string[] = [
    "fusion-tjbg",
    "fusion-A",
    "fusion-B",
    "fusion-C",
  ];
  override readonly allowWuxing = true;
  override readonly allowBagua = true;
}

register(FusionScenario);
