/**
 * 后台 service worker —— 只做**观察、转发、动态注册**三件事。
 *
 * 为什么非得有 SW：游戏的网络请求是 Flash 的 ``URLLoader`` 发出去的，页面 JS 里的
 * ``XMLHttpRequest`` / ``fetch`` 钩子**一个都看不见**它。唯一看得见的是 ``webRequest``，
 * 而 ``webRequest`` 只在扩展进程里有。所以是「SW 抓 URL → 转发给内容脚本 →
 * 内容脚本按规则提取并恢复」这条链。
 *
 * 这一层的原则：**不含任何规则 / 公式逻辑**。同一个 URL 该怎么提取随机数、该套哪个
 * 倍率，只有 :mod:`./rules` 一份实现（内容脚本用）。SW 若也做一遍匹配，两边迟早在
 * 「忽略类规则优先」「第一条命中生效」这种细节上漂开，而漂开的症状是「面板上的数
 * 悄悄变少」，极难查。SW 只判断**这个请求属于哪个标签页**。
 *
 * 三件事的具体做法：
 *
 * 1. **观察**：``webRequest.onBeforeRequest`` 的过滤器就是「已授权的 origin」。
 *    ``matches``/``urls`` 都来自 ``chrome.storage`` 里的站点表 ∩ 真正拿到权限的那些 ——
 *    没授权就不监听（也监不到），这正是 ``optional_host_permissions`` 的意义。
 * 2. **转发**：``tabs.sendMessage(tabId, {type:"url-seed:observed"})``。目标只有**顶层
 *    框架**（内容脚本 ``allFrames: false``）：游戏可能跑在 ``sx.4399.com`` 的 iframe 里，
 *    面板要是也注入进那个 iframe 就会被裁得看不见。请求落在哪个 frame 无所谓 ——
 *    这里按 **标签页** 转发，顶层框架的面板照样收得到。
 * 3. **注册**：内容脚本走 ``scripting.registerContentScripts`` 动态注册，而不是在
 *    ``manifest.json`` 里写 ``content_scripts`` 的全站点匹配（``&lt;all_urls&gt;`` 那种写法）。
 *    后者会在安装时甩出「读取和更改所有网站上的所有数据」这种吓人的提示，且用户无法
 *    按站点收窄；动态注册天然就是「授权了几个 origin 就注入几个」。
 * 4. **旧浏览器（MV2 档）**：Chromium 70 级没有 ``chrome.scripting``，第 3 条那条路不存在。
 *    退路是 ``tabs.onUpdated`` + ``tabs.executeScript`` 按导航注入（见
 *    :func:`injectOnNavigate`），**权限模型一点没变** —— 依旧是「用户授了哪个 origin
 *    才在哪个站点注入」。刻意**不**改用 manifest 的 ``content_scripts`` +
 *    ``&lt;all_urls&gt;``：那等于安装时就把 host 权限全要下来，第 3 条想避开的事白做了。
 *    两条路唯一的差别是「谁来匹配 URL」。
 *
 * 另外维护一份 **每标签页最近的 URL**（内存里的环形缓冲）：内容脚本是 ``document_end``
 * 注入的，而游戏往往在页面刚开始加载时就发了 ``ac=get_token`` —— 那一条会早于内容
 * 脚本出现。内容脚本一注入就向 SW 要这份缓冲（``url-seed:recent-request``），把
 * 「错过的那几条」补回来。这份缓冲是 **best-effort**：SW 会被回收，回收后它就空了。
 */

import {
  CONTENT_SCRIPT_FILE,
  CONTENT_SCRIPT_ID,
  messageType,
  type ObservedMessage,
  type RecentResponseMessage,
} from "./protocol";
import {
  containsOrigin,
  executeContentScript,
  getRegisteredContentScripts,
  registerContentScript,
  sendToTab,
  supportsDynamicContentScripts,
  unregisterContentScripts,
  updateContentScript,
} from "./chromeAsync";
import { patternForUrl, uniquePatterns } from "./sites";
import { loadSites, onStorageChanged } from "./storage";

/** 每个标签页最多留多少条原始 URL。够覆盖「页面刚加载那几十毫秒」即可。 */
const RECENT_LIMIT = 200;

/** 只记 http(s) —— 过滤器已经限制了，这里是双保险（也顺手挡掉 ``chrome-extension://``）。 */
const HTTP_RE = /^https?:\/\//i;

interface RecentEntry {
  readonly url: string;
  readonly ts: number;
}

const recentByTab = new Map<number, RecentEntry[]>();

/** 当前实际挂着的过滤器（用来判断「要不要重挂监听」）。 */
let activeFilter: readonly string[] | null = null;
let observed: ((details: chrome.webRequest.RequestDetails) => void) | null = null;

