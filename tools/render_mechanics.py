#!/usr/bin/env python3
"""将 web/readme.md 转换为独立样式的游戏机制介绍 HTML (web/public/mechanics.html)。

为什么需要此脚本：
1. 保持独立静态图片：Markdown 中引用的流程图和截图（assets/*.png）保持为独立文件引用，
   不转为 Base64 内联进 HTML，方便在不同平台、文档及外部工具中灵活复用；
2. 仙侠古风美学：渲染出的 HTML 具备与《造梦西游3》计算器主站统一的古典暗金神话质感
   （仙山墨蓝背景、玄木卷轴容器、浮雕金字标题、古铜暗纹表格、高亮引用块）；
3. 零外部依赖：纯 Python 标准库编写（无需安装 markdown/beautifulsoup 等第三方包），
   在任何机器与 CI 环境中均可直接执行。

用法::

    # 默认：从 web/readme.md 转换并写入 web/public/mechanics.html，同时同步图片
    python web/tools/render_mechanics.py

    # 校验模式（只检查目标 HTML 是否与当前 Markdown 一致，不写文件）：
    python web/tools/render_mechanics.py --check

    # 指定输入与输出文件：
    python web/tools/render_mechanics.py --input web/readme.md --output web/public/mechanics.html
"""

from __future__ import annotations

import argparse
import html
import pathlib
import re
import shutil
import sys
from typing import Final

ROOT: Final[pathlib.Path] = pathlib.Path(__file__).resolve().parents[2]
DEFAULT_INPUT: Final[pathlib.Path] = ROOT / "web" / "readme.md"
DEFAULT_OUTPUT: Final[pathlib.Path] = ROOT / "web" / "public" / "mechanics.html"
ASSETS_SRC: Final[pathlib.Path] = ROOT / "web" / "assets"
ASSETS_DEST: Final[pathlib.Path] = ROOT / "web" / "public" / "assets"

