/**
 * 设置界面 —— 站点（授权域名）、规则、偏好的编辑逻辑。
 *
 * 独立成模块的理由：``options.html`` 与 ``popup.html`` 都要「加当前网站」这一个动作，
 * 而规则编辑器只出现在 ``options``。共用的部分（:func:`addSite` / :func:`removeSite`）
 * 与只给设置页的部分（:func:`mountSettings`）放一起，是因为它们都围绕同一份
 * ``chrome.storage``，分开反而要来回跳文件对字段。
 *
 * 两条实现上的讲究：
 *
 * 1. **输入时不能整块重渲染** —— 每敲一个字符就 ``clear()`` 再重建会把焦点连同
 *    光标位置一起丢掉（中文输入法直接废掉）。所以只在**结构变化**（增删规则、
 *    换上下顺序、切采集/忽略、恢复默认）时重渲染，输入事件只就地更新模型、
 *    保存、刷新**这一张卡片**的校验与预览。
 *    （清空一律走 :func:`./dom.clear` —— **不要**用 ``replaceChildren``：它是 Chrome
 *    86+ 的 API，旧内核上直接 ``TypeError``，而这正是「设置页只剩外壳」那次的成因。）
 * 2. **校验与预览都调 :mod:`./rules` 里的真函数** —— 不做「另写一份宽松版」的事，
 *    否则设置页显示「✓ 可用」而实际运行报错，那比不校验更坑。
 */

import { containsOrigin, removeOrigins, requestOrigins } from "./chromeAsync";
import { clear, el } from "./dom";
import {
  DEFAULT_EXTRACT,
  DEFAULT_FASTNEXT,
  DEFAULT_FORMULA,
  MAX_FASTNEXT,
  newRule,
  previewRule,
  restoreDefaults,
  validateRule,
  type Rule,
  type RuleKind,
} from "./rules";
import { FORMULA_HELP } from "./formula";
import { normalizePattern } from "./sites";
import { loadPrefs, loadRules, loadSites, savePrefs, saveRules, saveSites } from "./storage";
import { installStyles, masthead, THEME } from "./theme";

/** :func:`addSite` 的结果。 */
export type AddSiteResult =
  /** 已授权并写入。 */
  | "ok"
  /** 已经在这个列表里了。 */
  | "duplicate"
  /** 不是合法的 match pattern。 */
  | "invalid"
  /** 用户在权限弹窗里点了拒绝。 */
  | "denied"
  /** 不在扩展环境里（单测 / 非 Chrome）。 */
  | "unavailable";

/**
 * 加一个站点：规范化 → 申请权限 → 写 storage。
 *
 * ⚠️ 必须在**用户手势**里调（按钮的 click 回调），否则 ``permissions.request``
 * 会被 Chrome 直接拒掉且不弹窗。
 */
export async function addSite(input: string): Promise<AddSiteResult> {
  const pattern = normalizePattern(input);
  if (pattern === null) return "invalid";
  // ⚠️ 顺序要紧：``permissions.request`` 必须尽量贴着用户手势。先写 storage 再请权限
  // （中间夹一次 ``await``）就可能让 Chrome 认为「这不是用户手势」而直接拒掉且不弹窗。
  // 已授权的 origin 会立即返回 ``true`` 且不出弹窗，所以重复添加时这一步是空转。
  let granted: boolean;
  try {
    granted = await requestOrigins([pattern]);
  } catch {
    return "unavailable";
  }
  if (!granted) return "denied";
  const sites = await loadSites();
  if (sites.includes(pattern)) return "duplicate";
  await saveSites([...sites, pattern]);
  return "ok";
}

/** 删一个站点（同时撤销它的 host 权限 —— 不留多余授权）。 */
export async function removeSite(pattern: string): Promise<void> {
  const sites = await loadSites();
  await saveSites(sites.filter((site) => site !== pattern));
  try {
    await removeOrigins([pattern]);
  } catch {
    // 撤销失败不影响功能（storage 里的站点已删，SW 下次同步就不再注册它）。
  }
}

/** 从 URL 猜出的 match pattern 是不是已经在列表里（popup 用来改按钮文案）。 */
export async function hasSite(pattern: string): Promise<boolean> {
  return (await loadSites()).includes(pattern);
}

