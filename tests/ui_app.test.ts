// @vitest-environment happy-dom
/**
 * ``App.vue`` 的**组件测试** —— 补上外壳那一层的回归网（``notes/web-design.md`` §5.7）。
 *
 * 为什么在 ``ui_session.test.ts`` 之外还要有这么一份
 * --------------------------------------------------
 * ``session.ts`` 的测试钉的是「规则」，但**接线**没被钉：把 ``@click`` 接错方法、
 * 把 ``:data-field`` 写错 key、``v-if`` 写成 ``v-show``、弹层忘记分块 —— 这些
 * 全都不会让 ``session`` 的测试变红，却会让用户点了没反应。这个文件的唯一职责
 * 就是钉住「DOM ↔ session」这一层，不重复钉规则。
 *
 * 环境：本文件单独跑在 ``happy-dom`` 上（首行 docblock）。**不改** ``vite.config.ts``
 * 里的全局 ``environment: "node"`` —— 其余 800+ 条测试要跑真的 emscripten wasm，
 * 在浏览器环境里加载 wasm 会走 fetch 分支，那是另一件事。所以这里**不加载 wasm**：
 * 「真后端跑一轮」由 ``ui_session.test.ts``（node 环境）钉住，「结果面板怎么画」
 * 用纯数据快照 :class:`Outcome` 直接喂进去（它本来就是纯数据，§5.6）。
 *
 * ⚠️ 别在这里写死测试条数 / 场景数 / 400 这类数字：一律从源码里导出或就地求值。
 */

import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import "../src/scenarios/index";
import { allScenarios } from "../src/scenarios/registry";
import { Outcome, type InputField, type Scenario } from "../src/scenarios/scenario";
import { textOf } from "../src/ui/form";
import { SEED_CHUNK, type PanelState } from "../src/ui/result";
import { UiSession } from "../src/ui/session";
import App from "../src/ui/App.vue";

/** 分享链接的基地址固定住，免得测到宿主环境的地址。 */
const HREF = "https://example.test/app/index.html";

function mkSession(): UiSession {
  return new UiSession({ href: () => HREF });
}

/** 挂载后的包装器类型（用 ``ReturnType`` 取，免得写死 ``@vue/test-utils`` 的泛型参数）。 */
type Wrapper = ReturnType<typeof mount>;

/** 建会话并挂上 App（挂到 ``document.body``：焦点 / ``querySelector`` 那条路才通）。 */
function mountApp(session: UiSession): Wrapper {
  const wrapper = mount(App, { props: { session }, attachTo: document.body });
  alive.push(wrapper);
  return wrapper;
}

const alive: Wrapper[] = [];

/** 某条测试临时盖在 ``navigator.clipboard`` 上的东西，``afterEach`` 里还回去。 */
let clipboardSaved: PropertyDescriptor | undefined;

beforeEach(() => {
  clipboardSaved = Object.getOwnPropertyDescriptor(navigator, "clipboard");
});

afterEach(() => {
  for (const wrapper of alive.splice(0)) wrapper.unmount();
  document.body.innerHTML = "";
  if (clipboardSaved === undefined) delete (navigator as { clipboard?: unknown }).clipboard;
  else Object.defineProperty(navigator, "clipboard", clipboardSaved);
});

// ------------------------------------------------------------------ 小工具

/** 按按钮上的文字找（比 ``button:nth-child`` 稳）。 */
function buttonByText(wrapper: Wrapper, text: string) {
  const found = wrapper.findAll("button").find((b) => b.text() === text);
  if (found === undefined) {
    throw new Error(`界面上没有「${text}」按钮（现有：${wrapper.findAll("button").map((b) => b.text()).join(" / ")}）`);
  }
  return found;
}

/** 工具栏第一个下拉 = 场景。 */
function scenarioSelect(wrapper: Wrapper) {
  const found = wrapper.findAll("label.pick select")[0];
  if (found === undefined) throw new Error("工具栏里没有场景下拉");
  return found;
}

/** 当前画出来的 ``data-field`` 集合（参数区；工具栏勾选框那段现在是空转的）。 */
function dataFields(wrapper: Wrapper): string[] {
  const keys = new Set<string>();
  for (const el of wrapper.findAll("[data-field]")) {
    const key = el.attributes("data-field");
    if (key !== undefined) keys.add(key);
  }
  return [...keys].sort();
}

