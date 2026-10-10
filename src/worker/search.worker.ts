/**
 * 搜索 Worker —— 「一个 worker 一个 wasm runtime」。
 *
 * 为什么必须这样切：wasm 侧**不可重入**。`cracker.c` 用的是模块级静态缓冲
 * （`g_scratch`、`g_seeds`、`uRange`/`fRange` 的落点、`crack2` 的环形缓冲状态），
 * 同一个 runtime 上的两次 `*_slice` 调用一旦交错就会互相踩。浏览器主线程里
 * 唯一能真正并行的办法就是开多个 worker，**各自 `createRuntime()` 一份**
 * （emscripten 的 wasm 实例是每个 realm 一份，互不共享内存）。
 *
 * 协议：主线程发 `slice` / `near` / `ping`，worker 回 `slice` / `near` / `pong` / `error`
 * （形状见 :mod:`./protocol`，两侧都用同一份类型）。
 *
 * ⚠️ 消息是**串行**处理的：本文件里的 handler 只在 `getRuntime()` 那次 `await`
 * 上让出控制权，一旦开始 `searchSlice` 就是同步跑到底，所以不会有两片交错。
 *
 * ⚠️ 规格必须**以字典形式**传进来（`SeedSpec` 是 class，结构化克隆会丢掉原型，
 * 到了这头就只剩一个普通对象）。因此 worker 侧必须 `specFromDict()` 还原，
 * 并按 `JSON.stringify` 缓存解析结果 —— 一片一次解析 250 条约束是纯浪费。
 */
// ⚠️ 必须是第一条 import：worker 里也要在 `cracker.mjs` 求值前补上 `globalThis`
// （Chromium 70 上没有它）。单文件版本里这段 worker 源码是**内联**的，顺序同样成立。
import "../polyfills";
import { specFromDict, type SeedSpec } from "../core/spec";
import { createRuntime, type WasmRuntime } from "../wasm/runtime";
import { isWasmVariant, setChosenVariant } from "../wasm/variant";
import type { PoolRequest, PoolResponse } from "./protocol";

/**
 * worker 全局的最小形状。
 *
 * ⚠️ 不用 `/// <reference lib="webworker" />`：那会和 `tsconfig` 里的 `DOM` 撞车
 * （`MessageEvent`/`Worker` 等重复声明）。本文件是模块，顶层 `declare const self`
 * 只在模块作用域生效，覆盖吊诡的 `Window & typeof globalThis` 只会让类型更准。
 */
interface WorkerScope {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  close(): void;
}
declare const self: WorkerScope;

let loading: Promise<WasmRuntime> | null = null;

/** 按 `JSON.stringify(spec)` 缓存解析结果（一片一次足够）。 */
const specCache = new Map<string, SeedSpec>();

/**
 * 懒加载唯一的 wasm runtime。
 *
 * ⚠️ wasm 的位置现在由 `wasm/variant.ts` 统一决定（它把 `?url` 相对 `import.meta.url`
 * 解成绝对 URL，而本文件所在的 worker 块里那就是 worker 脚本自己的目录）。
 * 这里**不再**自己传 `locateFile` —— 那等于告诉 `runtime.ts`「我自己指定位置」，
 * 变体选择（modern 不行退 mvp）会整个被跳过。
 *
 * ⚠️ 失败时把缓存清掉（否则一条 rejected 的 promise 会永久毒住后续所有消息），
 * 这样下一条消息还有机会重试（大概率还是失败，但报错会再带上一次上下文）。
 */
function getRuntime(): Promise<WasmRuntime> {
  loading ??= createRuntime({ quiet: true }).catch((err: unknown) => {
    loading = null;
    throw err;
  });
  return loading;
}

function specOf(dict: Record<string, unknown>): SeedSpec {
  const key = JSON.stringify(dict);
  let spec = specCache.get(key);
  if (spec === undefined) {
    spec = specFromDict(dict);
    specCache.set(key, spec);
  }
  return spec;
}

function errorInfo(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "Error", message: String(err) };
}

/** 处理一条消息并回一条响应（导出出来是为了能单测，不用真的起 worker）。 */
export async function handleMessage(msg: PoolRequest): Promise<PoolResponse> {
  try {
    // 主线程已经定过结论就照办（`fromPeer` 保证不会覆盖本地已加载成功的那个）。
    if (isWasmVariant(msg.variant)) setChosenVariant(msg.variant, true);
    if (msg.type === "ping") return { type: "pong", id: msg.id };
    const rt = await getRuntime();
    const spec = specOf(msg.spec);
    // 两种任务只差「调哪个方法」：`slice` 扫种子区间，`near` 扫一条链的一小块。
    // 归并都在主线程按任务顺序做，worker 不关心自己排第几。
    const found =
      msg.type === "slice"
        ? rt.searcher.searchSlice(spec, msg.lo, msg.hi)
        : rt.searcher.searchNear(msg.seed, spec, msg.limit);
    return {
      type: msg.type,
      id: msg.id,
      ok: true,
      seeds: [...found.seeds],
      head: found.head,
      truncated: found.truncated,
      consumed: found.consumed,
    };
  } catch (err) {
    return { type: "error", id: msg.id, ok: false, ...errorInfo(err) };
  }
}

self.addEventListener("message", (event: MessageEvent) => {
  const msg = event.data as PoolRequest;
  // 立刻回一个「收到」，让主线程能在长时间同步计算**之前**知道 worker 活着。
  if (msg.type !== "ping") self.postMessage({ type: "ack", id: msg.id } satisfies PoolResponse);
  void handleMessage(msg).then((resp) => self.postMessage(resp));
});
