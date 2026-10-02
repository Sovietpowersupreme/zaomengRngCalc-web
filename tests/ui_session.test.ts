/**
 * :class:`UiSession` 的行为钉 —— 界面外壳里**所有**规则的归口测试。
 *
 * 为什么值得单独测：``App.vue`` 只负责 DOM 接线（``notes/web-design.md`` §5.2/§5.7），
 * 所以「点运行到底会发生什么」这件事只可能在这里被钉住 —— 快，且不依赖 ``happy-dom``。
 * 覆盖三条线：
 *
 * 1. **纯状态机**（校验驳回、无后端、忙时拒绝、reset / 换场景）—— 不需要 wasm；
 * 2. **链接层**（``boot`` 恢复场景与参数、不认识的 key 只记日志、分享链接往返）——
 *    node 里没有 ``location`` / ``history``，正好顺带钉住 :meth:`UiSession.syncHash` 的
 *    环境守卫（不该抛）；
 * 3. **真跑一轮**（``v4-reforge`` 打默认值：一抽命中）—— 用真的 wasm，确认 ``state`` /
 *    ``conclusion`` / ``notes`` / ``lastMs`` / 日志都接上了，而不是只有表单能动；
 * 4. **取消**（空闲守卫 + 串行搜索不可取消这条限制）—— 见该 describe 里的说明。
 */

import { beforeAll, describe, expect, it } from "vitest";

import "../src/scenarios/index";
import { allScenarios, getScenario } from "../src/scenarios/registry";
import { textOf } from "../src/ui/form";
import { BACKENDS, UiSession, type SessionOptions } from "../src/ui/session";
import type { WasmRuntime } from "../src/wasm/runtime";
import { testRuntime } from "./helpers/golden";

const HREF = "https://example.test/app/index.html";

/** 后缀式建会话：``href`` 固定，免得测到宿主环境的地址。 */
function mkSession(patch: SessionOptions = {}): UiSession {
  return new UiSession({ href: () => HREF, ...patch });
}

/** 拿出 ``v4-reforge``（真跑一轮用；它默认参数就一抽命中，快）。 */
function v4Session(): UiSession {
  const session = mkSession();
  session.selectScenario("v4-reforge");
  return session;
}

/** 日志里有没有哪一行包含这段文字。 */
function hasLog(session: UiSession, needle: string): boolean {
  return session.log.value.some((line) => line.includes(needle));
}

/** 失败状态的消息（不是失败状态就抛，免得断言悄悄变成空操作）。 */
function failureMessage(session: UiSession): string {
  const state = session.state.value;
  if (state.kind !== "failed") throw new Error(`本该是 failed，实际是 ${state.kind}`);
  return state.message;
}

/** 真 wasm 后端：两处 describe（真跑一轮 / 取消）共用，所以建在模块作用域。 */
let rt: WasmRuntime;
beforeAll(async () => {
  rt = await testRuntime();
});

describe("会话 · 起步状态", () => {
  it("默认落在注册表的第一个场景，控件值 = 各字段默认值的文本形式", () => {
    const session = mkSession();
    const first = allScenarios()[0];
    expect(first).toBeDefined();
    expect(session.scenario.value).toBe(first);
    expect(session.scenarios).toEqual(allScenarios());
    for (const field of first!.schema().fields) {
      // ``text_of`` 是唯一的换算规则：``null`` → 空串、``bool`` → 真布尔、
      // ``choice`` 兜到第一个候选。``raw`` 必须逐字段等于它，而不是 ``defaults()``
      // 的原始值（``start_seed`` 的默认值是 ``null``）。
      expect(session.raw.value[field.key]).toEqual(textOf(field, field.default));
    }
  });

  it("没跑过的时候：state=idle、进度为 null、状态栏是「就绪」", () => {
    const session = mkSession();
    expect(session.state.value.kind).toBe("idle");
    expect(session.progressPercent.value).toBeNull();
    expect(session.running.value).toBe(false);
    expect(session.lastMs.value).toBeNull();
    expect(session.statusText.value).toBe("就绪");
    expect(session.conclusion.value.text).toBe("还没有结果");
  });

  it("后端只有一个（web 侧只有 wasm），下拉当前值就是它", () => {
    expect([...BACKENDS]).toEqual(["wasm"]);
    const session = mkSession();
    expect(session.backend.value).toBe("wasm");
  });

  it("没结果时详情 JSON 是空串（detailJson 是方法，不是 computed）", () => {
    const session = mkSession();
    expect(session.detailJson()).toBe("");
  });
});