function sameList(a: readonly string[], b: readonly string[] | null): boolean {
  if (b === null || a.length !== b.length) return false;
  return a.every((item, index) => item === b[index]);
}

// =========================================================================== 观察

/** 记一条进环形缓冲（连续重复的 URL 不重复记 —— 同一个 URL 反推出的随机数必然相同）。 */
function remember(tabId: number, url: string, ts: number): void {
  let list = recentByTab.get(tabId);
  if (list === undefined) {
    list = [];
    recentByTab.set(tabId, list);
  }
  const last = list[list.length - 1];
  if (last !== undefined && last.url === url) return;
  list.push({ url, ts });
  if (list.length > RECENT_LIMIT) list.splice(0, list.length - RECENT_LIMIT);
}

function observe(details: chrome.webRequest.RequestDetails): void {
  const { tabId, url, timeStamp } = details;
  // ``-1`` = 不是任何标签页发起的（SW 自己 / 预取 / 其它扩展）—— 没有面板可显示。
  if (tabId < 0 || !HTTP_RE.test(url)) return;
  remember(tabId, url, timeStamp);
  const message: ObservedMessage = { type: "url-seed:observed", url, ts: timeStamp, tabId };
  sendToTab(tabId, message);
}

/** 把监听器的过滤器换成 ``patterns``；没变化就什么都不做。 */
function setObserving(patterns: readonly string[]): void {
  if (sameList(patterns, activeFilter)) return;
  if (observed !== null) {
    chrome.webRequest.onBeforeRequest.removeListener(observed);
    observed = null;
  }
  activeFilter = [...patterns];
  if (patterns.length === 0) return;
  observed = observe;
  // ``types`` 一律不限制：Flash 的 URLLoader 在 ``webRequest`` 里是 ``xmlhttprequest``
  // 还是 ``other`` 随版本/实现而变，漏一种就等于漏掉游戏流量。
  chrome.webRequest.onBeforeRequest.addListener(observed, { urls: [...patterns] });
}

// =========================================================================== 注册

/** 内容脚本的注册项（``matches`` 由调用方给）。 */
function contentScript(matches: readonly string[]): chrome.scripting.RegisteredContentScript {
  return {
    id: CONTENT_SCRIPT_ID,
    matches: [...matches],
    js: [CONTENT_SCRIPT_FILE],
    // ``document_end``：面板要往 ``document.body`` 上挂节点，太早没 body；
    // 早期请求由 SW 的最近缓冲补回（见文件头）。
    runAt: "document_end",
    allFrames: false,
    // 浏览器重启后还在（否则每次重启都得重新授权一次才监听）。
    persistAcrossSessions: true,
  };
}

/** 让内容脚本的生效范围与「已授权站点」一致。 */
async function syncContentScript(patterns: readonly string[]): Promise<void> {
  if (!supportsDynamicContentScripts()) {
    // MV2：没有动态注册这回事，记下来交给导航时逐次注入（见 :func:`injectOnNavigate`）。
    manualMatches = [...patterns];
    return;
  }
  const registered = await getRegisteredContentScripts();
  const current = registered.find((script) => script.id === CONTENT_SCRIPT_ID) ?? null;

  if (patterns.length === 0) {
    if (current !== null) await unregisterContentScripts([CONTENT_SCRIPT_ID]);
    return;
  }
  if (current === null) {
    await registerContentScript(contentScript(patterns));
    return;
  }
  // ``matches`` 一致就别动它 —— ``updateContentScripts`` 会让已注入的脚本
  // 在下次导航前处于「已注销」的中间态，能省一次是一次。
  if (!sameList(patterns, current.matches)) await updateContentScript(contentScript(patterns));
}

// ============================================================ MV2：按导航注入

/**
 * MV2 档「该在哪些站点注入内容脚本」的镜像（MV3 档恒为空数组，自然不生效）。
 */
let manualMatches: readonly string[] = [];

/** ``tabId → 上次注入时那个 URL``（同一次导航里 ``loading`` 会来好几次）。 */
const injectedNav = new Map<number, string>();

/**
 * MV2 档：导航开始时往**已授权的站点**注入一次内容脚本。
 *
 * 判据刻意**不**自己写正则去比对 ``matches``：``tab.url`` 在没有 host 权限时本来就
 * 是 ``undefined``（天然挡掉未授权站点）；再拿 :func:`patternForUrl` 切出的具体 pattern
 * 去问 ``permissions.contains`` —— ``https://*.a.com/*`` 是否覆盖 ``https://x.a.com/*``
 * 是 Chrome 自己的学问。自己实现匹配，迟早和 match pattern 的语义漂开。
 *
 * ⚠️ 同一次导航里 ``status: "loading"`` 可能来不止一次，重复注入会挂出两个面板
 * （内容脚本里的 ``GUARD_KEY`` 是另一道保险）。所以按 URL 去重，并在 ``complete``
 * 时忘掉记录 —— 那样「刷新」这种 URL 不变的重载才能重新注入。
 */