HTML_TEMPLATE: Final[str] = """<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{title}</title>
    <link rel="icon" type="image/png" href="./favicon.png" />
    <style>
      :root {{
        --bg-main: #0d172e;
        --bg-panel: rgba(28, 23, 15, 0.94);
        --border-gold: #7d5f05;
        --border-subtle: #5a492e;
        --gold-text: #ffde10;
        --gold-light: #ffd700;
        --text-main: #ece0c3;
        --text-muted: #b8a88f;
        --quote-bg: rgba(43, 37, 23, 0.7);
        --code-bg: #16120b;
      }}

      * {{
        box-sizing: border-box;
      }}

      html, body {{
        margin: 0;
        padding: 0;
        background: radial-gradient(ellipse at 50% 0%, #1e3a7a 0%, #162e69 40%, #0d172e 100%) no-repeat fixed;
        color: var(--text-main);
        font-family: "Microsoft YaHei", "PingFang SC", "Segoe UI", system-ui, sans-serif;
        font-size: 14px;
        line-height: 1.7;
      }}

      /* 顶部导航条 */
      .topbar {{
        position: sticky;
        top: 0;
        z-index: 100;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 20px;
        background: linear-gradient(180deg, rgba(35, 28, 17, 0.98) 0%, rgba(22, 17, 10, 0.98) 100%);
        border-bottom: 2px solid var(--border-gold);
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.6);
      }}

      .topbar .title {{
        font-size: 15px;
        font-weight: 700;
        color: var(--gold-text);
        text-shadow: 0 1px 3px #000;
        display: flex;
        align-items: center;
        gap: 8px;
      }}

      .topbar .back-btn {{
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 14px;
        border: 1px solid var(--border-gold);
        border-radius: 4px;
        background: linear-gradient(180deg, #443725 0%, #2b2216 100%);
        color: var(--text-main);
        text-decoration: none;
        font-weight: 600;
        font-size: 13px;
        transition: all 0.2s;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.4);
      }}

      .topbar .back-btn:hover {{
        background: linear-gradient(180deg, #ffe066 0%, #f39c12 50%, #d35400 100%);
        color: #fff;
        border-color: var(--gold-light);
        box-shadow: 0 0 10px rgba(255, 222, 16, 0.6);
      }}

      /* 主体文章容器 */
      .container {{
        max-width: 980px;
        margin: 24px auto 60px;
        padding: 24px 32px;
        background: var(--bg-panel);
        border: 1px solid var(--border-subtle);
        border-radius: 8px;
        box-shadow: 0 8px 30px rgba(0, 0, 0, 0.7), inset 0 0 40px rgba(0, 0, 0, 0.5);
      }}

      h1, h2, h3, h4 {{
        color: var(--gold-text);
        text-shadow: 0 1px 2px #000;
        margin-top: 1.8em;
        margin-bottom: 0.6em;
      }}

      h1 {{
        font-size: 26px;
        border-bottom: 2px solid var(--border-gold);
        padding-bottom: 8px;
        margin-top: 0;
        text-align: center;
      }}

      h2 {{
        font-size: 20px;
        border-bottom: 1px solid var(--border-subtle);
        padding-bottom: 6px;
        display: flex;
        align-items: center;
      }}

      h2::before {{
        content: "❖";
        color: #f39c12;
        font-size: 14px;
        margin-right: 8px;
      }}

      h3 {{
        font-size: 16px;
        color: #f5eedc;
      }}

      h3::before {{
        content: "◆";
        color: #f39c12;
        font-size: 11px;
        margin-right: 6px;
      }}

      p {{
        margin: 0.8em 0;
      }}

      blockquote {{
        margin: 12px 0;
        padding: 10px 16px;
        background: var(--quote-bg);
        border-left: 4px solid var(--gold-text);
        border-radius: 0 4px 4px 0;
        color: #f0e6cf;
      }}

      blockquote p {{
        margin: 4px 0;
      }}

      a {{
        color: #ffde10;
        text-decoration: none;
      }}

      a:hover {{
        text-decoration: underline;
      }}

      ul, ol {{
        padding-left: 24px;
        margin: 8px 0;
      }}

      li {{
        margin: 4px 0;
      }}

      /* 表格样式 */
      table {{
        width: 100%;
        border-collapse: collapse;
        margin: 16px 0;
        background: rgba(30, 24, 15, 0.8);
        border: 1px solid var(--border-subtle);
        border-radius: 4px;
        overflow: hidden;
      }}

      th, td {{
        padding: 8px 12px;
        text-align: center;
        border: 1px solid var(--border-subtle);
      }}

      th {{
        background: #2b2517;
        color: var(--gold-text);
        font-weight: 700;
      }}

      td {{
        color: var(--text-main);
      }}

      tr:hover td {{
        background: rgba(255, 222, 16, 0.05);
      }}

      /* 代码块 */
      pre, code {{
        font-family: Consolas, "Cascadia Mono", Monaco, monospace;
      }}

      code {{
        background: var(--code-bg);
        color: #ffe066;
        padding: 2px 6px;
        border-radius: 3px;
        border: 1px solid #4a3d2a;
        font-size: 0.92em;
      }}

      pre {{
        background: var(--code-bg);
        border: 1px solid var(--border-subtle);
        border-radius: 4px;
        padding: 12px 16px;
        overflow-x: auto;
        color: #ece0c3;
        line-height: 1.5;
        box-shadow: inset 0 2px 6px rgba(0, 0, 0, 0.7);
      }}

      pre code {{
        background: transparent;
        border: none;
        padding: 0;
        color: inherit;
      }}

      /* 图片排版：保持独立外部文件，不内联，居中阴影展示 */
      img {{
        display: block;
        max-width: 100%;
        height: auto;
        margin: 16px auto;
        border: 1px solid var(--border-subtle);
        border-radius: 6px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.6);
        background: #16120b;
      }}

      hr {{
        border: none;
        border-top: 1px dashed var(--border-subtle);
        margin: 24px 0;
      }}

      .footer-note {{
        text-align: center;
        margin-top: 40px;
        padding-top: 16px;
        border-top: 1px solid var(--border-subtle);
        color: var(--text-muted);
        font-size: 12px;
      }}
    </style>
  </head>
  <body>
    <!-- 顶部快速导航条 -->
    <header class="topbar">
      <div class="title">
        <span>造梦西游3 随机数计算器 · 游戏机制介绍</span>
      </div>
      <a href="./index.html" class="back-btn">← 返回计算器</a>
    </header>

    <main class="container">
{content}
      <div class="footer-note">
        <p>造梦西游3 随机数计算器 · 机制介绍 · 作者: 非♂</p>
      </div>
    </main>
  </body>
</html>
"""


