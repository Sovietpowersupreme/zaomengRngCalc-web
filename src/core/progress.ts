/**
 * ``src_forge/core/progress.py`` 的 TS 版：进度 / 取消 / 限流。
 *
 * 与 Python 的差别（只有一处，别当成遗漏）：
 * * Python 的 :class:`CancelToken` 包的是 ``threading.Event``（后端跑在自己的线程里）；
 *   Web 侧没有「另一个线程里阻塞等待」这回事 —— 取消来自 ``postMessage``、
 *   或者干脆是 ``Worker.terminate()``，所以这里只是一个**布尔标志**，
 *   由 worker 的消息循环置位、由搜索循环检查。
 */

import { Canceled } from "./errors";

/** 一次进度上报。 */
export class Progress {
  constructor(
    /** 已完成的工作量（单位由 :attr:`unit` 决定）。 */
    readonly done = 0,
    /** 总工作量；``0`` 表示未知。 */
    readonly total = 0,
    /** 人类可读的一行描述。 */
    readonly message = "",
    /** ``"uv"``（枚举了多少个种子）或 ``"shard"``（跑完几个分片）。 */
    readonly unit = "uv",
  ) {}

  get fraction(): number {
    if (this.total <= 0) return 0;
    const value = this.done / this.total;
    return value < 0 ? 0 : value > 1 ? 1 : value;
  }

  get percent(): number {
    return this.fraction * 100;
  }

  toString(): string {
    if (this.total > 0) return `${this.message} ${this.done}/${this.total} (${this.percent.toFixed(1)}%)`;
    return `${this.message} ${this.done}`;
  }
}

export type ProgressCallback = (progress: Progress) => void;

/**
 * 取消标志（单线程版）。
 *
 * ⚠️ 与 Python 不同：**没有** ``wait()`` / 上下文管理器 —— Web 侧的取消是
 * 「消息循环置位 + 搜索循环检查」，用 `with` 那套只会让人以为还能跨线程等。
 */
export class CancelToken {
  private flag = false;

  constructor(init = false) {
    this.flag = init;
  }

  cancel(): void {
    this.flag = true;
  }

  get cancelled(): boolean {
    return this.flag;
  }

  /** 已取消则抛 :class:`Canceled`。 */
  throwIfCancelled(): void {
    if (this.flag) throw new Canceled("搜索已取消");
  }
}

/** 限流包装：把高频回调压到「最多每 ``interval`` 秒一次」。 */
export class Throttle {
  private last = 0;
  private first = true;

  constructor(
    private readonly callback: ProgressCallback | undefined,
    private readonly interval = 0.1,
  ) {}

  call(progress: Progress): void {
    if (!this.callback) return;
    const now = Date.now() / 1000;
    // 首帧与终帧一定放行，中间按时间窗限流。
    if (this.first || now - this.last >= this.interval || progress.fraction >= 1) {
      this.first = false;
      this.last = now;
      this.callback(progress);
    }
  }

  /** 无视限流立即上报（分片边界用）。 */
  force(progress: Progress): void {
    if (!this.callback) return;
    this.last = Date.now() / 1000;
    this.callback(progress);
  }
}

/** 默认分片大小：32MB (1 << 25)，减少消息通信与 Worker 调度开销，提升 wasm 吞吐。 */
export const DEFAULT_SHARD_SIZE = 1 << 25;
