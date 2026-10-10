/**
 * 游戏页里的**悬浮面板**（Shadow DOM）。
 *
 * 为什么用 Shadow DOM 而不是一个普通 ``div``：游戏页面的 CSS 又老又霸道
 * （``* { font-family: ... }``、``div { display: table }`` 这类），普通节点挂上去
 * 不是变形就是被盖住。Shadow 根把页面的选择器全挡在外面，面板只剩继承属性
 * （``font`` / ``color`` / ``line-height`` 等）会漏进来，所以 ``:host`` 上直接
 * ``all: initial`` 一把清干净，再写自己的那几条。
 *
 * 为什么不用 Vue：这一块是**内容脚本**，打包成 IIFE 塞进页面；为了一个悬浮窗
 * 拉进整个 Vue 运行时（几十 KB）不值当，而且 ``inlineWasmBinary`` 那套单文件
 * 机制只认 ``self.__RNG_SINGLEFILE__`` 一个全局，多一个框架就多一处依赖。
 * 所以这里就是 ``document.createElement`` + ``textContent`` —— 顺带把
 * **所有外部字符串一律走 ``textContent``** 这条规矩焊死了（URL 是页面来的，
 * 拼 ``innerHTML`` 等于给自己开个注入口子）。
 *
 * 面板只负责「显示」与「把点击转回给调用方」，不认识规则、不认识 wasm、不认识
 * ``chrome.*`` —— :mod:`./content` 是唯一知道全部状态的地方。
 *
 * 配色与设置页 / popup 同源（仙侠古典：深棕木牌 + 金），色值抄自 :mod:`./theme`；
 * 但**不能 import 过来用** —— Shadow DOM 隔断外部样式表，:data:`theme.THEME` 注入到
 * ``document.head`` 也照不进这个根，所以下面的 ``STYLE`` 自带全套颜料。
 */

import { supportsFlexGap } from "../../../src/compat/css";
import { clear, el } from "./dom";
import type { ResolveOutcome } from "./resolve";
import type { CapturedValue, ValuePair } from "./select";

/** 状态行的语义色。 */
export type StatusLevel = "info" | "busy" | "warn" | "error";

/** 面板上的交互回给 :mod:`./content` 处理。 */
export interface PanelHandlers {
  /** 点「恢复最近两个」。 */
  readonly onResolve: () => void;
  /** 点「清空」。 */
  readonly onClear: () => void;
  /** 勾/取消「自动恢复」。 */
  readonly onAutoChange: (auto: boolean) => void;
}

