# 造梦西游3 种子恢复（URL 随机数）· **MV2 档**（旧浏览器）

和 `../url-seed/` 是**同一个扩展**，同一份源码、同一份 UI、同一套规则与恢复算法，
只是打给**还在支持 MV2 的旧内核**（Chromium 70 级）用。

**功能、界面、用法、规则、公式，全部看 [`../url-seed/README.md`](../url-seed/README.md)**
—— 那份文档描述的就是这个扩展；这里只讲**这一档为什么存在、和另一档差在哪、怎么装**。

---

## 为什么需要单独一档

MV3 **降不到 Chromium 70**，不是「麻烦」而是「做不到」：

| 拦路虎 | 要求 | 结果 |
| --- | --- | --- |
| MV3 清单本身 | Chrome **88** | 更低的版本直接拒绝安装 |
| `minimum_chrome_version: "116"`（MV3 档的现有设定） | Chrome 116 | 装不上 |
| `chrome.scripting.registerContentScripts` | Chrome **96** | 权限模型没法实现 |
| `persistAcrossSessions: true` | Chrome 96 | 同上 |

所以旧内核只有一条路：**MV2 + 旁加载**（Chrome 应用商店早已不收新 MV2 上传）。

> ⚠️ **MV2 在 Chrome 127+ 已被彻底停用**（`chrome://extensions` 里会直接显示「不受支持」）。
> 也就是说这一档只服务于**真正老的内核**（Chrome/Edge ≤ 126，或基于 Chromium 70± 的套壳浏览器）。
> 如果你在 127+ 上，用 MV3 档（`../url-seed/`）；如果是**浏览器厂商版本号很高但内核很旧**的情况，
> 直接让用户到网页版的 `/legacy/` 去算种子。

---

## 一、怎么打、怎么装

```sh
cd web
npm run build:ext:mv2        # 只打 MV2 档
npm run build:ext:all        # 两档都打
npm run build:ext:mv2:debug  # MV2 档、不压缩（出问题好看行号）
```

产物：`web/extension/url-seed-mv2/dist/`（已在 `.gitignore` 里，不入库）。
安装同 MV3 档：`chrome://extensions` → 开发者模式 → **加载已解压的扩展程序** → 选那个 `dist` 目录。

> 同样**必须选 `dist`**，别选 `url-seed-mv2/`。这个目录里连清单都没有（见下），
> 选错只会得到「清单文件缺失或无法读取」，一眼就知道选错了。

---

## 二、这一档的目录里有什么

**只有一份清单**：

```
web/extension/url-seed-mv2/
├── src/manifest.json    ← MV2 清单（本档唯一的源）
├── dist/                ← 构建产物（要加载的就是它）
└── README.md
```

`src/` 下的其它东西**一个都没有**：四个入口（`background` / `content` / `popup` / `options`）、
两个 HTML、四个图标，全部在构建时从 `../url-seed/` 取。这是刻意的 ——

* 扩展的 UI、规则模型、公式解析器、恢复执行层，两档跑的是**同一份代码**。
  复制一份出来维护，早晚会腐，而腐了的表现是「两个插件行为不一样」，最难发现；
* 万一哪天真要分叉，再复制也不迟；在那之前，重复的文件只有坏处。

```
              web/extension/url-seed/src/*.ts   ← 唯一的一份源码
                        │
        ┌───────────────┴───────────────┐
        │                               │
   MV3 档（默认）                    MV2 档（--mv2）
   target es2022                     target es2017
   内联 wasmBase64（modern）          内联 wasmMvpBase64（纯 MVP）
   url-seed/dist/                    url-seed-mv2/dist/
```

---

## 三、和 MV3 档的**全部**差别

| | MV3（`url-seed/`） | MV2（本档） |
| --- | --- | --- |
| 清单 | `src/manifest.json` | `src/manifest.json`（本目录） |
| `manifest_version` | 3 | 2 |
| 最低内核 | Chrome 116 | **Chromium 70** |
| 后台 | `background.service_worker` | `background.scripts` + **`persistent: true`** |
| 图标按钮 | `action` | `browser_action` |
| 授权 | `optional_host_permissions` | `optional_permissions: ["*://*/*"]` |
| 注入内容脚本 | `chrome.scripting` 动态注册 | `tabs.onUpdated` + `tabs.executeScript` |
| 语法目标 | `es2022` | `es2017` |
| 内联 wasm | `wasmBase64`（modern） | `wasmMvpBase64`（纯 MVP） |
| CSS 兜底 | 不需要 | `-webkit-backdrop-filter` + `no-flex-gap` |

五件值得单独说明的事：

**1）wasm 换成了纯 MVP 那份，且只声明 `wasmMvpBase64`**

`web/src/wasm/variant.ts` 的 `candidateVariants()` 是**按「声明了哪几个变体」**决定加载哪份
wasm 的。所以这一档的 `content.js` 里**只**有 `wasmMvpBase64`：
老引擎拿到含 bulk memory 段（section 12）的 modern 产物会直接 `CompileError`，
而那种错只在老机器上复现。构建脚本因此会把「混进另一份字段」当成构建失败。
两份 wasm 的恢复结果已实测逐位一致（见 `web/tests/wasm_variant.test.ts`）。

**2）没有 `chrome.scripting`，改走「按导航注入」**

