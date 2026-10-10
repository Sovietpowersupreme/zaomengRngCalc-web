/**
 * 内容脚本 —— 页面里的**编排者**。整条链上唯一知道全部状态的地方。
 *
 * 数据流::
 *
 *     SW（webRequest）──url-seed:observed──▶ 内容脚本
 *                                              ├─ rules.matchUrl   → 提取 + 换算公式
 *                                              ├─ ValueBuffer      → 去重、取最后两个不同的值
 *                                              ├─ resolver.resolve → wasm 恢复（唯一解才算解）
 *                                              └─ Panel            → 悬浮窗显示
 *
 * 只有它碰 ``chrome.*`` 与 ``document``，其它模块（rules / formula / select / resolve）
 * 都是纯逻辑，能在 node 里单测 —— 这是刻意的分工，那些模块才是真会错的地方。
 *
 * 三个必须照顾到的现实：
 *
 * 1. **内容脚本是 ``document_end`` 注入的**，而游戏往往在页面刚开始加载时就发了
 *    ``ac=get_token``。所以一启动就向 SW 索要「本标签页最近的 URL 列表」并重放一遍
 *    （``url-seed:recent-request``）；这中间又陆续到达的观察消息先存进 ``early``，
 *    等状态就绪后按「先 recent、后 early」的顺序补进缓冲 —— 顺序就是时间序，
 *    恢复要的正是相邻两次。
 * 2. **恢复是同步跑在页面主线程上的**（1~2 秒）。所以：``auto`` 有防抖；同一对值
 *    只算一次；算之前先让出一次宏任务，好让「恢复中…」真的画到屏幕上。
 * 3. **可能被注入两次**（动态注册 + popup 手动注入）。``globalThis`` 上一个标记位
 *    就够了 —— 内容脚本跑在隔离世界里，两个世界各有一份 ``globalThis``，
 *    而同一个世界重复注入才会看到这个标记。
 */

// ⚠️ **必须是整条 import 链的第一条**（理由与 ``web/src/polyfills.ts`` 的文件头相同）：
// 这个 bundle 里内联了 emscripten 的胶水，它**一求值就读** ``globalThis``
// （``!!globalThis.window`` / ``globalThis.WorkerGlobalScope`` / ``globalThis.TextDecoder`` …），
// 而 ``globalThis`` 是 **Chrome 71** 才有的 —— MV2 档声明的最低版本是 **70**，
// 不兜底就是内容脚本一进页面直接 ``ReferenceError: globalThis is not defined``（整窗静默失效）。
// 现代档（Chrome 116+）上这段只是一个 ``typeof`` 判断，等于不存在。
import "../../../src/polyfills";

import { sendToBackground } from "./chromeAsync";
import { Panel, type StatusLevel } from "./panel";
import {
  messageType,
  type ObservedMessage,
  type PongMessage,
  type RecentRequestMessage,
} from "./protocol";
import { fastnextOf, matchUrl, type Rule } from "./rules";
import { resolver, type ResolveOutcome } from "./resolve";
import { ValueBuffer, type CapturedValue } from "./select";
import { DEFAULT_PREFS, loadPrefs, loadRules, onStorageChanged, savePrefs, type PanelPrefs } from "./storage";

/** 重复注入的守卫（只对本隔离世界有效）。 */
const GUARD_KEY = "__urlSeedContentLoaded";

/** 自动恢复的防抖时长。游戏一次加载会连着发好几条 ``ran=``，等它安静下来再算。 */
const AUTO_DELAY_MS = 600;

/** 调试日志留多少行。 */
const LOG_LIMIT = 60;

// =========================================================================== 状态

let rules: Rule[] = [];
let prefs: PanelPrefs = { ...DEFAULT_PREFS };
const buffer = new ValueBuffer();
const logLines: string[] = [];

let panel: Panel | null = null;
let statusBeforePanel: { text: string; level: StatusLevel } | null = null;
let lastOutcome: ResolveOutcome | null = null;
/** 已经算过的那一对值（``earlier|later|后移次数``），用来避免重复恢复。 */
let lastKey = "";
let busy = false;
let queued: "auto" | "manual" | null = null;
let autoTimer: number | null = null;

/** 状态就绪前到达的观察消息（时间序，晚于 SW 的 recent 列表）。 */
const early: { url: string; ts: number }[] = [];
let ready = false;

// =========================================================================== 小工具

function stamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

function log(line: string): void {
  logLines.push(`${stamp()} ${line}`);
  if (logLines.length > LOG_LIMIT) logLines.splice(0, logLines.length - LOG_LIMIT);
  panel?.setLog(logLines);
}

function setStatus(text: string, level: StatusLevel = "info"): void {
  if (panel === null) {
    statusBeforePanel = { text, level };
    return;
  }
  panel.setStatus(text, level);
}

