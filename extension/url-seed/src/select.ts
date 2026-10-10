/**
 * **有效值缓冲** —— 从「观察到的 URL 流」里挑出恢复要用的那两个数。
 *
 * 恢复（``resolveCandidates(0, arg1, arg2)``）需要**相邻两次**的随机数：较早那个
 * （``arg1``）拿去 ``recoverSeeds`` 反演候选种子，较晚那个（``arg2``）用来筛。
 * 但页面会在两次数之间塞进来一堆别的请求（心跳、广告、别的模块的 ``ran``），
 * 而且游戏**经常连着发同一个数**。
 *
 * 所以这里的规则是两条，都很直白：
 *
 * 1. **连续同值只留一条**（``push`` 返回 ``false``）。同值连发不构成新信息；
 * 2. **取最后两个「值不同」的条目**（:meth:`ValueBuffer.lastTwo`），从尾部往前扫，
 *    跳过和最后一个相同的值。返回的 ``earlier``/``later`` 顺序就是
 *    ``arg1``/``arg2`` 的顺序。
 *
 * 缓冲有上限（默认 50 条），只留最近的 —— 面板要显示它们，但没人想看一千条。
 */

/** 一条被采纳的随机数（带着它的出处，便于面板上核对）。 */
export interface CapturedValue {
  /** 换算出的 31 位随机整数。 */
  readonly value: number;
  /** 提取到的原文（``"48363.584419712424"``）。 */
  readonly text: string;
  /** 来自哪条 URL。 */
  readonly url: string;
  /** ``Date.now()``。 */
  readonly ts: number;
  readonly ruleId: string;
  readonly ruleName: string;
}

/** 「较早 / 较晚」两个不同的值 —— 正好是 ``resolveCandidates`` 的 ``arg1``/``arg2``。 */
export interface ValuePair {
  /** 较早那次（= ``resolveCandidates`` 的 ``randomInt``）。 */
  readonly earlier: CapturedValue;
  /** 较晚那次（= ``resolveCandidates`` 的 ``target``）。 */
  readonly later: CapturedValue;
}

/** 默认缓冲上限。 */
export const DEFAULT_BUFFER_SIZE = 50;

/**
 * 从一条**时间序**列表里挑「最后两个不同的值」。纯函数，单测直接打它。
 *
 * ``null`` = 凑不齐两个不同的值。
 */
export function pickLastTwo(values: readonly CapturedValue[]): ValuePair | null {
  if (values.length < 2) return null;
  const later = values[values.length - 1];
  if (later === undefined) return null;
  for (let i = values.length - 2; i >= 0; i -= 1) {
    const earlier = values[i];
    if (earlier === undefined) break;
    // ⚠️ 比的是 **value** 而不是文本：``"0.5"`` 与 ``"0.5000"`` 是同一个随机数。
    if (earlier.value !== later.value) return { earlier, later };
  }
  return null;
}

/** 有效值缓冲（内容脚本里一条流一份）。 */
export class ValueBuffer {
  private readonly items: CapturedValue[] = [];
  private readonly capacity: number;

  constructor(capacity: number = DEFAULT_BUFFER_SIZE) {
    this.capacity = Math.max(2, Math.trunc(capacity));
  }

  /**
   * 追加一条。
   *
   * @returns ``false`` 表示「与上一条同值，被去重了」—— 调用方可以据此跳过重算。
   */
  push(item: CapturedValue): boolean {
    const last = this.items[this.items.length - 1];
    if (last !== undefined && last.value === item.value) return false;
    this.items.push(item);
    // 只从头部裁（``splice(0, n)`` 而不是 ``shift()`` 循环，一次搬完）。
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
    return true;
  }

  /** 时间序快照（副本，外部改不动内部）。 */
  list(): readonly CapturedValue[] {
    return [...this.items];
  }

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
  }

  /** 恢复要用的那两个值；凑不齐返回 ``null``。 */
  lastTwo(): ValuePair | null {
    return pickLastTwo(this.items);
  }
}
