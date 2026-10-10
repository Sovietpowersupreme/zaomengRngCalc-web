/**
 * ``golden/runs.json`` —— **场景层**（``Scenario.run()``）的跨语言回归对拍。
 *
 * ``fixtures/scenarios.json`` 只冻到「表单契约」（``describe()``），``scenarios.json``
 * 只冻到 spec 层（``search_slice`` / ``search_near`` 的命中序列）。而前端真正在用的
 * 是更上一层：输入翻译、``consume`` / ``need_consume``、``seed_after``、``preview``
 * 文本、``notes`` —— 这一层漂了，前面两份 golden 一点都不会响。
 *
 * 三个关键事实
 * ------------
 * 1. 数据由 **Python** 的 ``tools/make_scenario_runs.py`` 采，采样后端是 ``ctypes``；
 *    TS 侧只有 **wasm** ⇒ 这份文件同时是「两个后端在场景层逐字段一致」的证明。
 * 2. 断言分三类（照抄 ``src_forge/tests/test_scenario_runs.py``）：
 *    **结构**（meta 自洽、id 唯一、结果不重复）/ **漂移**（用例 ``inputs`` 的键集合
 *    必须等于 ``schema().defaults()`` 的键集合）/ **重放**（``toDict()`` 与 ``expect``
 *    逐字段相等，``notes`` 也要逐字段相等）。
 * 3. **重放只对 ``registeredKeys()`` 里的场景跑** ⇒ 分步移植期这个套件随场景落地
 *    自动长大（0 → 7 → 11 → 19 条），0 个场景时也不空跑。
 *
 * 与 Python 的两处**故意不同**
 * ---------------------------
 * * 结构断言里凡是「== 全部 10 个场景」的都松成**子集**（``registeredKeys()`` 是
 *   演进中的进度，不是错误）。但 ``meta.scenarios`` 与 :data:`BUILTIN_ORDER` 的
 *   **逐项相等**照样钉死 —— 那是静态契约，今天就能查，且能立刻发现 Python 侧
 *   加/删了场景而 TS 清单没跟。
 * * ``test_recording_backend_is_available``（Python 专有）不移植：golden 是 ``ctypes``
 *   采的而 TS 只有 wasm，这条在 Web 侧恒假，没有信息量。
 */

import { beforeAll, describe, expect, it } from "vitest";

// 副作用导入：只有 ``scenarios/index`` 里登记过的场景才算「已落地」。
import "../src/scenarios/index";
import { BUILTIN_ORDER, getScenario, missingKeys, registeredKeys } from "../src/scenarios/registry";
import type { WasmRuntime } from "../src/wasm/runtime";
import { loadRuns, testRuntime, type RunCase } from "./helpers/golden";

const GOLDEN = loadRuns();
const RUNS = GOLDEN.runs;
const META = GOLDEN.meta;

/** 已落地的场景 key（重放只对它们跑）。 */
const REGISTERED = new Set(registeredKeys());

/** 重放清单 —— 随移植进度自动长大：0 → 7 → 11 → 19。 */
const REPLAY: readonly RunCase[] = RUNS.filter((rec) => REGISTERED.has(rec.scenario));

/** 稳定序列化：golden 是 Python ``json.dump(sort_keys=True)`` 写的，键序本来就是规范的。 */
function sig(value: unknown): string {
  return JSON.stringify(value);
}

