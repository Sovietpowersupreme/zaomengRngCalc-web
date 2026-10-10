/**
 * 共用视觉基线 —— 与网页版「随机数计算器」同一套配色（仙侠古典：深蓝夜空 + 金）。
 *
 * 抽成模块的理由：设置页与 popup 都要用这套配色，各自再叠自己的布局。颜色写两处迟早
 * 会漂移，漂到最后就是「两个软件」。这里**只有调色板与控件外观，不含任何布局**。
 *
 * HTML 里的 ``<style>`` 只留「上屏前别闪白」的那几行底色 —— ``<script defer>`` 执行完
 * 之前浏览器可能已经画过一帧，深色界面闪一下白屏格外刺眼。组件样式放这里，跟代码一起改。
 *
 * ⚠️ 模板字符串里**不能出现反引号与 ``${``**；CSS 注释里不要写星号（``/* … *`` 会提前收尾）。
 */

import { applyCompatClasses } from "../../../src/compat/css";
import { el } from "./dom";

/** 调色板与控件外观（与 ``web/src/ui/App.vue`` 的 ``<style>`` 对齐，改一边就想想另一边）。 */
export const THEME = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }

/* 按钮：深棕木牌，悬浮时描金边 */
button {
  font: inherit;
  padding: 4px 12px;
  border: 1px solid #756345;
  border-radius: 4px;
  background: linear-gradient(180deg, #443725 0%, #2b2216 100%);
  color: #ece0c3;
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 2px 4px rgba(0, 0, 0, 0.35);
  transition: all 0.15s ease;
}
button:hover:not(:disabled) {
  background: linear-gradient(180deg, #57462f 0%, #382c1d 100%);
  border-color: #c9b382;
  color: #ffffff;
  box-shadow: 0 0 8px rgba(201, 179, 130, 0.4);
}
button:active:not(:disabled) {
  background: linear-gradient(180deg, #241d13 0%, #3a2e1d 100%);
  box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.6);
  transform: translateY(1px);
}
button:disabled { opacity: 0.4; cursor: not-allowed; box-shadow: none; }
button.primary {
  border-color: #ffd700;
  background: linear-gradient(180deg, #ffe066 0%, #f39c12 50%, #d35400 100%);
  color: #ffffff;
  font-weight: 700;
  text-shadow: 0 1px 2px #5c2600;
  box-shadow: 0 0 10px rgba(255, 215, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.4), 0 2px 4px rgba(0, 0, 0, 0.5);
}
button.primary:hover:not(:disabled) {
  background: linear-gradient(180deg, #fff099 0%, #f8b332 50%, #e65c00 100%);
  box-shadow: 0 0 16px rgba(255, 222, 16, 0.8), inset 0 1px 0 rgba(255, 255, 255, 0.6);
}

/* 文本框与下拉：暗底金边，聚焦发光 */
input[type="text"], input[type="number"], select, textarea {
  font: 12px/1.6 Consolas, "Cascadia Mono", ui-monospace, monospace;
  padding: 3px 7px;
  border: 1px solid #756345;
  border-radius: 3px;
  background: #17130e;
  color: #fdf6e2;
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.7);
  transition: border-color 0.15s, box-shadow 0.15s;
}
input[type="text"]:focus, input[type="number"]:focus, select:focus, textarea:focus {
  border-color: #f39c12;
  box-shadow: 0 0 6px rgba(243, 156, 18, 0.6), inset 0 1px 3px rgba(0, 0, 0, 0.7);
  outline: none;
}
input::placeholder, textarea::placeholder { color: #7c6f5a; }
input[type="checkbox"] { accent-color: #f39c12; cursor: pointer; width: 15px; height: 15px; }

/* 内联代码：小圆角暗底金字 */
code {
  font: 12px Consolas, "Cascadia Mono", ui-monospace, monospace;
  padding: 1px 6px;
  border: 1px solid #4a3d2a;
  border-radius: 3px;
  background: rgba(18, 14, 9, 0.9);
  color: #ffde10;
}

a { color: #ffd166; text-decoration: underline dotted; cursor: pointer; }
a:hover { color: #fff099; }

/* 滚动条 */
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: #17120a; }
::-webkit-scrollbar-thumb { background: #5a4b33; border: 2px solid #17120a; border-radius: 5px; }
::-webkit-scrollbar-thumb:hover { background: #7d6b49; }

/* 顶栏：与计算器的标题条同款（深棕渐变 + 2px 金线） */
.masthead {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 22px;
  background: linear-gradient(180deg, rgba(35, 28, 17, 0.95) 0%, rgba(22, 17, 10, 0.98) 100%);
  border-bottom: 2px solid #7d5f05;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.6);
}
/* 老引擎（Chromium 70 级）的 flex 容器不认 gap（见 web/src/compat/css.ts）：
   类由 installStyles() 按同一份探针挂到 html 上，下面几条只在老引擎生效，
   现代浏览器上等于不存在（所以上面的 gap 不用改）。 */
html.no-flex-gap .masthead > * + * { margin-left: 12px; }
.masthead .mark { color: #f39c12; font-size: 15px; line-height: 1; }
.masthead h1 {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  line-height: 1.25;
  color: #ffde10;
  text-shadow: 0 1px 3px #000, 0 0 8px rgba(255, 222, 16, 0.4);
}
.masthead .sub { margin: 2px 0 0; font-size: 11px; color: #a89b82; letter-spacing: 1px; }
.masthead .spring { flex: 1 1 auto; }
.masthead .tag {
  padding: 2px 9px;
  font-size: 11px;
  white-space: nowrap;
  color: #d8c9a6;
  background: rgba(255, 222, 16, 0.08);
  border: 1px solid rgba(255, 222, 16, 0.25);
  border-radius: 3px;
}

/* 通用小件 */
.grow { flex: 1 1 auto; min-width: 0; }
.spring { flex: 1 1 auto; }
.muted { color: #a89b82; font-size: 12px; }
.ok { color: #4cd964; }
.warn { color: #ffd166; }
.err { color: #ff6b6b; }
`;

/** 顶栏元素（金句点 + 标题 + 副标题 + 右侧小标签）。 */
export function masthead(title: string, subtitle: string, tag: string): HTMLElement {
  return el(
    "header",
    { cls: "masthead" },
    el("span", { cls: "mark", text: "❖" }),
    el("div", {}, el("h1", { text: title }), el("p", { cls: "sub", text: subtitle })),
    el("span", { cls: "spring" }),
    el("span", { cls: "tag", text: tag }),
  );
}

/**
 * 把若干段 CSS 挂到 ``<head>``。
 *
 * **不要挂在 ``#app`` 里** —— 那两处界面都会 ``clear(app)`` 重渲染（popup 每次刷新、
 * 设置页启动失败时清屏），样式会跟着被清掉，页面瞬间变回白底黑字的裸 HTML。
 *
 * 顺手打兼容类（``html.no-flex-gap``）：两个页面的**全部**组件样式都出自这里，
 * 所以在这里探测一次就够 —— 不存在「样式已经生效、类还没挂上」的中间帧。
 * ⚠️ 也因此**不要**在 popup.html / options.html 里塞内联 ``<script>`` 探针：
 * MV2 的默认 CSP 是 ``script-src 'self'``，内联脚本会被直接拦掉。
 */
export function installStyles(...sheets: readonly string[]): void {
  applyCompatClasses();
  for (const css of sheets) document.head.append(el("style", { text: css }));
}