function fieldKeys(scenario: Scenario): string[] {
  return scenario
    .schema()
    .fields.map((f) => f.key)
    .sort();
}

function hasLog(session: UiSession, needle: string): boolean {
  return session.log.value.some((line) => line.includes(needle));
}

/** 拿一个「必填、且画在参数区」的字段（工具栏字段全是 bool，不会必填）。 */
function requiredOnForm(): { scenario: Scenario; field: InputField } {
  for (const scenario of allScenarios()) {
    const field = scenario.schema().fields.find((f) => f.required && !f.inToolbar);
    if (field !== undefined) return { scenario, field };
  }
  throw new Error("没有任何场景有「画在参数区的必填字段」—— 这条测试的前提没了");
}

/** 找一个和 ``first`` 字段集**真的不同**的场景（用来验换场景后 DOM 跟着换）。 */
function otherScenarioWithDifferentFields(first: Scenario): Scenario {
  const firstKeys = fieldKeys(first);
  for (const scenario of allScenarios()) {
    if (scenario === first) continue;
    const keys = fieldKeys(scenario);
    if (keys.length !== firstKeys.length || keys.some((k) => !firstKeys.includes(k))) return scenario;
  }
  throw new Error("所有场景的字段集都一样 —— 换场景那条测试没了意义");
}

/** 造一个「已经跑完」的面板快照（不跑 wasm：渲染层只关心 ``Outcome`` 是纯数据）。 */
function doneState(seeds: readonly number[]): PanelState {
  return {
    kind: "done",
    outcome: new Outcome({ seed: seeds[0] ?? 0, distance: 1, backend: "wasm", seeds }),
  };
}

function range(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i + 1);
}

/** 弹层里**已经画出来**的种子个数（只数 ``<pre>``，别把「再显示 400 个」里的 400 数进去）。 */
function seedsInOverlay(wrapper: Wrapper): number {
  let total = 0;
  for (const pre of wrapper.findAll(".modalbody pre")) {
    total += (pre.text().match(/\d+/g) ?? []).length;
  }
  return total;
}

// =========================================================================== 渲染

describe("App · 渲染", () => {
  it("场景下拉列出全部注册场景，当前值 = 会话场景；状态栏写明场景与表单版本", () => {
    const session = mkSession();
    const wrapper = mountApp(session);
    const select = scenarioSelect(wrapper);

    const options = select.findAll("option").map((o) => o.attributes("value"));
    expect(options).toEqual(allScenarios().map((s) => s.key));
    expect((select.element as HTMLSelectElement).value).toBe(session.scenario.value.key);

    const status = wrapper.find(".statusbar").text();
    expect(status).toContain(`场景 ${session.scenario.value.key}`);
    expect(status).toContain(`表单版本 ${session.scenario.value.version}`);
  });

  it("后端下拉只有 wasm 一项，且锁住（Web 侧只有一份产物）", () => {
    const wrapper = mountApp(mkSession());
    const select = wrapper.findAll("label.pick select")[1];
    if (select === undefined) throw new Error("工具栏里没有后端下拉");
    expect(select.findAll("option").map((o) => o.attributes("value"))).toEqual(["wasm"]);
    expect(select.attributes("disabled")).toBeDefined();
  });

  it("参数区把 schema 的每个字段都画出来了（一个不漏、一个不多）", () => {
    const session = mkSession();
    const wrapper = mountApp(session);
    expect(dataFields(wrapper)).toEqual(fieldKeys(session.scenario.value));
    // 现在没有任何字段属于窗口工具栏，所以「参数区」就是全集。
    expect(session.toolbarFields.value).toEqual([]);
  });

  it("没跑过的时候结果面板是「还没有结果」，种子条不出现", () => {
    const wrapper = mountApp(mkSession());
    expect(wrapper.find(".conclusion").text()).toBe("还没有结果");
    expect(wrapper.find(".seedbar").exists()).toBe(false);
    expect(wrapper.find(".kv").exists()).toBe(false);
  });
});

// =========================================================================== 展示值那一栏