// =========================================================================== 设置页主体

/**
 * 设置页**布局**（配色与控件在 :mod:`./theme` 里，两边共用）。
 *
 * 之前的毛病是「文字左对齐还贴着窗口左边缘」：整页只有一个 960px 的版心，每行
 * ``label`` 固定 62px 且**文字左对齐**，于是所有说明文字都从最左边起排。
 * 现在照计算器的参数面板来：
 *
 * - 版心居中并留出左右内边距；
 * - 每段是一个金边 ``fieldset``（``legend`` 当标题），内容离边框 18px；
 * - 带标签的行用三列网格，``label`` **右对齐**贴着自己的字段（同 ``web/src/ui/App.vue``
 *   的 ``.rows`` / ``.row`` / ``.label``）。
 */
const STYLE = `
.page {
  display: grid;
  align-content: start;
  gap: 16px;
  max-width: 1040px;
  margin: 0 auto;
  padding: 18px 22px 72px;
}

/* 分组框：与计算器参数面板同款（金边 legend + 厚内边距） */
.group {
  margin: 0;
  padding: 8px 18px 16px;
  border: 1px solid #6e5e41;
  border-radius: 6px;
  background: rgba(38, 31, 21, 0.75);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
}
.group > legend {
  padding: 0 9px;
  font-size: 12px;
  font-weight: 700;
  color: #ffde10;
  text-shadow: 0 1px 2px #000;
  background: #33291b;
  border: 1px solid #7d6b49;
  border-radius: 3px;
}

/* 说明条：左侧一道金线 */
.hint {
  margin: 0 0 12px;
  padding: 7px 12px;
  color: #c5b79a;
  font-size: 12px;
  line-height: 1.65;
  background: rgba(43, 37, 23, 0.6);
  border-left: 3px solid #ffde10;
  border-radius: 0 4px 4px 0;
}

.list { display: grid; gap: 10px; }
.rows { display: grid; gap: 8px; }

/* 规则卡片：左沿一道竖条，启用=木色、关掉=暗、有错=红 */
.rule {
  display: grid;
  gap: 8px;
  padding: 10px 14px 12px;
  border: 1px solid #6e5e41;
  border-left: 3px solid #7d6b49;
  border-radius: 6px;
  background: rgba(28, 23, 15, 0.72);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.28);
}
.rule > .bar { padding-bottom: 8px; border-bottom: 1px dashed rgba(125, 107, 73, 0.35); }
.rule.bad { border-color: #a33a3a; border-left-color: #ff5252; background: rgba(60, 22, 22, 0.5); }
.rule.off { opacity: 0.58; border-left-color: #4a3d2a; }
.rule.off .name { text-decoration: line-through; text-decoration-color: #7c6f5a; }

/* 带标签的字段行：标签右对齐，字段占满剩余宽度 */
.field {
  display: grid;
  grid-template-columns: minmax(84px, max-content) minmax(0, 1fr) max-content;
  align-items: center;
  gap: 10px;
}
.field > label {
  text-align: right;
  color: #e5d7ba;
  font-size: 12px;
  font-weight: 500;
}
.field input[type="text"] { width: 100%; }
.fastnext { width: 96px; justify-self: start; }
.field > .hint { justify-self: start; color: #a89b82; font-size: 11px; }
.field > select { justify-self: start; min-width: 200px; }

/* 无标签的操作行 */
.bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.bar > input[type="text"].grow { width: 100%; }

.name { width: 260px; font-size: 13px; font-family: inherit; }

.badge {
  padding: 1px 8px;
  border-radius: 9px;
  font-size: 11px;
  white-space: nowrap;
  color: #c5b79a;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.13);
}
.badge.builtin { color: #bcdcff; background: rgba(120, 190, 255, 0.16); border-color: rgba(120, 190, 255, 0.34); }
.badge.ignore { color: #ffd166; background: rgba(255, 222, 16, 0.1); border-color: rgba(255, 222, 16, 0.28); }

/* 已授权站点：一行一块木牌 */
.site {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  border: 1px solid #5a4b33;
  border-radius: 4px;
  background: rgba(30, 24, 15, 0.85);
}
.site > code { flex: 0 0 auto; }

/* 偏好：整行可点的复选框牌 */
.bool {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 12px;
  font-size: 13px;
  border: 1px solid #5a4b33;
  border-radius: 4px;
  background: rgba(30, 24, 15, 0.6);
  cursor: pointer;
}
.bool:hover { border-color: #7d6b49; background: rgba(40, 32, 20, 0.8); }

/* 公式说明：金菱形列表 */
.help {
  display: grid;
  gap: 5px;
  margin: 0;
  padding: 0;
  list-style: none;
  color: #c5b79a;
  font-size: 12px;
}
.help li { display: flex; align-items: baseline; gap: 8px; }
.help li::before { content: "❖"; flex: 0 0 auto; color: #f39c12; font-size: 9px; }

.note { color: #a89b82; font-size: 12px; }
.problems { display: grid; gap: 2px; font-size: 12px; }
.problems .problem { color: #ff6b6b; }
.problems .ok { color: #4cd964; }
.preview-out {
  padding: 6px 10px;
  font: 12px/1.6 Consolas, "Cascadia Mono", ui-monospace, monospace;
  color: #ece0c3;
  background: rgba(18, 14, 9, 0.95);
  border: 1px solid #6e5e41;
  border-radius: 4px;
  box-shadow: inset 0 1px 5px rgba(0, 0, 0, 0.8);
  overflow-wrap: anywhere;
}
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 0 0 12px; }
/* 老引擎的 flex 不认 gap（类由 installStyles() 挂，见 theme.ts）：靠兄弟边距顶开。
   网格布局的 gap 老引擎一直支持，所以上面那些 display: grid 的行不用管。 */
html.no-flex-gap .bar > * + * { margin-left: 8px; }
html.no-flex-gap .site > * + * { margin-left: 10px; }
html.no-flex-gap .bool > * + * { margin-left: 9px; }
html.no-flex-gap .help li > * + * { margin-left: 8px; }
html.no-flex-gap .actions > * + * { margin-left: 8px; }
.msg { margin: 0; min-height: 18px; font-size: 12px; color: #c5b79a; }
.msg.err { color: #ff6b6b; }
.msg.ok { color: #4cd964; }
`;

