/**
 * 主线程 ↔ 搜索 Worker 的消息协议。
 *
 * 两侧（`pool.ts` / `search.worker.ts`）**共用这一份类型**，所以协议改动会在
 * 编译期同时炸在发送方和接收方上 —— 这正是把协议单独抽出来的理由。
 *
 * ⚠️ 规格一律以**字典**形式过线（`SeedSpec.toDict()`）：结构化克隆不保留原型，
 * `SeedSpec` 的 class identity 过不去。
 */

/** 一片枚举任务（对应 `SeedSearcher.searchSlice(spec, lo, hi)`）。 */
export interface SliceRequest {
  readonly type: "slice";
  /** 单调递增的任务号；响应原样带回。 */
  readonly id: number;
  /** `SeedSpec.toDict()` 的输出。 */
  readonly spec: Record<string, unknown>;
  /** 左闭。 */
  readonly lo: number;
  /** 右开。 */
  readonly hi: number;
}

/** 探活（顺便用来做「冷启动」：第一条 ping 就会把 wasm 加载起来）。 */
export interface PingRequest {
  readonly type: "ping";
  readonly id: number;
}

/**
 * 一块局部搜索（对应 :func:`nearChunks` 切出来的一个 ``[offset, len]``）。
 *
 * ⚠️ ``seed`` 是**块起点**，不是用户给的起点：主线程先用
 * ``engine.fastNextK(seed, offset)`` 把链跳过 ``offset`` 步，再把结果发过来。
 * 跳步必须在**主线程**算，因为：
 *
 * * 主线程本来就有一份 runtime（``rt.engine``），而每个 worker 再各建一份是为了并行；
 * * worker 只需要知道「从哪开始、扫多少」，不需要知道全局几何，协议因此更小。
 */
export interface NearRequest {
  readonly type: "near";
  /** 单调递增的任务号；响应原样带回。 */
  readonly id: number;
  /** ``SeedSpec.toDict()`` 的输出。 */
  readonly spec: Record<string, unknown>;
  /** 块起点种子（主线程算好的 ``fastNextK(起点, offset)``）。 */
  readonly seed: number;
  /** 这一块的步数（``nearChunks`` 里的 ``len``）。 */
  readonly limit: number;
}

export type PoolRequest = SliceRequest | NearRequest | PingRequest;

/** worker 收到任务后**立刻**回的确认（在同步跑 wasm 之前发出）。 */
export interface AckResponse {
  readonly type: "ack";
  readonly id: number;
}

/**
 * 一片枚举 / 一块局部搜索的结果（`SeedSet` 的可克隆投影）。
 *
 * 两种任务共用一种响应形状 —— 归并时都只需要这五个字段，拆成两份只会让
 * ``onMessage`` 里多一段一模一样的代码。
 */
export interface ResultResponse {
  readonly type: "slice" | "near";
  readonly id: number;
  readonly ok: true;
  readonly seeds: number[];
  readonly head: number;
  readonly truncated: boolean;
  readonly consumed: number | null;
}

export interface PongResponse {
  readonly type: "pong";
  readonly id: number;
}

/** 任务失败（规格不支持、wasm 报错、加载失败……）。 */
export interface ErrorResponse {
  readonly type: "error";
  readonly id: number;
  readonly ok: false;
  readonly name: string;
  readonly message: string;
}

export type PoolResponse = AckResponse | ResultResponse | PongResponse | ErrorResponse;