describe("App · 目标属性那一栏的红字", () => {
  // 这一栏的文本来自 ``fieldHints``（该属性当前的上下限），填错的那一格由
  // ``fieldHintIssues`` 覆盖成一句原因并加 ``bad``。**只**标填错的那格 ——
  // 旧实现里一个错字会让整栏一起退化成「—」。
  const ITEM = "armors/翼火甲";

  function makingApp(): { session: UiSession; wrapper: Wrapper } {
    const session = mkSession();
    session.selectScenario("making");
    session.setValue("item", ITEM);
    const wrapper = mountApp(session);
    return { session, wrapper };
  }

  function hintCell(wrapper: Wrapper, key: string) {
    const found = wrapper.find(`[data-hint="${key}"]`);
    if (!found.exists()) throw new Error(`界面上没有 ${key} 的展示值格子`);
    return found;
  }

  it("没填错时就是该属性的上下限，且不带 bad", () => {
    const { wrapper } = makingApp();
    const cell = hintCell(wrapper, "target_生命");
    expect(cell.text()).toBe("280~330");
    expect(cell.classes()).not.toContain("bad");
  });

  it("填错一格 → 只有那一格写原因并标红，别的一格原样", async () => {
    const { wrapper } = makingApp();
    await wrapper.find('[data-field="target_生命"]').setValue("abc");
    await nextTick();

    const bad = hintCell(wrapper, "target_生命");
    expect(bad.text()).toBe("无法解析");
    expect(bad.classes()).toContain("bad");

    const ok = hintCell(wrapper, "target_魔法");
    expect(ok.text()).toBe("130~150");
    expect(ok.classes()).not.toContain("bad");
    expect(hintCell(wrapper, "target_防御").text()).toBe("10~12");
  });

  it("超出范围 → 红字写清允许的范围；改回去以后复位", async () => {
    const { wrapper } = makingApp();
    const input = wrapper.find('[data-field="target_生命"]');

    await input.setValue("99999999");
    await nextTick();
    expect(hintCell(wrapper, "target_生命").text()).toBe("超出 280~330");
    expect(hintCell(wrapper, "target_生命").classes()).toContain("bad");

    await input.setValue("");
    await nextTick();
    expect(hintCell(wrapper, "target_生命").text()).toBe("280~330");
    expect(hintCell(wrapper, "target_生命").classes()).not.toContain("bad");
  });

  it("换成没有可随机属性的白板 → 整栏回到「—」（本来就没得显示）", async () => {
    const { wrapper } = makingApp();
    await wrapper.find('[data-field="item"]').setValue("armors/斗战");
    await nextTick();
    for (const key of ["target_生命", "target_魔法", "target_防御"]) {
      const cell = hintCell(wrapper, key);
      expect(cell.text()).toBe("—");
      expect(cell.classes()).not.toContain("bad");
    }
  });
});

// =========================================================================== 小数输入

describe("App · 成长和的小数点", () => {
  // 用户报的 bug：往「成长和」填 6.4，按下 `.` 那个点不出现、光标反而往左退一格。
  // 根因是那一格被画成了 `<input type="number">` —— 小数点能不能打进由**引擎 / locale**
  // 决定，`6.` 这种中间态更是普遍被吞。所以小数一律 `text` + `inputmode="decimal"`，
  // 解析交给 `coerce`（NFKC + `Number`）。这一组钉的就是这个分工。
  function fusionApp(): { session: UiSession; wrapper: Wrapper } {
    const session = mkSession();
    session.selectScenario("fusion");
    const wrapper = mountApp(session);
    return { session, wrapper };
  }

  function hintTextAt(wrapper: Wrapper, key: string): string {
    const found = wrapper.find(`[data-hint="${key}"]`);
    if (!found.exists()) throw new Error(`界面上没有 ${key} 的展示值格子`);
    return found.text();
  }

  it("成长和是文本框，并带小数键盘提示（不是 type=\"number\"）", () => {
    const { wrapper } = fusionApp();
    const input = wrapper.find('[data-field="bagua"]');
    expect(input.attributes("type")).toBe("text");
    expect(input.attributes("inputmode")).toBe("decimal");
  });

  it("整数框照旧 type=\"number\"（别顺手把所有框都改成 text）", () => {
    const { session, wrapper } = fusionApp();
    const field = session.scenario.value.schema().fields.find((f) => f.kind === "int");
    if (field === undefined) throw new Error(`${session.scenario.value.key} 里没有 int 字段`);
    expect(wrapper.find(`[data-field="${field.key}"]`).attributes("type")).toBe("number");
  });

  it("填 6.4 → 会话里的值真的是 6.4，展示值那栏跟着重算", async () => {
    const { session, wrapper } = fusionApp();
    const before = hintTextAt(wrapper, "target_成长");
    expect(before).not.toBe("—");

    await wrapper.find('[data-field="bagua"]').setValue("6.4");
    await nextTick();

    expect(session.raw.value.bagua).toBe("6.4");
    expect(session.inputs.value.bagua).toBe(6.4);
    // 展示值是 `fieldHints` 现算的：能跟着变就说明 6.4 真的进了输入值，
    // 而不是「抛异常 → 回落默认值 → 界面假装没看见」。
    expect(hintTextAt(wrapper, "target_成长")).not.toBe(before);
  });

  it("中文输入法打出的全角「６．４」也能用（NFKC 归一半角）", async () => {
    const { session, wrapper } = fusionApp();
    await wrapper.find('[data-field="bagua"]').setValue("６．４");
    await nextTick();

    expect(session.inputs.value.bagua).toBe(6.4);
  });
});

