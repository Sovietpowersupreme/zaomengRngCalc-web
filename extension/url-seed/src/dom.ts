/**
 * 极简 ``createElement`` 包装 —— 扩展里的三处 UI（面板 / popup / 设置页）共用。
 *
 * 为什么不用 Vue：这三处全是「一屏静态表单 + 十来个事件」，用框架的收益（响应式、
 * 组件复用）远小于代价（多一份运行时、内容脚本还要额外处理 ``inlineWasmBinary``
 * 那套单文件机制）。用原生 DOM 写，代码量差不多，但**不引入任何依赖**，
 * 也就不用担心某天框架升级把内容脚本的 IIFE 打包搞出 ``eval``（MV3 CSP 会直接拒绝）。
 *
 * 规矩：**外部字符串一律走 ``text``（⇒ ``textContent``）**，这个模块不提供
 * ``innerHTML`` 口子。URL 是页面给的，拼 HTML 等于自己开一个注入口。
 */

/** 元素构造参数 —— 只列这里真的用得上的属性，其余用 :attr:`attrs`。 */
export interface ElProps {
  /** ``className``。 */
  readonly cls?: string;
  /** ``textContent``（**永远优先用它**，不要拼 HTML）。 */
  readonly text?: string;
  /** ``title``（鼠标悬停提示，也常用来放完整 URL）。 */
  readonly title?: string;
  /** ``<input>`` 的 ``type``。 */
  readonly type?: string;
  /** ``<input>`` 的初值。 */
  readonly value?: string;
  /** ``<input>`` / ``<textarea>`` 的占位文案。 */
  readonly placeholder?: string;
  /** ``<textarea>`` 行数。 */
  readonly rows?: number;
  readonly checked?: boolean;
  readonly disabled?: boolean;
  /** 事件表：``{ click: (event) => … }``。 */
  readonly on?: Readonly<Record<string, (event: Event) => void>>;
  /** 其余要设的 HTML 属性（``id`` / ``spellcheck`` / ``data-*`` 等）。 */
  readonly attrs?: Readonly<Record<string, string>>;
}

/** 建一个元素并挂好属性/事件/子节点（``null`` / ``undefined`` 子节点直接跳过）。 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  ...children: readonly (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.cls !== undefined) node.className = props.cls;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title !== undefined) node.title = props.title;
  if (props.type !== undefined && node instanceof HTMLInputElement) node.type = props.type;
  if (props.value !== undefined && (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)) {
    node.value = props.value;
  }
  if (props.placeholder !== undefined && (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)) {
    node.placeholder = props.placeholder;
  }
  if (props.rows !== undefined && node instanceof HTMLTextAreaElement) node.rows = props.rows;
  if (props.checked !== undefined && node instanceof HTMLInputElement) node.checked = props.checked;
  if (props.disabled !== undefined && (node instanceof HTMLButtonElement || node instanceof HTMLInputElement)) {
    node.disabled = props.disabled;
  }
  for (const [name, value] of Object.entries(props.attrs ?? {})) node.setAttribute(name, value);
  for (const [name, handler] of Object.entries(props.on ?? {})) node.addEventListener(name, handler);
  for (const child of children) {
    // ⚠️ 必须显式跳过空值：``append(null)`` 会把字面量 "null" 当文本插进去。
    if (child === null || child === undefined) continue;
    node.append(child);
  }
  return node;
}

/**
 * 清空一个容器（重渲染前用）。
 *
 * ⚠️ **不要用 ``replaceChildren()``** —— 那是 ``ParentNode.replaceChildren``，Chrome **86**
 * 才有的 API。Chromium 70 上它是 ``undefined``，一调就 ``TypeError``；而这套界面的三处
 * （popup / 设置页 / 页面内面板）全是「先 clear 再渲染」的写法 ⇒ 一处抛错 = 那一块界面
 * 永远空白、它后面的代码一行都不跑。真机（Chromium 70）上的表现正是：
 *
 * * popup 整个是白的（``render()`` 第一行就 clear）；
 * * 设置页只剩外壳 —— 站点列表、规则列表、偏好三块一个都不出（各自都是 clear 开头）；
 * * 页面面板的数字列表永远是空的（``setValues`` 里 clear 在 append 之前）。
 *
 * ``firstChild`` 循环从 IE 起就有，同样不走 HTML 解析，也就不必用 ``innerHTML = ""``。
 */
export function clear(node: Element): void {
  while (node.firstChild !== null) node.removeChild(node.firstChild);
}

/**
 * 用新子节点**替换**容器的全部内容（``replaceChildren(a, b, …)`` 的老内核可用版）。
 *
 * 语义与 ``replaceChildren`` 一致：先清空，再把非 ``null`` / ``undefined`` 的子节点按序挂上。
 * 空值必须显式跳过 —— ``append(null)`` 会插进字面量 ``"null"``。
 */
export function replace(
  node: Element,
  ...children: readonly (Node | string | null | undefined)[]
): void {
  clear(node);
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child);
  }
}

/**
 * 取一个**必须存在**的元素（popup / options 的挂载点 ``#app``）。
 *
 * 比 ``document.getElementById`` 好在两点：返回类型里没有 ``null``
 * （否则每个闭包里都得再收窄一次），而且 HTML 与脚本对不上时立刻抛。
 */
export function mustFind(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`页面里没有 #${id}（HTML 和脚本对不上了）`);
  return node;
}

/** 从 ``<input>`` / ``<textarea>`` 读值（元素类型已确定时的简写）。 */
export function readValue(node: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string {
  return node.value;
}
