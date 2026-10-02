/**
 * wasm 侧的「内存布局 + 临时内存」层。
 *
 * 为什么需要它：``csrc`` 里的 ``uRange`` / ``fRange`` / ``seedArray`` 都是**按值**
 * 传递的结构体，wasm 的 ABI 不允许 JS 直接构造这种参数（只能传数值 = 内存地址）。
 * 所以 JS 必须：
 *
 * 1. 在静态 scratch 上**手写**结构体字节；
 * 2. 把指针传给 ``wc_*`` 薄壳；
 * 3. 再从 ``seedArray *`` 把结果读回来。
 *
 * ⚠️ 结构体宽度**不要自己算**：一律走 ``wc_sizeof_*`` / ``wc_offsetof_*``
 * （实测值：``uRange`` 260 字节、``fRange`` 520 字节、``seedArray`` 4004 字节，
 * 但代码里只用探针返回值，避免以后 C 侧一改这里就静默错位）。
 */

import { SpecError } from "../core/errors";
import { M32, u32, type U32Pair } from "../core/values";
import type { CrackerModule } from "./cracker.mjs";

// =========================================================================== 布局
export interface URangeLayout {
  readonly size: number;
  readonly min: number;
  readonly max: number;
  readonly num: number;
}

export interface FRangeLayout {
  readonly size: number;
  readonly min: number;
  readonly max: number;
  readonly num: number;
}

export interface SeedArrayLayout {
  readonly size: number;
  readonly data: number;
  readonly len: number;
  readonly seed: number;
}

export interface Layout {
  readonly urange: URangeLayout;
  readonly frange: FRangeLayout;
  readonly seedArray: SeedArrayLayout;
  readonly maxInput: number;
  readonly randPureMax: number;
  readonly seedCap: number;
  readonly scratchBase: number;
  readonly scratchSize: number;
}

/**
 * 调一个「无参 → uint32」的自描述导出。
 *
 * ⚠️ 导出名带 ``_`` 前缀，但 ``ccall`` 要**不带**前缀的名字（实测：
 * ``ccall("_wc_max_input")`` 会抛 ``func is not a function``）。
 * 两条路都留了兜底，这样即使以后 emscripten 的命名策略变化也不会瞎。
 */
function scalar(m: CrackerModule, name: string): number {
  const direct = (m as unknown as Record<string, unknown>)[`_${name}`];
  if (typeof direct === "function") {
    return Number((direct as () => number).call(m));
  }
  return m.ccall(name, "number", [], []);
}

let cachedLayout: Layout | undefined;
let cachedFor: CrackerModule | undefined;

/** 探一次结构体布局，之后缓存（同一个 module 实例才复用）。 */
export function probeLayout(m: CrackerModule): Layout {
  if (cachedLayout && cachedFor === m) return cachedLayout;
  const layout: Layout = {
    urange: {
      size: scalar(m, "wc_sizeof_urange"),
      min: scalar(m, "wc_offsetof_urange_min"),
      max: scalar(m, "wc_offsetof_urange_max"),
      num: scalar(m, "wc_offsetof_urange_num"),
    },
    frange: {
      size: scalar(m, "wc_sizeof_frange"),
      min: scalar(m, "wc_offsetof_frange_min"),
      max: scalar(m, "wc_offsetof_frange_max"),
      num: scalar(m, "wc_offsetof_frange_num"),
    },
    seedArray: {
      size: scalar(m, "wc_sizeof_seedarray"),
      data: scalar(m, "wc_offsetof_seedarray_data"),
      len: scalar(m, "wc_offsetof_seedarray_len"),
      seed: scalar(m, "wc_offsetof_seedarray_seed"),
    },
    maxInput: scalar(m, "wc_max_input"),
    randPureMax: scalar(m, "wc_rand_pure_max"),
    seedCap: scalar(m, "wc_seed_array_cap"),
    scratchBase: scalar(m, "wc_scratch"),
    scratchSize: scalar(m, "wc_scratch_size"),
  };
  cachedLayout = layout;
  cachedFor = m;
  return layout;
}

