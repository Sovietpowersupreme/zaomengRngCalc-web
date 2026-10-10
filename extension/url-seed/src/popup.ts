/**
 * popup —— 「就现在这一页」的快捷操作。
 *
 * 它是扩展的**入口**，不是设置页：用户点图标的场景永远是「我在游戏页面上，
 * 想看种子」。所以这里只做三件事：
 *
 * 1. 拼出当前网站的 match pattern，一键申请权限并把站点记下来
 *    （这一步必须在 popup 里做 —— ``activeTab`` 权限只在用户点图标这一下生效，
 *    设置页里拿不到当前标签页的完整 URL）；
 * 2. 探一下这页有没有内容脚本在跑，有就顺手把它的当前状态（抓了几个数、
 *    恢复出什么）显示出来 —— 不打开面板也能看到结果；
 * 3. 给一条去设置页的链接。
 *
 * 所有真实状态都在内容脚本 / SW 里，这里**只是查询与转发**。
 */

import { activeTab, askTab, containsOrigin, executeContentScript, openOptionsPage, reloadTab, requestOrigins, sendToTab } from "./chromeAsync";
import { clear, el, mustFind, replace } from "./dom";
import { CONTENT_SCRIPT_FILE, messageType, type PingMessage, type PongMessage, type ShowPanelMessage } from "./protocol";
import { addSite, hasSite } from "./settings";
import { hostOfPattern, patternForUrl } from "./sites";
import { loadPrefs, loadRules, loadSites, savePrefs, type PanelPrefs } from "./storage";
import { installStyles, THEME } from "./theme";

/**
 * popup 自己的排布（配色与控件在 :mod:`./theme`，与设置页共用）。
 *
 * 320px 宽的窄条放不下设置页那套三列网格，所以这里就是一列往下堆；只有 ``.host``
 * 单独做成一块木牌 —— 那是整个 popup 里信息量最大的一行（「现在跑在哪个站上」）。
 */
const POPUP_STYLE = `
.pop { display: grid; gap: 8px; padding: 12px 14px 14px; }
.pop h1 {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: #ffde10;
  text-shadow: 0 1px 3px #000, 0 0 8px rgba(255, 222, 16, 0.35);
}
.line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.host {
  padding: 3px 9px;
  font-weight: 700;
  color: #ffde10;
  word-break: break-all;
  background: rgba(30, 24, 15, 0.9);
  border: 1px solid #6b5a3e;
  border-radius: 4px;
}
.actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.actions + .actions { margin-top: 2px; }
.actions > a { font-size: 12px; }
/* 老引擎的 flex 不认 gap（类由 installStyles() 挂，见 theme.ts）：靠兄弟边距顶开 */
html.no-flex-gap .line > * + * { margin-left: 8px; }
html.no-flex-gap .actions > * + * { margin-left: 6px; }
`;

const app = mustFind("app");
// 样式挂 <head>：下面是会 clear(app) 重渲染的，挂在 app 里会被一起清掉。
installStyles(THEME, POPUP_STYLE);
app.classList.add("pop");

function line(...children: readonly (Node | string | null)[]): HTMLElement {
  return el("div", { cls: "line" }, ...children);
}

async function pingContentScript(tabId: number): Promise<PongMessage | null> {
  const request: PingMessage = { type: "url-seed:ping" };
  const reply = await askTab(tabId, request);
  return messageType(reply) === "url-seed:pong" ? (reply as PongMessage) : null;
}