Chromium 70 没有 `chrome.scripting`（那是 Chrome 96 才有的），退路是
`tabs.onUpdated` + `tabs.executeScript`（见 `src/background.ts` 的 `injectOnNavigate`）。

**权限模型一点没变**：依旧是「用户在弹窗里授了哪个 origin，才在哪个站点注入」。
刻意**不**改用清单里的 `content_scripts` + `<all_urls>` —— 那等于安装时就把所有网站权限要下来，
而且会把注入时机挪到「页面自己解析清单」的阶段，跟 popup 里的按需授权对不上。

**3）后台页必须常驻（`persistent: true`）**

「每个标签页最近一条 URL」的缓冲是**内存里的**（用来判断刷新/跳转，避免重复注入）；
MV2 的非持久背景页（event page）会被回收，回收就等于丢了它。构建脚本会断言这一条。

**4）CSS 的两处兜底**

* `backdrop-filter` 在 Chromium 70 上要 `-webkit-` 前缀 ⇒ 面板里两个都写了；
* flex 容器的 `gap` 是 Chrome **84** 才有的（grid 的 gap 一直都有）。老引擎上它**不报错，
  只是元素全挤在一起**，所以兜底是「探测 + 挂类 + 兄弟边距」：
  - 探测复用网页版那一份（`web/src/compat/css.ts`，量真实布局，不用 `@supports`）；
  - 扩展页（popup / 设置页）由 `installStyles()` 把 `no-flex-gap` 挂到 `<html>` 上，
    兜底规则写在 `html.no-flex-gap …` 前缀下 —— 现代浏览器上一条都不生效；
  - 页面里的浮动面板在 **Shadow DOM** 里，挂在 `<html>` 上选不中它，所以那个类挂在
    **面板自己的宿主 div** 上，规则写成 `:host(.no-flex-gap) …`。

  ⚠️ 两个 HTML 里**不能**塞内联 `<script>` 探针：MV2 的默认 CSP 是 `script-src 'self'`，
  内联脚本会被拦掉（而且报错在控制台里，页面看着「什么都没发生」）。
  反正两个扩展页的**全部**组件样式都出自 `installStyles()`，在那里挂类不存在「样式已生效、类还没挂上」的中间帧。

**5）源码里不许用 Chrome 70 之后的 DOM API（这条不是构建脚本管的）**

构建脚本只查语法（能不能解析、有没有 `eval`、清单像不像 MV2），**查不出 API 的年龄**。
真正守这条线的是 `web/tests/legacy_gate.test.ts` 的 `FORBIDDEN_API` 组：它读**构建产物**的字节，
出现 `replaceChildren`（86）/ `Object.hasOwn`（93）/ `structuredClone`（98）之类就红。

**为什么必须扫产物、不能只扫源码**：降级与打包阶段会自己注入代码，源码里干干净净也照样能炸。

真踩过的坑（这一档发出去后的第一个 bug）：`src/dom.ts` 的 `clear()` 原本用
`ParentNode.replaceChildren`（Chrome **86**+）。三处界面（popup / 设置页 / 面板）**全是**
「先 clear 再渲染」的写法 ⇒ 旧内核上第一步就 `TypeError`，表现是：

* **popup 整个是白的**（`render()` 第一行就 clear）；
* **设置页只剩外壳** —— 站点列表、规则列表、偏好三块一个都不出；
* **面板的数字列表永远是空的**（clear 在 append 之前）。

而且 popup 与设置页是**唯一**能授权站点的地方 ⇒「界面挂了」还连坐成「一个随机数都抓不到」。
现在 `clear()` 是 `firstChild` 循环（IE 起就有），另加一个 `replace()` 顶 `replaceChildren(…)` 的语义。

> ⚠️ 往 `FORBIDDEN_API` 里**加**条目要克制：`findLast` / `toSorted` / `toReversed` **不能**加 ——
> `@vue/reactivity` 的 `arrayInstrumentations` 里有这几个**方法定义**（不是调用），
> 加进去会让网页旧档的闸门恒红。
>
> 也就是说：子串扫描只会**误报**（把「方法定义」当成「调用」），但**清单外的 API 它一个都抓不到**。
> 它是护栏，不是证明 —— 写界面代码时该查的浏览器兼容表还是得查。

---

## 四、构建时跑的检查

`web/tools/build_extension.mjs --mv2` 在 MV3 档那三道（`assertParses` / `assertNoEval` /
`assertManifestComplete`）之外，还多两档专属的：

* `assertManifestProfile` —— 清单必须真的像 MV2：`manifest_version: 2`、
  **不许**出现 `scripting` / `background.service_worker` / `action` / `host_permissions`、
  且 `background.persistent` 必须是显式布尔值；
* 内联 wasm 的字段名必须是 `wasmMvpBase64`，出现 `wasmBase64` 直接判失败。

`assertNoEval` 在这一档同样必要：MV2 的扩展页默认 CSP 也是 `script-src 'self'`。

> 顺带一提：Oxc 把这一档降到 `es2017` 时会刷一堆
> `[TOLERATED_TRANSFORM] Big integer literals are not available in the configured target environment.`
> —— 那 14 条**都是** `web/src/core/fromValue.ts` 里的 `1n` / `BigInt`。
> BigInt **字面量**是 Chrome 67 就有的，对 70 无害，所以是「容忍」不是「要修」。
> 别去把这些 `1n` 改成 `BigInt(1)`：那只是把警告挪个地方，还会拖慢精度转换的热路径。