// =========================================================================== 内存视图
/**
 * 堆视图缓存：**内存增长后必须重取**（``ALLOW_MEMORY_GROWTH=1`` 下 buffer 会换一块）。
 *
 * ⚠️ 构建只导出了 ``HEAPU32`` / ``HEAP32`` / ``HEAPF64``（见 ``build_info.json`` 的
 * ``EXPORTED_RUNTIME_METHODS``），**没有** ``HEAPU8``。字节视图自己从
 * ``HEAPU32.buffer`` 派生即可，不为此重建 wasm。
 */
export class Memory {
  private readonly m: CrackerModule;
  private buffer: ArrayBufferLike;
  private u8: Uint8Array;
  private u32View: Uint32Array;
  private i32View: Int32Array;
  private f64View: Float64Array;

  constructor(m: CrackerModule) {
    this.m = m;
    this.buffer = m.HEAPU32.buffer;
    this.u8 = new Uint8Array(this.buffer);
    this.u32View = m.HEAPU32;
    this.i32View = m.HEAP32;
    this.f64View = m.HEAPF64;
  }

  /** 每次访问前调一次；只在 buffer 换过时才重建视图。 */
  refresh(): void {
    const buffer = this.m.HEAPU32.buffer;
    if (buffer === this.buffer) return;
    this.buffer = buffer;
    this.u8 = new Uint8Array(buffer);
    this.u32View = new Uint32Array(buffer);
    this.i32View = new Int32Array(buffer);
    this.f64View = new Float64Array(buffer);
  }

  get bytes(): Uint8Array {
    this.refresh();
    return this.u8;
  }

  get u32(): Uint32Array {
    this.refresh();
    return this.u32View;
  }

  get i32(): Int32Array {
    this.refresh();
    return this.i32View;
  }

  get f64(): Float64Array {
    this.refresh();
    return this.f64View;
  }

  writeU32(ptr: number, values: ArrayLike<number>, offset = 0): void {
    const view = this.u32;
    const base = (ptr >>> 2) + offset;
    for (let i = 0; i < values.length; i += 1) view[base + i] = u32(values[i] as number);
  }

  readU32(ptr: number, length: number): number[] {
    const view = this.u32;
    const base = ptr >>> 2;
    const out = new Array<number>(length);
    for (let i = 0; i < length; i += 1) out[i] = view[base + i] as number;
    return out;
  }

  readI32(ptr: number): number {
    return this.i32[ptr >>> 2] as number;
  }

  writeF64(ptr: number, values: ArrayLike<number>): void {
    const view = this.f64;
    const base = ptr >>> 3;
    for (let i = 0; i < values.length; i += 1) view[base + i] = Number(values[i]);
  }

  readF64(ptr: number, length: number): number[] {
    const view = this.f64;
    const base = ptr >>> 3;
    const out = new Array<number>(length);
    for (let i = 0; i < length; i += 1) out[i] = view[base + i] as number;
    return out;
  }
}

// =========================================================================== scratch
/**
 * 静态 scratch 的 bump 分配器。
 *
 * ⚠️ 本构建**没有导出 ``_malloc``/``_free``**，JS 侧的临时内存只有这一块
 * 64 KiB（实测 ``wc_scratch_size() == 65536``）。用完即弃；嵌套调用请用
 * :meth:`mark` / :meth:`release` 成对回退，不要指望 GC。
 */
export class Scratch {
  readonly base: number;
  readonly size: number;
  private off = 0;

  constructor(
    private readonly mem: Memory,
    readonly layout: Layout,
  ) {
    this.base = layout.scratchBase;
    this.size = layout.scratchSize;
  }

  /** 当前游标（配合 :meth:`release` 做嵌套回退）。 */
  mark(): number {
    return this.off;
  }

  /** 回退到某个 :meth:`mark`。 */
  release(mark: number): void {
    this.off = mark;
  }

  /** 全部释放。 */
  reset(): void {
    this.off = 0;
  }

  /** 已用字节数（调试用）。 */
  used(): number {
    return this.off;
  }

  alloc(bytes: number, align = 8): number {
    const start = (this.off + (align - 1)) & ~(align - 1);
    const end = start + bytes;
    if (end > this.size) {
      throw new SpecError(
        `wasm scratch 溢出：需要 ${end} 字节，只有 ${this.size} 字节` +
          `（嵌套调用忘了 release？当前游标 ${this.off}）`,
      );
    }
    this.off = end;
    return this.base + start;
  }

