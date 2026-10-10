/**
 * **match pattern** 的解析与生成（Chrome 的 match patterns）。
 *
 * 扩展只在**用户明确授权过的网站**上观察网络请求，所以「一个 URL 属于哪个网站」
 * 这件事到处都要用：popup 的「启用当前网站」、SW 里 ``webRequest`` 的过滤器、
 * 内容脚本的动态注册、``permissions.onAdded/onRemoved`` 的同步。
 * 集中在两个纯函数里，别再各写一份正则。
 *
 * 形态（够用就好，不追求把规范实现全）::
 *
 *     <scheme>://<host>[/<path>]
 *     scheme = http | https | *
 *     host   = example.com | *.example.com | *     # 通配只允许在最前面
 *     path   = /* | /game/* | /index.php          # 省略等价于 /*
 *
 * ⚠️ **match pattern 里不能写端口**（写了会报「Invalid pattern」），而它天生
 * 匹配该 host 的**任意**端口 ⇒ :func:`patternForUrl` 会把端口丢掉。
 */

/** 合法 scheme（``*`` 也算）。 */
const SCHEME_RE = /^(?:https?|\*)$/;

/**
 * host 段：``*``、``*.foo``、``example.com`` 都合法。
 *
 * ⚠️ 单独一个 ``*`` 必须走**第一条分支**：``(?:\*\.)?[a-z0-9]…`` 那条要求首字符是
 * 字母数字，光一个 ``*`` 是过不去的（manifest 里 all_urls 那种写法就这么被误判过）。
 */
const HOST_RE = /^(?:\*|(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/i;

/**
 * 校验一条 match pattern 是否**能被 Chrome 接受**。
 *
 * 限制是刻意保守的：宁可在设置页报错，也不要让 ``chrome.permissions.request``
 * 到运行时才抛 ``Invalid value for origin``（那句报错用户完全看不懂）。
 */
export function isValidPattern(pattern: string): boolean {
  const text = pattern.trim();
  const split = text.indexOf("://");
  if (split <= 0) return false;
  if (!SCHEME_RE.test(text.slice(0, split))) return false;
  const rest = text.slice(split + 3);
  const slash = rest.indexOf("/");
  const host = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? "/*" : rest.slice(slash);
  if (host === "") return false;
  if (host.includes(":")) return false; // 端口不许写
  if (!HOST_RE.test(host)) return false;
  return path.startsWith("/");
}

/** 去掉首尾空白；不是合法 pattern 就返回 ``null``。 */
export function normalizePattern(pattern: string): string | null {
  return isValidPattern(pattern) ? pattern.trim() : null;
}

/**
 * 从一个具体 URL 生成 match pattern —— popup 的「启用当前网站」用它。
 *
 * ``https://game.4399.com/index.php?a=1`` ⇒ ``https://game.4399.com/*``。
 * 端口会被丢掉（pattern 不支持端口，而它本来就忽略端口）。
 *
 * ``null`` = 不是 http/https（``chrome://``、``file://``、``about:`` 之类都授权不了）。
 */
export function patternForUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname;
  if (host === "") return null;
  const pattern = `${parsed.protocol}//${host}/*`;
  return isValidPattern(pattern) ? pattern : null;
}

/** pattern 的 host 部分（面板/列表里显示用）。 */
export function hostOfPattern(pattern: string): string {
  const split = pattern.indexOf("://");
  if (split <= 0) return pattern;
  const rest = pattern.slice(split + 3);
  const slash = rest.indexOf("/");
  return slash === -1 ? rest : rest.slice(0, slash);
}

/** 去重（保序）。 */
export function uniquePatterns(patterns: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const pattern of patterns) {
    const normalized = normalizePattern(pattern);
    if (normalized === null || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
