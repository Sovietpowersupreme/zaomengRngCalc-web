/**
 * 有效值缓冲（``web/extension/url-seed/src/select.ts``）。
 *
 * 恢复要的是**相邻两次不同的**随机数。游戏会连着发同一个数、两次数之间还会夹进
 * 心跳/广告请求，所以「最后两个值不同的条目」这个规则必须钉死 —— 挑错了顺序
 * （``earlier``/``later`` 反过来）恢复就永远失败，而且失败得很安静。
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUFFER_SIZE,
  ValueBuffer,
  pickLastTwo,
  type CapturedValue,
} from "../extension/url-seed/src/select";

let seq = 0;

/** 造一条缓冲条目（只有 ``value`` 和 ``text`` 参与断言，其余给个合理的默认）。 */
function item(value: number, text = String(value)): CapturedValue {
  seq += 1;
  return {
    value,
    text,
    url: `https://x.com/a?ran=${text}`,
    ts: 1_700_000_000_000 + seq,
    ruleId: "builtin:token",
    ruleName: "保存游戏 get_token",
  };
}

describe("pickLastTwo", () => {
  it("取最后两个不同的值，顺序 = earlier / later", () => {
    const pair = pickLastTwo([item(1), item(2), item(3)]);
    expect(pair?.earlier.value).toBe(2);
    expect(pair?.later.value).toBe(3);
  });

  it("从尾部往前跳过与最后一个同值的（同值连发不算新信息）", () => {
    const pair = pickLastTwo([item(7), item(8), item(9), item(9), item(9)]);
    expect(pair?.earlier.value).toBe(8);
    expect(pair?.later.value).toBe(9);
  });

  it("只看「值」，不管它来自哪条 URL / 哪条规则", () => {
    // 夹在中间的 5 来自另一次请求（例如 flash_* 那些）—— 它同样是同一条 RNG 上的
    // 一次取值，所以理应被当成「较早的那个」，不能因为它「不像是同一类」就跳过。
    const pair = pickLastTwo([item(1207965724), item(5), item(967974830)]);
    expect(pair?.earlier.value).toBe(5);
    expect(pair?.later.value).toBe(967974830);
  });

  it("比的是 value 而不是文本（\"0.5\" 与 \"0.5000\" 是同一个数）", () => {
    const pair = pickLastTwo([item(1, "1"), item(0.5, "0.5"), item(0.5, "0.5000")]);
    expect(pair?.earlier.value).toBe(1);
    expect(pair?.later.text).toBe("0.5000");
  });

  it("凑不齐两个不同的值 → null", () => {
    expect(pickLastTwo([])).toBeNull();
    expect(pickLastTwo([item(3)])).toBeNull();
    expect(pickLastTwo([item(3), item(3), item(3)])).toBeNull();
  });
});

describe("ValueBuffer", () => {
  it("连续同值去重，push 返回 false", () => {
    const buffer = new ValueBuffer();
    expect(buffer.push(item(10))).toBe(true);
    expect(buffer.push(item(10, "10.000"))).toBe(false);
    expect(buffer.size).toBe(1);
    expect(buffer.push(item(11))).toBe(true);
    expect(buffer.size).toBe(2);
  });

  it("lastTwo 直接用得上（这是内容脚本调恢复的唯一入口）", () => {
    const buffer = new ValueBuffer();
    buffer.push(item(1207965724));
    buffer.push(item(967974830));
    const pair = buffer.lastTwo();
    expect(pair?.earlier.value).toBe(1207965724);
    expect(pair?.later.value).toBe(967974830);
  });

  it("超出容量从头部裁（只留最近的）", () => {
    const buffer = new ValueBuffer(3);
    for (const value of [1, 2, 3, 4, 5]) buffer.push(item(value));
    expect(buffer.list().map((entry) => entry.value)).toEqual([3, 4, 5]);
  });

  it("容量至少为 2（否则永远凑不出两个值）", () => {
    const buffer = new ValueBuffer(0);
    buffer.push(item(1));
    buffer.push(item(2));
    buffer.push(item(3));
    expect(buffer.size).toBe(2);
    expect(buffer.lastTwo()?.earlier.value).toBe(2);
  });

  it("list() 是副本，外部改不动内部", () => {
    const buffer = new ValueBuffer();
    buffer.push(item(1));
    const snapshot = buffer.list() as CapturedValue[];
    snapshot.push(item(2));
    expect(buffer.size).toBe(1);
  });

  it("clear() 清空（换页/切换规则时用）", () => {
    const buffer = new ValueBuffer();
    buffer.push(item(1));
    buffer.clear();
    expect(buffer.size).toBe(0);
    expect(buffer.lastTwo()).toBeNull();
  });

  it("默认容量是 50（面板上看得过来）", () => {
    expect(DEFAULT_BUFFER_SIZE).toBe(50);
  });
});