/** 建面板（首次真的抓到随机数时才建，免得在每个页面上都挂一个空窗）。 */
function ensurePanel(): Panel {
  if (panel !== null) return panel;
  panel = new Panel({
    onResolve: () => void runResolve("manual"),
    onClear: () => {
      buffer.clear();
      lastOutcome = null;
      lastKey = "";
      refresh();
      setStatus("已清空，等新的随机数…");
      log("清空缓冲");
    },
    onAutoChange: (auto) => {
      prefs = { ...prefs, auto };
      void savePrefs(prefs);
      if (!auto && autoTimer !== null) {
        window.clearTimeout(autoTimer);
        autoTimer = null;
      }
      if (auto) scheduleAuto();
      setStatus(auto ? "已开启自动恢复" : "已关闭自动恢复");
      log(`自动恢复：${auto ? "开" : "关"}`);
    },
  });
  panel.setAuto(prefs.auto);
  panel.setDebug(prefs.debug);
  panel.setLog(logLines);
  if (statusBeforePanel !== null) {
    panel.setStatus(statusBeforePanel.text, statusBeforePanel.level);
    statusBeforePanel = null;
  }
  return panel;
}

function refresh(): void {
  if (panel === null) return;
  panel.setValues(buffer.list(), buffer.lastTwo());
  panel.setResult(lastOutcome);
}

// =========================================================================== 提取

/**
 * 一条 URL 进缓冲。
 *
 * @returns ``pushed`` = 新值入列（调用方该刷新面板并考虑自动恢复）；
 *   其余三种都只是「这条不算数」，日志里都留痕。
 */
function ingest(url: string, ts: number): "pushed" | "duplicate" | "ignored" | "unchanged" {
  const outcome = matchUrl(url, rules);
  if (outcome.kind === "ignore") {
    log(`忽略（${outcome.rule.name}）← ${url}`);
    return "ignored";
  }
  if (outcome.kind === "error") {
    log(`规则「${outcome.rule.name}」出错：${outcome.message} ← ${url}`);
    setStatus(`规则「${outcome.rule.name}」出错：${outcome.message}`, "error");
    return "unchanged";
  }
  if (outcome.kind !== "capture") {
    log(`未命中 ← ${url}`);
    return "unchanged";
  }
  const item: CapturedValue = {
    value: outcome.value,
    text: outcome.text,
    url,
    ts,
    ruleId: outcome.rule.id,
    ruleName: outcome.rule.name,
  };
  if (!buffer.push(item)) {
    // 与上一条同值：游戏常连着发同一个数，重复进来不构成新信息。
    log(`重复值 ${outcome.value}（${outcome.rule.name}）← ${url}`);
    return "duplicate";
  }
  log(`+${outcome.value}（${outcome.rule.name}）← ${url}`);
  return "pushed";
}

function handleObserved(url: string, ts: number): void {
  if (ingest(url, ts) !== "pushed") return;
  ensurePanel().show();
  refresh();
  scheduleAuto();
}

// =========================================================================== 恢复

function scheduleAuto(): void {
  if (!prefs.auto) return;
  if (autoTimer !== null) window.clearTimeout(autoTimer);
  autoTimer = window.setTimeout(() => {
    autoTimer = null;
    void runResolve("auto");
  }, AUTO_DELAY_MS);
}

/**
 * 用缓冲里最后两个不同的值恢复。
 *
 * ``reason`` 只影响两件事：``auto`` 会跳过「这对值算过了」的重复计算；``manual``
 * 会给出「还差一个数」这类提示。
 */
async function runResolve(reason: "auto" | "manual"): Promise<void> {
  const pair = buffer.lastTwo();
  if (pair === null) {
    if (reason === "manual") setStatus("需要两个**不同**的随机数才能恢复", "warn");
    return;
  }
  // 后移次数由**匹配值**（更晚那个读数）那条规则决定 —— 恢复出的种子是「读出匹配值
  // 之前」的状态，之后又推进了几步当然要看「谁产出了匹配值」。两条规则的 N 不一致时
  // 就以此为准（设置页里也这么写）。用当前规则表实时查：改完设置立刻生效，不用重抓值。
  const fastnext = fastnextOf(rules, pair.later.ruleId);
  const key = `${pair.earlier.value}|${pair.later.value}|${fastnext}`;
  if (reason === "auto" && key === lastKey && lastOutcome !== null) return;
  if (busy) {
    // 正在算：记下「算完再算一次」，别把这次的请求吞掉。
    queued = reason;
    return;
  }

  busy = true;
  panel?.setBusy(true);
  setStatus(`恢复中…（${pair.earlier.value} → ${pair.later.value}）`, "busy");
  // 先记一行「开始」：万一后面的 await 再也没回来，调试日志里能看到这一步到了、
  // 而下一步没到 —— 否则日志里就只剩「+值」那几行，看不出卡在哪。
  log(`开始恢复（${reason === "auto" ? "自动" : "手动"}）：${pair.earlier.value} → ${pair.later.value}`);
  try {
    // 让出一次宏任务：恢复是同步的（wasm 跑在当前线程），不让浏览器有一次绘制的机会，
    // 上面那行「恢复中…」就永远画不出来 —— 用户只会看到界面卡住。
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });
    const outcome = await resolver.resolve(pair.earlier.value, pair.later.value, 0, fastnext);
    lastOutcome = outcome;
    lastKey = key;
    panel?.setResult(outcome);
    setStatus(outcome.found ? `恢复完成：${outcome.summary}` : `恢复完成：${outcome.summary}`, outcome.found ? "info" : "warn");
    log(`恢复 ${pair.earlier.value} / ${pair.later.value} → ${outcome.summary}`);
  } catch (err) {
    lastOutcome = null;
    panel?.setResult(null);
    const message = err instanceof Error ? err.message : String(err);
    setStatus(`恢复失败：${message}`, "error");
    log(`恢复失败：${message}`);
  } finally {
    busy = false;
    panel?.setBusy(false);
    const next = queued;
    queued = null;
    // 排队的那次：自动的就重新走上防抖（值可能又变了），手动的立刻重算。
    if (next === "manual") void runResolve("manual");
    else if (next === "auto" && prefs.auto) scheduleAuto();
  }
}

