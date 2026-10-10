/**
 * CSS 兼容探针 —— 判断这个引擎要不要走「老引擎兜底」样式。
 *
 * 目前只有一件事：**flex 容器的 `gap`**。它是 **Chrome 84** 才有的（grid 的 `gap` 早就有），
 * Chromium 70 上不认 —— 而且它不会报错，只是元素**全挤在一起**：界面照样能用，但很难看。
 *
 * 做法是「探测 + 挂类」，不是 `@supports`：
 *
 * * `@supports (gap: 1px)` **不能用** —— Chrome 70 上 grid 的 gap 让这条声明直接成立，
 *   于是 flex 的场景被误判成「支持」。
 * * 探针要量**真实布局**（``getBoundingClientRect``），只有真的排下去了才算支持。
 * * 结果挂成 `html.no-flex-gap`，兜底 CSS 全部写在那个前缀下 ⇒ 现代引擎上**一条都不生效**，
 *   不会和 `gap` 打架（也就不需要维护两份样式）。
 */

/**
 * 这个引擎的 flex 容器认不认 `gap`？
 *
 * 探针是一个绝对定位、移出视口的 column flex 容器 + 两个零高度子元素：
 * 有 gap 时第二个子元素的 `top` 差正好等于 gap，没有时是 0。
 *
 * ⚠️ 三个属性名都设（`gap` / `rowGap` / `columnGap`）：老引擎不认识某个名字时赋值等于没赋，
 * 认识的那个才可能真生效。指向性设置（`rowGap` + column 方向）比 `gap` 更不容易被将来
 * 的「只支持某一边」的实现糊弄过去。
 *
 * :param doc: 只在测试里传别的文档；正常调用不传。
 */
export function supportsFlexGap(doc: Document = document): boolean {
  const probe = doc.createElement("div");
  probe.style.cssText = "position:absolute;left:-9999px;top:0;display:flex;flex-direction:column";
  const first = doc.createElement("div");
  const second = doc.createElement("div");
  probe.appendChild(first);
  probe.appendChild(second);
  // `body` 可能还不存在（脚本在 `head` 里同步跑）；挂在 `documentElement` 上一样会参与布局。
  const host = doc.body ?? doc.documentElement;
  host.appendChild(probe);
  try {
    probe.style.gap = "10px";
    probe.style.rowGap = "10px";
    probe.style.columnGap = "10px";
    const top = (el: HTMLElement): number => el.getBoundingClientRect().top;
    return top(second) - top(first) > 0;
  } finally {
    // 无论成败都要摘掉：探针绝不能在页面里留下节点。
    probe.remove();
  }
}

/**
 * 探测并把结果挂到 `html` 上，返回是否支持。
 *
 * 挂 `html` 而不是某个组件节点：兜底 CSS 写在 ``App.vue`` 的 scoped 样式里，
 * 前缀就是 ``html.no-flex-gap`` —— scoped 只给**最后一个复合选择器**加 `[data-v-…]`，
 * 所以 `html` 不需要是组件渲染出来的节点。
 *
 * :param doc: 只在测试里传别的文档；正常调用不传。
 */
export function applyCompatClasses(doc: Document = document): boolean {
  const ok = supportsFlexGap(doc);
  if (!ok) doc.documentElement.classList.add("no-flex-gap");
  return ok;
}