async function injectOnNavigate(tabId: number, url: string): Promise<void> {
  if (manualMatches.length === 0) return;
  const pattern = patternForUrl(url);
  if (pattern === null) return;
  if (!(await containsOrigin(pattern))) return;
  if (injectedNav.get(tabId) === url) return;
  injectedNav.set(tabId, url);
  try {
    // 与 MV3 动态注册对齐：顶层框架、``document_end``。
    await executeContentScript(tabId, CONTENT_SCRIPT_FILE, "document_end");
  } catch (err) {
    console.warn("[url-seed] 注入内容脚本失败：", err);
  }
}

// =========================================================================== 汇总

/** 真正生效的站点 = 存下来的站点表 ∩ 已授权的 origin（顺序按站点表）。 */
async function effectivePatterns(): Promise<string[]> {
  const sites = uniquePatterns(await loadSites());
  const allowed: string[] = [];
  for (const site of sites) {
    // 逐条问：``permissions.contains`` 传一组时要求「**全部**已授权」，
    // 那样只要有一条被用户在「扩展详情」里收窄，整张表都会判成未授权。
    if (await containsOrigin(site)) allowed.push(site);
  }
  return allowed;
}

let applying: Promise<void> | null = null;
let dirty = false;

/**
 * 重新计算并应用（观察过滤器 + 内容脚本注册）。
 *
 * 触发时机：SW 每次冷启动（顶层调用一次）、``permissions.onAdded/onRemoved``、
 * ``storage`` 里站点表变化。
 *
 * 并发调用合并成一次；合并期间又来请求就置 ``dirty``，跑完再补一轮 ——
 * popup 的「保存站点 → 申请权限」是两步两步来的，中间必然交叉。
 */
function apply(): Promise<void> {
  if (applying !== null) {
    dirty = true;
    return applying;
  }
  applying = (async () => {
    do {
      dirty = false;
      const allowed = await effectivePatterns();
      setObserving(allowed);
      await syncContentScript(allowed);
    } while (dirty);
  })()
    .catch((err: unknown) => {
      // 权限被撤销、标签页刚关掉之类的都会走到这里：不抛给 Chrome，只记一行。
      console.warn("[url-seed] 同步监听状态失败：", err);
    })
    .finally(() => {
      applying = null;
    });
  return applying;
}

// =========================================================================== 接线

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (messageType(message) !== "url-seed:recent-request") return undefined;
  const tabId = sender.tab?.id;
  const reply: RecentResponseMessage = {
    type: "url-seed:recent",
    urls: tabId === undefined ? [] : (recentByTab.get(tabId) ?? []).map((entry) => entry.url),
  };
  // 同步回复：**不要**返回 ``true``（那会让消息通道一直开着，直到 SW 被回收）。
  sendResponse(reply);
  return undefined;
});

// 站点表 / 权限一变就重算。``onStorageChanged`` 已经过滤了 areaName 与键名。
onStorageChanged((changed) => {
  if (changed.sites !== undefined) void apply();
});

chrome.permissions.onAdded.addListener(() => {
  void apply();
});
chrome.permissions.onRemoved.addListener(() => {
  void apply();
});

// 标签页关了就把它的缓冲扔掉（不然长开的浏览器里 map 会一直长）。
chrome.tabs.onRemoved.addListener((tabId) => {
  recentByTab.delete(tabId);
  injectedNav.delete(tabId);
});

// 顶层导航（``status: "loading"``）时清空该标签页的旧值：上一页的随机数对新页面
// 毫无意义，混在一起会拼出「跨页面的两个数」这种假组合。
// ⚠️ 只在 ``loading`` 清：``changeInfo.url`` 单给的时候是同文档导航（SPA 改 hash），
// 那种情况下页面没重载，值仍然是有效的。清空发生在内容脚本注入之前、新页面的
// 请求记录之前，顺序正好。
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading") {
    recentByTab.delete(tabId);
    // MV2 档：没有动态注册表，只能在这里按导航注入。MV3 档这段是死代码。
    if (!supportsDynamicContentScripts() && typeof tab.url === "string") {
      void injectOnNavigate(tabId, tab.url);
    }
    return;
  }
  // 导航结束就忘掉这次的 URL：刷新（URL 没变）才可能重新注入。
  if (changeInfo.status === "complete") injectedNav.delete(tabId);
});

// SW 冷启动时先同步一次（MV3 的 SW 随时可能被回收，这段顶层代码会被重新执行）。
void apply();