describe("会话 · 表单与校验", () => {
  it("setValue 写进去的是控件文本，inputs 里已经是数字", () => {
    const session = v4Session();
    session.setValue("start_seed", "999");
    expect(session.raw.value["start_seed"]).toBe("999");
    expect(session.inputs.value["start_seed"]).toBe(999);
  });

  it("格式不对 → collected 出 FieldProblem（坏字段回落默认值 + 标红）", () => {
    const session = v4Session();
    session.setValue("start_seed", "abc");
    const errors = session.collected.value.errors;
    expect(errors.map((note) => note.field)).toEqual(["start_seed"]);
    expect(errors[0]!.isError).toBe(true);
    expect(errors[0]!.message).toContain("必须是整数");
    // 坏字段不该把整张表单一起带走：回落到默认值，界面照常能画。
    expect(session.inputs.value["start_seed"]).toBeNull();
  });

  it("必填留空：coerce 不报错（空 = 回落默认值），是 issues() 报的 error", () => {
    const session = v4Session();
    session.setValue("start_seed", "");
    expect(session.collected.value.errors).toEqual([]);
    expect(session.inputs.value["start_seed"]).toBeNull();

    const merged = session.validateNow();
    expect(merged.filter((note) => note.isError).map((note) => note.field)).toContain("start_seed");
    expect(session.focusField.value).toBe("start_seed");
  });

  it("校验不过时 run 直接驳回：不开跑、状态不变、日志有一行说明", async () => {
    const session = v4Session();
    session.setValue("start_seed", "");
    await session.run();
    expect(session.state.value.kind).toBe("idle");
    expect(session.running.value).toBe(false);
    expect(session.lastMs.value).toBeNull();
    expect(hasLog(session, "校验未通过")).toBe(true);
    expect(hasLog(session, "开始：")).toBe(false);
    expect(session.notes.value.some((note) => note.isError)).toBe(true);
  });

  it("能跑通的输入：validateNow 之后没有 error，focusField 归位", () => {
    const session = v4Session();
    session.setValue("start_seed", "12345");
    expect(session.validateNow().filter((note) => note.isError)).toEqual([]);
    expect(session.focusField.value).toBeNull();
  });

  it("reset 把表单恢复成默认值，但不清日志", () => {
    const session = v4Session();
    session.setValue("start_seed", "12345");
    session.logLine("手写一行");
    session.reset();
    expect(session.raw.value).toEqual(
      getScenario("v4-reforge")
        .schema()
        .fields.reduce<Record<string, unknown>>((acc, field) => {
          acc[field.key] = textOf(field, field.default);
          return acc;
        }, {}),
    );
    expect(session.raw.value["start_seed"]).toBe("");
    expect(session.notes.value).toEqual([]);
    expect(session.state.value.kind).toBe("idle");
    expect(hasLog(session, "手写一行")).toBe(true);
  });

  it("换场景：表单换成新场景的默认值，链接带来的提示被清掉", () => {
    const session = mkSession();
    session.boot("#/v4-reforge?start_seed=777");
    expect(session.raw.value["start_seed"]).toBe("777");
    session.selectScenario("strength");
    expect(session.scenario.value.key).toBe("strength");
    expect(session.raw.value["start_seed"]).not.toBe("777");
    expect(session.linkNotes.value).toEqual([]);
  });

  it("换成不认识的名字只记一行日志，不抛", () => {
    const session = v4Session();
    session.selectScenario("不存在的东西");
    expect(session.scenario.value.key).toBe("v4-reforge");
    expect(hasLog(session, "不存在的东西")).toBe(true);
  });
});