// =========================================================================== 接线

describe("App · 与 session 的接线", () => {
  it("换场景：下拉一变，参数区的 data-field 立刻换成新场景的字段（旧的消失）", async () => {
    const session = mkSession();
    const first = session.scenario.value;
    const next = otherScenarioWithDifferentFields(first);
    const wrapper = mountApp(session);

    await scenarioSelect(wrapper).setValue(next.key);
    await nextTick();

    expect(session.scenario.value.key).toBe(next.key);
    expect(dataFields(wrapper)).toEqual(fieldKeys(next));
    expect((scenarioSelect(wrapper).element as HTMLSelectElement).value).toBe(next.key);
    // 反向确认：字段集**真的**换了，而不是「两边都是全集」这种假绿。
    expect(dataFields(wrapper)).not.toEqual(fieldKeys(first));
  });

  it("切走再切回：参数区的控件值被恢复（不是回到默认）", async () => {
    const session = mkSession();
    const first = session.scenario.value;
    const next = otherScenarioWithDifferentFields(first);
    const wrapper = mountApp(session);
    const field = first.schema().fields.find((f) => f.kind === "int" || f.kind === "float");
    if (field === undefined) throw new Error(`${first.key} 里没有数值字段`);

    await wrapper.find(`[data-field="${field.key}"]`).setValue("123");
    await nextTick();

    await scenarioSelect(wrapper).setValue(next.key);
    await nextTick();
    await scenarioSelect(wrapper).setValue(first.key);
    await nextTick();

    expect(session.scenario.value.key).toBe(first.key);
    expect(session.raw.value[field.key]).toBe("123");
    const input = wrapper.find(`[data-field="${field.key}"]`).element as HTMLInputElement;
    expect(input.value).toBe("123");
  });

  it("改文本框 → session.raw 跟着变（不是只改 DOM）", async () => {
    const session = mkSession();
    const wrapper = mountApp(session);
    const field = session.scenario.value.schema().fields.find((f) => f.kind === "int" || f.kind === "float");
    if (field === undefined) throw new Error(`${session.scenario.value.key} 里没有数值字段`);

    await wrapper.find(`[data-field="${field.key}"]`).setValue("123");

    expect(session.raw.value[field.key]).toBe("123");
    expect(session.inputs.value[field.key]).toBe(123);
  });

  it("勾选框 → session.raw 里是布尔 true（不是字符串 \"true\"）", async () => {
    const session = mkSession();
    const wrapper = mountApp(session);
    const field = session.scenario.value.schema().fields.find((f) => f.kind === "bool");
    if (field === undefined) throw new Error(`${session.scenario.value.key} 里没有布尔字段`);

    await wrapper.find(`[data-field="${field.key}"]`).setValue(true);

    expect(session.raw.value[field.key]).toBe(true);
  });

  it("「重置」把控件值拨回默认值", async () => {
    const session = mkSession();
    const wrapper = mountApp(session);
    const field = session.scenario.value.schema().fields.find((f) => f.kind === "int" || f.kind === "float");
    if (field === undefined) throw new Error(`${session.scenario.value.key} 里没有数值字段`);

    await wrapper.find(`[data-field="${field.key}"]`).setValue("123");
    await buttonByText(wrapper, "重置").trigger("click");
    await nextTick();

    expect(session.raw.value[field.key]).toEqual(textOf(field, field.default));
  });

  it("点「复制分享链接」把分享链接真的交给剪贴板，并给一句反馈", async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          written.push(text);
          return Promise.resolve();
        },
      },
    });

    const session = mkSession();
    const wrapper = mountApp(session);
    const link = session.shareLink();
    expect(link.startsWith(`${HREF}#/`)).toBe(true);

    await buttonByText(wrapper, "复制分享链接").trigger("click");
    await nextTick();

    expect(written).toEqual([link]);
    expect(wrapper.find(".flash").text()).toBe("已复制到剪贴板");
  });

  it("点「查后端」把后端信息写进日志，并切到「日志」页（否则停在结果页看不到反应）", async () => {
    const wrapper = mountApp(mkSession());
    // 初始在「结果」页。
    expect(wrapper.find(".tabs button.active").text()).toBe("结果");

    await buttonByText(wrapper, "查后端").trigger("click");
    await nextTick();

    // 真写了日志（这条用例不注入 runtime ⇒ runtimeInfo 为空，仍应至少记一行）。
    expect(wrapper.find("pre.log").text().length).toBeGreaterThan(0);
    // 且自动切到「日志」页 —— 对齐 ``window.py::check_backends`` 的 ``self.book.select(1)``。
    expect(wrapper.find(".tabs button.active").text()).toBe("日志");
  });
});

