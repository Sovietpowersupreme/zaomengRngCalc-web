/**
 * match pattern 的解析与生成（``web/extension/url-seed/src/sites.ts``）。
 *
 * 这是「扩展只在用户授权过的站点上监听」这条约束的落点：popup 用它算 origin、
 * SW 用它做 ``webRequest`` 过滤器、内容脚本用它动态注册。算错一个字符，
 * ``chrome.permissions.request`` 会在运行时抛 ``Invalid value for origin``，
 * 用户完全看不懂 —— 所以宁可在这里保守地拦下。
 */

import { describe, expect, it } from "vitest";
import {
  hostOfPattern,
  isValidPattern,
  normalizePattern,
  patternForUrl,
  uniquePatterns,
} from "../extension/url-seed/src/sites";

describe("isValidPattern", () => {
  it("接受常见形态", () => {
    for (const pattern of [
      "https://sx.4399.com/*",
      "http://localhost/*",
      "*://*.4399.com/*",
      "https://game.4399.com/index.php",
      "*://*/*",
      "https://example.com/*/deep/path",
    ]) {
      expect(isValidPattern(pattern), pattern).toBe(true);
    }
  });

  it("拒绝端口（match pattern 不允许写端口）", () => {
    expect(isValidPattern("http://localhost:8080/*")).toBe(false);
    expect(isValidPattern("https://sx.4399.com:443/*")).toBe(false);
  });

  it("拒绝不支持的 scheme 与坏 host", () => {
    expect(isValidPattern("ftp://example.com/*")).toBe(false);
    expect(isValidPattern("file:///c:/x/*")).toBe(false);
    expect(isValidPattern("chrome://extensions/*")).toBe(false);
    expect(isValidPattern("https:///*")).toBe(false);
    expect(isValidPattern("https://exa mple.com/*")).toBe(false);
    expect(isValidPattern("example.com")).toBe(false);
  });

  it("通配只允许在最前面，且必须是 *. 开头", () => {
    expect(isValidPattern("https://*.4399.com/*")).toBe(true);
    expect(isValidPattern("https://4399.*.com/*")).toBe(false);
    expect(isValidPattern("https://**.com/*")).toBe(false);
  });

  it("光一个 * 的 host 也合法（manifest 里要写 <all_urls> 同款）", () => {
    // 曾经 HOST_RE 要求首字符是字母数字，把 ``*://*/*`` 误判成非法，
    // 而 ``optional_host_permissions`` 里写的正是它。
    expect(isValidPattern("*://*/*")).toBe(true);
    expect(isValidPattern("https://*/*")).toBe(true);
  });
});

describe("normalizePattern", () => {
  it("去掉首尾空白", () => {
    expect(normalizePattern("  https://sx.4399.com/*  ")).toBe("https://sx.4399.com/*");
  });

  it("非法就返回 null", () => {
    expect(normalizePattern("不是个 pattern")).toBeNull();
    expect(normalizePattern("https://a.com:80/*")).toBeNull();
  });
});

describe("patternForUrl（popup 的「启用当前网站」）", () => {
  it("取 scheme + host，路径一律 /*", () => {
    expect(patternForUrl("https://game.4399.com/index.php?a=1&ran=1.5")).toBe(
      "https://game.4399.com/*",
    );
  });

  it("丢掉端口（pattern 本身就忽略端口）", () => {
    expect(patternForUrl("http://localhost:8080/game")).toBe("http://localhost/*");
  });

  it("带 www / 多级子域也原样保留（不自动收敛成通配）", () => {
    expect(patternForUrl("https://sx.4399.com/a/b?c=1")).toBe("https://sx.4399.com/*");
  });

  it("http / https 之外的都授权不了 → null", () => {
    expect(patternForUrl("chrome://extensions")).toBeNull();
    expect(patternForUrl("file:///c:/game.swf")).toBeNull();
    expect(patternForUrl("about:blank")).toBeNull();
    expect(patternForUrl("")).toBeNull();
  });
});

describe("hostOfPattern / uniquePatterns", () => {
  it("hostOfPattern 取 host 段（列表里显示用）", () => {
    expect(hostOfPattern("https://sx.4399.com/*")).toBe("sx.4399.com");
    expect(hostOfPattern("*://*.4399.com/*")).toBe("*.4399.com");
  });

  it("uniquePatterns 保序去重、顺便丢掉非法项", () => {
    expect(
      uniquePatterns([
        " https://a.com/* ",
        "https://b.com/*",
        "https://a.com/*",
        "坏的",
        "https://c.com/x",
      ]),
    ).toEqual(["https://a.com/*", "https://b.com/*", "https://c.com/x"]);
  });
});
