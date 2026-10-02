# `web/src/wasm/` —— Web 端用的 wasm 引擎

本目录里的 `.mjs` / `.wasm` 是 **生成物**，由 `csrc/build_wasm.py` 从
`csrc/cracker.c` + `csrc/wasm_glue.c` 编译而来，**不要手改**。

```bat
csrc\build_wasm.bat                :: 重新构建（默认 -O2，产物落在这里）
csrc\build_wasm.bat --check        :: 在临时目录重建，与已提交产物逐字节比对
csrc\build_wasm.bat --opt -O3      :: 换优化档位
```

`build_info.json` 记录了两份源码的 sha256、工具链摘要与构建参数，用于复现与审计。
里面的工具链位置一律是**相对写法**（`emcc` 相对 `$EMSDK`、`em_cache` 相对所在盘符的
根，基准写在 `path_base` 里）—— 这份 json 要公开，不适合记本机绝对路径。

源码摘要是**按 LF 归一化**后算的（多一个 `"eol": "lf"` 标记），所以 CRLF 工作区与
LF 克隆给出同一个值。**判断产物是否落后一律用 `--check`**（它比的是产物字节，与行尾
无关）；`build_info.json` 只作审计线索，**源码 mtime 不是依据** —— 注释/行尾级改动会
让 mtime 变新，而 emcc 输出一字不变。

## 为什么要有 `csrc/wasm_glue.c`

`cracker.h` 里 `crack` / `crack2` / `fastCrack` / `find*` 都把 `uRange` / `fRange`
**按值** 传递，而 wasm ABI 里 struct-by-value 走调用者栈上的临时副本 ——
JS 侧只能传数值（数值只能是内存地址），`ccall`/`cwrap` 无法构造这种参数。
`wasm_glue.c` 为每个按值函数配一个「指针入参 + `seedArray *out` 写回」的薄壳，
**只做转发，不改任何语义**。返回 `seedArray` 的函数（含 `recover_seeds`）同理。

## JS 侧调用约定

```js
import initCracker from "./cracker.mjs";
const M = await initCracker();          // MODULARIZE 产物：默认导出是个工厂
```

1. **不要自己算结构体布局**，问模块：
   ```js
   M.ccall("wc_offsetof_urange_num", "number", [], []);   // 256
   M.ccall("wc_sizeof_seedarray",   "number", [], []);    // 4004
   ```
   已确认（64 位 wasm，全部 u32 对齐）：
   `uRange` = `min`@0（32×4B）、`max`@128、`num`@256，`sizeof` 260；
   `seedArray` = `data`@0（999×4B）、`len`@3996、`seed`@4000，`sizeof` 4004。
2. **临时内存**：本构建**没有**导出 `_malloc`，改用数据段里的静态 scratch
   （`M._wc_scratch()` 拿基址，`M._wc_scratch_size()` = 64 KiB，bump 用完即弃）。
   静态数组不会被内存增长搬走，所以指针长期有效。
3. **`HEAPU32` / `HEAP32` / `HEAPF64` 每次都要重取**（`M.HEAPU32`）：内存增长时视图会被替换。
   这也是必须显式 `-sEXPORTED_RUNTIME_METHODS=...,HEAPU32,HEAP32,HEAPF64` 的原因 ——
   MODULARIZE 产物默认不把这几个视图挂在 `Module` 上（`HEAPF64` 是给 `fRange` /
   浮点 API 写 double 用的）。
4. 按值那一族**只能**走 `wc_*`：
   ```js
   M._wc_crack_slice(uvLo, uvHi, urPtr, step, outPtr);
   const len = M.HEAPU32[(outPtr + 3996) / 4];        // 先重取视图
   ```
5. 吃标量的函数（`fastNext` / `getPreSeed` / `RandomPureHasher` /
   `getBossTypeUltraFast` / `seedDistance` / `staticRandom` / `seedUpdateTest` …）
   直接 `M._fastNext(x)` 或 `ccall` 即可，不需要胶水。

## Python 侧怎么用（`src_forge` 的 wasm 后端）

本机没有 `wasmtime` / `wasmer`，所以 Python 走 node：

* `src_forge/backends/wasm_driver.mjs` —— 常驻 node 驱动，行分隔 JSON RPC；
* `src_forge/backends/wasm_backend.py` —— 实现 `Backend` / `RandomEngine` / `SeedSearcher`。

```python
from src_forge.backends import available_backends, get_backend
available_backends()            # ('ctypes', 'wasm', 'pure_py')
with get_backend("wasm") as be:
    be.engine().fast_next(12345)
    be.searcher().search_slice(spec, 0, 10)
```

协议（一行一个 JSON，响应行带 `##RPC##` 前缀）：

```json
{"op":"info"}
{"op":"call","fn":"wc_crack_slice","args":[{"u32":0},{"u32":10},{"urange":{"pairs":[[0,4294967295]],"num":1}},{"i32":1},{"out":true}]}
{"op":"quit"}
```

参数编码：`u32` / `i32` / `f64` / `u32arr` / `i32arr` / `u32io`（入出参 uint32 指针）/
`urange` / `frange` / `out`（`seedArray*`）。**结构体布局与 scratch 都在 JS 里处理**：
驱动器启动后先问 `wc_offsetof_*` / `wc_sizeof_*`，Python 侧一个偏移都不硬编码。

改这个目录的**任何**东西（包括 glue 或构建参数）都要：

```bat
csrc\build_wasm.bat
.venv\Scripts\python -m pytest src_forge/tests -q
```

## 已验收的事实

- 43 个 `wc_*` 导出齐全；
- `wc_recover_seeds(0)` → `[4186535581, 2771756286]`，与 `rev_random.h` / DLL 一致
  （注意 `re.seed` 恒为 0，只能用 `data` / `len`）；
- `crack_slice(0, 10)` 全放行区间 → `len = 10`，`data = [0,2,4,…,18]`；
- 全空间的 `crack` / `crack2` / `fastCrack` 与 `_mp` 家族在 wasm 下走的是
  `cracker_mp.h` 的串行回退分支（无 `-fopenmp`），`tools/wasm_crosscheck.py` 已逐位
  验证过与 DLL 一致；
- **`src_forge` 的 golden 对拍（498 个分片 + 648 个局部搜索用例）在 wasm 后端上逐位通过**
  ——也就是说这份 wasm 产物与 `libs/cracker.dll` 的 {原语, 枚举, 局部搜索} 全部一致。

## 踩过的坑（不要重犯）

- `EM_CACHE` 必须与项目同盘符（默认 = 项目所在盘符下的 `emsdk_cache`）；跨盘会让 emscripten 内部
  `os.path.relpath` 抛 `ValueError`，而异常被 `filelock` 吞掉后 **emcc 会永久卡住**。
- emcc **绝不能** `subprocess.run(..., capture_output=True)`：它是批处理子进程树，
  管道写满就死锁。用 `Popen` 继承 stdio + 超时 + `taskkill /F /T`。
- wasm 构建**不能**加 `-fopenmp`，也不能加 `-fexec-charset=GBK`。
- `rev_random.h` 是「定义式头文件」，`wasm_glue.c` 只能自己**声明** `recover_seeds`，
  直接 include 会在链接期重复定义；同理 `cracker_mp.h` 里的 `*_mp` 也只声明不 include。
- node 驱动里 stdout **只能**出现 `##RPC##` 行：模块的任何调试输出都要走 stderr，
  否则会把协议行弄脏。
