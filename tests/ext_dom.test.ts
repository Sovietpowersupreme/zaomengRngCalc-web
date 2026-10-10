// @vitest-environment happy-dom
/**
 * 扩展的 DOM 小工具（``web/extension/url-seed/src/dom.ts``）。
 *
 * 环境：本文件单独跑在 ``happy-dom`` 上（首行 docblock）。**不改** ``vite.config.ts``
 * 的全局 ``environment: "node"`` —— 只有这里真的需要 DOM。
 *
 * ⚠️ 这里**抓不到**那个真出过的 bug：``clear()`` 曾经用 ``ParentNode.replaceChildren``
 * （Chrome **86**+）实现，Chromium 70 上直接 ``TypeError``，于是 popup 全白、设置页
 * 只剩外壳、面板数字列表永远空。happy-dom（以及 node 里任何一个 DOM 垫片）**都实现了**
 * ``replaceChildren``，所以行为测试在这里恒绿 —— 钉住那个约束的是
 * ``tests/legacy_gate.test.ts`` 的 ``FORBIDDEN_API``：它去扫**构建产物**里的字节，
 * 只要 bundle 里出现 ``replaceChildren`` 就红。
 *
 * 所以本文件的职责是另一半：钉**语义**。
 *
 * * ``clear`` 真的把子节点（含纯文本节点）清干净，空容器上不抛；
 * * ``replace`` = 清空 + 按序追加，且 ``null`` / ``undefined`` 必须被**显式跳过**
 *   —— ``append(null)`` 会插入字面量 ``"null"``，界面会莫名其妙多出一行 "null"；
 * * ``el`` 同理（同一个坑，两个入口）。
 */

import { beforeEach, describe, expect, it } from "vitest";
import { clear, el, mustFind, readValue, replace } from "../extension/url-seed/src/dom";

let host: HTMLElement;

beforeEach(() => {
  document.body.replaceChildren();
  host = el("div", { attrs: { id: "host" } });
  document.body.append(host);
});

describe("clear", () => {
  it("清掉元素子节点", () => {
    host.append(el("span", { text: "a" }), el("span", { text: "b" }));
    expect(host.childNodes.length).toBe(2);
    clear(host);
    expect(host.childNodes.length).toBe(0);
  });

  it("清掉纯文本节点（旧的 clear 只 removeChild 元素就会漏）", () => {
    host.append("裸文本", el("span", { text: "x" }));
    clear(host);
    expect(host.childNodes.length).toBe(0);
    expect(host.textContent).toBe("");
  });

  it("空容器上不抛，且可反复调用（每次重渲染都会先 clear）", () => {
    expect(() => clear(host)).not.toThrow();
    expect(() => clear(host)).not.toThrow();
    expect(host.childNodes.length).toBe(0);
  });

  it("不碰兄弟节点", () => {
    const sibling = el("div", { text: "留着" });
    document.body.append(sibling);
    host.append(el("span", { text: "a" }));
    clear(host);
    expect(sibling.childNodes.length).toBe(1);
  });

  it("清空后还能继续用（clear → append → clear）", () => {
    host.append(el("span", { text: "第一轮" }));
    clear(host);
    host.append(el("span", { text: "第二轮" }));
    expect(host.textContent).toBe("第二轮");
    clear(host);
    expect(host.textContent).toBe("");
  });
});

describe("replace", () => {
  it("替换掉旧内容（不是追加）", () => {
    host.append(el("span", { text: "旧" }));
    replace(host, el("span", { text: "新" }));
    expect(host.childNodes.length).toBe(1);
    expect(host.textContent).toBe("新");
  });

  it("保持传入顺序", () => {
    replace(host, el("span", { text: "1" }), el("span", { text: "2" }), el("span", { text: "3" }));
    expect(host.textContent).toBe("123");
  });

  it("跳过 null / undefined，且不插入字面量 \"null\"", () => {
    replace(host, null, el("span", { text: "a" }), undefined, el("span", { text: "b" }), null);
    expect(host.childNodes.length).toBe(2);
    expect(host.textContent).toBe("ab");
    expect(host.textContent).not.toContain("null");
    expect(host.textContent).not.toContain("undefined");
  });

  it("只传空值 = 纯清空", () => {
    host.append(el("span", { text: "旧" }));
    replace(host, null, undefined);
    expect(host.childNodes.length).toBe(0);
  });

  it("可以放字符串（当纯文本，不当 HTML）", () => {
    replace(host, "<b>不是标签</b>");
    expect(host.childNodes.length).toBe(1);
    expect(host.querySelector("b")).toBeNull();
    expect(host.textContent).toBe("<b>不是标签</b>");
  });
});

describe("el", () => {
  it("空值子节点同样被跳过（和 replace 同一个坑）", () => {
    const node = el("div", {}, null, el("span", { text: "a" }), undefined);
    expect(node.childNodes.length).toBe(1);
    expect(node.textContent).toBe("a");
  });

  it("text 走 textContent，不解析 HTML", () => {
    const node = el("div", { text: "<i>x</i>" });
    expect(node.querySelector("i")).toBeNull();
    expect(node.textContent).toBe("<i>x</i>");
  });

  it("attrs / on 生效", () => {
    let clicked = 0;
    const node = el("button", {
      text: "点",
      attrs: { "data-field": "seed" },
      on: { click: () => { clicked += 1; } },
    });
    expect(node.getAttribute("data-field")).toBe("seed");
    node.click();
    expect(clicked).toBe(1);
  });

  it("checked / disabled / placeholder 只落在对应的 input 上", () => {
    const box = el("input", { type: "checkbox", checked: true, disabled: true });
    expect((box as HTMLInputElement).checked).toBe(true);
    expect(box.disabled).toBe(true);
    const area = el("textarea", { rows: 4, placeholder: "hint", value: "v" });
    // ⚠️ happy-dom 的 ``rows`` 是**字符串**（真浏览器里是 number）。``Number()`` 两边都对，
    // 断言这种垫片差异不值得写进被测代码里。
    expect(Number((area as HTMLTextAreaElement).rows)).toBe(4);
    expect((area as HTMLTextAreaElement).placeholder).toBe("hint");
  });
});

describe("mustFind / readValue", () => {
  it("找得到就返回元素本身", () => {
    expect(mustFind("host")).toBe(host);
  });

  it("找不到就抛，且错误里带上 id（HTML 与脚本对不上时要一眼看出来）", () => {
    expect(() => mustFind("nope")).toThrow(/nope/);
  });

  it("readValue 读 input / textarea / select 的当前值", () => {
    const input = el("input", { value: "123" });
    input.value = "456";
    expect(readValue(input)).toBe("456");
    expect(readValue(el("textarea", { value: "abc" }))).toBe("abc");
  });
});