  allocU32(count: number): number {
    return this.alloc(Math.max(count, 1) * 4, 4);
  }

  allocI32(count: number): number {
    return this.alloc(Math.max(count, 1) * 4, 4);
  }

  allocF64(count: number): number {
    return this.alloc(Math.max(count, 1) * 8, 8);
  }

  allocURange(): number {
    return this.alloc(this.layout.urange.size, 8);
  }

  allocFRange(): number {
    return this.alloc(this.layout.frange.size, 8);
  }

  allocSeedArray(): number {
    return this.alloc(this.layout.seedArray.size, 8);
  }

  // ------------------------------------------------------------------ 写入
  /**
   * 写一个 ``uRange``（``ts`` 的时间种子区间）。
   *
   * 未使用的槽位与 ctypes 后端一样填「全放行」（``[0, M32]``）—— C 只读
   * ``num`` 个，但填满能让越界读拿到确定性数据，便于对比。
   */
  writeURange(ptr: number, pairs: readonly U32Pair[], num = pairs.length): number {
    const { min, max, num: numOff } = this.layout.urange;
    const slots = this.layout.maxInput;
    const mins = new Array<number>(slots).fill(0);
    const maxs = new Array<number>(slots).fill(M32);
    for (let i = 0; i < Math.min(num, slots); i += 1) {
      const pair = pairs[i] as U32Pair;
      mins[i] = u32(pair.lo);
      maxs[i] = u32(pair.hi);
    }
    this.mem.writeU32(ptr + min, mins);
    this.mem.writeU32(ptr + max, maxs);
    this.mem.writeU32(ptr + numOff, [u32(num)]);
    return ptr;
  }

  /** 写一个 ``fRange``（浮点区间）。 */
  writeFRange(ptr: number, pairs: readonly (readonly [number, number])[]): number {
    const { min, max, num: numOff } = this.layout.frange;
    const slots = this.layout.maxInput;
    const mins = new Array<number>(slots).fill(0);
    const maxs = new Array<number>(slots).fill(1);
    for (let i = 0; i < Math.min(pairs.length, slots); i += 1) {
      const pair = pairs[i] as readonly [number, number];
      mins[i] = pair[0];
      maxs[i] = pair[1];
    }
    this.mem.writeF64(ptr + min, mins);
    this.mem.writeF64(ptr + max, maxs);
    this.mem.writeU32(ptr + numOff, [u32(pairs.length)]);
    return ptr;
  }

  writeU32Array(ptr: number, values: readonly number[]): number {
    if (values.length > 0) this.mem.writeU32(ptr, values);
    return ptr;
  }

  writeI32Array(ptr: number, values: readonly number[]): number {
    if (values.length > 0) {
      const view = this.mem.i32;
      const base = ptr >>> 2;
      for (const [i, v] of values.entries()) view[base + i] = v | 0;
    }
    return ptr;
  }

  // ------------------------------------------------------------------ 读取
  /** 读一个 ``seedArray``（``data`` 按 ``min(len, cap)`` 截断，越界的 ``len`` 不炸）。 */
  readSeedArray(ptr: number): SeedArrayResult {
    const { data, len, seed } = this.layout.seedArray;
    const rawLen = this.mem.readI32(ptr + len);
    const count = Math.max(0, Math.min(rawLen, this.layout.seedCap));
    return {
      seeds: this.mem.readU32(ptr + data, count),
      head: u32(this.mem.readI32(ptr + seed)),
      rawLen,
      truncated: rawLen >= this.layout.seedCap,
    };
  }
}

/** ``seedArray`` 的 JS 视图（对应 Python 的 :class:`SeedSet`）。 */
export interface SeedArrayResult {
  /** ``data[0:min(len, cap)]``。 */
  readonly seeds: number[];
  /** C 端的 ``re.seed``；语义随函数而变（见 ``SeedSet`` 文档）。 */
  readonly head: number;
  /** C 端的原始 ``len``（可能 > cap，说明写越界过一次）。 */
  readonly rawLen: number;
  /** 是否因为写满 ``cap`` 而提前返回（「缓存炸了」）。 */
  readonly truncated: boolean;
}
