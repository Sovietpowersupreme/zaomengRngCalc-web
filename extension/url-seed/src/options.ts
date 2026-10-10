/**
 * 设置页入口 —— 真正的界面全在 :mod:`./settings`（popup 也要用它的一部分）。
 *
 * 这里只留「找容器 + 报错」两件事：启动失败必须**写进页面**，因为设置页报错
 * 没有任何别的地方能看到（用户不会去开 devtools 看一个设置页）。
 */

import { clear, mustFind } from "./dom";
import { mountSettings } from "./settings";

const app = mustFind("app");

void mountSettings(app).catch((err: unknown) => {
  // ⚠️ 这条**报错兜底路径**以前自己也在用 ``replaceChildren``（Chrome 86+）⇒ 老内核上
  // 它跟着一起抛，用户看到的是「设置页全白」，连报错都读不到 —— 最坏的一种失败。
  clear(app);
  const box = document.createElement("pre");
  box.style.cssText =
    "margin:16px;padding:12px;white-space:pre-wrap;color:#ff6b6b;background:rgba(80,20,20,.5);border:1px solid #ff5252;border-radius:4px;";
  box.textContent = `设置页启动失败：\n${err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err)}`;
  app.append(box);
});
