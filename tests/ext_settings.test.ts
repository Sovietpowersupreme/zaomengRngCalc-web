// @vitest-environment happy-dom
/**
 * 设置页（``web/extension/url-seed/src/settings.ts``）里「后移次数」这一格。
 *
 * 环境：本文件单独跑在 ``happy-dom`` 上（首行 docblock，与 ``ext_dom.test.ts`` 同款）
 * —— 全局 ``environment`` 是 ``node``。
 *
 * 为什么能在这里跑：``storage.ts`` 对 ``chrome`` 的缺失是**显式兜底**的
 * （``area()`` 返回 ``null`` ⇒ 读到的全是默认值 ⇒ ``loadRules()`` 给内置规则），
 * 站点列表在 node 下是空数组（``renderSites`` 第一件事就是早退，碰不到
 * ``chrome.permissions``）。所以整页能在 happy-dom 里正常渲染，不需要任何 mock。
 *
 * 这里只钉「后移次数」这一个控件 —— 整页的其余部分属于既有行为，不在本次改动范围。
 */

import { beforeEach, describe, expect, it } from "vitest";
import { MAX_FASTNEXT } from "../extension/url-seed/src/rules";
import { mountSettings } from "../extension/url-seed/src/settings";

let root: HTMLElement;

beforeEach(() => {
  root = document.createElement("main");
});

/** 渲染设置页，返回挂载点。 */
async function mount(): Promise<HTMLElement> {
  await mountSettings(root);
  return root;
}

/** 取某条规则的卡片。 */
function card(id: string): HTMLElement {
  const node = root.querySelector(`[data-rule-id="${id}"]`);
  if (node === null) throw new Error(`渲染出来的卡片里没有 ${id}`);
  return node as HTMLElement;
}

/** 取卡片里 label 文案等于 ``label`` 的那一行（``.field``）。 */
function fieldOf(ruleId: string, label: string): HTMLElement | null {
  const fields = Array.from(card(ruleId).querySelectorAll<HTMLElement>(".field"));
  return fields.find((item) => item.querySelector("label")?.textContent === label) ?? null;
}

/** 取那一行里的 ``<input>``（「类型」那一格是 ``<select>``，所以另有 fieldOf）。 */
function inputOf(ruleId: string, label: string): HTMLInputElement | null {
  return fieldOf(ruleId, label)?.querySelector("input") ?? null;
}

/** 卡片当前是否被判为「有问题」（设置页用 ``.bad`` 标红）。 */
function isBad(ruleId: string): boolean {
  return card(ruleId).classList.contains("bad");
}

/** 卡片底部那一列校验结论的文本。 */
function problems(ruleId: string): string {
  return card(ruleId).querySelector(".problems")?.textContent ?? "";
}

/** 在输入框里打字（触发 ``input`` 事件 = 用户真的改了值）。 */
function type(input: HTMLInputElement, text: string): void {
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** 点「预览」并读回预览结论。 */
function preview(ruleId: string): string {
  const button = Array.from(card(ruleId).querySelectorAll("button")).find((item) => item.textContent === "预览");
  if (button === undefined) throw new Error("没有「预览」按钮");
  button.dispatchEvent(new Event("click", { bubbles: true }));
  return card(ruleId).querySelector(".preview-out")?.textContent ?? "";
}

describe("设置页的「后移次数」", () => {
  it("四条内置采集规则都渲染出这一格且值为出厂值；「忽略」规则没有这一格", async () => {
    await mount();
    const expected: Array<[string, string]> = [
      ["builtin:token", "0"],
      ["builtin:flash-ctrl", "0"],
      ["builtin:flash-ad", "0"],
      // 斗部群星那条流程里，get_time 端出随机数之后游戏还要再走 2 步。
      ["builtin:get-time", "2"],
    ];
    for (const [id, value] of expected) {
      const input = inputOf(id, "后移次数");
      expect(input, id).not.toBeNull();
      expect(input?.value, id).toBe(value);
      expect(input?.type, id).toBe("number");
      expect(input?.getAttribute("min"), id).toBe("0");
      expect(input?.getAttribute("max"), id).toBe(String(MAX_FASTNEXT));
    }
    // 「忽略」规则没有采集/公式，自然也没有后移次数（它只有「匹配 URL」+「类型」两行）。
    expect(fieldOf("builtin:entries", "后移次数")).toBeNull();
    expect(fieldOf("builtin:entries", "提取")).toBeNull();
    expect(fieldOf("builtin:entries", "类型")?.querySelector("select")).not.toBeNull();
  });

  it("输入 3 就地改（不重渲染 ⇒ 同一份 DOM），预览里出现「FastNext 3 次」", async () => {
    await mount();
    const input = inputOf("builtin:token", "后移次数");
    const before = preview("builtin:token");
    expect(before).toContain("随机整数");
    expect(before).not.toContain("FastNext");

    type(input as HTMLInputElement, "3");
    // 同一份 DOM：值还在框里（重渲染会把整张卡片换掉、输入框也会回落到 0）。
    expect(inputOf("builtin:token", "后移次数")).toBe(input);
    expect(input?.value).toBe("3");
    expect(isBad("builtin:token")).toBe(false);
    expect(preview("builtin:token")).toContain("FastNext 3 次");
  });

  it("越界值不静默纠正：框里留着用户写的东西，卡片标红并说明原因", async () => {
    await mount();
    const input = inputOf("builtin:token", "后移次数") as HTMLInputElement;

    type(input, "-3");
    expect(input.value).toBe("-3"); // 没被悄悄夹成 0
    expect(isBad("builtin:token")).toBe(true);
    expect(problems("builtin:token")).toContain("负数");

    type(input, String(MAX_FASTNEXT + 1));
    expect(isBad("builtin:token")).toBe(true);
    expect(problems("builtin:token")).toContain("最多");

    type(input, "1.5");
    expect(isBad("builtin:token")).toBe(true);
    expect(problems("builtin:token")).toContain("整数");

    type(input, "3");
    expect(isBad("builtin:token")).toBe(false);
    expect(problems("builtin:token")).toContain("规则可用");
  });

  it("清空 = 0（框里可以空着，但规则已经回到不后移）", async () => {
    await mount();
    const input = inputOf("builtin:token", "后移次数") as HTMLInputElement;
    type(input, "4");
    expect(preview("builtin:token")).toContain("FastNext 4 次");

    type(input, "");
    expect(isBad("builtin:token")).toBe(false); // 空值不是错误
    expect(preview("builtin:token")).not.toContain("FastNext");
  });

  it("其它字段照旧：改「后移次数」不会碰坏同一条规则的公式", async () => {
    await mount();
    const formula = inputOf("builtin:token", "换算公式") as HTMLInputElement;
    expect(formula.value).toContain("100000");
    type(inputOf("builtin:token", "后移次数") as HTMLInputElement, "2");
    expect(formula.value).toContain("100000");
    expect(formula.value).toBe(inputOf("builtin:token", "换算公式")?.value);
  });
});
