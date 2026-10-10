/**
 * 打造场景 —— ``weapons`` / ``armors`` / ``accessories``。
 *
 * 对应 ``src/MakingCalculator.py::calc2`` → ``src/making_calc/search.py::mytask``
 * 的非五行分支，外加「灵魂刷新」的 ``A``/``B`` 规则：
 *
 * * ``A = 有效宝石对数 + 1``，**邪灵品质**除外（``A = 0`` —— 邪灵装备不出灵魂）；
 * * 固定 ``B = 2``；
 * * ``consume = A + B``，即「属性计算之前要过掉的随机数个数」（旧的 ``n``）。
 *
 * 宝石最多 3 组，``mytask`` 会枚举**全部摆放顺序**（去重后）各搜一遍，
 * 取距离最小的那个顺序，并把顺序写进 ``Outcome.permutation``。
 *
 * ⚠️ 这个类**只有声明**：全部机制都在 `./equipment` 的 `EquipScenario` 里
 * （打造 / 合成 / 掉落 / 任务四个场景共用它，差别只有「分类白名单 + 三个开关」）。
 */

import { EquipScenario } from "./equipment";
import { register } from "./registry";

/** 打造：武器 / 防具 / 首饰。 */
export class MakingScenario extends EquipScenario {
  override readonly key = "making";
  override readonly label = "打造";
  override readonly hint =
    "武器、防具、首饰的打造。选装备 → 选最多 3 组宝石 → 填目标属性，" +
    "程序会枚举宝石摆放顺序并给出「还需要点几次制作」的最小值。\n" +
    "邪灵品质的装备不吃灵魂刷新，所以同样的宝石会让「须提前过的随机数」少 1。";

  override readonly categories: readonly string[] = ["weapons", "armors", "accessories"];
  override readonly allowGems = true;
}

register(MakingScenario);