async function render(): Promise<void> {
  clear(app);

  const tab = await activeTab();
  const url = tab?.url ?? "";
  const pattern = patternForUrl(url);

  if (tab?.id === undefined || url === "" || pattern === null) {
    app.append(
      el("h1", { text: "种子恢复" }),
      line(el("span", { cls: "muted", text: "当前页面不能用 —— 只在 http/https 的游戏页面上工作。" })),
      line(el("a", { text: "规则与站点设置", on: { click: () => void openOptionsPage() } })),
    );
    return;
  }

  const host = hostOfPattern(pattern);
  const [listed, granted, prefs, rules, sites] = await Promise.all([
    hasSite(pattern),
    containsOrigin(pattern),
    loadPrefs(),
    loadRules(),
    loadSites(),
  ]);
  const enabled = rules.filter((rule) => rule.enabled).length;

  app.append(
    el("h1", { text: "种子恢复" }),
    line(el("div", { cls: "host", text: host })),
    line(el("span", { cls: "muted", text: `站点 ${sites.length} 个｜规则 ${enabled}/${rules.length} 条启用` })),
  );

  const auto = el("input", {
    type: "checkbox",
    checked: prefs.auto,
    on: {
      change: (event) => {
        const next: PanelPrefs = { ...prefs, auto: (event.target as HTMLInputElement).checked };
        void savePrefs(next);
      },
    },
  });
  app.append(line(auto, el("span", { text: "自动恢复最近两个随机数" })));

  const actions = el("div", { cls: "actions" });

  if (!listed) {
    const status = line(el("span", { cls: "muted", text: "还没为此网站开启监听。" }));
    app.append(status);
    actions.append(
      el("button", {
        cls: "primary",
        text: `开启 ${host} 的监听`,
        title: pattern,
        on: {
          click: async (event) => {
            const button = event.currentTarget as HTMLButtonElement;
            button.disabled = true;
            const result = await addSite(pattern);
            if (result === "ok") {
              replace(status, el("span", { cls: "ok", text: "已授权。正在注入…" }));
              await executeContentScript(tab.id as number, CONTENT_SCRIPT_FILE).catch(() => undefined);
              const show: ShowPanelMessage = { type: "url-seed:show-panel" };
              sendToTab(tab.id as number, show);
              const pong = await pingContentScript(tab.id as number);
              replace(
                status,
                el("span", {
                  cls: pong === null ? "muted" : "ok",
                  text: pong === null ? "已授权，刷新游戏页面后自动生效。" : `已接管这一页（当前 ${pong.count} 个随机数）。`,
                }),
              );
              await render();
              return;
            }
            replace(
              status,
              el("span", {
                cls: "err",
                text:
                  result === "denied"
                    ? "授权被拒绝 —— 没有权限就读不到网络请求。"
                    : result === "duplicate"
                      ? "这个网站已经在列表里了。"
                      : result === "invalid"
                        ? "这页的地址没法转成合法的匹配规则。"
                        : "当前环境不支持申请权限。",
              }),
            );
            button.disabled = false;
          },
        },
      }),
    );
  } else {
    const pong = await pingContentScript(tab.id);
    app.append(
      pong === null
        ? line(el("span", { cls: "muted", text: "已授权，但这一页还没有内容脚本（刷新后自动生效）。" }))
        : line(
            el("span", { cls: pong.count > 0 ? "ok" : "muted", text: `已接管：${pong.count} 个随机数` }),
            el("span", { cls: "muted", text: "｜" }),
            el("span", { text: pong.summary }),
          ),
    );
    // 站点在列表里不等于权限还在：用户可能到 Chrome 的「扩展详情 → 网站访问权限」里收回了。
    // 这种“看着开了其实没开”的状态必须说出来，否则没人能想明白为什么一直没反应。
    if (!granted) {
      app.append(line(el("span", { cls: "warn", text: "注意：这个网站的访问权限已被收回，现在读不到它的网络请求。" })));
      actions.append(
        el("button", {
          text: "重新授权",
          on: {
            click: async () => {
              const ok = await requestOrigins([pattern]).catch(() => false);
              if (ok) await reloadTab(tab.id as number);
              await render();
            },
          },
        }),
      );
    }
    actions.append(
      el("button", {
        text: "显示面板",
        on: {
          click: () => {
            const show: ShowPanelMessage = { type: "url-seed:show-panel" };
            sendToTab(tab.id as number, show);
          },
        },
      }),
      el("button", {
        text: pong === null ? "立刻注入" : "重新注入",
        title: "不刷新页面，直接把内容脚本塞进这一页",
        on: {
          click: async (event) => {
            const button = event.currentTarget as HTMLButtonElement;
            button.disabled = true;
            await executeContentScript(tab.id as number, CONTENT_SCRIPT_FILE).catch(() => undefined);
            const show: ShowPanelMessage = { type: "url-seed:show-panel" };
            sendToTab(tab.id as number, show);
            await render();
          },
        },
      }),
      el("button", { text: "刷新本页", on: { click: () => void reloadTab(tab.id as number) } }),
    );
  }

  app.append(actions);
  app.append(
    el(
      "div",
      { cls: "actions" },
      el("a", { text: "规则与站点设置", on: { click: () => void openOptionsPage() } }),
    ),
  );
}

void render();
