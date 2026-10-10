/**
 * 场景层的**汇总入口**（barrel）。
 *
 * 分工：
 *
 * * 各个场景模块（``equipment.ts`` / ``strength.ts`` …）在模块末尾自己调用
 *   :func:`register` 把类登记进注册表 —— 这和 Python 侧
 *   ``registry._load_builtin()`` 用 ``importlib`` 扫模块的效果一样，
 *   区别只是 TS 的模块图是**静态**的，所以「扫」这个动作必须由这里显式写出来。
 * * 这个文件就是那份「模块清单」：它 ``import`` 谁，谁就会被登记。
 *   **没在这里 import 的场景，等于不存在**（``missingKeys()`` 会把它列出来）。
 *
 * :mod:`./registry` 里**故意不 import 任何场景**，否则会形成
 * ``场景 → registry → 场景`` 的循环依赖；所有副作用导入都集中在本文件。
 *
 * ── 移植进度（对照 Python ``registry.BUILTIN``，顺序即 UI 标签页顺序）──
 *
 * | key          | TS 模块            | 状态 |
 * |--------------|--------------------|------|
 * | making       | ``making.ts``      | ✅ |
 * | fusion       | ``fusion.ts``      | ✅ |
 * | drops        | ``drops.ts``       | ✅ |
 * | task         | ``task.ts``        | ✅ |
 * | strength     | ``strength.ts``    | ✅ |
 * | capture      | ``capture.ts``     | ✅ |
 * | rechild      | ``rechild.ts``     | ✅ |
 * | stars        | ``stars.ts``       | ✅ |
 * | seed-resolve | ``seed_resolve.ts``| ✅ |
 * | v4-reforge   | ``v4.ts``          | ✅ |
 *
 * 目标就是上面这 **10** 个（= Python ``registry.BUILTIN`` = :data:`BUILTIN_ORDER`，
 * 两边已经逐个对齐）。⚠️ ``save-game`` **不在其列**：它是 ``stars`` 的 ``raw`` 预设，
 * 不是独立场景，不建模块也不注册。
 *
 * 每落地一个就在下面加一行 ``import "./xxx";``（顺序随意，``registered_keys``
 * 的输出顺序由 :data:`BUILTIN_ORDER` 决定，与本文件的 import 顺序无关）。
 */

export * from "./registry";

// ⬜ 场景模块的副作用导入写在这里（目前 10 / 10 —— Python ``registry.BUILTIN`` 齐了）：
import "./capture";
import "./drops";
import "./fusion";
import "./making";
import "./rechild";
import "./seed_resolve";
import "./stars";
import "./strength";
import "./task";
import "./v4";