def render_inline(text: str) -> str:
    """渲染行内格式（代码、粗体、斜体、链接、图片），同时保留已有合法 HTML 标签。"""
    tag_holders: list[str] = []

    def save_tag(m: re.Match[str]) -> str:
        tag_holders.append(m.group(0))
        return f"\x00TAG{len(tag_holders) - 1}\x00"

    # 保护已有的标准 HTML 标签（<a>, <img>, <br>, <span>, <div>, <strong>, <em>, <code> 等）
    t = re.sub(r"<\/?(?:a|img|br|span|div|b|strong|i|em|code|p)\b[^>]*\/?>", save_tag, text)

    # 对剩余纯文本转义 HTML 实体
    t = t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    # 还原 Markdown 里转义的字符，例如 \< 转成 <（&lt;）
    t = t.replace(r"\&lt;", "&lt;").replace(r"\&gt;", "&gt;")

    # 行内代码：`code`
    t = re.sub(r"`([^`]+)`", lambda m: f"<code>{html.escape(m.group(1))}</code>", t)

    # 粗体：**text**
    t = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", t)

    # 斜体：*text*
    t = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", t)

    # Markdown 链接：[text](url)
    t = re.sub(
        r"\[([^\]]+)\]\(([^)]+)\)",
        r'<a href="\2" target="_blank" rel="noopener noreferrer">\1</a>',
        t,
    )

    # Markdown 图片：![alt](url)
    t = re.sub(r"!\[([^\]]*)\]\(([^)]+)\)", r'<img src="\2" alt="\1" />', t)

    # 还原被保护的 HTML 标签
    for idx, tag in enumerate(tag_holders):
        t = t.replace(f"\x00TAG{idx}\x00", tag)

    return t


def parse_list_items(lines: list[str], i: int = 0, indent: int = 0) -> tuple[str, int]:
    """支持多层嵌套的有序 / 无序列表解析。"""
    items: list[str] = []
    is_ordered: bool | None = None
    n = len(lines)

    while i < n:
        line = lines[i]
        m = re.match(r"^(\s*)([-*+]|\d+\.)\s+(.*)$", line)
        if not m:
            break
        curr_indent = len(m.group(1).expandtabs(4))
        if curr_indent < indent:
            break
        if curr_indent > indent:
            if items:
                sub_html, i = parse_list_items(lines, i, curr_indent)
                items[-1] += "\n" + sub_html
            else:
                break
            continue

        if is_ordered is None:
            is_ordered = m.group(2)[0].isdigit()

        items.append(render_inline(m.group(3).strip()))
        i += 1

    tag = "ol" if is_ordered else "ul"
    inner = "\n".join(f"  <li>{it}</li>" for it in items)
    return f"<{tag}>\n{inner}\n</{tag}>", i


def markdown_to_html(md_text: str) -> str:
    """将 Markdown 原文逐块转成 HTML 片段。"""
    lines = md_text.splitlines()
    html_blocks: list[str] = []
    i = 0
    n = len(lines)

    while i < n:
        raw_line = lines[i]
        stripped = raw_line.strip()

        # 空行
        if not stripped:
            i += 1
            continue

        # 代码块：```lang ... ```
        if stripped.startswith("```"):
            i += 1
            code_lines: list[str] = []
            while i < n and not lines[i].strip().startswith("```"):
                code_lines.append(html.escape(lines[i]))
                i += 1
            if i < n:
                i += 1
            html_blocks.append(f"<pre><code>{chr(10).join(code_lines)}</code></pre>")
            continue

        # 连续反引号单行代码片段（如 `switch(quality){` <br>）
        if re.match(r"^`.*`(\s*<br\s*\/?>)?$", stripped):
            code_lines = []
            while i < n and re.match(r"^`.*`(\s*<br\s*\/?>)?$", lines[i].strip()):
                c_match = re.match(r"^`(.*)`(\s*<br\s*\/?>)?$", lines[i].strip())
                if c_match:
                    code_lines.append(html.escape(c_match.group(1)))
                i += 1
            html_blocks.append(f"<pre><code>{chr(10).join(code_lines)}</code></pre>")
            continue

        # 标题：# h1 ~ ###### h6
        h_match = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if h_match:
            level = len(h_match.group(1))
            htext = render_inline(h_match.group(2))
            html_blocks.append(f"<h{level}>{htext}</h{level}>")
            i += 1
            continue

        # 分割线：--- / *** / ___
        if re.match(r"^([-*_])\1{2,}$", stripped):
            html_blocks.append("<hr />")
            i += 1
            continue

        # 独立 HTML 元素：<img ...> 等直接保留
        if re.match(r"^<img\s+[^>]+>$", stripped):
            html_blocks.append(stripped)
            i += 1
            continue

        # 引用块：以 '>' 开头的连续行
        if stripped.startswith(">"):
            bq_lines: list[str] = []
            while i < n and lines[i].strip().startswith(">"):
                b_line = re.sub(r"^>\s?", "", lines[i].strip())
                bq_lines.append(b_line)
                i += 1
            inner_html = markdown_to_html("\n".join(bq_lines))
            html_blocks.append(f"<blockquote>\n{inner_html}\n</blockquote>")
            continue

        # 表格：| a | b | 格式
        if stripped.startswith("|") and stripped.endswith("|"):
            table_lines: list[str] = []
            while i < n and lines[i].strip().startswith("|") and lines[i].strip().endswith("|"):
                table_lines.append(lines[i].strip())
                i += 1
            if len(table_lines) >= 2:
                headers = [render_inline(c.strip()) for c in table_lines[0].strip("|").split("|")]
                rows: list[list[str]] = []
                for row_line in table_lines[2:]:
                    cells = [render_inline(c.strip()) for c in row_line.strip("|").split("|")]
                    rows.append(cells)

                th_html = "".join(f"<th>{h}</th>" for h in headers)
                tr_html = []
                for r in rows:
                    td_html = "".join(f"<td>{c}</td>" for c in r)
                    tr_html.append(f"<tr>{td_html}</tr>")

                html_blocks.append(
                    f"<table>\n  <thead>\n    <tr>{th_html}</tr>\n  </thead>\n"
                    f"  <tbody>\n    " + "\n    ".join(tr_html) + "\n  </tbody>\n</table>"
                )
                continue

        # 列表：无序 (- / * / +) 或有序 (1. / 2.)
        if re.match(r"^(\s*)([-*+]|\d+\.)\s+", raw_line):
            list_html, i = parse_list_items(lines, i)
            html_blocks.append(list_html)
            continue

        # 普通段落：收集到空行或块级元素前
        para_lines: list[str] = []
        while i < n:
            curr = lines[i].strip()
            if not curr:
                break
            if (
                curr.startswith(("#", ">", "```", "---", "|"))
                or re.match(r"^<img\s+[^>]+>$", curr)
                or re.match(r"^`.*`(\s*<br\s*\/?>)?$", curr)
                or re.match(r"^(\s*)([-*+]|\d+\.)\s+", lines[i])
            ):
                break
            para_lines.append(render_inline(curr))
            i += 1

        if para_lines:
            para_text = "<br />\n".join(para_lines)
            html_blocks.append(f"<p>{para_text}</p>")

    # 为主体内容做轻量缩进
    indented = "\n\n".join("      " + b.replace("\n", "\n      ") for b in html_blocks)
    return indented