// =========================================================================== 校验 / 运行

describe("App · 校验与运行", () => {
  it("必填留空时点「运行」：日志是「校验未通过（N 项），没有开跑」，坏字段标红，状态停在 idle", async () => {
    const { scenario, field } = requiredOnForm();
    const session = mkSession();
    session.selectScenario(scenario.key);
    session.setValue(field.key, "");
    const wrapper = mountApp(session);

    await buttonByText(wrapper, "运行").trigger("click");
    await nextTick();

    // 日志行前面有 ``#N `` 序号前缀，所以只从中间匹（别写 ``^``）。
    const rejected = session.log.value.find((line) => line.includes("校验未通过"));
    expect(rejected).toBeDefined();
    expect(rejected).toMatch(/校验未通过（\d+ 项），没有开跑$/);
    expect(session.state.value.kind).toBe("idle");
    // 标红的那一格必须能指回出错字段（title = key），不是随便红一个。
    const marked = wrapper.findAll(".bad");
    expect(marked.some((el) => el.attributes("title") === field.key)).toBe(true);
  });

  it("运行中：参数区、场景下拉、运行按钮全锁，取消可用；跑完再放开", async () => {
    const session = mkSession();
    const wrapper = mountApp(session);
    const field = session.scenario.value.schema().fields[0];
    if (field === undefined) throw new Error("场景没有字段");

    session.running.value = true;
    await nextTick();

    expect(buttonByText(wrapper, "运行").attributes("disabled")).toBeDefined();
    expect(buttonByText(wrapper, "重置").attributes("disabled")).toBeDefined();
    expect(buttonByText(wrapper, "取消").attributes("disabled")).toBeUndefined();
    expect(scenarioSelect(wrapper).attributes("disabled")).toBeDefined();
    expect(wrapper.find(`[data-field="${field.key}"]`).attributes("disabled")).toBeDefined();

    session.running.value = false;
    await nextTick();

    expect(buttonByText(wrapper, "运行").attributes("disabled")).toBeUndefined();
    expect(buttonByText(wrapper, "取消").attributes("disabled")).toBeDefined();
  });

  it("有结果时结果面板接上：结论、键值表、种子条、属性预览", async () => {
    const session = mkSession();
    const wrapper = mountApp(session);

    session.state.value = doneState(range(3));
    await nextTick();

    expect(wrapper.find(".conclusion").text()).toBe("找到 3 个种子（最近 1，需消耗 0）");
    expect(wrapper.find(".kv").exists()).toBe(true);
    expect(wrapper.find(".seedbar").text()).toContain("共 3 个");
    expect(wrapper.find(".preview").exists()).toBe(true);
  });

  it("失败时把后端给的原文摆出来，结论是「计算失败」", async () => {
    const session = mkSession();
    const wrapper = mountApp(session);

    session.state.value = { kind: "failed", message: "没有可用的 wasm 后端" };
    await nextTick();

    expect(wrapper.find(".conclusion").text()).toBe("计算失败");
    expect(wrapper.find(".failure").text()).toBe("没有可用的 wasm 后端");
  });

  it("「详情」页只在切过去时才序列化 JSON（§5.6）", async () => {
    const session = mkSession();
    const wrapper = mountApp(session);
    session.state.value = doneState(range(2));
    await nextTick();

    // 结果页上，详情块是 ``v-show`` 藏着且内容为空 —— 没切换就不该算。
    const detailBody = wrapper.findAll(".tabbody")[2];
    if (detailBody === undefined) throw new Error("没有详情页容器");
    expect(detailBody.find("pre").exists()).toBe(false);

    await buttonByText(wrapper, "详情").trigger("click");
    await nextTick();

    expect(detailBody.find("pre").text()).toContain("seeds");
  });
});