describe("runs.json 元信息与结构（不依赖 TS 实现）", () => {
  it("夹具非空，且 meta 自洽", () => {
    expect(RUNS.length).toBeGreaterThan(0);
    expect(META.schema_version).toBe(1);
    expect(META.generator).toBe("tools/make_scenario_runs.py");
    expect(META.count).toBe(RUNS.length);
  });

  it("meta.scenarios 就是 UI 标签页顺序（= BUILTIN_ORDER），且不含 save-game", () => {
    // 这条是真正的跨语言静态契约：Python ``registry.registered_keys()`` 的顺序
    // 必须与 TS ``BUILTIN_ORDER`` 逐项相等。谁单方面加了场景，这里立刻红。
    expect([...META.scenarios]).toEqual([...BUILTIN_ORDER]);
    // ``save-game`` 只是 ``stars`` 的一个 raw 预设，**不是**独立场景。
    expect([...META.scenarios]).not.toContain("save-game");
  });

  it("采样指纹是 sha256（空串也算）", () => {
    expect(META.backend_sha256 === "" || META.backend_sha256.length === 64).toBe(true);
    expect(META.backend).not.toBe("");
  });

  it("id 唯一", () => {
    const ids = RUNS.map((rec) => rec.id);
    expect(new Set(ids).size, `重复 id：${ids.filter((id, i) => ids.indexOf(id) !== i).join(", ")}`).toBe(
      ids.length,
    );
  });

  it("每条用例的 scenario 都在清单里", () => {
    for (const rec of RUNS) expect([...BUILTIN_ORDER], rec.id).toContain(rec.scenario);
  });

  it("同场景内没有结果完全相同的两条用例（否则说明输入没起作用）", () => {
    // 这条规矩是被坑出来的：目标属性名写歪了（写了该装备没有的属性）时
    // ``build_target_ranges`` 会静默忽略，用例看着「跑通了」其实什么都没测到。
    const seen = new Map<string, string>();
    const dups: string[] = [];
    for (const rec of RUNS) {
      const key = `${rec.scenario}\u0000${sig(rec.expect)}\u0000${sig(rec.notes)}`;
      const prev = seen.get(key);
      if (prev === undefined) seen.set(key, rec.id);
      else dups.push(`${rec.id} 与 ${prev}`);
    }
    expect(dups).toEqual([]);
  });

  it("已落地的场景都被 golden 覆盖到（分步移植期只查子集）", () => {
    const covered = new Set(RUNS.map((rec) => rec.scenario));
    expect([...registeredKeys()].filter((key) => !covered.has(key))).toEqual([]);
  });
});

describe("漂移哨兵：用例 inputs 的键集合 == schema().defaults() 的键集合", () => {
  it("表单加了/删了字段就让 golden 过期，别让它在背后悄悄失效", () => {
    // 只对**已落地**的场景查：还没移植的场景 TS 侧根本没有 schema。
    const stale: string[] = [];
    for (const rec of REPLAY) {
      const want = new Set(Object.keys(getScenario(rec.scenario).schema().defaults()));
      const got = new Set(Object.keys(rec.inputs));
      const missing = [...want].filter((key) => !got.has(key)).sort();
      const extra = [...got].filter((key) => !want.has(key)).sort();
      if (missing.length > 0 || extra.length > 0) {
        stale.push(`${rec.id}: 少 [${missing.join(", ")}] / 多 [${extra.join(", ")}]`);
      }
    }
    expect(stale, "表单字段与 golden 不一致，重跑 tools\\make_scenario_runs.py").toEqual([]);
  });
});

describe("场景层重放：与 Python golden 逐字段一致（跨语言 + 跨后端）", () => {
  let rt: WasmRuntime;
  beforeAll(async () => {
    rt = await testRuntime();
  });

  // vitest 不允许空 suite：一个场景都还没落地时得有条占位用例。
  if (REPLAY.length === 0) {
    it("目前 0 / 10 个场景已移植，重放暂无对象", () => {
      expect(registeredKeys().length).toBe(0);
      expect(missingKeys().length).toBe(BUILTIN_ORDER.length);
    });
  }

  for (const rec of REPLAY) {
    it(`${rec.id}（${rec.scenario}）`, async () => {
      const scenario = getScenario(rec.scenario);
      // 与生成器 / Python 测试同构：``defaults()`` 打底，再用记下来的 inputs 覆盖
      // （里面有 ``start_seed``）。**别**只读 ``rec.inputs`` —— 那是覆盖项，不是全量。
      const inputs: Record<string, unknown> = {
        ...scenario.schema().defaults(),
        ...rec.inputs,
      };

      // 与生成器同构：``sc.run(inputs, start_seed, backend=backend)``，
      // 即 ``near=False`` / ``limit=None`` / ``ctx=None``（TS 的默认值一模一样）。
      const outcome = await scenario.run(inputs, rec.start_seed, { backend: rt });
      const data = outcome.toDict() as unknown as Record<string, unknown>;

      const keys = Object.keys(rec.expect);
      for (const key of keys) {
        // Python 那边取 ``data[k]`` 缺键会 KeyError，所以「键在不在」也是契约的一部分。
        expect(Object.hasOwn(data, key), `${rec.id}: toDict() 缺少 ${key}`).toBe(true);
      }
      const got: Record<string, unknown> = {};
      for (const key of keys) got[key] = data[key];
      expect(got, `${rec.id}: 结果与 golden 不一致`).toEqual(rec.expect);

      // ``notes`` 是 ``Note.toDict()`` 的全量（含 ``field`` 空串），逐字段比。
      expect(
        outcome.notes.map((note) => note.toDict()),
        `${rec.id}: 提示信息与 golden 不一致`,
      ).toEqual(rec.notes);
    });
  }
});
