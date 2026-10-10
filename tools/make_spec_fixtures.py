"""为 ``web/src/core/spec.ts`` 生成 `SeedSpec` 契约的对拍夹具。

为什么要有它：``spec.ts`` 是 Python ``src_forge/core/spec.py`` 的 1:1 翻译，
Web 侧不能 import Python，所以这里让 **Python 侧**跑一遍：

* ``roundtrip``：喂一份 JSON 字典 → ``spec_from_dict()`` → ``to_dict()``，
  把**规范化之后**的结果写进夹具（顺带钉住 ``step<1`` 回落、默认值填充等）；
* ``bounds``：``num`` / ``step`` / ``u32_bounds``（后端直接拿来填 ``uRange`` 的东西）；
* ``errors``：**必须抛 SpecError** 的输入 + 一句特征子串（两侧只比子串，
  因为 Python 用 ``{kind!r}`` 而 TS 用 ``JSON.stringify``，细节拼写必然不同）；
* ``steps``：``require_unit_step`` 的判定。

脚本自己会先验证「errors 用例确实抛错且消息含该子串」，所以夹具不会悄悄漂移。

用法::

    .venv\\Scripts\\python.exe web/tools/make_spec_fixtures.py            # 写文件
    .venv\\Scripts\\python.exe web/tools/make_spec_fixtures.py --check    # 只校验是否最新
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
from typing import Any, Final

ROOT: Final = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src_forge.core import spec as S  # noqa: E402  （必须先补 sys.path）
from src_forge.core.errors import SpecError  # noqa: E402

OUT_PATH: Final = ROOT / "web" / "tests" / "fixtures" / "specs.json"
SCHEMA: Final = 1
M32: Final = 0xFFFFFFFF


def interval(lo: int, hi: int) -> dict[str, Any]:
    return {"kind": "interval", "lo": lo, "hi": hi}


def mask(mask_bits: int, value: int) -> dict[str, Any]:
    return {"kind": "mask", "mask": mask_bits, "value": value}


#: 正常输入：``spec_from_dict(inp).to_dict()`` 必须逐字回放 ``inp`` 的规范化形。
ROUNDTRIP: Final[list[dict[str, Any]]] = [
    # --- interval ---
    {
        "kind": "interval",
        "step": 3,
        "constraints": [interval(0, 255), interval(1000, 2000)],
        "scanner": "crack2",
    },
    # scanner 缺省 → "crack"
    {"kind": "interval", "step": 1, "constraints": [interval(7, 7)]},
    # step < 1 → 回落到 1
    {"kind": "interval", "step": 0, "constraints": [interval(0, M32)]},
    {"kind": "interval", "step": -5, "constraints": [interval(1, 2)]},
    # 32 个槽位（上限）
    {
        "kind": "interval",
        "step": 2,
        "constraints": [interval(i * 10, i * 10 + 5) for i in range(32)],
        "scanner": "crack",
    },
    # --- mask ---
    {
        "kind": "mask",
        "step": 2,
        "constraints": [mask(0x60000000, 0x20000000), mask(0x60000000, 0), mask(0x60000000, 0x40000000)],
        "imask": 0x60000000,
    },
    {"kind": "mask", "step": 1, "constraints": [mask(M32, 12345)], "imask": M32},
    # imask 缺省 → M32
    {"kind": "mask", "step": 1, "constraints": [mask(M32, 0)]},
    # 高位越出 imask：expected 要把高位抹掉（``to_c_min`` 是 ``value & imask``）
    {"kind": "mask", "step": 1, "constraints": [mask(0xFFFF, 0x12345678)], "imask": 0xFFFF},
    # --- roll ---
    {
        "kind": "roll",
        "step": 5,
        "constraints": [interval(0, 100), interval(0, 200), interval(0, 300), interval(0, 400)],
        "roll_vals": [100, 200, 300, 400],
        "gem_vals": [50, 60],
        "gem_index": [0, 2],
    },
    # 无宝石
    {
        "kind": "roll",
        "step": 1,
        "constraints": [interval(0, 10), interval(0, 20)],
        "roll_vals": [1, 2],
        "gem_vals": [],
        "gem_index": [],
    },
    # roll_vals 比 num 短（C 的契约是 <=，不是 ==）
    {
        "kind": "roll",
        "step": 1,
        "constraints": [interval(0, 10), interval(0, 20), interval(0, 30)],
        "roll_vals": [7],
        "gem_vals": [],
        "gem_index": [],
    },
    # roll_vals 缺省 → 空
    {"kind": "roll", "step": 1, "constraints": [interval(0, 10)]},
    # --- wuxing ---
    {
        "kind": "wuxing",
        "step": 7,
        "constraints": [interval(0, 1000), interval(500, 2000)],
        "target_wx": 0b101,
        "bagua_growth": [5, 12],
    },
    {"kind": "wuxing", "step": 1, "constraints": [interval(0, 100)], "target_wx": 0},
    {"kind": "wuxing", "step": 1, "constraints": [interval(0, 100)]},
    # bagua_growth[1] == 0 → 「没有八卦成长」
    {
        "kind": "wuxing",
        "step": 1,
        "constraints": [interval(0, 100)],
        "target_wx": 0b100010,
        "bagua_growth": [3, 0],
    },
    # --- pool ---
    {
        "kind": "pool",
        "step": 4,
        "constraints": [interval(0, 10), interval(0, 20), interval(0, 30), interval(0, 40), interval(0, 50)],
        "total": 100,
        "roll_vals": [10, 20],
    },
    # 恰好 3 + 0
    {"kind": "pool", "step": 1, "constraints": [interval(0, 1), interval(0, 2), interval(0, 3)], "total": 7},
    # total 越出 uint32 → 回绕
    {
        "kind": "pool",
        "step": 1,
        "constraints": [interval(0, 1), interval(0, 2), interval(0, 3), interval(0, 4)],
        "total": M32 + 5,
        "roll_vals": [1],
    },
    # --- growth-wuxing ---
    {"kind": "growth-wuxing", "step": 1, "constraints": [], "target_wx": 0, "growth": [-0.3, 0.3], "grows": True},
    # step 恒为 1（字典里写 5 也没用）
    {
        "kind": "growth-wuxing",
        "step": 5,
        "constraints": [],
        "target_wx": 0b101,
        "growth": [-0.2, 0.3],
        "grows": False,
    },
    # target_wx 必带 WUXING_HAS 位（0 → 0b100000）
    {"kind": "growth-wuxing", "step": 1, "constraints": [], "target_wx": 0b100000},
    # 字段缺省
    {"kind": "growth-wuxing", "step": 1, "constraints": []},
]

#: ``(输入, 期望消息里的特征子串)``。脚本会当场验证「确实抛 SpecError 且含子串」。
ERRORS: Final[list[tuple[dict[str, Any], str]]] = [
    ({"step": 1, "constraints": [interval(0, 1)]}, "缺少 'kind' 字段"),
    ({"kind": "nope", "constraints": [interval(0, 1)]}, "未知的 spec kind"),
    # 0 个区间是 C 端 ``uRange`` 的硬前提
    ({"kind": "interval", "constraints": []}, "区间数量不能为 0"),
    ({"kind": "interval", "constraints": [interval(i, i + 1) for i in range(33)]}, "超过上限 32"),
    ({"kind": "interval", "constraints": [interval(9, 3)]}, "上下界反了"),
    ({"kind": "interval", "constraints": [interval(0, M32 + 1)]}, "越出 uint32"),
    ({"kind": "interval", "constraints": [{"kind": "who"}]}, "未知的约束类型"),
    # 掩码约束与 MaskSpec.imask 不同尺子
    ({"kind": "mask", "constraints": [mask(0xFF, 1)], "imask": 0xFFFF}, "不一致"),
    ({"kind": "mask", "constraints": [mask(M32, M32 + 1)]}, "越出 uint32"),
    # 类型不匹配
    ({"kind": "mask", "constraints": [interval(0, 1)]}, "MaskSpec 只接受 MaskConstraint"),
    ({"kind": "interval", "constraints": [mask(M32, 1)]}, "IntervalSpec 只接受 IntervalConstraint"),
    ({"kind": "wuxing", "constraints": [mask(M32, 1)]}, "WuxingSpec 只接受 IntervalConstraint"),
    ({"kind": "pool", "constraints": [mask(M32, 1)]}, "PoolSpec 只接受 IntervalConstraint"),
    ({"kind": "roll", "constraints": [mask(M32, 1)]}, "RollSpec 只接受 IntervalConstraint"),
    # roll：roll_num <= num；gem_vals 与 gem_index 等长；gem_index 不越界
    (
        {"kind": "roll", "constraints": [interval(0, 1)], "roll_vals": [1, 2]},
        "超过区间数量",
    ),
    (
        {"kind": "roll", "constraints": [interval(0, 1)], "roll_vals": [1], "gem_vals": [1], "gem_index": []},
        "gem_vals 长度",
    ),
    (
        {"kind": "roll", "constraints": [interval(0, 1)], "gem_vals": [1], "gem_index": [1]},
        "越界",
    ),
    # pool：3 + roll_num <= num
    (
        {"kind": "pool", "constraints": [interval(0, 1), interval(0, 2), interval(0, 3)], "roll_vals": [1]},
        "超过区间数量",
    ),
    # wuxing：bagua_growth 必须恰好 2 项
    ({"kind": "wuxing", "constraints": [interval(0, 1)], "bagua_growth": [1]}, "长度为 2"),
    # growth-wuxing：不接受约束；growth 越界
    (
        {"kind": "growth-wuxing", "constraints": [interval(0, 1)]},
        "不接受区间约束",
    ),
    ({"kind": "growth-wuxing", "constraints": [], "growth": [-1.5, 0.3]}, "growth 必须满足"),
    ({"kind": "growth-wuxing", "constraints": [], "growth": [0.3, -0.3]}, "growth 必须满足"),
    ({"kind": "growth-wuxing", "constraints": [], "growth": [-0.1, 1.5]}, "growth 必须满足"),
]

#: ``(输入, 期望消息里的特征子串)`` for :func:`S.require_unit_step`。
STEPS: Final[list[tuple[dict[str, Any], str]]] = [
    ({"kind": "roll", "step": 2, "constraints": [interval(0, 1)]}, "step 必须是 1"),
    ({"kind": "wuxing", "step": 3, "constraints": [interval(0, 1)]}, "step 必须是 1"),
    ({"kind": "pool", "step": 2, "constraints": [interval(0, 1), interval(0, 2), interval(0, 3)]}, "step 必须是 1"),
    # 这些应当**不抛**
    ({"kind": "roll", "step": 1, "constraints": [interval(0, 1)]}, ""),
    ({"kind": "interval", "step": 5, "constraints": [interval(0, 1)]}, ""),
    ({"kind": "growth-wuxing", "step": 1, "constraints": []}, ""),
]


def build() -> dict[str, Any]:
    roundtrip = []
    bounds = []
    for inp in ROUNDTRIP:
        got = S.spec_from_dict(inp)
        dumped = got.to_dict()
        roundtrip.append({"in": inp, "out": dumped})
        bounds.append(
            {
                "in": inp,
                "kind": got.kind,
                "num": got.num,
                "step": got.step,
                "u32_bounds": [[lo, hi] for lo, hi in got.u32_bounds],
            }
        )

    errors = []
    for inp, needle in ERRORS:
        try:
            S.spec_from_dict(inp)
        except SpecError as exc:
            message = str(exc)
            if needle not in message:
                raise AssertionError(f"错误消息里没有 {needle!r}：{message!r}") from None
            errors.append({"in": inp, "match": needle})
        else:  # pragma: no cover - 夹具自检
            raise AssertionError(f"这份输入本应抛 SpecError：{inp!r}")

    steps = []
    for inp, needle in STEPS:
        spec = S.spec_from_dict(inp)
        if needle:
            try:
                S.require_unit_step(spec)
            except SpecError as exc:
                if needle not in str(exc):
                    raise AssertionError(f"错误消息里没有 {needle!r}：{str(exc)!r}") from None
                steps.append({"in": inp, "match": needle})
            else:  # pragma: no cover - 夹具自检
                raise AssertionError(f"这份输入本应抛 SpecError：{inp!r}")
        else:
            S.require_unit_step(spec)
            steps.append({"in": inp, "match": ""})

    return {
        "schema": SCHEMA,
        "roundtrip": roundtrip,
        "bounds": bounds,
        "errors": errors,
        "steps": steps,
    }


def dumps(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=False) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="只校验夹具是否最新")
    args = parser.parse_args(argv)

    text = dumps(build())
    if args.check:
        if not OUT_PATH.exists():
            print(f"missing: {OUT_PATH}")
            return 1
        current = OUT_PATH.read_text(encoding="utf-8")
        if current != text:
            print(f"stale: {OUT_PATH}")
            return 1
        print(f"ok: {OUT_PATH}")
        return 0

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(text, encoding="utf-8", newline="")
    print(f"wrote: {OUT_PATH} ({len(text)} chars)")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
