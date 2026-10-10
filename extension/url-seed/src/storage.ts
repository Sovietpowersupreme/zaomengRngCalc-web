/**
 * ``chrome.storage.local`` 的**类型化封装** + 存储键的读写。
 *
 * 三个原则：
 *
 * 1. **不要裸对象**。storage 里读出来的东西是上一版扩展写的、也可能被用户手工改过，
 *    一律先过 ``normalize*``/``parse*`` 再往业务里送（坏数据丢一条，而不是让整块 UI 白屏）；
 * 2. **区分「没有这个键」和「空数组」**。这是「恢复默认」的前提：用户删光规则后，
 *    读到的必须是 ``[]``（他会用「恢复默认」把内置规则弄回来），而不是被我们
 *    自动补回内置规则；
 * 3. **node 里能 import**。单测在 node 下跑，没有 ``chrome``；所有取值都在函数体里
 *    做 ``typeof chrome === "undefined"`` 兜底，模块顶层**不许**碰 ``chrome``。
 */

import { STORAGE_KEYS } from "./protocol";
import { builtinRules, normalizeRules, type Rule } from "./rules";
import { uniquePatterns } from "./sites";

/** 面板偏好。 */
export interface PanelPrefs {
  /**
   * 自动用最近两个随机数恢复。
   *
   * **默认开** —— 需求原话就是「自动以最新的两个随机数进行反推，并显示种子」。
   * 算一次要 1~2 秒（同步跑在页面主线程上），所以内容脚本里加了防抖：抓到新值后
   * 静置 ``AUTO_DELAY_MS`` 才开算，且「这一对值算过了」就不重算。
   */
  auto: boolean;
  /** 面板里的调试区（原始 URL 日志）。默认**关**，但不影响记录，只影响显示。 */
  debug: boolean;
}

/** 默认偏好。 */
export const DEFAULT_PREFS: PanelPrefs = Object.freeze({ auto: true, debug: false });

/** ``chrome.storage.local``（不存在则 ``null``：node 单测 / 权限被策略禁用）。 */
function area(): chrome.storage.StorageArea | null {
  if (typeof chrome === "undefined") return null;
  return chrome.storage?.local ?? null;
}

/** 读一个键（没有则 ``undefined``）。 */
export function readValue(key: string): Promise<unknown> {
  const store = area();
  if (store === null) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    store.get(key, (items) => {
      resolve(items[key]);
    });
  });
}

/** 写一个键。 */
export function writeValue(key: string, value: unknown): Promise<void> {
  const store = area();
  if (store === null) return Promise.resolve();
  return new Promise((resolve) => {
    store.set({ [key]: value }, () => resolve());
  });
}

// =========================================================================== 规则
/**
 * 读规则列表。
 *
 * * 键**不存在**（首次运行）⇒ 内置默认规则；
 * * 键存在 ⇒ 逐条归一化（``[]`` 就是 ``[]``，不会偷偷补回内置规则）。
 */
export async function loadRules(): Promise<Rule[]> {
  const raw = await readValue(STORAGE_KEYS.rules);
  if (raw === undefined) return builtinRules();
  return normalizeRules(raw);
}

/** 写规则列表（只存纯数据字段）。 */
export function saveRules(rules: readonly Rule[]): Promise<void> {
  // 显式挑字段：``Rule`` 以后加字段时，这里不跟着改就不会把临时状态写进 storage。
  const plain = rules.map((rule) => ({
    id: rule.id,
    name: rule.name,
    kind: rule.kind,
    enabled: rule.enabled,
    match: rule.match,
    ...(rule.kind === "capture"
      ? {
          extract: rule.extract ?? "",
          formula: rule.formula ?? "",
          fastnext: rule.fastnext ?? 0,
        }
      : {}),
    ...(rule.builtin === true ? { builtin: true } : {}),
    ...(rule.note === undefined ? {} : { note: rule.note }),
  }));
  return writeValue(STORAGE_KEYS.rules, plain);
}

// =========================================================================== 授权网站
/** 读已授权的 match pattern 列表（自动去重、丢弃非法项）。 */
export async function loadSites(): Promise<string[]> {
  const raw = await readValue(STORAGE_KEYS.sites);
  return Array.isArray(raw) ? uniquePatterns(raw.filter((item): item is string => typeof item === "string")) : [];
}

/** 写已授权网站列表。 */
export function saveSites(sites: readonly string[]): Promise<void> {
  return writeValue(STORAGE_KEYS.sites, uniquePatterns(sites));
}

// =========================================================================== 偏好
/** 读面板偏好（缺省项自动补全）。 */
export async function loadPrefs(): Promise<PanelPrefs> {
  const raw = await readValue(STORAGE_KEYS.prefs);
  if (raw === null || typeof raw !== "object") return { ...DEFAULT_PREFS };
  const source = raw as Record<string, unknown>;
  return {
    auto: source["auto"] === true,
    debug: source["debug"] === true,
  };
}

/** 写面板偏好。 */
export function savePrefs(prefs: PanelPrefs): Promise<void> {
  return writeValue(STORAGE_KEYS.prefs, { auto: prefs.auto === true, debug: prefs.debug === true });
}

// =========================================================================== 变更订阅
/**
 * 订阅本扩展那几个键的变化（内容脚本用它同步设置页/popup 的改动）。
 *
 * @returns 取消订阅的函数 —— 返回它而不是让调用方自己去 ``removeListener``，
 *   是因为 ``addListener`` 传进去的是一个新的闭包，外面拿不到同一个引用。
 */
export function onStorageChanged(
  callback: (changed: { rules?: Rule[]; sites?: string[]; prefs?: PanelPrefs }) => void,
): () => void {
  if (typeof chrome === "undefined" || chrome.storage?.onChanged === undefined) return () => undefined;
  const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string): void => {
    if (areaName !== "local") return;
    const changed: { rules?: Rule[]; sites?: string[]; prefs?: PanelPrefs } = {};
    if (STORAGE_KEYS.rules in changes) changed.rules = normalizeRules(changes[STORAGE_KEYS.rules]?.newValue);
    if (STORAGE_KEYS.sites in changes) {
      const value = changes[STORAGE_KEYS.sites]?.newValue;
      changed.sites = Array.isArray(value)
        ? uniquePatterns(value.filter((item): item is string => typeof item === "string"))
        : [];
    }
    if (STORAGE_KEYS.prefs in changes) {
      const value = changes[STORAGE_KEYS.prefs]?.newValue;
      const source = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
      changed.prefs = { auto: source["auto"] === true, debug: source["debug"] === true };
    }
    callback(changed);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => {
    chrome.storage.onChanged.removeListener(listener);
  };
}