describe("会话 · 没有后端时不白屏", () => {
  it("setRuntime(null, …, 原因) 之后 run 变 failed，提示里带上那个原因", async () => {
    const session = v4Session();
    session.setValue("start_seed", "12345");
    session.setRuntime(null, null, "加载 cracker.wasm 失败：找不到文件");

    await session.run();
    const message = failureMessage(session);
    expect(message).toContain("cracker.wasm");
    expect(session.notes.value.some((note) => note.isError && note.message === message)).toBe(true);
    expect(session.running.value).toBe(false);
    // loadError 优先级最高：状态栏直接显示原因，而不是「就绪」。
    expect(session.statusText.value).toBe(message);
    expect(session.conclusion.value).toEqual({ text: "计算失败", danger: true });
    expect(hasLog(session, "失败：")).toBe(true);
  });

  it("从没注入过后端也一样：默认文案里点名 wasm", async () => {
    const session = v4Session();
    session.setValue("start_seed", "12345");
    await session.run();
    expect(failureMessage(session)).toContain("wasm");
  });
});

describe("会话 · 链接层（node 里没有 location / history，顺带钉住守卫）", () => {
  it("boot 恢复场景与参数，并且不自动开跑", () => {
    const session = mkSession();
    session.boot("#/v4-reforge?start_seed=777");
    expect(session.scenario.value.key).toBe("v4-reforge");
    expect(session.raw.value["start_seed"]).toBe("777");
    expect(session.running.value).toBe(false);
    expect(session.state.value.kind).toBe("idle");
    expect(hasLog(session, "从链接恢复了")).toBe(true);
  });

  it("boot 只认链接里的场景 key：没写 key 就留在默认场景、表单不动", () => {
    const session = mkSession();
    const before = { ...session.raw.value };
    session.boot("");
    expect(session.scenario.value.key).toBe(allScenarios()[0]!.key);
    expect(session.raw.value).toEqual(before);
    expect(hasLog(session, "从链接恢复了")).toBe(false);
  });

  it("不认识的场景 key：退回当前场景 + 记日志（不抛）", () => {
    const session = mkSession();
    session.boot("#/没有这个场景?start_seed=777");
    expect(session.scenario.value.key).toBe(allScenarios()[0]!.key);
    expect(hasLog(session, "不认识")).toBe(true);
    // 场景没换，所以那个 ``start_seed`` 是按**默认场景**的 schema 解出来的。
    expect(session.raw.value["start_seed"]).toBe("777");
  });

  it("超范围的链接参数被忽略 + 一条 warning（不会变成 error）", () => {
    const session = mkSession();
    session.boot("#/v4-reforge?start_seed=999999999999");
    expect(session.linkNotes.value.length).toBeGreaterThan(0);
    expect(session.linkNotes.value.every((note) => !note.isError)).toBe(true);
    expect(hasLog(session, "[链接]")).toBe(true);
    expect(session.raw.value["start_seed"]).toBe("");
  });

  it("shareLink 往返：分享出去的链接 boot 回来是同一份输入", () => {
    const session = v4Session();
    session.setValue("start_seed", "777");
    session.setValue("wuxing", "金火");
    const link = session.shareLink();
    expect(link.startsWith(`${HREF}#/v4-reforge?`)).toBe(true);

    const other = mkSession();
    other.boot(new URL(link).hash);
    expect(other.scenario.value.key).toBe("v4-reforge");
    expect(other.inputs.value["start_seed"]).toBe(777);
    expect(other.inputs.value["wuxing"]).toBe("金火");
    expect(other.linkNotes.value).toEqual([]);
  });

  it("默认值不进链接（保持链接短），回退后仍是默认", () => {
    const session = v4Session();
    const link = session.shareLink();
    expect(link).not.toContain("start_seed");
    expect(link).toContain("_v=");
  });
});

// =========================================================================== 真跑

