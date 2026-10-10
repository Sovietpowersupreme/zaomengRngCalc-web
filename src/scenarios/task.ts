/**
 * 任务场景 —— ``task-yanma``（炎马）。
 *
 * 任务装备不吃宝石，随机数个数由硬编码表给出（``task-yanma`` = **13**），
 * 走普通 ``findEquip2`` 分支：4 个可随机属性（攻击 1000~1300、生命 700~1200、
 * 防御 200~400、魔法 550~990），且**没有五行字段**。
 *
 * ⚠️ 只有声明：机制全在 `./equipment` 的 `EquipScenario`。
 */

import { EquipScenario } from "./equipment";
import { register } from "./registry";

/** 任务装备：炎马。 */
export class TaskScenario extends EquipScenario {
  override readonly key = "task";
  override readonly label = "任务";
  override readonly hint =
    "任务奖励装备（炎马）的搜索。\n炎马有四条可随机属性，属性计算前会先过 13 次随机数。";

  override readonly categories: readonly string[] = ["task-yanma"];
}

register(TaskScenario);
