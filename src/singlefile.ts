/**
 * 单文件本地版（``tools/build_singlefile.mjs``）的**运行时钩子**。
 *
 * 单文件版把 app / wasm / worker 全部内联进一个 HTML，于是三个「正常构建」依赖
 * 外部文件的地方必须换掉：
 *
 * | 正常构建 | 单文件版 |
 * | --- | --- |
 * | ``cracker.wasm`` 是独立文件，``locateFile`` 给相对 URL → ``fetch`` | ``?url`` 被 vite 的 lib/IIFE 构建内联成 ``data:application/wasm;base64,…``，emscripten ``fetch`` 一个 ``data:`` URI |
 * | ``new Worker(new URL("./search.worker.ts", import.meta.url))`` | ``Blob`` + ``createObjectURL`` |
 *
 * 两者的开关是同一个全局 ``self.__RNG_SINGLEFILE__``（由 HTML 里前置的一小段
 * classic script 注入，形状见 :interface:`SingleFileConfig`）。**正常构建里这个全局
 * 不存在**，本模块所有取用函数一律返回 ``null`` / ``false``，等于零影响 —— 这也是
 * 不在 :mod:`main`、:mod:`wasm/runtime`、:mod:`worker/pool` 里写 ``if (xxx)`` 分支判断
 * 之外的任何逻辑的原因。
 *
 * ⚠️ Worker 里的全局是**另一份**：Blob 的 prelude 只注入 wasm 的 Base64（不再重复整个
 * worker 源码），所以 :func:`inlineWasmBase64` 与 :func:`inlineWorkerSource` 是分开的两个
 * 取值函数，校验也各自独立。prelude **两个变体的字段都注入**，否则 worker 就只剩一个
 * 可选项 —— 而它自己也得能做「modern 不行就退 mvp」那个判断。
 *
 * ⚠️ 为了兼容 Chromium 70 类引擎，wasm 有**两个变体**（见 ``wasm/variant.ts``）：
 * ``wasmBase64``（modern）与 ``wasmMvpBase64``（纯 MVP）。两者**至少有一个**才算单文件版。
 *
 * 🔴 **这两个 Base64 不是加载通道** —— 实测（2026-10-02）当前那份 ``cracker.mjs`` **不读**
 * ``Module.wasmBinary``：胶水里 ``var wasmBinary`` 只有声明、从不赋值，``getWasmBinary()``
 * 拿到二进制之后**照样**去读 ``locateFile`` 给的那个路径。真正把字节送进 wasm 的就是
 * ``locateFile`` 返回的那个 ``data:`` URI（vite 内联的 ``?url``）。所以这里的 Base64 只担两件事：
 *
 * 1. ``isSingleFile()`` 的判据；
 * 2. **本构建声明了哪些变体可用**（``wasm/variant.ts::candidateVariants``）—— 这个声明是有用的，
 *    它决定要不要去试 ``modern``（注定失败的那一次尝试）。
 *
 * 把它真正用起来（换成 ``instantiateWasm`` 注入）是另一件事，目前没必要。
 */

import type { WasmVariant } from "./wasm/variant";

/** ``self.__RNG_SINGLEFILE__`` 的形状（主线程那份才有 ``workerSource``）。 */
export interface SingleFileConfig {
  /** modern 变体 ``cracker.wasm`` 的 Base64（不带 ``data:`` 前缀）。 */
  readonly wasmBase64?: string;
  /** MVP 变体 ``cracker.mvp.wasm`` 的 Base64（老引擎用；不需要就省略）。 */
  readonly wasmMvpBase64?: string;
  /** ``search.worker.ts`` 的 IIFE 打包源码（**仅主线程**需要）。 */
  readonly workerSource: string;
  /** ``zm3_icon.png`` 的 Base64（可选）。 */
  readonly zm3IconBase64?: string;
}

/** 变体 → 全局字段名。两边必须一致，否则会静默地「找不到内联字节」。 */
const VARIANT_FIELDS: Record<WasmVariant, keyof SingleFileConfig> = {
  modern: "wasmBase64",
  mvp: "wasmMvpBase64",
};

/** 全局名。主线程与 worker（Blob prelude）两侧必须一致。 */
const GLOBAL_KEY = "__RNG_SINGLEFILE__";