// =========================================================================== 弹层

describe("App · 种子全量弹层", () => {
  it("按 400 个一块渲染，「再显示 400 个」逐块放出，放完按钮消失；Esc / 关闭 都能关", async () => {
    const total = SEED_CHUNK * 2 + 7; // 3 块（最后一块不满）
    const session = mkSession();
    const wrapper = mountApp(session);

    session.state.value = doneState(range(total));
    await nextTick();

    expect(wrapper.find(".overlay").exists()).toBe(false);
    await buttonByText(wrapper, "查看全部").trigger("click");
    await nextTick();

    expect(wrapper.find(".overlay").exists()).toBe(true);
    expect(wrapper.find(".modal header").text()).toContain(`全部候选（${total} 个）`);
    expect(seedsInOverlay(wrapper)).toBe(SEED_CHUNK);

    const more = () => wrapper.findAll(".modalbody button").find((b) => /^再显示 \d+ 个$/.test(b.text()));
    const firstMore = more();
    if (firstMore === undefined) throw new Error("第一块之后应该还有「再显示」按钮");

    await firstMore.trigger("click");
    await nextTick();
    expect(seedsInOverlay(wrapper)).toBe(SEED_CHUNK * 2);

    const secondMore = more();
    if (secondMore === undefined) throw new Error("第二块之后应该还有「再显示」按钮");
    await secondMore.trigger("click");
    await nextTick();

    expect(seedsInOverlay(wrapper)).toBe(total);
    expect(more()).toBeUndefined(); // 放完了，按钮该消失

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    expect(wrapper.find(".overlay").exists()).toBe(false);

    // 再打开一次，用「关闭（Esc）」按钮关。
    await buttonByText(wrapper, "查看全部").trigger("click");
    await nextTick();
    expect(wrapper.find(".overlay").exists()).toBe(true);
    await buttonByText(wrapper, "关闭（Esc）").trigger("click");
    await nextTick();
    expect(wrapper.find(".overlay").exists()).toBe(false);
    // 重开时分块数要复位到 1（否则上次放出来的几十块会一直挂着）。
    await buttonByText(wrapper, "查看全部").trigger("click");
    await nextTick();
    expect(seedsInOverlay(wrapper)).toBe(SEED_CHUNK);
  });

  it("弹层里没有结果时也能开（计数写 0，不抛）", async () => {
    const session = mkSession();
    const wrapper = mountApp(session);
    session.state.value = doneState([]);
    await nextTick();

    // 空种子时种子条走的是 SEED_EMPTY 那条分支，「查看全部」本来就不该出现。
    expect(wrapper.find(".seedbar").text()).toContain("局部搜索只给最近的种子");
    expect(wrapper.findAll("button").some((b) => b.text() === "查看全部")).toBe(false);
  });
});

// =========================================================================== 快捷键

describe("App · 快捷键", () => {
  it("F7 触发运行，并拦截默认行为", async () => {
    const { scenario, field } = requiredOnForm();
    const session = mkSession();
    session.selectScenario(scenario.key);
    session.setValue(field.key, "");
    mountApp(session);
    await nextTick();

    const event = new KeyboardEvent("keydown", { key: "F7", cancelable: true });
    window.dispatchEvent(event);
    await nextTick();

    expect(event.defaultPrevented).toBe(true);
    expect(hasLog(session, "校验未通过")).toBe(true);
  });

  it("别的键（以及空闲时的 Esc）不拦 —— 不能把页面上的普通按键全吃掉", async () => {
    mountApp(mkSession());
    await nextTick();

    const f6 = new KeyboardEvent("keydown", { key: "F6", cancelable: true });
    window.dispatchEvent(f6);
    const esc = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    window.dispatchEvent(esc);
    await nextTick();

    expect(f6.defaultPrevented).toBe(false);
    expect(esc.defaultPrevented).toBe(false);
  });
});

