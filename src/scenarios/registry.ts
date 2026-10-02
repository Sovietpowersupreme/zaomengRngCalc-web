/**
 * 场景注册表 —— ``key`` → :class:`Scenario` 实例。
 * （``src_forge/gameInfo/registry.py`` 的 TS 对应物）
 *
 * 设计取舍
 * --------
 * 核心层刻意不用 ``__init_subclass__`` / 装饰器魔法（TS 里没有对应物，移植时会漂移），
 * 所以这里也保持朴素：
 *
 * 1. 每个场景模块在**模块级**调用一次 :func:`register`，把自己挂上去；
 * 2. :data:`BUILTIN_ORDER` 是显式清单（**顺序 = UI 的标签页顺序**）；
 * 3. 本模块**不导入任何场景** —— 那会形成 ``场景 → registry → 场景`` 的循环导入。
 *    由 ``scenarios/index.ts`` 这个 barrel 按顺序 ``import`` 各模块（副作用注册），
 *    应用入口再 ``import "./scenarios/index.js"``。
 *
 * 与 Python 的两处差异（有意为之）
 * --------------------------------
 * * Python 用 ``importlib`` 惰性导入模块，**单个模块导入失败不影响其它场景**
 *   （M2 分步落地期间很重要），失败原因记在 ``load_errors()``。TS 的模块图是静态的
 *   —— 少一个模块是**编译错误**，比运行期少一个标签页好得多。所以 ``load_errors()``
 *   在这里换成 :func:`missingKeys`：列出「清单里有、但还没注册」的 key，
 *   供分步移植期间的测试断言用。**目标是 Python ``registry.BUILTIN`` 的那 10 个 key
 *   全部落地后它必须为空**（:data:`BUILTIN_ORDER` 现存 10 项，与 Python 逐个对齐）。
 * * 注册表按需实例化（Python 是注册时就实例化）；场景是无状态的，两者等价。
 *
 * ⚠️ ``save-game`` **不是**独立场景，别照着名字补一项
 * --------------------------------------------------
 * 它是 ``stars`` 预设下拉框里的一个 ``raw`` 模式选项（两格输入），Python 侧曾单摆过
 * 一项、被用户要求删掉（理由写在 ``src_forge/gameInfo/registry.py`` 的 ``stars`` 上方）。
 * 本文件的 :data:`BUILTIN_ORDER` 也曾多留过一个同名占位（会让 :func:`missingKeys`
 * 多报一项、进度表对不上），现已删除。
 */

import { ScenarioError, type Scenario, type ScenarioDescribe } from "./scenario";

/** 场景清单。**改这里就等于改 UI 的标签页顺序。** */
export const BUILTIN_ORDER: readonly string[] = Object.freeze([
  "making",
  "fusion",
  "drops",
  "task",
  "strength",
  "capture",
  "rechild",
  "stars",
  "seed-resolve",
  "v4-reforge",
]);

const REGISTRY = new Map<string, Scenario>();
const CLASSES = new Map<string, new () => Scenario>();

/**
 * 注册一个场景类（或实例）。返回注册后的实例。
 *
 * 传**类**是常规用法（``register(MakingScenario)``）：注册表按需实例化，
 * 与 Python 的 ``register(cls)`` 一致。重复注册**同一个类**是幂等的
 * （barrel 被多次导入时不会炸）；换成另一个类才是冲突。
 */
export function register(scenario: Scenario | (new () => Scenario)): Scenario {
  const isClass = typeof scenario === "function";
  const cls = isClass ? (scenario as new () => Scenario) : (scenario.constructor as new () => Scenario);
  const probe = isClass ? new cls() : (scenario as Scenario);
  const key = probe.key;
  if (!key) throw new ScenarioError(`${cls.name || "Scenario"} 没有设置 key`);
  const existing = CLASSES.get(key);
  if (existing && existing !== cls) {
    throw new ScenarioError(`场景 key 冲突：'${key}' 已被 ${existing.name} 占用`);
  }
  CLASSES.set(key, cls);
  REGISTRY.set(key, probe);
  return probe;
}

/**
 * 已注册的场景 key：先按 :data:`BUILTIN_ORDER`，其余按字典序排在后面。
 * （后半截是给「外部自定义场景」留的位置，与 Python 一致。）
 */
export function registeredKeys(): readonly string[] {
  const ordered = BUILTIN_ORDER.filter((k) => REGISTRY.has(k));
  const extra = [...REGISTRY.keys()].filter((k) => !BUILTIN_ORDER.includes(k)).sort();
  return [...ordered, ...extra];
}

/** 清单里有、但还没注册的 key（分步移植期间的进度指示；全部落地后为空）。 */
export function missingKeys(): readonly string[] {
  return BUILTIN_ORDER.filter((k) => !REGISTRY.has(k));
}

export function* iterScenarios(): Generator<Scenario, void, undefined> {
  for (const key of registeredKeys()) {
    const scenario = REGISTRY.get(key);
    if (scenario) yield scenario;
  }
}

export function allScenarios(): Scenario[] {
  return [...iterScenarios()];
}

/** 按 key 取场景。未知 key 抛 :class:`ScenarioError`（并列出可用 key）。 */
export function getScenario(key: string): Scenario {
  const name = String(key);
  const scenario = REGISTRY.get(name);
  if (scenario) return scenario;
  const known = registeredKeys();
  const hint = known.length > 0 ? `（可用：${known.join(", ")}）` : "（注册表是空的：忘了 import scenarios barrel？）";
  throw new ScenarioError(`未知场景 '${name}'${hint}`);
}

/** 给 UI 用的场景目录（含表单描述），可直接 JSON 序列化。 */
export function describeAll(): ScenarioDescribe[] {
  return allScenarios().map((s) => s.describe());
}

/** 仅测试用：清空注册表，下次导入 barrel 时重新注册。 */
export function resetRegistry(): void {
  REGISTRY.clear();
  CLASSES.clear();
}
