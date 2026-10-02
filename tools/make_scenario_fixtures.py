"""为 ``web/src/scenarios/*`` 生成**场景目录**对拍夹具。

为什么要有它：``web/src/scenarios/scenario.ts`` 是 Python
``src_forge/gameInfo/scenario.py`` 的 1:1 翻译，Web 侧不能 import Python，
所以让 **Python 侧**把 :func:`registry.describe_all` 的完整输出（含 ``input_schema``
的 ``to_dict()``）落到 ``web/tests/fixtures/scenarios.json``，vitest 逐字段回放比对。

夹具里每个场景的形状 **逐字等于** ``Scenario.describe()`` 的返回值，另加两项
TS 侧要用来构造 ``Scenario`` 的类常量：

* ``near_limit`` —— 局部搜索默认步数上限（TS 侧是 ``Scenario.nearLimit``）；
* ``slice_bounds`` —— 「枚举」的默认范围（``null`` = 全空间）。

脚本自带两条**交叉自检**（夹具不会悄悄漂移）：

1. ``registry.BUILTIN_ORDER`` 的顺序必须与 ``web`` 侧 registry 的
   ``BUILTIN_ORDER`` 一致 —— 顺手也对着 ``src_forge/tests/golden/runs.json``
   的 ``meta.scenarios`` 校验一次（那是 UI 标签页顺序的权威来源）；
2. 每个 ``describe()["key"]`` 必须等于它所在位置的 key。

用法::

    .venv\\Scripts\\python.exe web/tools/make_scenario_fixtures.py            # 写文件
    .venv\\Scripts\\python.exe web/tools/make_scenario_fixtures.py --check    # 只校验是否最新
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

from src_forge.gameInfo import registry  # noqa: E402  （必须先补 sys.path）

OUT_PATH: Final = ROOT / "web" / "tests" / "fixtures" / "scenarios.json"
RUNS_PATH: Final = ROOT / "src_forge" / "tests" / "golden" / "runs.json"
SCHEMA: Final = 1


def build() -> dict[str, Any]:
    payloads: list[dict[str, Any]] = []
    for scenario in registry.iter_scenarios():
        data = scenario.describe()
        if data["key"] != scenario.key:  # pragma: no cover - 自检
            raise AssertionError(f"describe() 的 key 对不上：{data['key']!r} != {scenario.key!r}")
        bounds = scenario.slice_bounds
        payloads.append(
            {
                **data,
                "near_limit": int(scenario.near_limit),
                "slice_bounds": None if bounds is None else [int(bounds[0]), int(bounds[1])],
            }
        )

    order = [p["key"] for p in payloads]
    if order != list(registry.BUILTIN_ORDER):  # pragma: no cover - 自检
        raise AssertionError(f"注册顺序与 BUILTIN_ORDER 不一致：{order}")

    runs_order = json.loads(RUNS_PATH.read_text(encoding="utf-8"))["meta"]["scenarios"]
    if order != list(runs_order):  # pragma: no cover - 自检
        raise AssertionError(f"场景顺序与 runs.json 的 meta.scenarios 不一致：{order} vs {runs_order}")

    return {
        "schema": SCHEMA,
        "generator": "web/tools/make_scenario_fixtures.py",
        "order": order,
        "count": len(payloads),
        "scenarios": payloads,
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
        if OUT_PATH.read_text(encoding="utf-8") != text:
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