def sync_assets(src_dir: pathlib.Path, dest_dir: pathlib.Path) -> int:
    """自动将文档图片从 web/assets 镜像到 web/public/assets。"""
    if not src_dir.exists():
        return 0
    dest_dir.mkdir(parents=True, exist_ok=True)
    count = 0
    for p in src_dir.glob("*.png"):
        target = dest_dir / p.name
        if not target.exists() or target.stat().st_mtime < p.stat().st_mtime or target.stat().st_size != p.stat().st_size:
            shutil.copy2(p, target)
            count += 1
    return count


def render(input_path: pathlib.Path, output_path: pathlib.Path, title: str = "造梦西游3 游戏机制介绍") -> str:
    """执行渲染并返回完整的 HTML 字符串。"""
    md_content = input_path.read_text(encoding="utf-8")
    body_content = markdown_to_html(md_content)
    full_html = HTML_TEMPLATE.format(title=title, content=body_content)
    return full_html


def main() -> None:
    parser = argparse.ArgumentParser(description="将 Markdown 文档渲染为仙侠风独立 HTML")
    parser.add_argument("--input", type=pathlib.Path, default=DEFAULT_INPUT, help="源 Markdown 文件路径")
    parser.add_argument("--output", type=pathlib.Path, default=DEFAULT_OUTPUT, help="目标 HTML 文件路径")
    parser.add_argument("--title", type=str, default="造梦西游3 游戏机制介绍", help="页面标题")
    parser.add_argument("--check", action="store_true", help="校验模式：若产物落后则非零退出")
    args = parser.parse_args()

    input_file = args.input.resolve()
    output_file = args.output.resolve()

    if not input_file.exists():
        print(f"错误：输入文件不存在：{input_file}", file=sys.stderr)
        sys.exit(1)

    generated_html = render(input_file, output_file, title=args.title)

    if args.check:
        if not output_file.exists():
            print(f"FAILED: 目标文件不存在：{output_file}", file=sys.stderr)
            sys.exit(1)
        current = output_file.read_text(encoding="utf-8")
        if current != generated_html:
            print("FAILED: 目标 HTML 与 Markdown 原文不一致，需要重新生成", file=sys.stderr)
            sys.exit(1)
        print("OK: 目标 HTML 与 Markdown 完全一致")
        return

    # 正常写文件
    output_file.parent.mkdir(parents=True, exist_ok=True)
    output_file.write_text(generated_html, encoding="utf-8")
    synced_images = sync_assets(ASSETS_SRC, ASSETS_DEST)

    print(f"✓ 转换成功：{input_file} -> {output_file}")
    if synced_images > 0:
        print(f"✓ 静态图片同步：已同步 {synced_images} 张 PNG 到 {ASSETS_DEST}")
    print(f"  页面标题：{args.title}")
    print("  图片模式：独立相对文件（assets/*.png，非 Base64 内联）")


if __name__ == "__main__":
    main()
