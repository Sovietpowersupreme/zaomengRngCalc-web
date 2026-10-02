"""为 ``web/`` 侧生成「显示值 → 原始随机区间」的对拍夹具。

为什么要有它：``RangeCodec`` 是 Web 与 Python **必须逐位一致**的纯函数，
但 Web 侧的 vitest 跑在 node 里、不能（也不该）去 import Python。
所以这里用固定随机种子采一批用例，把 **Python 侧的计算结果**（就是权威答案）
写进 ``web/tests/fixtures/ranges.json``，vitest 只读这个文件回放比对。

用法::

    .venv\\Scripts\\python.exe web/tools/make_fixtures.py            # 写文件
    .venv\\Scripts\\python.exe web/tools/make_fixtures.py --check    # 只校验是否最新

夹具是**采样**出来的，所以必须固定种子：``random.Random(20240614)``。
"""

from __future__ import annotations

import argparse
import json
import pathlib
import random
import sys
from typing import Any, Callable, Final

ROOT: Final = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src_forge.core import ranges as R  # noqa: E402  （必须先补 sys.path）

OUT_PATH: Final = ROOT / "web" / "tests" / "fixtures" / "ranges.json"
SEED: Final = 20240614
SCHEMA: Final = 1

MODES: Final[dict[str, Callable[..., Any]]] = {
    "truncate": R.uint_before_truncation,
    "round": R.uint_before_round,
    "ceil": R.uint_before_ceil,
}

#: 故意混入中文标点，因为分隔符集合里就有它们。
DELIMS: Final = [" ", "  ", "，", "|", "、", "/", " ; ", "\t"]


def _as_json(value: Any) -> Any:
    """``tuple``/``list`` 混着来，统一成 JSON 数组。"""
    if isinstance(value, (tuple, list)):
        return [_as_json(v) for v in value]
    return int(value)


def _make_seq(rng: random.Random, n: int, r: int) -> tuple[int | list[int] | str, str]:
    """造三种形态的显示值输入：标量 / 数字数组 / 分隔符串。"""
    count = rng.randrange(1, 4)
    # 故意允许越界与负数：C 侧不夹取，夹具要钉住这个行为
    values = [n + rng.randrange(-2 * r - 2, 2 * r + 3) for _ in range(count)]
    shape = rng.choice(["scalar", "list", "str"])
    if shape == "scalar":
        return values[0], "scalar"
    if shape == "list":
        return values, "list"
    delim = rng.choice(DELIMS)
    return delim.join(str(v) for v in values), "str"


def build() -> dict[str, Any]:
    rng = random.Random(SEED)
    uint_cases: list[dict[str, Any]] = []
    for mode, fn in MODES.items():
        for _ in range(80):
            n = rng.choice([0, 1, 5, 10, 100, 999, 10000, 123456])
            r = rng.choice([1, 2, 3, 7, 9, 10, 20, 99, 100, 505, 1000])
            seq, shape = _make_seq(rng, n, r)
            out = fn(seq, n, r)
            uint_cases.append(
                {"mode": mode, "shape": shape, "n": n, "r": r, "seq": seq, "out": _as_json(out)}
            )

    text_cases: list[dict[str, Any]] = []
    for mode in MODES:
        for _ in range(20):
            n = rng.choice([0, 1, 50, 5000])
            r = rng.choice([1, 3, 10, 100, 777])
            count = rng.randrange(1, 4)
            values = [n + rng.randrange(0, r + 1) for _ in range(count)]
            text = rng.choice(DELIMS).join(str(v) for v in values)
            out = MODES[mode](text, n, r)
            text_cases.append(
                {"mode": mode, "n": n, "r": r, "seq": text, "out": _as_json(out)}
            )

    # convert2Range / convert2FloatRange 的字符串分支（原 Python 里从没工作过的那条）
    constraint_cases: list[dict[str, Any]] = []
    for _ in range(40):
        pairs: list[tuple[float, float]] = []
        for _ in range(rng.randrange(1, 4)):
            lo = rng.randrange(0, 10**9)
            pairs.append((lo, lo + rng.randrange(0, 10**6)))
        parts = [f"({lo},{hi})" for lo, hi in pairs]
        join = rng.choice(["|", " | ", "| "])
        text = join.join(parts)
        text = rng.choice([text, f" {text} ", text.replace(",", ", ")])
        constraint_cases.append(
            {"text": text, "out": [[c.lo, c.hi] for c in R.convert_to_constraints(text)]}
        )

    float_cases: list[dict[str, Any]] = []
    for _ in range(30):
        pairs = []
        for _ in range(rng.randrange(1, 4)):
            lo = round(rng.random() * 0.5, 3)
            hi = round(lo + rng.random() * 0.5, 3)
            pairs.append((lo, hi))
        text = "|".join(f"({lo}, {hi})" for lo, hi in pairs)
        got = R.float_intervals(text)
        float_cases.append({"text": text, "out": [[it.lo, it.hi] for it in got]})

    errors = [
        {"mode": "round", "n": 1, "r": 0, "seq": 1, "why": "r == 0 不能作除数（round 分支）"},
        {"mode": "round", "n": 1, "r": -3, "seq": 1, "why": "r < 0"},
        {"mode": "truncate", "n": 1, "r": -1, "seq": 1, "why": "r + 1 == 0 不能作除数"},
        {"mode": "round", "n": 0, "r": 5, "seq": "/1 2", "why": "开头的分隔符会切出一个空片段"},
        {"mode": "round", "n": 0, "r": 5, "seq": "1 2.5", "why": "显示值必须是整数"},
    ]

    return {
        "schema": SCHEMA,
        "seed": SEED,
        "scale_factor": R.SCALE_FACTOR,
        "uint": uint_cases,
        "uint_text": text_cases,
        "constraints": constraint_cases,
        "float": float_cases,
        "errors": errors,
    }


def dumps(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=False) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="生成 web 侧 RangeCodec 夹具")
    parser.add_argument("--check", action="store_true", help="只校验，不写文件")
    args = parser.parse_args(argv)

    text = dumps(build())
    if args.check:
        if not OUT_PATH.exists():
            print(f"缺少夹具文件: {OUT_PATH}")
            return 1
        current = OUT_PATH.read_text(encoding="utf-8")
        if current != text:
            print(f"夹具已过期，请重新生成: {OUT_PATH}")
            return 1
        print(f"OK: {OUT_PATH.relative_to(ROOT)} 一致")
        return 0

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    # newline="" 保证换行不被平台改写（跟 json.dumps 的 "\n" 一致）
    OUT_PATH.write_text(text, encoding="utf-8", newline="")
    print(f"写出 {OUT_PATH.relative_to(ROOT)}（{len(text)} 字节）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