// =========================================================================== 滚动锁死

describe("App · 外壳滚动锁死", () => {
  /**
   * 老内核 phantom 溢出回归网：``.shell`` / window 一旦被编程滚动，整个外壳就出视口
   * （Chromium 70 实测）。这三条钉住：焦点只滚**字段所在窗格**，外壳与 window 恒回 0。
   *
   * ``happy-dom`` 没有布局引擎，``getBoundingClientRect`` 全 0、``scrollTop`` 恒 0 ——
   * 所以整组先把 ``requestAnimationFrame`` 存根掉（rAF 轮询兜底在现代内核上是「恒 0 ⇒
   * 零写入」，存根等价），再给参与断言的盒子逐个垫上假的几何/滚动位置。
   */
  let realRaf: typeof window.requestAnimationFrame;
  let realCancelRaf: typeof window.cancelAnimationFrame;

  beforeEach(() => {
    realRaf = window.requestAnimationFrame;
    realCancelRaf = window.cancelAnimationFrame;
    window.requestAnimationFrame = ((): number => 1) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = (() => {}) as typeof window.cancelAnimationFrame;
  });

  afterEach(() => {
    window.requestAnimationFrame = realRaf;
    window.cancelAnimationFrame = realCancelRaf;
    Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
    Object.defineProperty(window, "scrollX", { value: 0, configurable: true });
  });

  /** 临时盖掉 ``window.scrollY``（``scrollX`` 恒 0：只看竖直方向就够）。 */
  function stubWindowScrollY(value: number): void {
    Object.defineProperty(window, "scrollY", { value, configurable: true });
  }

  /** 把元素的 ``scrollTop`` 换成可读写的假值（happy-dom 恒 0 且只读）。 */
  function stubScrollTop(el: Element, initial: number): { get: () => number } {
    let value = initial;
    Object.defineProperty(el, "scrollTop", {
      get: () => value,
      set: (v: number) => {
        value = v;
      },
      configurable: true,
    });
    return { get: () => value };
  }

  it("焦点只滚字段所在的窗格，绝不滚 .shell 和 window", async () => {
    const { scenario, field } = requiredOnForm();
    const session = mkSession();
    session.selectScenario(scenario.key);
    session.setValue(field.key, ""); // 必填留空 ⇒ 点「运行」会被校验驳回并指向该字段
    const wrapper = mountApp(session);
    await nextTick();

    // 字段所在的窗格：参数区用的是 .scroll（结果页才是 .tabbody）。
    const el = document.querySelector<HTMLElement>(`[data-field="${field.key}"]`);
    if (el === null) throw new Error(`字段 ${field.key} 没画出来`);
    const pane = el.closest(".scroll") ?? el.closest(".tabbody");
    if (pane === null) throw new Error("字段不在 .scroll/.tabbody 窗格里 —— 结构变了，这条测试要重写");
    const shell = wrapper.find(".shell").element;

    // pane top=0/height=100，字段 top=100/height=20 ⇒ 字段中心 110 - 窗格中心 50 = 60。
    Object.defineProperty(pane, "getBoundingClientRect", {
      value: () => ({ top: 0, height: 100 }) as DOMRect,
      configurable: true,
    });
    Object.defineProperty(el, "getBoundingClientRect", {
      value: () => ({ top: 100, height: 20 }) as DOMRect,
      configurable: true,
    });
    const paneScroll = stubScrollTop(pane, 0);
    const shellScroll = stubScrollTop(shell, 40); // 故意非 0：watcher 路径不许碰它
    stubWindowScrollY(12); // window 也不许被碰

    await buttonByText(wrapper, "运行").trigger("click");
    await nextTick();

    expect(hasLog(session, "校验未通过")).toBe(true); // 走的是真实校验驳回链路
    expect(paneScroll.get()).toBeCloseTo(60, 6);
    expect(shellScroll.get()).toBe(40); // .shell 没被滚
    expect(window.scrollY).toBe(12); // window 没被滚
  });

  it("未知字段（DOM 里没有对应 data-field）不滚任何容器", async () => {
    const session = mkSession();
    const wrapper = mountApp(session);
    await nextTick();
    const shellScroll = stubScrollTop(wrapper.find(".shell").element, 7);
    stubWindowScrollY(9);
    const before = shellScroll.get();

    session.focusField.value = "__no_such_field__"; // DOM 里不存在 ⇒ watcher 该直接 return
    await nextTick();

    expect(shellScroll.get()).toBe(before);
    expect(window.scrollY).toBe(9);
  });

  it(".shell / window 的 scroll 事件把位置按回 0", async () => {
    const wrapper = mountApp(mkSession());
    await nextTick();
    const shellScroll = stubScrollTop(wrapper.find(".shell").element, 30);

    wrapper.find(".shell").element.dispatchEvent(new Event("scroll"));
    await nextTick();
    expect(shellScroll.get()).toBe(0);

    stubWindowScrollY(25);
    // happy-dom 的 scrollTo 是空操作；这条只验证「window 的 scroll 监听器真的挂着」——
    // 处理器读 scrollY≠0 会调 scrollTo(0,0)，不抛即为接线正确。
    expect(() => window.dispatchEvent(new Event("scroll"))).not.toThrow();
    await nextTick();
    expect(shellScroll.get()).toBe(0); // shell 不受 window 事件影响
  });
});