/** 取全局原始值（不校验）。 */
function rawConfig(): Record<string, unknown> | null {
  const raw = (globalThis as unknown as Record<string, unknown>)[GLOBAL_KEY];
  if (raw === null || typeof raw !== "object") return null;
  return raw as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * 内联的 wasm Base64（主线程与 worker 都有）。
 *
 * 只要任何一个变体有它，就说明当前是单文件版 —— 所以 :func:`isSingleFile` 直接复用它。
 */
export function inlineWasmBase64(variant: WasmVariant = "modern"): string | null {
  const cfg = rawConfig();
  return cfg === null ? null : nonEmptyString(cfg[VARIANT_FIELDS[variant]]);
}

/** 单文件版里实际内联了哪些变体（顺序 = 尝试顺序）。非单文件版返回空数组。 */
export function inlineWasmVariants(): WasmVariant[] {
  const raw = rawConfig();
  if (raw === null) return [];
  const found: WasmVariant[] = [];
  for (const variant of ["modern", "mvp"] as const) {
    if (nonEmptyString(raw[VARIANT_FIELDS[variant]]) !== null) found.push(variant);
  }
  return found;
}

/** 内联的 worker 源码（**只有主线程**有；worker 侧为 ``null``，但 worker 不需要它）。 */
export function inlineWorkerSource(): string | null {
  const cfg = rawConfig();
  return cfg === null ? null : nonEmptyString(cfg["workerSource"]);
}

/** 内联的品牌图标 Data URI（单文件版有；普通构建为 null）。 */
export function inlineIconUri(): string | null {
  const cfg = rawConfig();
  if (cfg === null) return null;
  const b64 = nonEmptyString(cfg["zm3IconBase64"]);
  return b64 !== null ? `data:image/png;base64,${b64}` : null;
}

/** 当前是否是单文件版（判据 = 有没有内联 wasm Base64，任一变体都算）。 */
export function isSingleFile(): boolean {
  return inlineWasmBase64("modern") !== null || inlineWasmBase64("mvp") !== null;
}

/** 解码结果缓存（每个变体一份）。 */
const decodedCache = new Map<WasmVariant, Uint8Array | null>();

/** 把 Base64 解成字节；解码一次就缓存。 */
function base64ToBytes(base64: string): Uint8Array {
  // ``atob`` 在浏览器与 Web Worker 里都在；单文件版只在这两种环境里跑。
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * 内联 wasm 的二进制（每个变体解码一次并缓存）；非单文件版 / 解码失败 ⇒ ``null``。
 *
 * ⚠️ 当前这份 ``cracker.mjs`` **不读** ``Module.wasmBinary``（详见文件头那段红字），
 * 所以它不进 wasm —— 真干活的是 ``locateFile`` 里的 ``data:`` URI。
 * 留着它是为了：接口完整、以及将来若改用 ``instantiateWasm`` 注入时不用再改这里。
 */
export function inlineWasmBinary(variant: WasmVariant = "modern"): Uint8Array | null {
  const hit = decodedCache.get(variant);
  if (hit !== undefined) return hit;
  const base64 = inlineWasmBase64(variant);
  let bytes: Uint8Array | null = null;
  if (base64 !== null) {
    try {
      bytes = base64ToBytes(base64);
    } catch {
      bytes = null;
    }
  }
  decodedCache.set(variant, bytes);
  return bytes;
}

/**
 * 建一个内联（Blob）搜索 Worker；不可用 / 非单文件版 ⇒ ``null``。
 *
 * 为什么是 **classic** worker（不带 ``type: "module"``）：源码已经是 IIFE 打包过的
 * 单文件，blob 里既不能解析相对 import、也不允许裸标识符（``blob:`` 没有目录可言），
 * classic 正好只要求「一段自包含脚本」。
 *
 * ⚠️ object URL **不 revoke**：worker 存活期间 URL 必须有效；这里最多泄漏
 * :data:`~worker.pool.MAX_POOL_SIZE` 个（< 1 MB），换来的是「页面生命周期内 worker
 * 永远能重建」。不 revoke 是有意为之。
 *
 * ⚠️ 任何一步失败都**吞掉异常**返回 ``null``（而不是抛）：调用方
 * （``worker/pool.ts`` 的工厂）拿到 ``null`` 就会走原来的路径，最终由
 * ``main.ts`` 的探活统一做「退回串行」的提示。
 */
export function createInlineWorker(index: number): Worker | null {
  const source = inlineWorkerSource();
  if (source === null) return null;
  if (
    typeof Worker === "undefined" ||
    typeof Blob === "undefined" ||
    typeof URL === "undefined"
  ) {
    return null;
  }
  // prelude 注入 worker 需要的那两项：每个变体的 wasm Base64（有几个注几个）。
  // ⚠️ 不能只注主线程「选中」的那一个：worker 是另一个 realm，它自己要先试
  // modern、失败再退 mvp，只给一份就等于把回退能力砍掉。
  // 末尾必须留换行，防止和源码首行的注释/语句粘连。
  const fields: string[] = [];
  for (const variant of ["modern", "mvp"] as const) {
    const base64 = inlineWasmBase64(variant);
    if (base64 !== null) {
      fields.push(`${VARIANT_FIELDS[variant]}:${JSON.stringify(base64)}`);
    }
  }
  if (fields.length === 0) return null;
  const prelude = `self.${GLOBAL_KEY}={${fields.join(",")}};\n`;
  let url: string | null = null;
  try {
    const blob = new Blob([prelude, source], { type: "text/javascript" });
    url = URL.createObjectURL(blob);
    return new Worker(url, { name: `rngcalc-search-${index}` });
  } catch {
    if (url !== null) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
    }
    return null;
  }
}

/**
 * 探活：建一个 Blob worker、发一条 ``ping``、等 ``pong``（或超时 / ``error``）。
 *
 * 存在的理由：``file://`` 下「能不能起 Blob worker」是**浏览器策略**问题，
 * 没有可靠的特性检测；唯一的办法是真起一个。``ping`` 在 worker 里
 * （``search.worker.ts`` 的 ``handleMessage``）**不会** ``getRuntime()``，
 * 所以探活不会触发 wasm 加载，毫秒级返回。
 *
 * 非单文件版直接 ``false``（绝不建 worker —— 那条路径有文件 URL 可用，不需要探）。
 */
export function probeInlineWorker(timeoutMs = 8000): Promise<boolean> {
  const worker = createInlineWorker(-1);
  if (worker === null) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      try {
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
      } catch {
        /* ignore */
      }
      try {
        worker.terminate();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };

    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { type?: unknown } | null;
      if (data !== null && typeof data === "object" && data["type"] === "pong") finish(true);
    };
    const onError = (): void => finish(false);

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    timer = setTimeout(() => finish(false), Math.max(1, Math.trunc(timeoutMs)));
    try {
      worker.postMessage({ type: "ping", id: -1 });
    } catch {
      finish(false);
    }
  });
}
