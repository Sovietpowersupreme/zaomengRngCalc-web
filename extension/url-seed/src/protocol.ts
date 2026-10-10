/**
 * 扩展各进程之间的**消息**与**存储键**的唯一来源。
 *
 * MV3 有四个互不相邻的运行环境（service worker / 内容脚本 / popup / options），它们
 * 只能靠 ``chrome.runtime.sendMessage`` 与 ``chrome.storage`` 说话。字符串字面量散在
 * 各处迟早会漂（改了发送方忘了接收方 ⇒ 静默无响应，最难查），所以这里集中定义。
 *
 * ⚠️ 本文件**不许**在模块顶层碰 ``chrome`` —— 单测在 node 里 import 它，
 * 顶层一碰就整片炸。所有 ``chrome.*`` 调用都在函数体里。
 */

/** 本扩展的核心存储键（``chrome.storage.local``）。 */
export const STORAGE_KEYS = {
  /** 已授权监听的 match pattern 列表（如 ``https://*.4399.com/*``）。 */
  sites: "urlSeed.sites",
  /** 规则列表（含内置规则的当前值）。 */
  rules: "urlSeed.rules",
  /** 面板偏好（自动恢复开关等）。 */
  prefs: "urlSeed.prefs",
} as const;

/** 内容脚本动态注册的 id（``chrome.scripting.registerContentScripts``）。 */
export const CONTENT_SCRIPT_ID = "urlSeed.content";

/** 内容脚本打包后的文件名（相对扩展根）。 */
export const CONTENT_SCRIPT_FILE = "content.js";

// ============================================================ service worker → 内容脚本

/** 观察到一条（已授权的）网络请求。 */
export interface ObservedMessage {
  type: "url-seed:observed";
  url: string;
  /** ``Date.now()``（毫秒）。 */
  ts: number;
  tabId: number;
}

/** 内容脚本刚注入，向 SW 索要本标签页最近的原始 URL（SW 里的 best-effort 缓冲）。 */
export interface RecentRequestMessage {
  type: "url-seed:recent-request";
}

/** SW 对 {@link RecentRequestMessage} 的回复。 */
export interface RecentResponseMessage {
  type: "url-seed:recent";
  urls: string[];
}

// ============================================================ popup → 内容脚本

/** popup 让内容脚本把面板显示出来（面板平时是惰性创建的）。 */
export interface ShowPanelMessage {
  type: "url-seed:show-panel";
}

/** 内容脚本 → 调用方：探活（popup 判断当前页有没有内容脚本在跑）。 */
export interface PingMessage {
  type: "url-seed:ping";
}

/** 内容脚本对 {@link PingMessage} 的回复。 */
export interface PongMessage {
  type: "url-seed:pong";
  /** 该页当前积累了多少条有效随机数。 */
  count: number;
  /** 已经恢复出种子（或确认无解）时的结果摘要，供 popup 直接显示。 */
  summary: string;
}

/** SW / 内容脚本共同接受的消息集合。 */
export type ExtMessage =
  | ObservedMessage
  | RecentRequestMessage
  | RecentResponseMessage
  | ShowPanelMessage
  | PingMessage
  | PongMessage;

/** 从任意 ``unknown`` 里安全取出 ``type`` 字段。 */
export function messageType(message: unknown): string | null {
  if (message === null || typeof message !== "object") return null;
  const type = (message as { type?: unknown }).type;
  return typeof type === "string" ? type : null;
}