interface Ctx {
  rulesHost: HTMLElement;
  sitesHost: HTMLElement;
  sitesMsg: HTMLElement;
  prefsHost: HTMLElement;
}

/** 一条内置规则备注里带着「例：<url> —— …」，把那个 url 挖出来当预览样例。 */
function sampleUrlOf(rule: Rule): string {
  const note = rule.note ?? "";
  const at = note.indexOf("例：");
  if (at < 0) return "";
  const rest = note.slice(at + 2);
  const stop = rest.indexOf(" ");
  return stop < 0 ? rest : rest.slice(0, stop);
}

/** 把设置界面挂到 ``root`` 上（``options.html`` 的 ``<main>``）。 */
export async function mountSettings(root: HTMLElement): Promise<void> {
  // 样式挂 <head>：下面两处都会 clear() 重渲染，挂在 root 里会被一起清掉。
  installStyles(THEME, STYLE);
  const page = el("div", { cls: "page" });
  root.append(masthead("造梦西游3 · 种子恢复", "URL 随机数 → 种子", "规则与站点"), page);

  let rules = await loadRules();
  let prefs = await loadPrefs();

  const ctx: Ctx = {
    rulesHost: el("div", { cls: "list" }),
    sitesHost: el("div", { cls: "list" }),
    sitesMsg: el("div", { cls: "msg" }),
    prefsHost: el("div", { cls: "rows" }),
  };

  let saveTimer: number | null = null;
  const saveRulesSoon = (): void => {
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      void saveRules(rules);
    }, 250);
  };

  // ---------------------------------------------------------------- 规则

  function toggleOff(card: HTMLElement, off: boolean): void {
    card.classList.toggle("off", off);
  }

  function ruleCard(rule: Rule, index: number): HTMLElement {
    const card = el("div", { cls: "rule", attrs: { "data-rule-id": rule.id } });
    toggleOff(card, !rule.enabled);

    const problems = el("div", { cls: "problems" });
    const previewOut = el("div", { cls: "preview-out" });

    const check = (): void => {
      clear(problems);
      const list = validateRule(rule);
      card.classList.toggle("bad", list.length > 0);
      if (list.length === 0) problems.append(el("div", { cls: "ok", text: "✓ 规则可用" }));
      else for (const problem of list) problems.append(el("div", { cls: "problem", text: `✗ ${problem}` }));
    };

    // ---- 头部：启用 / 名字 / 徽标 / 排序与删除
    const enabled = el("input", {
      type: "checkbox",
      checked: rule.enabled,
      title: "关掉的规则完全不参与判定",
      on: {
        change: (event) => {
          rule.enabled = (event.target as HTMLInputElement).checked;
          toggleOff(card, !rule.enabled);
          saveRulesSoon();
        },
      },
    });
    const name = el("input", {
      cls: "name",
      type: "text",
      value: rule.name,
      title: "起个好认的名字",
      on: {
        input: (event) => {
          rule.name = (event.target as HTMLInputElement).value;
          saveRulesSoon();
          check();
        },
      },
    });
    const kind = el("select", {
      title: "「忽略」表示这条 URL 上的数字不是游戏随机数，直接丢掉",
      on: {
        change: (event) => {
          rule.kind = (event.target as HTMLSelectElement).value as RuleKind;
          saveRulesSoon();
          void renderRules(); // 采集/忽略的字段不一样，整块重画
        },
      },
    });
    kind.append(
      el("option", { value: "capture", text: "采集随机数", attrs: rule.kind === "capture" ? { selected: "selected" } : {} }),
      el("option", { value: "ignore", text: "忽略这条 URL", attrs: rule.kind === "ignore" ? { selected: "selected" } : {} }),
    );

    const move = (delta: number): void => {
      const to = index + delta;
      if (to < 0 || to >= rules.length) return;
      const moved = rules[index];
      const target = rules[to];
      if (moved === undefined || target === undefined) return;
      rules[index] = target;
      rules[to] = moved;
      saveRulesSoon();
      void renderRules();
    };

    card.append(
      el(
        "div",
        { cls: "bar" },
        enabled,
        name,
        rule.builtin === true ? el("span", { cls: "badge builtin", text: "内置" }) : el("span", { cls: "badge", text: "自定义" }),
        el("span", { cls: "badge ignore", text: `优先级 ${index + 1}` }),
        el("span", { cls: "spring" }),
        el("button", { text: "↑ 上移", title: "往上移 = 更优先", on: { click: () => move(-1) } }),
        el("button", { text: "↓ 下移", on: { click: () => move(1) } }),
        el("button", {
          text: "删除",
          title: rule.builtin === true ? "删了还能用上面的「恢复默认规则」找回来" : "删掉这条规则",
          on: {
            click: () => {
              rules = rules.filter((item) => item.id !== rule.id);
              saveRulesSoon();
              void renderRules();
            },
          },
        }),
      ),
      el("div", { cls: "field" }, el("label", { text: "匹配 URL" }), el("div", { cls: "grow" }, textField(rule, "match", rule.match, "在完整 URL 上跑的正则，例：[?&]ac=get_token\\b", check))),
    );

    if (rule.kind === "capture") {
      card.append(
        el("div", { cls: "field" }, el("label", { text: "类型" }), kind),
        el(
          "div",
          { cls: "field" },
          el("label", { text: "提取" }),
          el(
            "div",
            { cls: "grow" },
            textField(rule, "extract", rule.extract ?? DEFAULT_EXTRACT, "用 (…) 把数字括起来，例：(?:[?&]|^)ran=([^&#\\s]+)", check),
          ),
        ),
        el(
          "div",
          { cls: "field" },
          el("label", { text: "换算公式" }),
          el("div", { cls: "grow" }, textField(rule, "formula", rule.formula ?? DEFAULT_FORMULA, "例：int(n / 100000 * 0x80000000)", check)),
        ),
        el(
          "div",
          { cls: "field" },
          el("label", { text: "后移次数" }),
          fastnextField(rule, check),
          el("span", { cls: "hint", text: `拿到种子后再往后 FastNext 几次（0~${MAX_FASTNEXT}，默认 0）` }),
        ),
      );
    } else {
      card.append(el("div", { cls: "field" }, el("label", { text: "类型" }), kind));
    }

    if (rule.note !== undefined && rule.note !== "") {
      card.append(el("div", { cls: "note", text: rule.note }));
    }
    if (rule.kind === "capture") {
      const sample = el("input", { cls: "grow", type: "text", value: sampleUrlOf(rule), placeholder: "粘一条真实 URL 试试这条规则" });
      const run = (): void => {
        previewOut.textContent = previewRule(rule, sample.value);
      };
      card.append(
        el(
          "div",
          { cls: "field" },
          el("label", { text: "试一下" }),
          sample,
          el("button", { text: "预览", on: { click: run } }),
        ),
        previewOut,
      );
      if (sample.value !== "") run();
    }
    card.append(problems);
    check();
    return card;
  }

  /** 在卡片里就地改一个字符串字段（不重渲染 ⇒ 不丢焦点）。 */
  function textField(rule: Rule, key: "match" | "extract" | "formula", value: string, placeholder: string, check: () => void): HTMLElement {
    return el("input", {
      type: "text",
      value,
      placeholder,
      on: {
        input: (event) => {
          rule[key] = (event.target as HTMLInputElement).value;
          saveRulesSoon();
          check();
        },
      },
    });
  }

  /**
   * 「后移次数」的整数框（同样就地改、不重渲染 ⇒ 不丢焦点）。
   *
   * 这里**故意不做静默纠正**：负数 /超大 / 小数都原样存进规则里，让
   * :func:`validateRule` 报错、卡片变红。若在这里悄悄夹成 0，用户会看到输入框
   * 写着 ``-3``、卡片却是绿的 —— 数据和界面各说各话，比直接报错更让人困惑。
   * 只有「空串 / 压根不是数」才回落 :data:`DEFAULT_FASTNEXT`（等价于清空 = 0）。
   *
   * 落库时 :func:`~./storage.saveRules` 之后还会经 :func:`~./rules.normalizeRule`
   * 过一遍 :func:`~./rules.coerceFastnext`，所以坏值不会真的留在磁盘上。
   */
  function fastnextField(rule: Rule, check: () => void): HTMLElement {
    return el("input", {
      cls: "fastnext",
      type: "number",
      value: String(rule.fastnext ?? DEFAULT_FASTNEXT),
      title: `拿到种子后再往后 FastNext 几次（0~${MAX_FASTNEXT}）：恢复出的是「读出匹配值之前」的种子，游戏在那之后又推进了 N 步就填 N`,
      attrs: { min: "0", max: String(MAX_FASTNEXT), step: "1" },
      on: {
        input: (event) => {
          const text = (event.target as HTMLInputElement).value;
          const num = Number(text);
          rule.fastnext = text.trim() === "" || !Number.isFinite(num) ? DEFAULT_FASTNEXT : num;
          saveRulesSoon();
          check();
        },
      },
    });
  }

  function renderRules(): void {
    clear(ctx.rulesHost);
    rules.forEach((rule, index) => ctx.rulesHost.append(ruleCard(rule, index)));
  }

  // ---------------------------------------------------------------- 站点

  async function renderSites(): Promise<void> {
    clear(ctx.sitesHost);
    const sites = await loadSites();
    if (sites.length === 0) {
      ctx.sitesHost.append(el("div", { cls: "note", text: "还没有任何网站。在游戏页面点扩展图标「为当前网站开启监听」最省事。" }));
      return;
    }
    for (const pattern of sites) {
      const granted = await containsOrigin(pattern);
      ctx.sitesHost.append(
        el(
          "div",
          { cls: "site" },
          el("code", { text: pattern }),
          el("span", { cls: granted ? "badge builtin" : "badge ignore", text: granted ? "已授权" : "未授权" }),
          el("span", { cls: "spring" }),
          granted
            ? null
            : el("button", {
                text: "授权",
                on: {
                  click: async () => {
                    const ok = await requestOrigins([pattern]).catch(() => false);
                    ctx.sitesMsg.textContent = ok ? "已授权。" : "未授权（弹窗被拒绝或不在扩展环境里）。";
                    await renderSites();
                  },
                },
              }),
          el("button", {
            text: "删除",
            on: {
              click: async () => {
                await removeSite(pattern);
                ctx.sitesMsg.textContent = `已移除 ${pattern}（同时撤销了它的访问权限）。`;
                await renderSites();
              },
            },
          }),
        ),
      );
    }
  }

  // ---------------------------------------------------------------- 偏好

  function renderPrefs(): void {
    clear(ctx.prefsHost);
    const auto = el("input", {
      type: "checkbox",
      checked: prefs.auto,
      on: {
        change: (event) => {
          prefs = { ...prefs, auto: (event.target as HTMLInputElement).checked };
          void savePrefs(prefs);
        },
      },
    });
    const debug = el("input", {
      type: "checkbox",
      checked: prefs.debug,
      on: {
        change: (event) => {
          prefs = { ...prefs, debug: (event.target as HTMLInputElement).checked };
          void savePrefs(prefs);
        },
      },
    });
    ctx.prefsHost.append(
      el(
        "label",
        { cls: "bool" },
        auto,
        el("span", { text: "自动恢复（可能造成卡顿）" }),
      ),
      el("label", { cls: "bool" }, debug, el("span", { text: "页面面板里显示 URL 调试日志" })),
    );
  }

  // ---------------------------------------------------------------- 组装

  const addInput = el("input", {
    cls: "grow",
    type: "text",
    placeholder: "https://*.4399.com/*",
    on: {
      keydown: (event) => {
        if ((event as KeyboardEvent).key === "Enter") void doAdd();
      },
    },
  });
  const doAdd = async (): Promise<void> => {
    ctx.sitesMsg.className = "msg";
    const result = await addSite(addInput.value);
    if (result === "ok") {
      addInput.value = "";
      ctx.sitesMsg.className = "msg ok";
      ctx.sitesMsg.textContent = "已添加并授权。刷新游戏页面后生效。";
      await renderSites();
      return;
    }
    ctx.sitesMsg.className = "msg err";
    ctx.sitesMsg.textContent =
      result === "invalid"
        ? "格式不对。要写成 match pattern，例：https://*.4399.com/*"
        : result === "duplicate"
          ? "这个网站已经在列表里了。"
          : result === "denied"
            ? "没有授权，扩展无法读取这个网站的网络请求。"
            : "当前环境不支持申请权限（只能在扩展页面里操作）。";
  };

  page.append(
    el(
      "fieldset",
      { cls: "group" },
      el("legend", { text: "监听哪些网站" }),
      el("p", {
        cls: "hint",
        text: "只有在下面这些网站的页面里，扩展才会读取网络请求来提取随机数。改动会让你重新授权，刷新页面后生效。",
      }),
      el("div", { cls: "rows" }, ctx.sitesHost),
      el("div", { cls: "bar" }, addInput, el("button", { cls: "primary", text: "添加", on: { click: () => void doAdd() } })),
      ctx.sitesMsg,
    ),
    el(
      "fieldset",
      { cls: "group" },
      el("legend", { text: "规则" }),
      el("p", {
        cls: "hint",
        text: "从上往下逐条试，第一条匹配的规则说了算。所以「忽略」用的规则要排在前面。删掉内置的也不要紧，点「恢复默认规则」会补回来（不会动你自己加的规则）。",
      }),
      el(
        "div",
        { cls: "actions" },
        el("button", {
          cls: "primary",
          text: "新建规则",
          on: {
            click: () => {
              rules.push(newRule(rules));
              saveRulesSoon();
              void renderRules();
            },
          },
        }),
        el("button", {
          text: "恢复默认规则",
          title: "把所有内置规则恢复成出厂值，并把被删掉的补回来；自定义规则不受影响",
          on: {
            click: () => {
              rules = restoreDefaults(rules);
              saveRulesSoon();
              void renderRules();
            },
          },
        }),
      ),
      ctx.rulesHost,
    ),
    el(
      "fieldset",
      { cls: "group" },
      el("legend", { text: "偏好" }),
      ctx.prefsHost,
    ),
    el(
      "fieldset",
      { cls: "group" },
      el("legend", { text: "公式怎么写" }),
      el("ul", { cls: "help" }, ...FORMULA_HELP.map((line) => el("li", { text: line }))),
    ),
  );

  renderRules();
  await renderSites();
  renderPrefs();
}
