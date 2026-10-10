"""把 ``web/public/favicon.png``（那颗 3D 骰子）缩放成扩展要用的 4 个尺寸图标。

为什么要有这个脚本
------------------
MV3 的 ``manifest.json`` 要 ``icons/icon{16,32,48,128}.png``，而仓库里**没有**
现成的方形小图（``public/favicon.png`` 是 50x49、``public/assets/zm3_icon.png`` 是
360x160 的横版标题字）。与其塞几个来路不明的二进制进仓库，不如留一段 20 行的生成器：
图标永远能从受版本控制的源图重建。

跑法::

    .venv\\Scripts\\python.exe web\\tools\\make_ext_icons.py

依赖 Pillow（本机 ``.venv`` 里是 12.2.0）。生成结果是**受版本控制**的
（``web/extension/url-seed/icons/``），只在换源图时才需要重跑。
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover - 只在没装 Pillow 时报错
    print("需要 Pillow：.venv\\Scripts\\python.exe -m pip install Pillow", file=sys.stderr)
    raise SystemExit(2)

WEB = Path(__file__).resolve().parent.parent
SOURCE = WEB / "public" / "favicon.png"
OUT_DIR = WEB / "extension" / "url-seed" / "icons"

# ``16`` 是工具栏/页签，``48`` 是扩展管理页，``128`` 是安装对话框和商店。
SIZES = (16, 32, 48, 128)


def main() -> int:
    if not SOURCE.is_file():
        print(f"缺源图：{SOURCE}", file=sys.stderr)
        return 1
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with Image.open(SOURCE) as opened:
        image = opened.convert("RGBA")
        print(f"源图 {SOURCE.name}: {image.width}x{image.height}")
        for size in SIZES:
            # ``LANCZOS`` = Pillow 里质量最好的重采样。这是**一次性**生成，不用省时间；
            # 源图只有 50x49，放大到 128 一定偏软，但形状仍然可辨（够当扩展图标）。
            icon = image.resize((size, size), Image.Resampling.LANCZOS)
            target = OUT_DIR / f"icon{size}.png"
            icon.save(target, format="PNG", optimize=True)
            print(f"  -> {target.relative_to(WEB)}  {target.stat().st_size} B")
    print(f"完成：{len(SIZES)} 个图标")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