describe("会话 · 真跑一轮（wasm）", () => {
  it("跑完：state=done、有结论、有耗时、日志收尾（没挂池子也能跑）", async () => {
    const session = v4Session();
    session.setValue("start_seed", "12345");
    session.setRuntime(rt, null);

    await session.run();

    expect(session.state.value.kind).toBe("done");
    expect(session.running.value).toBe(false);
    expect(session.progress.value).toBeNull();
    expect(session.lastMs.value).toBeGreaterThan(0);
    // 「默认参数一抽命中」是 v4 的既有性质，这里顺手把它钉在界面上。
    expect(session.conclusion.value).toEqual({ text: "找到种子 1207965724（距离 1）", danger: false });
    expect(session.rows.value.length).toBeGreaterThan(0);
    expect(session.preview.value.kind).toBe("raw");
    expect(session.detailJson().length).toBeGreaterThan(0);
    expect(session.statusText.value).toContain("ms");
    expect(hasLog(session, "完成：")).toBe(true);
  });

  it("v4 不声明 advance()：跑完不回填参数", async () => {
    const session = v4Session();
    session.setValue("start_seed", "12345");
    session.setRuntime(rt, null);
    const before = { ...session.raw.value };
    await session.run();
    expect(session.raw.value).toEqual(before);
    expect(hasLog(session, "回填")).toBe(false);
  });

  it("正在跑的时候再点运行：拒绝，并说明「同一时刻只支持一轮」", async () => {
    const session = v4Session();
    session.setValue("start_seed", "12345");
    session.setRuntime(rt, null);

    const first = session.run(); // 同步段里已经把 running 置 true
    expect(session.running.value).toBe(true);
    await session.run();
    expect(hasLog(session, "已有任务在跑")).toBe(true);
    await first;
    expect(session.state.value.kind).toBe("done");
  });

  it("setRuntime 成功时把后端自描述写进 runtimeInfo 和日志", () => {
    const session = v4Session();
    session.setRuntime(rt, null);
    expect(session.runtimeInfo.value).toBe(rt.describe());
    expect(session.loadError.value).toBe("");
    expect(hasLog(session, rt.describe())).toBe(true);
  });
});

describe("取消", () => {
  it("空闲时按取消：只记一行日志，不抛、不打标记、不改状态", () => {
    const session = mkSession();
    const before = session.state.value;
    expect(session.cancelRequested.value).toBe(false);

    session.cancel();

    expect(hasLog(session, "当前没有在跑的任务")).toBe(true);
    expect(session.cancelRequested.value).toBe(false);
    expect(session.running.value).toBe(false);
    expect(session.state.value).toBe(before);
  });

  it("串行搜索是原子的：开跑后立刻取消也拦不住 —— 结果照常落地、不会被记成取消", async () => {
    // ⚠️ 钉的是**限制**而不是功能。依据：``Searcher.searchNearest`` 只在发起 C 调用
    // **之前**查一次 ``cancelToken``（``core/search.ts`` 的 ``searchNearest``），
    // 而那条 C 调用是同步的 —— ``run()`` 的同步段一直跑到它返回，事件循环根本没机会
    // 把 ``cancel()`` 插进来。所以「取消」今天只对 worker 池那条路（``worker/pool.ts``
    // 的 ``abort(new Canceled(...))``）有意义；而首发三个场景的 nearLimit 全都低于
    // ``PARALLEL_MIN_STEPS``（1e8），池子压根派不上 ⇒ 界面上按 Esc 属于**预备功能**。
    // 将来谁把某个场景的 nearLimit 抬过 1e8，这条测试会红 —— 那时该改成「取消生效」。
    const session = mkSession();
    session.selectScenario("seed-resolve");
    session.setRuntime(rt, null);
    session.setValue("value", "0.5"); // 浮点反查 = 首发里最慢的一条（实测 ~60 ms）

    const promise = session.run();
    expect(session.running.value).toBe(true);
    session.cancel();
    expect(session.cancelRequested.value).toBe(true);
    expect(hasLog(session, "已请求取消")).toBe(true);

    await promise;

    expect(session.state.value.kind).toBe("done");
    expect(hasLog(session, "#1 已取消")).toBe(false);
    expect(session.cancelRequested.value).toBe(false);
    expect(session.running.value).toBe(false);
    expect(session.progress.value).toBeNull();
  });
});