const HOST_ID = "url-seed-panel-host";

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** ``HH:MM:SS``。不用 ``toLocaleTimeString``：不同机器格式不一样，长度还会抖。 */
function clock(ts: number): string {
  const date = new Date(ts);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 面板样式。**必须自带全套配色**：Shadow DOM 把外部样式表（含注入到
 * ``document.head`` 的 :data:`./theme.THEME`）全挡在外面，所以这里不能只写布局、
 * 指望共享调色板生效。色值照抄 :mod:`./theme`，改一边就想想另一边。
 *
 * ⚠️ 模板字符串里不能出现反引号与 ``${``；CSS 注释里不要写星号（``/* … *`` 会提前收尾）。
 */
const STYLE = `
:host {
  all: initial;
  position: fixed;
  top: 12px;
  right: 12px;
  z-index: 2147483647;
  display: block;
  width: 340px;
  max-width: calc(100vw - 24px);
  color-scheme: dark;
}
.panel {
  font: 12px/1.6 "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
  color: #ece0c3;
  background: rgba(28, 23, 15, 0.95);
  border: 1px solid #6e5e41;
  border-radius: 6px;
  box-shadow: 0 8px 26px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(125, 95, 5, 0.5), inset 0 0 24px rgba(0, 0, 0, 0.45);
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
  overflow: hidden;
  text-align: left;
}
.panel.busy {
  border-color: #f39c12;
  box-shadow: 0 8px 26px rgba(0, 0, 0, 0.7), 0 0 10px rgba(243, 156, 18, 0.55), inset 0 0 24px rgba(0, 0, 0, 0.45);
}
/*
 * 老引擎（Chromium 70 级）的 flex 容器不认 gap，元素会全挤在一起。
 * 面板在 shadow 根里，所以兼容类得挂在**宿主 div** 上（挂 <html> 上选不到 shadow 内部）。
 * 宿主类由构造函数按共享探针（见 web/src/compat/css.ts）打上 —— 现代引擎上
 * 下面四条等于不存在，所以各处的 gap 声明不用动。
 */
:host(.no-flex-gap) .head > * + * { margin-left: 6px; }
:host(.no-flex-gap) .row > * + * { margin-left: 8px; }
:host(.no-flex-gap) label.auto > * + * { margin-left: 5px; }
:host(.no-flex-gap) ul.list li > * + * { margin-left: 6px; }
.head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 9px;
  background: linear-gradient(180deg, #382f1f 0%, #261f14 100%);
  border-bottom: 1px solid #6b5a3e;
  cursor: move;
  user-select: none;
}
.head .title {
  font-weight: 700;
  font-size: 12px;
  color: #ffde10;
  text-shadow: 0 1px 3px #000, 0 0 8px rgba(255, 222, 16, 0.4);
}
.head .title::before { content: "❖"; margin-right: 5px; color: #f39c12; font-size: 11px; }
.head .spacer { flex: 1 1 auto; }
.head .badge {
  padding: 1px 7px;
  border: 1px solid rgba(255, 222, 16, 0.25);
  border-radius: 3px;
  background: rgba(255, 222, 16, 0.08);
  color: #d8c9a6;
  font-size: 11px;
}
.icon {
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #a89b82;
  font-family: inherit;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.icon:hover { background: rgba(255, 222, 16, 0.12); color: #ffde10; }
.body { padding: 8px; display: grid; gap: 8px; }
.panel.collapsed .body { display: none; }
.seed {
  padding: 4px 8px;
  border: 1px solid #4a3d2a;
  border-radius: 3px;
  background: #16120b;
  font: 700 15px/1.4 ui-monospace, Consolas, monospace;
  color: #ffde10;
  text-shadow: 0 1px 3px #000, 0 0 8px rgba(255, 222, 16, 0.4);
  word-break: break-all;
}
.seed.none {
  color: #a89b82;
  font-weight: 500;
  text-shadow: none;
}
.notes { color: #ffd166; }
.cands { color: #c5b79a; font: 11px/1.5 ui-monospace, Consolas, monospace; word-break: break-all; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
button.act {
  padding: 4px 10px;
  border: 1px solid #756345;
  border-radius: 4px;
  background: linear-gradient(180deg, #443725 0%, #2b2216 100%);
  color: #ece0c3;
  font: inherit;
  cursor: pointer;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 2px 4px rgba(0, 0, 0, 0.35);
  transition: all 0.15s ease;
}
button.act:hover:not(:disabled) {
  background: linear-gradient(180deg, #57462f 0%, #382c1d 100%);
  border-color: #c9b382;
  color: #ffffff;
  box-shadow: 0 0 8px rgba(201, 179, 130, 0.4);
}
button.act:disabled { opacity: 0.4; cursor: not-allowed; box-shadow: none; }
label.auto { display: flex; align-items: center; gap: 5px; color: #e5d7ba; cursor: pointer; }
input[type="checkbox"] { accent-color: #f39c12; cursor: pointer; width: 15px; height: 15px; }
.values {
  max-height: 148px;
  overflow: auto;
  border-top: 1px solid #5a4b33;
  padding-top: 6px;
}
.values .empty { color: #a89b82; }
ul.list { margin: 0; padding: 0; list-style: none; }
ul.list li {
  display: flex;
  gap: 6px;
  padding: 2px 5px;
  border-radius: 3px;
  font: 11px/1.5 ui-monospace, Consolas, monospace;
}
ul.list li.hit {
  background: rgba(255, 222, 16, 0.12);
  box-shadow: inset 2px 0 0 #ffde10;
}
ul.list li .tag {
  flex: 0 0 auto;
  padding: 0 4px;
  border: 1px solid rgba(255, 222, 16, 0.25);
  border-radius: 3px;
  background: rgba(255, 222, 16, 0.08);
  color: #d8c9a6;
  font-size: 10px;
}
ul.list li .num { flex: 0 0 auto; color: #ffde10; }
ul.list li .raw { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #ece0c3; }
ul.list li .when { flex: 0 0 auto; color: #a89b82; }
.status {
  padding: 4px 9px;
  font-size: 11px;
  background: linear-gradient(180deg, #2a2317 0%, #1f1910 100%);
  border-top: 1px solid #5a4b33;
  color: #c5b79a;
}
.status.busy { color: #f39c12; }
.status.warn { color: #ffd166; }
.status.error { color: #ff5252; }
details.debug { font-size: 11px; }
details.debug summary { cursor: pointer; color: #a89b82; }
details.debug pre {
  margin: 4px 0 0;
  padding: 6px 8px;
  max-height: 120px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
  border: 1px solid #6e5e41;
  border-radius: 3px;
  background: rgba(18, 14, 9, 0.95);
  color: #c5b79a;
  font: 10px/1.5 ui-monospace, Consolas, monospace;
}
.hint { color: #a89b82; font-size: 11px; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: #17120a; }
::-webkit-scrollbar-thumb { background: #5a4b33; border: 2px solid #17120a; border-radius: 5px; }
::-webkit-scrollbar-thumb:hover { background: #7d6b49; }
`;

/** 面板：显示 + 把点击转回给 :mod:`./content`（元素构造用 :func:`./dom.el`）。 */
export class Panel {
  private readonly host: HTMLDivElement;
  private readonly badge: HTMLSpanElement;
  private readonly panel: HTMLDivElement;
  private readonly seed: HTMLDivElement;
  private readonly notes: HTMLDivElement;
  private readonly cands: HTMLDivElement;
  private readonly list: HTMLUListElement;
  private readonly empty: HTMLDivElement;
  private readonly values: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly resolveBtn: HTMLButtonElement;
  private readonly autoCheck: HTMLInputElement;
  private readonly debug: HTMLDetailsElement;
  private readonly debugPre: HTMLPreElement;

  private visibleFlag = false;
  private collapsed = false;
  private dragging: { readonly dx: number; readonly dy: number } | null = null;

  constructor(private readonly handlers: PanelHandlers) {
    const title = el("span", { cls: "title", text: "种子恢复" });
    this.badge = el("span", { cls: "badge", text: "0 个数" });
    const collapseBtn = el("button", {
      cls: "icon",
      text: "–",
      title: "折叠 / 展开",
      on: { click: () => this.setCollapsed(!this.collapsed) },
    });
    const closeBtn = el("button", {
      cls: "icon",
      text: "×",
      title: "隐藏面板（下次抓到随机数会再出现）",
      on: { click: () => this.hide() },
    });
    const head = el(
      "div",
      { cls: "head" },
      title,
      el("span", { cls: "spacer" }),
      this.badge,
      collapseBtn,
      closeBtn,
    );

    this.seed = el("div", { cls: "seed none", text: "等两个随机数…" });
    this.notes = el("div", { cls: "notes" });
    this.cands = el("div", { cls: "cands" });

    this.autoCheck = el("input", {
      type: "checkbox",
      on: { change: () => this.handlers.onAutoChange(this.autoCheck.checked) },
    });
    const autoLabel = el("label", { cls: "auto" }, this.autoCheck, el("span", { text: "自动恢复" }));
    this.resolveBtn = el("button", {
      cls: "act",
      text: "恢复最近两个",
      on: { click: () => this.handlers.onResolve() },
    });
    const clearBtn = el("button", { cls: "act", text: "清空", on: { click: () => this.handlers.onClear() } });

    this.list = el("ul", { cls: "list" });
    this.empty = el("div", { cls: "empty", text: "还没有抓到随机数。授权站点后刷新游戏页面。" });
    this.values = el("div", { cls: "values" }, this.empty, this.list);

    this.debugPre = el("pre");
    this.debug = el("details", { cls: "debug" }, el("summary", { text: "原始请求日志（调试）" }), this.debugPre);
    this.debug.hidden = true;

    this.status = el("div", { cls: "status", text: "就绪" });

    const body = el(
      "div",
      { cls: "body" },
      this.seed,
      this.notes,
      this.cands,
      el("div", { cls: "row" }, autoLabel, this.resolveBtn, clearBtn),
      this.values,
      this.debug,
    );
    this.panel = el("div", { cls: "panel" }, head, body, this.status);

    const style = el("style");
    style.textContent = STYLE;

    // 面板宿主：一个自建的 ``div``，挂在 ``<html>`` 下面。
    //
    // ⚠️ **绝对不能**把 shadow 根挂在 ``document.documentElement`` 上：元素一旦有了
    // shadow 根，它的 light DOM 子节点就**不再渲染**（除非有 ``<slot>``）—— 挂到
    // ``<html>`` 上等于把整个游戏页面抹掉。挂 ``<body>`` 也不好：这是 Flash 游戏，
    // 页面自己的脚本会替换/清空 body，面板会被一起带走。所以挂在 ``<html>`` 下、
    // 跟 body 平级。
    this.host = el("div");
    this.host.id = HOST_ID;
    this.host.style.display = "none";
    // 老引擎的 flex 不认 gap：给宿主打个类，让 :host(.no-flex-gap) 那几条兜底生效。
    // 注意是打在**我们的宿主**上，不是页面的 <html> 上 —— 面板在 shadow 根里。
    if (!supportsFlexGap()) this.host.classList.add("no-flex-gap");
    // 页面里可能已经有一个**孤儿**面板：扩展被重新加载时，旧内容脚本所在的隔离世界
    // 会连同它的 DOM 一起失效，但节点还留在页面上。这里顺手清掉，免得页面上叠两个。
    document.getElementById(HOST_ID)?.remove();
    document.documentElement.append(this.host);
    const root = this.host.attachShadow({ mode: "open" });
    root.append(style, this.panel);

    this.bindDrag(head);
  }

  get visible(): boolean {
    return this.visibleFlag;
  }

  show(): void {
    this.visibleFlag = true;
    this.host.style.display = "block";
  }

  hide(): void {
    this.visibleFlag = false;
    this.host.style.display = "none";
  }

  setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    this.panel.classList.toggle("collapsed", collapsed);
  }

  setAuto(auto: boolean): void {
    this.autoCheck.checked = auto;
  }

  setBusy(busy: boolean): void {
    this.resolveBtn.disabled = busy;
    this.panel.classList.toggle("busy", busy);
  }

  setStatus(text: string, level: StatusLevel = "info"): void {
    this.status.textContent = text;
    this.status.className = `status ${level === "info" ? "" : level}`.trim();
  }

  /** 值列表（``pair`` 里那两个高亮：``恢复`` = 较早，``匹配`` = 较晚）。 */
  setValues(values: readonly CapturedValue[], pair: ValuePair | null): void {
    this.badge.textContent = `${values.length} 个数`;
    this.empty.hidden = values.length > 0;
    clear(this.list);
    // 倒序：最新的在最上面（面板很小，没人想往下滚）。
    const rows = [...values].reverse();
    for (const item of rows) {
      const tag =
        pair !== null && item === pair.earlier ? "恢复" : pair !== null && item === pair.later ? "匹配" : null;
      const li = el(
        "li",
        { cls: tag === null ? "" : "hit", title: item.url },
        el("span", { cls: "tag", text: tag ?? item.ruleName }),
        el("span", { cls: "num", text: String(item.value) }),
        el("span", { cls: "raw", text: item.text }),
        el("span", { cls: "when", text: clock(item.ts) }),
      );
      this.list.append(li);
    }
  }

  /** 恢复结果；``null`` = 还没算。 */
  setResult(outcome: ResolveOutcome | null): void {
    if (outcome === null) {
      this.seed.textContent = "等两个随机数…";
      this.seed.className = "seed none";
      this.notes.textContent = "";
      this.cands.textContent = "";
      return;
    }
    this.seed.textContent = outcome.summary;
    this.seed.className = outcome.found ? "seed" : "seed none";
    this.notes.textContent = outcome.notes.join("；");
    this.cands.textContent =
      outcome.candidates.length > 1
        ? `候选种子：${outcome.candidates.join(", ")}`
        : outcome.candidates.length === 1
          ? `候选种子：${outcome.candidates[0]}`
          : "";
  }

  /** 调试用的原始请求日志（只有 ``prefs.debug`` 打开时才显示）。 */
  setDebug(enabled: boolean): void {
    this.debug.hidden = !enabled;
  }

  setLog(lines: readonly string[]): void {
    this.debugPre.textContent = lines.join("\n");
  }

  /** 头部拖动。用 ``pointer*`` 事件（鼠标/触屏一套），拖过之后改用 ``left/top``。 */
  private bindDrag(head: HTMLElement): void {
    head.addEventListener("pointerdown", (event) => {
      if (event.target instanceof HTMLElement && event.target.closest("button") !== null) return;
      const rect = this.host.getBoundingClientRect();
      this.dragging = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      this.host.style.left = `${rect.left}px`;
      this.host.style.top = `${rect.top}px`;
      this.host.style.right = "auto";
      head.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    head.addEventListener("pointermove", (event) => {
      const drag = this.dragging;
      if (drag === null) return;
      // 夹在视口内，免得拖出屏幕再也点不到。
      const left = Math.min(Math.max(0, event.clientX - drag.dx), window.innerWidth - 40);
      const top = Math.min(Math.max(0, event.clientY - drag.dy), window.innerHeight - 24);
      this.host.style.left = `${left}px`;
      this.host.style.top = `${top}px`;
    });
    const stop = (): void => {
      this.dragging = null;
    };
    head.addEventListener("pointerup", stop);
    head.addEventListener("pointercancel", stop);
  }
}
