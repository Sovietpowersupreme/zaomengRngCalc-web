/**
 * 回调式 ``chrome.*`` API 的 Promise 包装 —— 只包本扩展真正会用的那几个。
 *
 * ``web/extension/url-seed/src/chrome.d.ts`` 里的签名全是**回调式**（那是 MV3 里
 * 到处都在用的老写法，Promise 版是逐步加的、不同版本覆盖面不一致）。把回调统一
 * 收在这一层，好处有三个：
 *
 * * 调用方（SW / popup / options）能直接 ``await``，读起来是一条直线；
 * * ``chrome.runtime.lastError`` 集中在这里「读掉」，不会到处刷
 *   「Unchecked runtime.lastError」；
 * * 少数几个**故意吞异常**的地方（见 :func:`sendToTab`）旁边就能写清楚为什么。
 *
 * ⚠️ 本文件不碰 ``chrome`` 顶层 —— 全部在函数体里。单测在 node 里 import 它，
 * 只要不真的调进去就不会炸。
 */

/** 允许被吞掉的「预期内失败」：没装内容脚本 / 权限不够。 */
export class ChromeUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChromeUnavailable";
  }
}

function unavailable(what: string): ChromeUnavailable {
  return new ChromeUnavailable(`chrome.${what} 不可用（不在扩展环境里，或被策略禁用）`);
}

/** 取回调里的 ``lastError.message``（没有则 ``null``）。读它本身就是「已处理」的意思。 */
function lastError(): string | null {
  const err = chrome.runtime?.lastError;
  return typeof err?.message === "string" ? err.message : null;
}

/**
 * 把「一次回调 + 无返回值」的调用包成 Promise，``lastError`` 变 reject。
 *
 * ⚠️ 不设超时：回调**可能**不被调用（极少数被企业策略拦掉的情形），但设了超时反而会
 * 在慢机器上把正常调用判成失败。真出这种事先看 SW 的控制台。
 */
function once(call: (done: (err: string | null) => void) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    call((err) => {
      if (err === null) resolve();
      else reject(new ChromeUnavailable(err));
    });
  });
}

/** 把「一次回调 + 一个值」的调用包成 Promise。 */
function query<T>(call: (done: (value: T, err: string | null) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    call((value, err) => {
      if (err === null) resolve(value);
      else reject(new ChromeUnavailable(err));
    });
  });
}

// ============================================================ permissions

/** 这几个 origin 是否**全部**已授权。 */
export function containsOrigins(origins: readonly string[]): Promise<boolean> {
  if (origins.length === 0) return Promise.resolve(true);
  if (!chrome.permissions?.contains) return Promise.resolve(false);
  return query<boolean>((done) =>
    chrome.permissions?.contains({ origins: [...origins] }, (result) => done(result, lastError())),
  );
}

/** 单独问一个 origin（用来把「已授权列表」逐条筛出来）。 */
export async function containsOrigin(origin: string): Promise<boolean> {
  try {
    return await containsOrigins([origin]);
  } catch {
    return false;
  }
}

/**
 * 申请这几个 origin 的权限。**必须在用户手势里调**（popup 的按钮回调里），
 * 否则 Chrome 直接拒绝且不弹窗。
 */
export function requestOrigins(origins: readonly string[]): Promise<boolean> {
  if (origins.length === 0) return Promise.resolve(true);
  if (!chrome.permissions?.request) return Promise.reject(unavailable("permissions.request"));
  return query<boolean>((done) =>
    chrome.permissions?.request({ origins: [...origins] }, (granted) => done(granted, lastError())),
  );
}

/** 撤销这几个 origin（用户在 popup 里删站点时调）。 */
export function removeOrigins(origins: readonly string[]): Promise<boolean> {
  if (origins.length === 0) return Promise.resolve(true);
  if (!chrome.permissions?.remove) return Promise.reject(unavailable("permissions.remove"));
  return query<boolean>((done) =>
    chrome.permissions?.remove({ origins: [...origins] }, (removed) => done(removed, lastError())),
  );
}

// ============================================================ scripting

/** 注册一个动态内容脚本（id 已存在会报错，调用方用 :func:`updateContentScript` 覆盖）。 */
export function registerContentScript(script: chrome.scripting.RegisteredContentScript): Promise<void> {
  if (!chrome.scripting?.registerContentScripts) return Promise.reject(unavailable("scripting.registerContentScripts"));
  return once((done) => chrome.scripting?.registerContentScripts([script], () => done(lastError())));
}

/** 覆盖已有的动态内容脚本（``matches`` 变了就走这里）。 */
export function updateContentScript(script: chrome.scripting.RegisteredContentScript): Promise<void> {
  if (!chrome.scripting?.updateContentScripts) return Promise.reject(unavailable("scripting.updateContentScripts"));
  return once((done) => chrome.scripting?.updateContentScripts([script], () => done(lastError())));
}