// =========================================================================== 与 SW / popup 通信

/**
 * 消息监听**必须在模块顶层**注册（``main()`` 里有 ``await``，等它跑完再注册会漏消息）。
 * 状态没就绪时收到的观察消息先进 ``early``，由 ``main()`` 末尾补放。
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = messageType(message);

  if (type === "url-seed:observed") {
    const observed = message as ObservedMessage;
    if (!ready) early.push({ url: observed.url, ts: observed.ts });
    else handleObserved(observed.url, observed.ts);
    return undefined;
  }

  if (type === "url-seed:show-panel") {
    ensurePanel().show();
    refresh();
    if (buffer.size === 0) setStatus("面板已就绪，等游戏的随机数…");
    return undefined;
  }

  if (type === "url-seed:ping") {
    const reply: PongMessage = {
      type: "url-seed:pong",
      count: buffer.size,
      summary: lastOutcome !== null ? lastOutcome.summary : buffer.size === 0 ? "还没抓到随机数" : "等两个随机数…",
    };
    // 同步回复 —— 不返回 ``true``（那是给异步回复用的）。
    sendResponse(reply);
    return undefined;
  }

  return undefined;
});

/** 向 SW 索要本标签页最近的原始 URL（补回内容脚本注入之前漏掉的那几条）。 */
async function requestRecent(): Promise<string[]> {
  const message: RecentRequestMessage = { type: "url-seed:recent-request" };
  const reply = await sendToBackground(message);
  if (reply === null || typeof reply !== "object") return [];
  const urls = (reply as { urls?: unknown }).urls;
  return Array.isArray(urls) ? urls.filter((item): item is string => typeof item === "string") : [];
}

// =========================================================================== 启动

async function main(): Promise<void> {
  rules = await loadRules();
  prefs = await loadPrefs();
  setStatus("就绪，等游戏的随机数…");

  onStorageChanged((changed) => {
    if (changed.rules !== undefined) {
      rules = changed.rules;
      log(`规则已更新（${rules.length} 条）`);
      // 站点表变了不关这里的事（SW 负责重挂监听），但规则变了要重算一次当前的值列表。
      refresh();
    }
    if (changed.prefs !== undefined) {
      prefs = changed.prefs;
      panel?.setAuto(prefs.auto);
      panel?.setDebug(prefs.debug);
      if (!prefs.auto && autoTimer !== null) {
        window.clearTimeout(autoTimer);
        autoTimer = null;
      }
    }
  });

  // 预热 wasm（读 Base64 → 编译模块）。不预热也行，第一次恢复会多等这一下，
  // 但面板会先显示「恢复中…」，不至于像死机。
  // 失败要说出来：预热的失败就是后面每一次恢复的失败（加载这一层带超时 + 重试，
  // 见 ``resolve.ts`` 的文件头），只记进日志的话，用户看到一个永远不动的面板
  // 时根本无从知道是 wasm 没起来。点「恢复」会重新加载（失败不缓存）。
  void resolver.warmup().catch((err: unknown) => {
    const reason = err instanceof Error ? err.message : String(err);
    log(`wasm 预热失败：${reason}`);
    setStatus(`wasm 预热失败：${reason}`, "error");
  });

  // 先重放 SW 的「最近 URL」（较早），再补放启动期间到达的消息（较晚）—— 合成时间序。
  const recent = await requestRecent();
  ready = true;
  for (const url of recent) ingest(url, Date.now());
  for (const item of early.splice(0)) ingest(item.url, item.ts);

  if (buffer.size > 0) {
    ensurePanel().show();
    refresh();
    log(`启动补入 ${buffer.size} 个随机数`);
    scheduleAuto();
  } else {
    log(`内容脚本就绪（未命中任何随机数，共 ${recent.length} 条历史请求）`);
  }
}

// 同一个隔离世界重复注入：直接退出（见文件头第 3 条）。
const world = globalThis as unknown as Record<string, unknown>;
if (world[GUARD_KEY] !== true) {
  world[GUARD_KEY] = true;
  void main().catch((err: unknown) => {
    console.error("[url-seed] 内容脚本启动失败：", err);
  });
}
