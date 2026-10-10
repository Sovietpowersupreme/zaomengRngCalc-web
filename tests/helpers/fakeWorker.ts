/**
 * 进程内的假 Worker —— 给 `src/worker/pool.ts` 的测试用（`worker_pool.test.ts`
 * 与 `scenario_pool.test.ts` 共用）。
 *
 * ⚠️ 真的 `Worker` 在 node 里跑不起来（`search.worker.ts` 顶层就
 * `self.addEventListener`），所以这里注入一个假的：它守着一条 Promise 链模拟
 * 「一槽一任务、串行处理」，干的事与真 worker 一模一样
 * （`specFromDict` → `searchNear`/`searchSlice` → 回 `seeds/head/truncated/consumed`），
 * 还照协议先发 `ack`。
 *
 * 于是测的是**池子的调度与归并**（分片下标归位、字段与串行逐位一致、取消、
 * 错误回传、终止、并发守卫），真 wasm 行为另有 `searcher.test.ts` 对拍 golden。
 */

import type { WorkerLike } from "../../src/worker/pool";
import type { NearRequest, PoolRequest, PoolResponse, SliceRequest } from "../../src/worker/protocol";
import { specFromDict } from "../../src/core/spec";
import type { WasmRuntime } from "../../src/wasm/runtime";

export type FailOn = (msg: SliceRequest | NearRequest) => Error | null;

export interface FakeWorkerOptions {
  /** 每条任务延迟多少毫秒再回（用来验证「顺序由任务下标决定，不由完成先后决定」）。 */
  delayMs?: number;
  /** 返回非 null 则这条任务以 `error` 回应（`Error.name` 会被跨 realm 复原）。 */
  failOn?: FailOn | null;
  /** `postMessage` 直接抛错（模拟 worker 已经死掉）。 */
  throwOnPost?: boolean;
}

export class FakeWorker implements WorkerLike {
  /** 累计创建了几个（测试里用完记得 `FakeWorker.reset()` 或只看相对值）。 */
  static created = 0;
  /** 最后一条失败消息的文案。 */
  static lastError: string | null = null;

  static reset(): void {
    FakeWorker.created = 0;
    FakeWorker.lastError = null;
  }

  readonly messages: PoolRequest[] = [];
  private readonly listeners: Array<(event: { data: PoolResponse }) => void> = [];
  private chain: Promise<void> = Promise.resolve();
  private dead = false;

  /**
   * 池子挂上的「我自己崩了」钩子（见 `pool.ts::ensureSlots`），与真 `Worker` 同名的两个属性。
   *
   * 声明成 `unknown` 参数是为了让 :meth:`crash` 能直接传一个 `Error` 进来。
   */
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;

  constructor(
    private readonly runtime: WasmRuntime,
    private readonly delayMs = 0,
    private readonly failOn: FailOn | null = null,
    private readonly throwOnPost = false,
  ) {
    FakeWorker.created += 1;
  }

  /** 收到的、类型为 `type` 的消息（`ping` / `slice` / `near`）。 */
  messagesOfType(type: PoolRequest["type"]): PoolRequest[] {
    return this.messages.filter((m) => m.type === type);
  }

  postMessage(message: unknown): void {
    if (this.throwOnPost) throw new Error("postMessage 炸了（模拟 worker 已经死了）");
    const msg = message as PoolRequest;
    this.messages.push(msg);
    // 串行：模拟 worker 单线程 + 一槽一任务。
    this.chain = this.chain.then(() => this.handle(msg));
  }

  addEventListener(_type: "message", listener: (event: { data: PoolResponse }) => void): void {
    this.listeners.push(listener);
  }

  terminate(): void {
    this.dead = true;
  }

  /**
   * 模拟「worker 自己崩了」：走 `onerror` 这条路（收不到响应、也发不出响应）。
   *
   * ⚠️ 不会真的停掉 `chain`：崩了之后池子会 `terminate()` 它，`emit` 就不再往外发了。
   */
  crash(message = "假 worker 崩了"): void {
    this.onerror?.(new Error(message));
  }

  private emit(resp: PoolResponse): void {
    if (this.dead) return;
    for (const listener of this.listeners) listener({ data: resp });
  }

  private async handle(msg: PoolRequest): Promise<void> {
    if (this.dead) return;
    if (msg.type === "ping") {
      this.emit({ type: "pong", id: msg.id });
      return;
    }
    this.emit({ type: "ack", id: msg.id });
    const fail = this.failOn?.(msg) ?? null;
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (fail !== null) {
      FakeWorker.lastError = fail.message;
      this.emit({ type: "error", id: msg.id, ok: false, name: fail.name, message: fail.message });
      return;
    }
    const spec = specFromDict(msg.spec);
    // 与真 worker（`search.worker.ts` 的 `handleMessage`）同一条分支规则。
    if (msg.type === "near") {
      const found = this.runtime.searcher.searchNear(msg.seed, spec, msg.limit);
      this.emit({
        type: "near",
        id: msg.id,
        ok: true,
        seeds: [...found.seeds],
        head: found.head,
        truncated: found.truncated,
        consumed: found.consumed,
      });
      return;
    }
    const found = this.runtime.searcher.searchSlice(spec, msg.lo, msg.hi);
    this.emit({
      type: "slice",
      id: msg.id,
      ok: true,
      seeds: [...found.seeds],
      head: found.head,
      truncated: found.truncated,
      consumed: found.consumed,
    });
  }
}

/** :class:`SearchPool` 的 `createWorker` 工厂（每个槽一个假 worker）。 */
export function makeFakeFactory(
  runtime: WasmRuntime,
  options: FakeWorkerOptions = {},
): (index: number) => WorkerLike {
  return (_index: number) =>
    new FakeWorker(runtime, options.delayMs ?? 0, options.failOn ?? null, options.throwOnPost ?? false);
}