export function unregisterContentScripts(ids: readonly string[]): Promise<void> {
  if (!chrome.scripting?.unregisterContentScripts) return Promise.resolve();
  return once((done) => chrome.scripting?.unregisterContentScripts({ ids: [...ids] }, () => done(lastError())));
}

export function getRegisteredContentScripts(): Promise<chrome.scripting.RegisteredContentScript[]> {
  if (!chrome.scripting?.getRegisteredContentScripts) return Promise.resolve([]);
  return query<chrome.scripting.RegisteredContentScript[]>((done) =>
    chrome.scripting?.getRegisteredContentScripts(null, (scripts) => done(scripts, lastError())),
  );
}

/** 是否有 MV3 的 ``chrome.scripting``（动态注册那套）。Chromium 70 级没有，只能走 MV2 的退路。 */
export function supportsDynamicContentScripts(): boolean {
  return chrome.scripting?.registerContentScripts !== undefined;
}

/**
 * 手动往某个标签页注入一次内容脚本。两个调用方：popup 的「就这一页，立刻生效」，
 * 以及 MV2 档背景页的导航注入。
 *
 * 两条实现，语义刻意对齐：MV3 用 ``scripting.executeScript``（**没有** ``runAt``，
 * 调用即注入）；MV2 用 ``tabs.executeScript``，它认 ``runAt``，于是导航注入也能保持
 * 与 MV3 动态注册一样的 ``document_end`` —— 面板要往 ``document.body`` 上挂节点，
 * 太早没 body。
 */
export function executeContentScript(
  tabId: number,
  file: string,
  runAt: "document_start" | "document_end" | "document_idle" = "document_idle",
): Promise<void> {
  if (chrome.scripting?.executeScript) {
    return chrome.scripting.executeScript({ target: { tabId }, files: [file] }).then(() => undefined);
  }
  if (chrome.tabs?.executeScript) {
    return once((done) => chrome.tabs.executeScript(tabId, { file, runAt }, () => done(lastError())));
  }
  return Promise.reject(unavailable("scripting.executeScript / tabs.executeScript"));
}

// ============================================================ tabs / runtime

export function activeTab(): Promise<chrome.tabs.Tab | null> {
  if (!chrome.tabs?.query) return Promise.resolve(null);
  return query<chrome.tabs.Tab[]>((done) =>
    chrome.tabs?.query({ active: true, currentWindow: true }, (tabs) => done(tabs, lastError())),
  ).then((tabs) => tabs[0] ?? null);
}

/**
 * 往标签页发消息，**故意吞掉失败**。
 *
 * 「这个 tab 没装内容脚本」是最常见的情形（用户还没为它授权、页面是 ``chrome://``、
 * 页面在消息发出的一瞬间正在导航），它不是错误，不该在 SW 里刷一片红。
 */
export function sendToTab(tabId: number, message: unknown): void {
  if (!chrome.tabs?.sendMessage) return;
  try {
    chrome.tabs.sendMessage(tabId, message, () => {
      void lastError(); // 读掉即「已处理」
    });
  } catch {
    // 标签页已经关掉了 —— 同样忽略。
  }
}

export async function openOptionsPage(): Promise<void> {
  if (!chrome.runtime?.openOptionsPage) return;
  chrome.runtime.openOptionsPage();
}

/** 往标签页发消息并等回复（popup 探活用；失败一律 ``null``）。 */
export function askTab(tabId: number, message: unknown): Promise<unknown> {
  if (!chrome.tabs?.sendMessage) return Promise.resolve(null);
  return new Promise<unknown>((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        void lastError(); // 读掉即「已处理」（没装内容脚本时会填「Receiving end does not exist」）
        resolve(response ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** 重新加载标签页（授权后让动态注册的内容脚本立刻接管）。 */
export function reloadTab(tabId: number): Promise<void> {
  if (!chrome.tabs?.reload) return Promise.resolve();
  return once((done) => chrome.tabs?.reload(tabId, {}, () => done(lastError())));
}

/**
 * 向 service worker 发消息并等它的回复。
 *
 * 失败（SW 不在、没人 ``sendResponse``）一律当成 ``null``：调用方都有备用路径
 * （比如内容脚本索要「最近 URL」拿不到就当没抓到）。发送本身就能唤醒被回收的 SW。
 */
export function sendToBackground(message: unknown): Promise<unknown> {
  if (!chrome.runtime?.sendMessage) return Promise.resolve(null);
  return new Promise<unknown>((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        void lastError(); // 读掉即「已处理」
        resolve(response ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}