// =========================================================================== 分栏

describe("App · 分栏拖动", () => {
  /** 给 ``main.split`` 一个假尺寸（happy-dom 里 ``getBoundingClientRect`` 全是 0）。 */
  function stubSplitGeometry(wrapper: Wrapper, width = 1000): void {
    const main = wrapper.find("main.split").element;
    main.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: width, bottom: 100, width, height: 100, x: 0, y: 0 }) as DOMRect;
    const divider = wrapper.find(".divider").element;
    // happy-dom 未必实现指针捕获；``dragStart`` 会无条件调它。
    divider.setPointerCapture = () => {};
  }

  /** 当前左栏百分比（``flex-basis``）。**不**按字符串比 —— ``0.28 * 100`` 是 ``28.000000000000004``。 */
  function basisPercent(wrapper: Wrapper): number {
    const style = wrapper.find("section.params").attributes("style") ?? "";
    const matched = /flex-basis:\s*([\d.]+)%/.exec(style);
    if (matched === null) throw new Error(`没读到 flex-basis：${style}`);
    return Number(matched[1]);
  }

  it("拖动按比例走，但被夹在 28% ~ 72% 之间", async () => {
    const wrapper = mountApp(mkSession());
    stubSplitGeometry(wrapper);
    const divider = wrapper.find(".divider");

    divider.element.dispatchEvent(new MouseEvent("pointerdown", { clientX: 520 }));
    divider.element.dispatchEvent(new MouseEvent("pointermove", { clientX: 400 }));
    await nextTick();
    expect(basisPercent(wrapper)).toBeCloseTo(40, 6);

    divider.element.dispatchEvent(new MouseEvent("pointermove", { clientX: -9999 }));
    await nextTick();
    expect(basisPercent(wrapper)).toBeCloseTo(28, 6);

    divider.element.dispatchEvent(new MouseEvent("pointermove", { clientX: 9999 }));
    await nextTick();
    expect(basisPercent(wrapper)).toBeCloseTo(72, 6);

    // 松手之后再动鼠标不该继续改宽度。
    divider.element.dispatchEvent(new MouseEvent("pointerup", { clientX: 0 }));
    divider.element.dispatchEvent(new MouseEvent("pointermove", { clientX: 500 }));
    await nextTick();
    expect(basisPercent(wrapper)).toBeCloseTo(72, 6);
  });

  it("没按下就移动：不改宽度（拖拽要有起点）", async () => {
    const wrapper = mountApp(mkSession());
    stubSplitGeometry(wrapper);
    const before = basisPercent(wrapper);

    wrapper.find(".divider").element.dispatchEvent(new MouseEvent("pointermove", { clientX: 900 }));
    await nextTick();

    expect(basisPercent(wrapper)).toBeCloseTo(before, 6);
  });
});
